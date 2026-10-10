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

const HOME = os.homedir();
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
const result = { cmd, dryRun, ok: 0, created: 0, recreated: 0, removed: 0, conflicts: [], adoptCandidates: [], perAgent: [], projects: [], actions: [], errors: [] };

const out = (msg) => { if (!jsonOut) console.log(msg); };
const isDir = async (p) => { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } };
const lstat = async (p) => { try { return await fs.lstat(p); } catch { return null; } };

async function sourceSkills() {
  const names = [];
  for (const e of await fs.readdir(SOURCE_SKILLS, { withFileTypes: true })) {
    if (e.name === 'README.md' || e.name.startsWith('.')) continue; // README 与隐藏目录（如 .golive-owned）不是技能
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
  await fs.mkdir(agent.skills, { recursive: true });
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
  const entries = await fs.readdir(agent.skills, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // 点前缀（如 codex 的 .system 系统技能）不属于收编范围
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
const startMarker = (name) => `<!-- synced-rule:${name} start（源：~/.agents/rules/${name}.md，勿在块内手工改动）-->`;
const endMarker = (name) => `<!-- synced-rule:${name} end -->`;

// 块正文 = 源文件去掉头部说明（到第一个 --- 为止）
function ruleBody(raw) {
  const idx = raw.indexOf('\n---\n');
  return (idx === -1 ? raw : raw.slice(idx + 5)).trim();
}

function ruleTargets(raw) {
  // 保留原始 token（~ 和 @trae-projects 由 cmdRules 展开）
  return raw.match(/<!--\s*sync-targets:\s*([^>]+?)\s*-->/)?.[1].split(/\s+/) || [];
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

async function cmdRules() {
  const files = (await fs.readdir(SOURCE_RULES)).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const name = file.replace(/\.md$/, '');
    const raw = await fs.readFile(path.join(SOURCE_RULES, file), 'utf8');
    const body = ruleBody(raw);
    const targetTokens = ruleTargets(raw);
    if (!targetTokens.length) { result.errors.push(`${name}: 头部缺 sync-targets 声明，跳过`); continue; }

    const re = new RegExp(`<!--\\s*synced-rule:${name} start[\\s\\S]*?synced-rule:${name} end\\s*-->`);
    // 目标展开：~ 开头 = home 相对；@trae-projects:<文件名> = PROJECTS 各项目的 .trae/rules/<文件名>
    const targets = [];
    for (const t of targetTokens) {
      if (t.startsWith('@trae-projects:')) {
        const fname = t.slice('@trae-projects:'.length);
        for (const p of PROJECTS) targets.push({ path: path.join(p.dir, '.trae', 'rules', fname), label: `trae:${p.id}` });
      } else {
        targets.push({ path: t.replace(/^~/, HOME), label: t });
      }
    }
    out(`\n[${name}] 块正文 ${body.split('\n').length} 行 · 目标 ${targets.length} 处`);
    if (!targets.length) { result.errors.push(`${name}: 头部缺 sync-targets 声明，跳过`); continue; }

    for (const { path: target, label } of targets) {
      let content = null;
      try { content = await fs.readFile(target, 'utf8'); }
      catch {
        // trae 项目规则文件允许新建；其余目标缺文件直接报错
        if (!label.startsWith('trae:')) { result.errors.push(`${name} → ${label}: 目标文件不存在`); continue; }
      }

      const matched = content && content.match(re);
      const replaceWith = `${startMarker(name)}\n${body}\n${endMarker(name)}\n`;
      if (matched) {
        const same = md5(matched[0].replace(/\r\n/g, '\n').trimEnd()) === md5(replaceWith.trimEnd());
        if (same) { out(`  ✓ 一致 · ${label}`); result.ok++; continue; }
        result.actions.push({ type: 'rules-replace', rule: name, target: label });
        out(`  ~ 块有漂移 → 替换 · ${label}`);
        if (!dryRun) {
          await fs.mkdir(path.join(RULES_BACKUP, `rules-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`), { recursive: true });
          const bak = path.join(RULES_BACKUP, `rules-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`, path.basename(target));
          await fs.copyFile(target, bak);
          await fs.writeFile(target, content.replace(re, replaceWith.trimEnd()), 'utf8');
        }
        result.created++;
      } else {
        // trae 项目规则文件可以新建；其余目标缺文件已在上面的 catch 报错
        result.actions.push({ type: 'rules-append', rule: name, target: label });
        out(`  + ${content === null ? '新建文件' : '缺块 → 末尾追加'} · ${label}`);
        if (!dryRun) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, (content ? content.trimEnd() + '\n\n' : '') + replaceWith, 'utf8');
        }
        result.created++;
      }
    }
  }
}

// ============================================================
// memory：记忆共享层下发（块注入，幂等；正文为空的源跳过）
// ============================================================
const memStart = (cat) => `<!-- synced-memory:${cat} start（源：~/.agents/memory/${cat}.md，勿在块内手工改动）-->`;
const memEnd = (cat) => `<!-- synced-memory:${cat} end -->`;
const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

async function cmdMemory() {
  for (const cat of MEMORY.categories) {
    let raw;
    try { raw = await fs.readFile(path.join(MEMORY_DIR, cat + '.md'), 'utf8'); }
    catch { out(`\n[${cat}] 源文件不存在，跳过`); continue; }
    // 正文 = 分隔线之后的内容；空正文（仅注释/空白）不注入，避免污染目标文件
    const body = ruleBody(raw).replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!body) { out(`\n[${cat}] 源为空 → 跳过注入`); continue; }
    out(`\n[${cat}] 正文 ${body.split('\n').length} 行 · 目标 ${MEMORY.targets.length} 处`);
    const re = new RegExp(`<!--\\s*synced-memory:${cat} start[\\s\\S]*?synced-memory:${cat} end\\s*-->`);
    for (const target of MEMORY.targets) {
      let content;
      try { content = await fs.readFile(target, 'utf8'); }
      catch { result.errors.push(`memory/${cat} → ${target}: 目标文件不存在`); continue; }
      const replaceWith = `${memStart(cat)}\n${body}\n${memEnd(cat)}\n`;
      const matched = content.match(re);
      if (matched) {
        if (md5(matched[0].replace(/\r\n/g, '\n').trimEnd()) === md5(replaceWith.trimEnd())) {
          out(`  ✓ 一致 · ${target.replace(HOME, '~')}`); result.ok++; continue;
        }
        result.actions.push({ type: 'memory-replace', cat, target });
        out(`  ~ 块有漂移 → 替换 · ${target.replace(HOME, '~')}`);
        if (!dryRun) {
          const bakDir = path.join(RULES_BACKUP, `memory-${stamp()}`);
          await fs.mkdir(bakDir, { recursive: true });
          await fs.copyFile(target, path.join(bakDir, path.basename(target)));
          await fs.writeFile(target, content.replace(re, replaceWith.trimEnd()), 'utf8');
        }
        result.created++;
      } else {
        result.actions.push({ type: 'memory-append', cat, target });
        out(`  + 缺块 → 末尾追加 · ${target.replace(HOME, '~')}`);
        if (!dryRun) await fs.writeFile(target, content.trimEnd() + '\n\n' + replaceWith, 'utf8');
        result.created++;
      }
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
  let pending = (links.conflicts || []).length + (links.adoptCandidates || []).length +
                  (rules.actions || []).length + (memory.actions || []).length;

  out(`技能源     ${sourceNames.size} 个`);
  for (const a of per) {
    out(`  ${a.id.padEnd(10)} 链接 ${a.ok}/${a.total}` +
        (a.conflicts.length ? ' · 冲突: ' + a.conflicts.join(', ') : '') +
        (a.adopt.length ? ' · 待收编: ' + a.adopt.join(', ') : ''));
  }
  for (const p of projects) {
    out(`  trae:${p.id.padEnd(20)} 链接 ${p.ok}/${p.total}${p.conflicts.length ? ' · 项目专属实体 ' + p.conflicts.length : ''}`);
  }
  out(`规则块     ${rules.ok || 0} 一致 / ${(rules.actions || []).length} 待注入`);
  out(`记忆块     ${memory.ok || 0} 一致 / ${(memory.actions || []).length} 待注入`);
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
  if (cmd === 'rules') await cmdRules();
  if (cmd === 'memory') await cmdMemory();
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
