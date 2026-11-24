#!/usr/bin/env node
/**
 * agent-sync · 技能与规则同步引擎（单源 → 各 agent）
 * ---------------------------------------------------------------
 * 三类动作：
 *   links  技能映射：源里所有技能在各 agent skills 目录确保 junction（不复制实体）；
 *          同时映射进 PROJECTS 清单里各 trae 项目的 .trae/skills（trae 无全局目录，项目级接入）
 *   adopt  收编巡检：agent 目录里源没有的实体技能 → 移入源 + 补链接（先列清单确认）
 *   rules  规则注入：~/.agents/rules/*.md 按标记块幂等注入各 agent 全局文件
 *   memory 记忆下发：~/.agents/memory/<类别>.md 块注入各 agent 全局文件（空源自动跳过）
 *   check  一致性巡检：以上全部预演汇总，只读不改盘
 *
 * 通用开关：
 *   --dry-run  预演，不写盘
 *   --yes      adopt 跳过确认
 *   --json     只输出 JSON（给面板用）
 *
 * 约定：
 *   - 源目录 ~/.agents/skills、~/.agents/rules（唯一实体，agent 侧一律链接）
 *   - zcode 原生直读 ~/.agents/skills，无需映射，只注入规则
 *   - agent 侧实体目录与源同名 = 冲突，只报告不自动处理（防覆盖手改）
 *   - 日志与 backup-agents.mjs 共用 sync-log.txt（新记录插头部）
 */

import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { readProjectSkills, projectSkillNames } from './project-skills.mjs';
import { syncRoutingRules } from './plugin-rules.mjs';

const HOME = os.homedir();
const PROJECT_SKILLS = await readProjectSkills(HOME);
const PROJECT_SKILL_NAMES = projectSkillNames(PROJECT_SKILLS);
// 备份/日志根：读 ~/.agents/sync.config.json 的 backupRoot，缺省 = 脚本所在目录
const CONFIG = await fs.readFile(path.join(HOME, '.agents', 'sync.config.json'), 'utf8').then(JSON.parse).catch(() => ({}));
const BACKUP_ROOT = CONFIG.backupRoot || path.dirname(fileURLToPath(import.meta.url));
const SOURCE_SKILLS = path.join(HOME, '.agents', 'skills');
const SOURCE_RULES = path.join(HOME, '.agents', 'rules');
const LOG_FILE = path.join(BACKUP_ROOT, 'sync-log.txt');
const RULES_BACKUP = path.join(BACKUP_ROOT, 'backups');

const dryRun = process.argv.includes('--dry-run');
const yes = process.argv.includes('--yes');
const jsonOut = process.argv.includes('--json');
const cmd = process.argv.find((a, i) => i > 1 && !a.startsWith('--'));

// 目标矩阵：加新 agent 在这里加一行
// skills: null 表示该 agent 原生直读源目录，只需注入规则
const AGENTS = [
  { id: 'claude',    skills: path.join(HOME, '.claude', 'skills'),    rules: path.join(HOME, '.claude', 'CLAUDE.md') },
  { id: 'workbuddy', skills: path.join(HOME, '.workbuddy', 'skills'), rules: path.join(HOME, '.workbuddy', 'SOUL.md') },
  { id: 'zcode',     skills: null,                                    rules: path.join(HOME, '.zcode', 'AGENTS.md') },
  { id: 'opencode',  skills: path.join(HOME, '.config', 'opencode', 'skills'), rules: path.join(HOME, '.config', 'opencode', 'AGENTS.md') },
  { id: 'codex',     skills: path.join(HOME, '.codex', 'skills'),     rules: path.join(HOME, '.codex', 'AGENTS.md') },
];

// trae 项目级接入：trae 没有全局技能目录，技能/规则都在项目 .trae/ 下。
// 把源映射进每个项目的 .trae/skills，源更新所有项目即时生效。加项目在这里加一行。
// mcp: 该项目使用的 MCP 模板名（~/.agents/mcp/<名>.json），sync mcp 时合并进项目 .mcp.json
const PROJECTS = [
  { id: 'btw-sport-uniapp',     dir: 'D:\\sqs\\aiCode\\btw-sport-uniapp',      mcp: ['lanhu'] },
  { id: 'btw-sport-admin',      dir: 'D:\\sqs\\aiCode\\btw-sport-admin',       mcp: ['lanhu'] },
  { id: 'btw-platform-template',dir: 'D:\\sqs\\aiCode\\btw-platform-template' },
  { id: 'json-render-demo',     dir: 'D:\\sqs\\aiCode\\json-render-demo' },
  { id: 'json-render-demo-trae',dir: 'D:\\sqs\\aiCode\\json-render-demo-trae' },
  { id: 'supaBase',             dir: 'D:\\sqs\\aiCode\\supaBase' },
];

// 记忆共享层：~/.agents/memory/<类别>.md → 块注入各 agent 全局文件。
// workbuddy 目标选 SOUL.md 而非 MEMORY.md：后者是它自己会重写的动态文件，注入块会被冲掉。
const MEMORY_DIR = path.join(HOME, '.agents', 'memory');
const MCP_DIR = path.join(HOME, '.agents', 'mcp');
const MEMORY = {
  categories: ['user', 'feedback'],
  targets: [
    path.join(HOME, '.claude', 'CLAUDE.md'),
    path.join(HOME, '.workbuddy', 'SOUL.md'),
    path.join(HOME, '.zcode', 'AGENTS.md'),
    path.join(HOME, '.config', 'opencode', 'AGENTS.md'),
    path.join(HOME, '.codex', 'AGENTS.md'),
  ],
};

// ============================================================
// 小工具
// ============================================================
const result = { cmd, dryRun, ok: 0, created: 0, recreated: 0, removed: 0, conflicts: [], adoptCandidates: [], perAgent: [], projects: [], projectSkills: [], actions: [], errors: [] };

const out = (msg) => { if (!jsonOut) console.log(msg); };
const isDir = async (p) => { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } };
const lstat = async (p) => { try { return await fs.lstat(p); } catch { return null; } };

async function sourceSkills() {
  const names = [];
  for (const e of await fs.readdir(SOURCE_SKILLS, { withFileTypes: true })) {
    if (e.name === 'README.md' || e.name.startsWith('.')) continue; // README 与隐藏目录（如 .golive-owned）不是技能
    if (PROJECT_SKILL_NAMES.has(e.name)) continue;
    // isDir 会跟随链接（源里 golive 本身是工具自管的符号链接，照常纳入）
    if (await isDir(path.join(SOURCE_SKILLS, e.name))) names.push(e.name);
  }
  return names;
}

function makeJunction(target, linkPath) {
  return fs.symlink(target, linkPath, 'junction');
}

// 巡检单个 agent 的 skills 目录，返回 {missing, broken, conflict, adopt}
async function scanAgent(agent, sources) {
  const srcSet = new Set(sources);
  const r = { missing: [], broken: [], conflict: [], adopt: [], dangling: [] };
  if (!dryRun) await fs.mkdir(agent.skills, { recursive: true });
  for (const name of sources) {
    const p = path.join(agent.skills, name);
    const st = await lstat(p);
    if (!st) { r.missing.push(name); continue; }
    if (st.isSymbolicLink()) {
      if (!(await isDir(p))) r.broken.push(name);
      continue;
    }
    if (st.isDirectory()) { r.conflict.push(name); continue; }
    // 文件（如 workbuddy 的迁移标记 json）：忽略
  }
  const entries = await fs.readdir(agent.skills, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // 点前缀（如 codex 的 .system 系统技能）不属于收编范围
    if (PROJECT_SKILL_NAMES.has(e.name)) continue; // 项目归属由登记表约束，不收编或隐式删除
    if (e.isSymbolicLink() && !srcSet.has(e.name)) r.dangling.push(e.name);
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    if (!srcSet.has(e.name)) r.adopt.push(e.name);
  }
  return r;
}

// ============================================================
// links：技能映射
// ============================================================
async function cmdLinks() {
  for (const project of PROJECT_SKILLS) {
    const status = { id: project.id, dir: project.dir, present: [], missing: [], globalDuplicates: [], agentCopies: [] };
    for (const name of project.skills) {
      const source = path.join(project.dir, '.agents', 'skills', name, 'SKILL.md');
      const exists = await fs.stat(source).then((s) => s.isFile()).catch(() => false);
      (exists ? status.present : status.missing).push(name);
      if (await lstat(path.join(SOURCE_SKILLS, name))) status.globalDuplicates.push(name);
      for (const agent of AGENTS) {
        if (agent.skills && await lstat(path.join(agent.skills, name))) status.agentCopies.push({ agent: agent.id, skill: name });
      }
    }
    result.projectSkills.push(status);
    for (const name of status.missing) result.errors.push(`project ${project.id}/${name}: 源不可读`);
    for (const name of status.globalDuplicates) result.errors.push(`project ${project.id}/${name}: 全局同名副本需人工处理`);
    for (const copy of status.agentCopies) result.errors.push(`project ${project.id}/${copy.skill}: ${copy.agent}全局目录残留，需人工处理`);
    out(`项目技能 ${project.id}: ${status.present.length}/${project.skills.length}可读，全局副本${status.globalDuplicates.length}，agent残留${status.agentCopies.length}`);
  }
  const sources = await sourceSkills();
  for (const agent of AGENTS) {
    if (!agent.skills) {
      out(`\n[${agent.id}] 原生直读源目录，无需映射`);
      continue;
    }
    const scan = await scanAgent(agent, sources);
    result.perAgent.push({
      id: agent.id,
      dir: agent.skills.replace(HOME, '~'),
      total: sources.length,
      ok: sources.length - scan.missing.length - scan.broken.length - scan.conflict.length,
      missing: scan.missing.length,
      broken: scan.broken.length,
      conflicts: scan.conflict,
      adopt: scan.adopt,
      rulesFile: agent.rules,
    });
    out(`\n[${agent.id}] ${agent.skills.replace(HOME, '~')}`);

    for (const name of scan.broken) {
      const p = path.join(agent.skills, name);
      result.actions.push({ type: 'recreate-link', agent: agent.id, target: name });
      if (!dryRun) { await fs.rm(p); await makeJunction(path.join(SOURCE_SKILLS, name), p); }
      result.recreated++;
      out(`  ~ 修复失效链接: ${name}`);
    }
    for (const name of scan.missing) {
      const p = path.join(agent.skills, name);
      result.actions.push({ type: 'create-link', agent: agent.id, target: name });
      if (!dryRun) await makeJunction(path.join(SOURCE_SKILLS, name), p);
      result.created++;
    }
    for (const name of scan.dangling) {
      // 源里已删除的技能：agent 侧残留的死链，清除（只删链接本身，不动其它内容）
      const p = path.join(agent.skills, name);
      result.actions.push({ type: 'remove-dangling', agent: agent.id, target: name });
      out(`  - 源已删除 → 清除残留链接: ${name}`);
      if (!dryRun) await fs.rm(p);
      result.removed++;
    }
    out(`  链接完整 ${sources.length - scan.missing.length - scan.broken.length - scan.conflict.length}/${sources.length}` +
        ` · 新建 ${scan.missing.length} · 修复 ${scan.broken.length}${scan.conflict.length ? ` · 冲突 ${scan.conflict.length}` : ''}${scan.dangling.length ? ` · 清除 ${scan.dangling.length}` : ''}`);
    for (const name of scan.missing) out(`  + 新建 junction: ${name}`);
    if (scan.conflict.length) {
      out(`  ! 冲突（agent 侧实体目录与源同名，请人工处理后改链接）:`);
      for (const name of scan.conflict) {
        out(`    - ${name}`);
        result.conflicts.push({ agent: agent.id, skill: name });
      }
    }
    if (scan.adopt.length) {
      out(`  ? 收编候选（agent 侧实体目录，源里没有；运行 adopt 处理）:`);
      for (const name of scan.adopt) {
        out(`    - ${name}`);
        result.adoptCandidates.push({ agent: agent.id, skill: name });
      }
    }
    result.ok += sources.length - scan.missing.length - scan.broken.length - scan.conflict.length;
  }
  // trae：新版原生直读 ~/.agents/skills（设置「启用 .agents 技能目录」），无需项目级 junction；
  // PROJECTS 仅用于 @trae-projects 规则注入与 mcp 下发
}

// ============================================================
// adopt：收编（移入源 + 补链接，移动前确认）
// ============================================================
async function cmdAdopt() {
  const sources = await sourceSkills();
  const plan = [];
  for (const agent of AGENTS) {
    if (!agent.skills) continue;
    const scan = await scanAgent(agent, sources);
    for (const name of scan.adopt) {
      plan.push({ agent, name });
      result.adoptCandidates.push({ agent: agent.id, skill: name });
    }
  }
  if (!plan.length) { out('没有需要收编的实体技能。'); return; }

  out('收编清单（实体目录 → 移入源 + 原位补 junction）:');
  for (const { agent, name } of plan) out(`  [${agent.id}] ${name}`);

  if (dryRun) { out('\n[dry-run] 未移动。去掉 --dry-run 并确认后执行。'); return; }
  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(`共 ${plan.length} 项，确认移入源? [y/N] `);
    rl.close();
    if (ans.trim().toLowerCase() !== 'y') { out('已取消。'); return; }
  }
  for (const { agent, name } of plan) {
    const from = path.join(agent.skills, name);
    const to = path.join(SOURCE_SKILLS, name);
    try {
      await fs.rename(from, to);
      await makeJunction(to, from);
      result.actions.push({ type: 'adopt', agent: agent.id, skill: name });
      result.created++;
      out(`  ✓ ${name}: ${agent.id} → 源 + 补链接`);
    } catch (err) {
      result.errors.push(`adopt ${agent.id}/${name}: ${err.message}`);
    }
  }
}

// ============================================================
// rules：规则块注入（幂等）
// ============================================================
// 规则和记忆共用同一组边界。每个源文件只拥有同名的一对标记。
const GLOBAL_RULE_FILES = [...AGENTS.map(agent => agent.rules),
  path.join(HOME, '.dsh', 'AGENTS.md'), path.join(HOME, '.trae-cn', 'user_rules.md')];

function ruleBody(raw) {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const separator = text.indexOf('\n---\n');
  return (separator === -1 ? text : text.slice(separator + 5)).trim();
}

function declaredTargets(raw, field) {
  const header = raw.split(/\r?\n---\r?\n/, 1)[0];
  const declaration = header.match(new RegExp('<!--\\s*' + field + ':\\s*([^>]*?)\\s*-->'));
  return declaration?.[1].trim().split(/\s+/).filter(Boolean) || [];
}

function expandTargets(tokens) {
  const targets = new Map();
  function add(file, label, optional = false, create = false) {
    const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    const previous = targets.get(key);
    targets.set(key, {file, label, optional:previous ? previous.optional && optional : optional, create});
  }
  for (const token of tokens) {
    if (token === '@global') {
      for (const file of GLOBAL_RULE_FILES) add(file, '~/' + path.relative(HOME, file).split(path.sep).join('/'), true);
    } else if (token.startsWith('@trae-projects:')) {
      const fname = token.slice('@trae-projects:'.length);
      for (const project of PROJECTS) add(path.join(project.dir, '.trae','rules',fname), 'trae:' + project.id, false, true);
    } else {
      if (token.startsWith('@')) throw new Error('未知的目标分组 ' + token);
      add(token.replace(/^~(?=[\\/])/, HOME), token);
    }
  }
  return targets;
}

function managedRange(content, kind, name) {
  const markers = /^<!--[ \t]*(synced-rule|synced-memory):([^\s<>]+)[ \t]+(start|end)(?=[ \t（(]|-->)[^\r\n]*?-->[ \t]*(?=\r?$)/gm;
  const offset = content.startsWith('\uFEFF') ? 1 : 0;
  let open = null;
  let found = null;
  for (const m of content.slice(offset).matchAll(markers)) {
    const [, family, id, side] = m;
    if (side === 'start') {
      if (open) throw new Error('同步块嵌套或缺结束标记：' + open.id);
      open = {family, id, start:m.index + offset};
    } else {
      if (!open || open.family !== family || open.id !== id) throw new Error('同步块标记不匹配：' + id);
      if (family === 'synced-' + kind && id === name) {
        if (found) throw new Error('同步块重名：' + name);
        found = {start:open.start, end:m.index + m[0].length + offset};
      }
      open = null;
    }
  }
  if (open) throw new Error('同步块缺结束标记：' + open.id);
  return found;
}

async function syncBlock(target, kind, name, body, reference = false) {
  const {file, label} = target;
  let content = '';
  let existing = true;
  try { content = await fs.readFile(file,'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (target.optional || reference) return;
    if (!target.create) throw new Error('目标文件不存在');
    existing = false;
  }
  const range = managedRange(content, kind, name);
  if (reference && !range) { result.ok++; return; }
  const domain = kind === 'rule' ? 'rules' : 'memory';
  const tag = 'synced-' + kind + ':' + name;
  const expected = '<!-- ' + tag + ' start（源：~/.agents/' + domain + '/' + name + '.md，勿在块内手工改动）-->\n' + body + '\n<!-- ' + tag + ' end -->';
  const same = range && content.slice(range.start,range.end).replace(/\r\n/g,'\n') === expected;
  if (reference && !same) throw new Error('按需块的内容与源不同，已保留现场');
  if (!reference && same) { result.ok++; return; }

  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const block = expected.replace(/\n/g, eol);
  let next;
  let action;
  if (reference) {
    const suffix = content.slice(range.end).replace(/^(?:\r?\n){1,2}/, '');
    next = content.slice(0,range.start) + suffix;
    action = 'remove';
  } else if (range) {
    next = content.slice(0,range.start) + block + content.slice(range.end);
    action = 'replace';
  } else {
    const gap = !content || content.endsWith(eol + eol) ? '' : content.endsWith(eol) ? eol : eol + eol;
    next = content + gap + block + eol;
    action = 'append';
  }
  // 先验证合成结果；新增规则的正文也不能截断其他块。
  managedRange(next, kind, name);
  result.actions.push(kind === 'rule' ? {type:domain+'-'+action, rule:name, target:label} :
    {type:domain+'-'+action, cat:name, target:file});
  out('  ' + action + ' · ' + name + ' → ' + label);
  if (!dryRun) {
    await fs.mkdir(path.dirname(file), {recursive:true});
    const real = existing ? await fs.realpath(file) : file;
    const tmp = real + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(tmp, next, {flag:'wx', mode:existing ? (await fs.stat(real)).mode : 0o600});
      if (existing) {
        const signature = crypto.createHash('sha256').update(real).update('\0').update(content).digest('hex').slice(0,20);
        const bak = path.join(RULES_BACKUP, domain + '-' + new Date().toISOString().slice(0,10), signature + '-' + path.basename(real));
        await fs.mkdir(path.dirname(bak), {recursive:true});
        await fs.writeFile(bak, content);
        if (await fs.readFile(real, 'utf8') !== content) throw new Error('写入前文件已变化，请重新同步');
        await fs.rename(tmp, real);
      } else {
        await fs.copyFile(tmp, real, fs.constants.COPYFILE_EXCL);
      }
    } finally { await fs.rm(tmp, {force:true}); }
  }
  if (reference) result.removed++; else result.created++;
}

async function cmdRules() {
  try {
    await syncRoutingRules({home:HOME, dryRun, backups:path.join(RULES_BACKUP,'plugin-rules'), result, out, pluginsOnly:process.argv.includes('--plugins-only')});
  } catch (e) { result.errors.push('技能调用规则：' + e.message); }
  if (process.argv.includes('--plugins-only') || process.argv.includes('--routing-only')) return;
  const files = (await fs.readdir(SOURCE_RULES)).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const name = file.slice(0,-3);
    try {
      const raw = await fs.readFile(path.join(SOURCE_RULES,file),'utf8');
      const included = expandTargets(declaredTargets(raw,'sync-targets'));
      const references = expandTargets(declaredTargets(raw,'reference-targets'));
      if (!included.size && !references.size) throw new Error('头部缺同步目标声明');
      for (const key of references.keys()) if (included.has(key)) throw new Error('同一目标同时声明注入和按需引用');
      const body = ruleBody(raw);
      for (const [key, target] of [...included, ...references]) {
        try { await syncBlock(target, 'rule', name, body, references.has(key)); }
        catch (e) { result.errors.push(name + ' → ' + target.label + ': ' + e.message); }
      }
    } catch (e) { result.errors.push(name + ': ' + e.message); }
  }
}

// rules 和 memory 改的是同一批文件。写入者先登记自己的 PID，其他进程退让后再重读。
async function withDocumentWriter(work) {
  if (dryRun) return work();
  const dir = path.join(HOME, '.agents', '.document-writers');
  const own = String(process.pid);
  const marker = path.join(dir, own);
  await fs.mkdir(dir, {recursive:true});
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await fs.writeFile(marker, '');
    try {
      const busy = (await fs.readdir(dir)).some(name => {
        if (name === own || !/^\d+$/.test(name)) return false;
        try { process.kill(Number(name), 0); return true; }
        catch (e) { return e.code !== 'ESRCH'; }
      });
      if (!busy) return await work();
    } finally { await fs.rm(marker, {force:true}); }
    await new Promise(done => setTimeout(done, 40 + Math.random() * 80));
  }
  result.errors.push('另一个规则或记忆同步仍在写入，请稍后重试');
}

async function cmdMemory() {
  for (const cat of MEMORY.categories) {
    let raw;
    try { raw = await fs.readFile(path.join(MEMORY_DIR,cat+'.md'),'utf8'); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const body = ruleBody(raw).replace(/<!--[\s\S]*?-->/g,'').trim();
    if (!body) continue;
    const tokens = declaredTargets(raw, 'sync-targets');
    const targets = expandTargets(tokens.length ? tokens : MEMORY.targets);
    for (const target of targets.values()) {
      try { await syncBlock(target,'memory',cat,body); }
      catch (e) { result.errors.push('memory/' + cat + ' → ' + target.label + ': ' + e.message); }
    }
  }
}

// ============================================================
// mcp：项目级 MCP 配置下发（模板合并安装，幂等；不碰项目已有/专属 server）
// ============================================================
// 键排序后序列化：让"内容相同、键序不同"的配置判定为一致
const stable = (v) => JSON.stringify(v, (k, val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return Object.fromEntries(Object.keys(val).sort().map((kk) => [kk, val[kk]]));
  }
  return val;
});

async function cmdMcp() {
  const templates = new Map();
  try {
    for (const f of await fs.readdir(MCP_DIR)) {
      if (!f.endsWith('.json')) continue;
      templates.set(f.replace(/\.json$/, ''), JSON.parse(await fs.readFile(path.join(MCP_DIR, f), 'utf8')));
    }
  } catch { /* 目录不存在 */ }
  if (!templates.size) { out('没有 MCP 模板（~/.agents/mcp/*.json）'); return; }
  out(`模板 ${templates.size} 个：${[...templates.keys()].join(', ')}`);

  for (const proj of PROJECTS) {
    const uses = proj.mcp || [];
    if (!uses.length) continue;
    const mcpFile = path.join(proj.dir, '.mcp.json');
    let conf;
    try { conf = JSON.parse(await fs.readFile(mcpFile, 'utf8')); }
    catch { conf = {}; }
    conf.mcpServers = conf.mcpServers || {};
    out(`\n[${proj.id}] ${mcpFile.replace(proj.dir, '')} · 现有 ${Object.keys(conf.mcpServers).length} 个 server`);
    let changed = false;
    for (const t of uses) {
      const tpl = templates.get(t);
      if (!tpl) { result.errors.push(`${proj.id}: MCP 模板 ${t} 不存在`); continue; }
      for (const [server, def] of Object.entries(tpl.mcpServers || {})) {
        if (!conf.mcpServers[server]) {
          result.actions.push({ type: 'mcp-add', project: proj.id, server });
          out(`  + 缺失 → 安装 ${server}`);
          if (!dryRun) { conf.mcpServers[server] = def; changed = true; }
          result.created++;
        } else if (stable(conf.mcpServers[server]) === stable(def)) {
          out(`  ✓ ${server} 一致`); result.ok++;
        } else {
          // 项目侧已有同名但配置不同：以项目为准，只报告
          result.actions.push({ type: 'mcp-conflict', project: proj.id, server });
          result.conflicts.push({ agent: proj.id, skill: server });
          out(`  ! ${server} 项目侧配置与模板不同 → 保持项目侧不动`);
        }
      }
    }
    if (changed) await fs.writeFile(mcpFile, JSON.stringify(conf, null, 2) + '\n', 'utf8');
  }
}

// ============================================================
// check：一致性巡检（links/rules/memory 预演汇总，只读）
// ============================================================
async function cmdCheck() {
  const SELF = fileURLToPath(import.meta.url);
  const j = (args) => {
    const r = spawnSync(process.execPath, [SELF, ...args, '--json', '--dry-run'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    try { return JSON.parse(r.stdout); } catch { return { error: (r.stderr || 'no output').slice(0, 300) }; }
  };
  const links = j(['links']);
  const rules = j(['rules']);
  const memory = j(['memory']);
  const per = links.perAgent || [];
  const projects = links.projects || [];

  // 技能源里所有 bundle 的依赖清单检查（只读）
  const sourceNames = new Set(await sourceSkills());
  const bundles = [];
  for (const name of sourceNames) {
    let b;
    try { b = JSON.parse(await fs.readFile(path.join(SOURCE_SKILLS, name, 'bundle.json'), 'utf8')); }
    catch { continue; }
    bundles.push({ name, requires: b.requires || {} });
  }

  const linkOk = per.reduce((n, a) => n + a.ok, 0) + projects.reduce((n, p) => n + p.ok, 0);
  const linkTotal = per.reduce((n, a) => n + a.total, 0) + projects.reduce((n, p) => n + p.total, 0);
  let pending = (links.errors || []).length + (links.conflicts || []).length + (links.adoptCandidates || []).length +
                  (rules.actions || []).length + (rules.errors || []).length + (memory.actions || []).length + (memory.errors || []).length;

  out(`技能源     ${sourceNames.size} 个`);
  for (const a of per) {
    out(`  ${a.id.padEnd(10)} 链接 ${a.ok}/${a.total}` +
        (a.conflicts.length ? ' · 冲突: ' + a.conflicts.join(', ') : '') +
        (a.adopt.length ? ' · 待收编: ' + a.adopt.join(', ') : ''));
  }
  for (const p of projects) {
    out(`  trae:${p.id.padEnd(20)} 链接 ${p.ok}/${p.total}${p.conflicts.length ? ' · 项目专属实体 ' + p.conflicts.length : ''}`);
  }
  out(`规则       ${rules.ok || 0} 一致 / ${(rules.actions || []).length} 待同步 / ${(rules.errors || []).length} 异常`);
  for (const error of rules.errors || []) out('  ! ' + error);
  out(`记忆块     ${memory.ok || 0} 一致 / ${(memory.actions || []).length} 待注入`);
  for (const error of memory.errors || []) out('  ! ' + error);
  out(`链接合计   ${linkOk}/${linkTotal}`);

  // bundle 依赖检查：技能依赖看源，MCP 依赖看各声明项目的 .mcp.json
  let bundlePending = 0;
  for (const b of bundles) {
    const need = b.requires.skills || [];
    const missing = need.filter((s) => !sourceNames.has(s));
    out(`包 ${b.name}`);
    out(`  技能依赖 ${need.length}${missing.length ? ' · ✗ 缺: ' + missing.join(', ') : ' · ✓'}`);
    bundlePending += missing.length;
    for (const m of b.requires.mcp || []) {
      const rows = [];
      for (const proj of PROJECTS) {
        if (!(proj.mcp || []).length) continue; // 未声明使用 MCP 的项目不检查
        let conf = {};
        try { conf = JSON.parse(await fs.readFile(path.join(proj.dir, '.mcp.json'), 'utf8')); } catch { }
        rows.push(`${proj.id}${conf.mcpServers?.[m] ? '✓' : '✗'}`);
      }
      const missingMcp = rows.some((r) => r.endsWith('✗'));
      out(`  MCP ${m}: ${rows.join('  ') || '（无声明项目）'}`);
      if (missingMcp) bundlePending++;
    }
  }
  if (bundles.length) out(`包依赖     ${bundles.length} 个包 · ${bundlePending} 处缺失`);

  // 未接入 agent 检测：已知特征目录存在、但不在 AGENTS 矩阵时提示（信息项，不计 pending）
  const KNOWN_AGENT_HINTS = [
    ['codex', path.join(HOME, '.codex')],
    ['gemini-cli', path.join(HOME, '.gemini')],
    ['cursor', path.join(HOME, '.cursor')],
    ['opencode', path.join(HOME, '.config', 'opencode')],
    ['warp', path.join(HOME, '.warp')],
  ];
  const unregistered = [];
  const matrixIds = new Set(AGENTS.map((a) => a.id));
  for (const [id, dir] of KNOWN_AGENT_HINTS) {
    if (matrixIds.has(id)) continue; // 已接入矩阵的不再报"痕迹"
    if (await isDir(dir)) unregistered.push(`${id}（${dir.replace(HOME, '~')}）`);
  }
  if (unregistered.length) {
    out(`未接入检测   发现 ${unregistered.length} 个未纳入同步的 agent 痕迹：`);
    for (const u of unregistered) out(`  ? ${u} → 在 AGENTS 矩阵加一行即可纳入 links/rules/backup`);
  }

  pending += bundlePending;
  out(pending === 0 ? '\n✓ 全部一致，无待处理项' : `\n⚠ ${pending} 项待处理 · 建议顺序：links → adopt → rules → memory`);
  result.projectSkills = links.projectSkills || [];
  result.check = { links, rules, memory, bundles, linkOk, linkTotal, pending };
}

// ============================================================
// 主流程：执行 + 日志 + JSON
// ============================================================
async function main() {
  if (!cmd || !['links', 'adopt', 'rules', 'memory', 'mcp', 'check'].includes(cmd)) {
    console.error('用法: node sync.mjs <links|adopt|rules|memory|mcp|check> [--dry-run] [--yes] [--json]');
    process.exit(1);
  }
  if (cmd === 'links') await cmdLinks();
  if (cmd === 'adopt') await cmdAdopt();
  if (cmd === 'rules') await withDocumentWriter(cmdRules);
  if (cmd === 'memory') await withDocumentWriter(cmdMemory);
  if (cmd === 'mcp') await cmdMcp();
  if (cmd === 'check') await cmdCheck();

  const ts = new Date().toLocaleString('sv-SE', { hour12: false }).replace('T', ' ');
  const summary = `[${ts}] sync ${cmd} mode=${dryRun ? 'dry-run' : 'apply'} ` +
    `ok=${result.ok} created=${result.created} removed=${result.removed} conflict=${result.conflicts.length} adopt=${result.adoptCandidates.length} errors=${result.errors.length}`;

  if (!jsonOut) {
    out(`\n${summary}${dryRun ? '  [dry-run 未写盘]' : ''}`);
    if (result.errors.length) { out('错误:'); result.errors.forEach((e) => out('  ! ' + e)); }
  }

  if (!dryRun) {
    let prev = '';
    try { prev = await fs.readFile(LOG_FILE, 'utf8'); } catch { /* 首次无日志 */ }
    let log = `\n${summary}\n`;
    for (const a of result.actions) log += `  · ${JSON.stringify(a)}\n`;
    for (const c of result.conflicts) log += `  ! 冲突: ${c.agent}/${c.skill}\n`;
    for (const e of result.errors) log += `  ! ${e}\n`;
    await fs.writeFile(LOG_FILE, log + prev, 'utf8');
  }

  if (jsonOut) {
    console.log(JSON.stringify({ ...result, summary }));
  }
  if (result.errors.length && !dryRun) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
