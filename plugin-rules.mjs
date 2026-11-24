import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const marketplaces = { superpowers: 'superpowers-marketplace', ponytail: 'ponytail', 'frontend-design': 'claude-plugins-official' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = text => JSON.parse(text.replace(/^\uFEFF/, ''));

async function optional(read) {
  try { return await read; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function validatePolicy(policy) {
  if (!object(policy)) throw new Error('策略应为 JSON 对象');
  for (const [plugin, rule] of Object.entries(policy)) {
    const option = { ponytail: 'defaultMode', superpowers: 'skipSessionStartGuide' }[plugin];
    if (!Object.hasOwn(marketplaces, plugin) || !object(rule) || !object(rule.descriptions) ||
        Object.keys(rule).some(k => k !== 'descriptions' && k !== option)) throw new Error('未知插件或字段：' + plugin);
    if (rule.defaultMode !== undefined && rule.defaultMode !== 'off') throw new Error('defaultMode 仅支持 off');
    if (rule.skipSessionStartGuide !== undefined && typeof rule.skipSessionStartGuide !== 'boolean') throw new Error('skipSessionStartGuide 应为布尔值');
    for (const [skill, value] of Object.entries(rule.descriptions)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(skill) || typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
        throw new Error('技能名或单行描述无效：' + skill);
      }
    }
  }
}

const frontmatter = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
const oneLine = s => typeof s === 'string' && !!s.trim() && !/[\r\n\0]/.test(s);

function sourceLocations(home, rules) {
  if (!Array.isArray(rules)) throw new Error('skill-routing.json 应为规则数组');
  const locations = new Map();
  for (const rule of rules) {
    if (!object(rule) || !/^[a-z0-9][a-z0-9-]*$/.test(rule.name ?? '') || !oneLine(rule.description) ||
        !oneLine(rule.scope) || !Array.isArray(rule.locations) || !rule.locations.length ||
        Object.keys(rule).some(k => !['name', 'description', 'scope', 'replaceLines', 'locations', 'plugin'].includes(k)) ||
        (rule.plugin !== undefined && (rule.plugin !== 'frontend-design' || rule.name !== rule.plugin))) {
      throw new Error('skill-routing.json 的技能登记无效');
    }
    if (rule.replaceLines !== undefined && (!object(rule.replaceLines) ||
        Object.entries(rule.replaceLines).some(([a, b]) => !oneLine(a) || (b !== null && !oneLine(b))))) {
      throw new Error(rule.name + ' 的正文替换应为单行，删除旧指令用 null');
    }
    for (const location of rule.locations) {
      if (typeof location !== 'string' || location.split(/[\\/]/).includes('..') ||
          !(location.startsWith('~/.agents/skills/') || path.isAbsolute(location))) throw new Error('无效技能源路径：' + location);
      const dir = location.startsWith('~/') ? path.resolve(home, location.slice(2)) : path.resolve(location);
      if (locations.has(dir)) throw new Error('重复登记技能源：' + dir);
      locations.set(dir, rule);
    }
  }
  return locations;
}

// 仅修改声明作用域。示例代码与其余上游正文按原换行保留。
function routeMarkdown(text, rule) {
  const match = frontmatter.exec(describe(text, rule.name, rule.description));
  const eol = match[1].includes('\r\n') ? '\r\n' : '\n';
  const fields = match[2].replace(/^disable-model-invocation:[^\r\n]*/gm, line => {
    if (!/^disable-model-invocation:[ \t]*(true|false)[ \t]*(?:#.*)?$/i.test(line)) throw new Error('无法识别 disable-model-invocation');
    return line.replace(/(:[ \t]*)true/i, '$1false');
  });
  const body = match.input.slice(match[0].length);
  const begin = '<!-- agent-sync:skill-scope start -->', end = '<!-- agent-sync:skill-scope end -->';
  let fence, hasScope = false, inBlock = false, sawBlock = false;
  const lines = [];
  for (const raw of body.split(/(?<=\n)/)) {
    const line = raw.replace(/\r?\n$/, '');
    const mark = /^\s{0,3}(\x60{3,}|~{3,})/.exec(line)?.[1];
    if (fence || mark) {
      if (fence && mark?.startsWith(fence) && line.trim() === mark) fence = undefined;
      else if (!fence) fence = mark;
      if (!inBlock) lines.push(raw);
      continue;
    }
    if (line === begin) {
      if (sawBlock) throw new Error('重复的技能作用域标记');
      inBlock = sawBlock = true;
      lines.push(begin + eol, rule.scope + eol);
    } else if (line === end) {
      if (!inBlock) throw new Error('孤立的技能作用域结束标记');
      inBlock = false;
      lines.push(raw);
    } else if (!inBlock) {
      const replacements = rule.replaceLines ?? {};
      const next = Object.hasOwn(replacements, line) ? replacements[line] : line;
      if (next === rule.scope) hasScope = true;
      if (next !== null) lines.push(next + raw.slice(line.length));
    }
  }
  if (inBlock) throw new Error('技能作用域标记未闭合');
  const prefix = !hasScope && !sawBlock ? [eol, begin, rule.scope, end, '', ''].join(eol) : '';
  return match[1] + fields + match[3] + prefix + lines.join('');
}

function allowImplicit(text) {
  const policies = [...text.matchAll(/^\uFEFF?policy:([^\r\n]*)((?:(?:\r?\n)+(?:[ \t]+[^\r\n]*|#[^\r\n]*))*)/gm)];
  if (!policies.length) return text;
  const [section, inline, block] = policies[0];
  if (policies.length !== 1) throw new Error('重复的 agents/openai.yaml policy');
  if (/^\s*\{\s*allow_implicit_invocation:\s*(true|false)\s*\}\s*(?:#.*)?$/i.test(inline)) {
    return text.slice(0, policies[0].index) + section.replace(/(allow_implicit_invocation:\s*)false/i, '$1true') + text.slice(policies[0].index + section.length);
  }
  if (!/^\s*(?:#.*|\{\s*\})?$/.test(inline)) throw new Error('无法识别 agents/openai.yaml 的 policy');
  const children = block.match(/^[ \t]+(?=[\w-]+:)/gm) ?? [];
  if (!children.length) return text;
  const indent = Math.min(...children.map(x => x.length));
  const key = new RegExp('^([ ]{' + indent + '}allow_implicit_invocation:[ \\t]*)([^\\r\\n]*)', 'gm');
  const next = section.replace(key, (_, start, value) => {
    if (!/^(true|false)[ \t]*(?:#.*)?$/i.test(value)) throw new Error('无法识别 allow_implicit_invocation');
    return start + value.replace(/^(true|false)/i, 'true');
  });
  return text.slice(0, policies[0].index) + next + text.slice(policies[0].index + section.length);
}

function describe(text, skill, value) {
  const header = frontmatter.exec(text);
  const name = header?.[2].match(/^name:[ \t]*["']?([a-z0-9-]+)["']?[ \t]*\r?$/m)?.[1];
  const fields = header?.[2].match(/^description:[^\r\n]*(?:(?:\r?\n)+[ \t]+[^\r\n]*)*/gm);
  if (name !== skill || fields?.length !== 1) throw new Error(skill + ' 的 SKILL.md 头部无法识别');
  // 已有的安全纯文本保持原样；特殊 YAML 字符按 JSON 字符串转义。
  const plain = /^[\p{L}]/u.test(value) && !/[:#\r\n]/.test(value) && !/^(yes|no|true|false|null|on|off)$/i.test(value);
  const target = 'description: ' + (plain ? value : JSON.stringify(value));
  if (fields[0] === target || fields[0] === 'description: ' + JSON.stringify(value)) return text;
  const start = header[1].length + header[2].search(/^description:/m);
  return text.slice(0, start) + target + text.slice(start + fields[0].length);
}

const guide = /^(?:&\s+)?["']?\$\{(?:CLAUDE_|CODEX_)?PLUGIN_ROOT\}[\\/]hooks[\\/](?:run-hook\.cmd["']?\s+["']?)?session-start(?:-codex)?["']?$/;
function removeGuide(events) {
  if (!object(events)) throw new Error('无法识别 hooks 格式');
  if (!Object.hasOwn(events, 'SessionStart')) return false;
  let changed = false;
  const groups = [];
  for (const group of events.SessionStart) {
    const keep = group.hooks.filter(handler => {
      if (handler.type !== 'command') return true;
      const commands = [handler.command, handler.powershell].filter(Boolean);
      if (commands.length && !handler.args && commands.every(c => typeof c === 'string' && guide.test(c.trim()))) return false;
      if (/session-start|using-superpowers/i.test(JSON.stringify(handler))) throw new Error('未知 Superpowers 开场命令，保留原配置');
      return true;
    });
    if (keep.length === group.hooks.length) groups.push(group);
    else {
      changed = true;
      if (keep.length) groups.push({ ...group, hooks: keep });
    }
  }
  if (changed && groups.length) events.SessionStart = groups;
  else if (changed) delete events.SessionStart;
  return changed;
}

function encodeJson(data, original) {
  const newline = original?.includes('\r\n') ? '\r\n' : '\n';
  const indent = original?.match(/\n([ \t]+)"/)?.[1] ?? 2;
  return (original?.startsWith('\uFEFF') ? '\uFEFF' : '') + JSON.stringify(data, null, indent).replaceAll('\n', newline)
    + (!original || original.endsWith('\n') ? newline : '');
}

function inside(root, file) {
  const rel = path.relative(root, file);
  if (!rel || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') throw new Error('目标不在插件包内：' + file);
}

async function installed(host, home, plugin) {
  const base = (host === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) || path.join(home, '.' + host);
  const plugins = path.join(base, 'plugins');
  const cache = path.join(plugins, 'cache');
  const parent = path.join(cache, marketplaces[plugin], plugin);
  let dirs;
  if (host === 'claude') {
    const raw = await optional(fs.readFile(path.join(plugins, 'installed_plugins.json'), 'utf8'));
    if (raw === null) return [];
    const entries = parse(raw).plugins;
    if (!object(entries)) throw new Error('无法识别 Claude 插件登记表');
    dirs = [...new Set((entries[plugin + '@' + marketplaces[plugin]] ?? []).map(x => path.resolve(x.installPath)))];
  } else {
    const entries = await optional(fs.readdir(parent, { withFileTypes: true }));
    dirs = (entries ?? []).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => path.join(parent, e.name));
  }
  const roots = [];
  for (const dir of dirs) {
    if (path.relative(parent, path.dirname(dir)) !== '') throw new Error('插件目录与登记不符：' + dir);
    const root = await fs.realpath(dir);
    inside(await fs.realpath(cache), root);
    roots.push(root);
  }
  return roots;
}

function sourceFiles(root) {
  const plans = new Map();
  async function file(relative, allowMissing = false) {
    const location = path.resolve(root, relative);
    inside(root, location);
    const real = await optional(fs.realpath(location));
    if (!real && allowMissing) return null;
    if (!real) throw new Error('缺少文件：' + location);
    inside(root, real);
    if (!plans.has(real)) {
      const old = await fs.readFile(real, 'utf8');
      plans.set(real, { file: real, old, next: old });
    }
    return plans.get(real);
  }
  return { plans, file };
}

async function planSkill(files, skill, route) {
  skill.rule = 'skill-routing';
  skill.next = routeMarkdown(skill.old, route);
  const metadata = await files.file(path.join(path.dirname(skill.file), 'agents/openai.yaml'), true);
  if (metadata) {
    metadata.rule = skill.rule;
    metadata.next = allowImplicit(metadata.old);
  }
}

async function planPackage(host, root, plugin, rule, route) {
  const files = sourceFiles(root);
  const { file, plans } = files;
  const compat = host === 'codex' && plugin === 'frontend-design';
  const manifestFile = await file('.' + host + '-plugin/plugin.json', compat) ?? await file('.claude-plugin/plugin.json');
  const manifest = parse(manifestFile.old);
  if (manifest.name !== plugin) throw new Error('插件 manifest.name 不匹配：' + root);
  const declared = manifest.skills ?? './skills';
  const skillDirs = new Set(Array.isArray(declared) ? declared : [declared]);
  if (host === 'claude') skillDirs.add('./skills');
  for (const [name, value] of Object.entries(rule.descriptions)) {
    let found = false;
    for (const dir of skillDirs) {
      if (typeof dir !== 'string' || !dir.length || path.isAbsolute(dir)) throw new Error('无法识别 manifest.skills');
      const skill = await file(path.join(dir, name, 'SKILL.md'), true);
      if (skill) {
        if (route) await planSkill(files, skill, route);
        else skill.next = describe(skill.old, name, value);
        found = true;
      }
    }
    if (!found) throw new Error('已登记技能缺少 SKILL.md：' + name);
  }
  if (rule.skipSessionStartGuide) {
    const paths = new Set();
    let changed = false;
    const decl = manifest.hooks;
    for (const entry of Array.isArray(decl) ? decl : decl == null ? [] : [decl]) {
      if (typeof entry === 'string' && entry.endsWith('.json')) paths.add(entry);
      else if (object(entry)) changed = removeGuide(entry.hooks ?? entry) || changed;
      else throw new Error('无法识别插件 manifest.hooks');
    }
    if (changed) manifestFile.next = encodeJson(manifest, manifestFile.old);
    // Claude 自动发现默认文件；Codex 显式声明空 hooks 时不启用它。
    if (host === 'claude' || decl == null) {
      const standard = await file('hooks/hooks.json', true);
      if (standard) paths.add('hooks/hooks.json');
    }
    for (const relative of paths) {
      const target = await file(relative);
      const data = parse(target.old);
      if (removeGuide(data.hooks ?? data)) target.next = encodeJson(data, target.old);
    }
  }
  // manifest 只作识别时不计入已管理项。
  if (manifestFile.old === manifestFile.next) plans.delete(manifestFile.file);
  return [...plans.values()];
}

async function planDefault(home) {
  const base = process.env.XDG_CONFIG_HOME || (process.platform === 'win32'
    ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming') : path.join(home, '.config'));
  const file = path.join(base, 'ponytail', 'config.json');
  if ((await optional(fs.lstat(file)))?.isSymbolicLink()) throw new Error('用户配置是链接，保留原目标：' + file);
  const old = await optional(fs.readFile(file, 'utf8'));
  const config = old === null ? {} : parse(old);
  if (!object(config)) throw new Error('Ponytail 用户配置应为 JSON 对象');
  return { file, old, next: config.defaultMode === 'off' ? old : encodeJson({ ...config, defaultMode: 'off' }, old) };
}

async function writeChange({ file, old, next }, backup) {
  if (old !== null) {
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.writeFile(backup, old, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), '.agent-sync-' + randomUUID() + '.tmp');
  try {
    const mode = old === null ? 0o600 : (await fs.stat(file)).mode;
    await fs.writeFile(tmp, next, { flag: 'wx', mode });
    const current = await optional(fs.readFile(file, 'utf8'));
    if (current === next) return;
    if (current !== old) throw new Error('文件在同步期间改变，请重试：' + file);
    if (old === null) await fs.link(tmp, file);
    else await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }); }
}

export async function syncRoutingRules({ home, dryRun, backups, result, out, pluginsOnly = false }) {
  const directory = path.join(home, '.agents/rules');
  const readPolicy = async (name, fallback) => {
    const raw = await optional(fs.readFile(path.join(directory, name), 'utf8'));
    return raw === null ? fallback : parse(raw);
  };
  const policy = await readPolicy('plugin-routing.json', {});
  validatePolicy(policy);
  const routes = await readPolicy('skill-routing.json', []);
  const locations = sourceLocations(home, routes);
  const pluginRoutes = new Map();
  for (const route of routes.filter(r => r.plugin)) {
    if (Object.hasOwn(policy, route.plugin)) throw new Error('重复登记插件：' + route.plugin);
    policy[route.plugin] = { descriptions: { [route.name]: route.description } };
    pluginRoutes.set(route.plugin, route);
  }
  const plans = [];
  if (!pluginsOnly) {
    for (const [location, route] of locations) {
      try {
        const root = await fs.realpath(location);
        if (path.relative(location, root) !== '') {
          if (locations.get(root) === route) continue;
          throw new Error('链接指向其他技能源，保留目标：' + root);
        }
        const files = sourceFiles(root);
        await planSkill(files, await files.file('SKILL.md'), route);
        plans.push(...files.plans.values());
      } catch (e) { result.errors.push(location + '：' + e.message); }
    }
  }
  let manageDefault = false;
  for (const [plugin, rule] of Object.entries(policy)) {
    for (const host of ['claude', 'codex']) {
      try {
        for (const root of await installed(host, home, plugin)) {
          try {
            plans.push(...await planPackage(host, root, plugin, rule, pluginRoutes.get(plugin)));
            if (rule.defaultMode === 'off') manageDefault = true;
          } catch (e) { result.errors.push(root + '：' + e.message); }
        }
      } catch (e) { result.errors.push(host + '/' + plugin + '：' + e.message); }
    }
  }
  if (manageDefault) {
    try { plans.push(await planDefault(home)); }
    catch (e) { result.errors.push('Ponytail 用户配置：' + e.message); }
    if (/^(lite|full|ultra)$/i.test((process.env.PONYTAIL_DEFAULT_MODE || '').trim())) {
      result.errors.push('PONYTAIL_DEFAULT_MODE 环境变量覆盖了用户的 off 默认值');
    }
  }
  for (const change of plans) {
    if (change.old === change.next) { result.ok++; continue; }
    const backup = change.old === null ? null : path.join(backups, createHash('sha256')
      .update(change.file).update('\0').update(change.old).digest('hex') + '.bak');
    result.actions.push({ type: change.rule ? 'skill-rule' : 'plugin-rule', rule: change.rule ?? 'plugin-routing', target: change.file, backup });
    out('  ~ 调用规则 · ' + change.file);
    try {
      if (!dryRun) await writeChange(change, backup);
      result.created++;
    } catch (e) { result.errors.push(change.file + '：' + e.message); }
  }
}
