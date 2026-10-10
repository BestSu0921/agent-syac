#!/usr/bin/env node
/**
 * 全局 Agent 记忆/技能备份脚本
 * ---------------------------------------------------------------
 * 作用：把 C 盘各 AI agent（workbuddy / claudecode / zcode / trae 等）
 *       的「全局记忆 + 全局技能 + 关键配置」镜像到 D 盘统一目录，
 *       防止 C 盘格式化/损坏导致找不回。
 *
 * 同步语义：
 *   - 默认「增量镜像」：只新增/更新源里比目标新的文件，绝不删除目标多余文件（安全）。
 *   - 加 --mirror：删除目标中存在、但源已不存在的文件（严格一致，慎用）。
 *   - 加 --dry-run：只打印将要复制的文件，不写盘。
 *
 * 用法：
 *   node backup-agents.mjs            # 正常增量备份
 *   node backup-agents.mjs --dry-run  # 预演
 *   node backup-agents.mjs --mirror   # 严格镜像（删多余）
 *
 * 想加新 agent / 新路径：直接往下方 SOURCES 数组加一项即可。
 */

import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir(); // C:\Users\admin
// 备份根：读 ~/.agents/sync.config.json 的 backupRoot，缺省 = 脚本所在目录（兼容本机 D:\ai-agent-backup）
const CONFIG = await fs.readFile(path.join(HOME, '.agents', 'sync.config.json'), 'utf8').then(JSON.parse).catch(() => ({}));
const BACKUP_ROOT = CONFIG.backupRoot || path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(BACKUP_ROOT, 'sync-log.txt');
const MANIFEST = path.join(BACKUP_ROOT, 'MANIFEST.md');

const dryRun = process.argv.includes('--dry-run');
const mirror = process.argv.includes('--mirror');

// ============================================================
// 备份白名单：只收「记忆 + 技能 + 关键配置」，不收运行时大文件
//   type: 'file' -> src 是文件，dest 写完整目标相对路径（含文件名）
//   type: 'dir'  -> src 是目录，dest 写目标目录相对路径
//   ignore: 可选，basename 匹配（'node_modules'）或后缀（'*.db-wal'）或路径片段
// ============================================================
const SOURCES = [
  // ---------- 全局技能中心（所有 agent 共享的技能源，必须优先备份）----------
  { name: 'global-agents-skills', type: 'dir', src: path.join(HOME, '.agents', 'skills'), dest: 'global-agents/skills', ignore: ['node_modules'] },
  { name: 'global-agents-rules', type: 'dir', src: path.join(HOME, '.agents', 'rules'), dest: 'global-agents/rules' },
  { name: 'global-agents-memory', type: 'dir', src: path.join(HOME, '.agents', 'memory'), dest: 'global-agents/memory' },
  { name: 'global-agents-mcp', type: 'dir', src: path.join(HOME, '.agents', 'mcp'), dest: 'global-agents/mcp' },
  { name: 'codex-AGENTS', type: 'file', src: path.join(HOME, '.codex', 'AGENTS.md'), dest: 'codex/AGENTS.md' },

  // ---------- WorkBuddy ----------
  { name: 'workbuddy-MEMORY', type: 'file', src: path.join(HOME, '.workbuddy', 'MEMORY.md'), dest: 'workbuddy/MEMORY.md' },
  { name: 'workbuddy-IDENTITY', type: 'file', src: path.join(HOME, '.workbuddy', 'IDENTITY.md'), dest: 'workbuddy/IDENTITY.md' },
  { name: 'workbuddy-SOUL', type: 'file', src: path.join(HOME, '.workbuddy', 'SOUL.md'), dest: 'workbuddy/SOUL.md' },
  { name: 'workbuddy-USER', type: 'file', src: path.join(HOME, '.workbuddy', 'USER.md'), dest: 'workbuddy/USER.md' },
  { name: 'workbuddy-skills', type: 'dir', src: path.join(HOME, '.workbuddy', 'skills'), dest: 'workbuddy/skills', ignore: ['node_modules', '*.log'] },

  // ---------- Claude Code ----------
  { name: 'claudecode-CLAUDE', type: 'file', src: path.join(HOME, '.claude', 'CLAUDE.md'), dest: 'claudecode/CLAUDE.md' },
  { name: 'claudecode-skills', type: 'dir', src: path.join(HOME, '.claude', 'skills'), dest: 'claudecode/skills', ignore: ['node_modules'] },
  { name: 'claudecode-settings', type: 'file', src: path.join(HOME, '.claude', 'settings.json'), dest: 'claudecode/settings.json' },
  { name: 'claudecode-settings-local', type: 'file', src: path.join(HOME, '.claude', 'settings.local.json'), dest: 'claudecode/settings.local.json' },

  // ---------- ZCode ----------
  { name: 'zcode-memories', type: 'dir', src: path.join(HOME, '.zcode', 'cli', 'memories'), dest: 'zcode/memories', ignore: ['*.db-wal', '*.db-shm', 'node_modules'] },
  { name: 'zcode-agents', type: 'dir', src: path.join(HOME, '.zcode', 'cli', 'agents'), dest: 'zcode/agents', ignore: ['sess_*'] },
  { name: 'zcode-AGENTS', type: 'file', src: path.join(HOME, '.zcode', 'AGENTS.md'), dest: 'zcode/AGENTS.md' },

  // ---------- Trae（home 下主要是编辑器配置，真正记忆极少；排除扩展副本）----------
  { name: 'trae-config', type: 'dir', src: path.join(HOME, '.trae'), dest: 'trae', ignore: ['extensions'] },

  // ---------- Trae CN 用户配置（真身在 AppData/Roaming/Trae CN；只备配置，排除运行时大文件）----------
  { name: 'trae-cn-user', type: 'dir', src: path.join(HOME, 'AppData', 'Roaming', 'Trae CN', 'User'), dest: 'trae-cn/User', ignore: ['History', 'workspaceStorage', 'globalStorage'] },

  // ---------- 可选补充（按需取消注释）----------
  // Trae 真正的用户数据在 AppData/Roaming/Trae/User，含 globalStorage/设置，
  // 体积可能较大，默认不收；需要可取消下一行注释：
  // { name: 'trae-userdata', type: 'dir', src: path.join(HOME, 'AppData', 'Roaming', 'Trae', 'User'), dest: 'trae-userdata', ignore: ['extensions', 'globalStorage/*/ms-'] },
];

// ============================================================
function shouldIgnore(name, full, ignore) {
  if (!ignore) return false;
  const lower = name.toLowerCase();
  for (const ig of ignore) {
    if (ig.includes('*')) {
      const core = ig.replace(/\*/g, '').toLowerCase();
      if (ig.startsWith('*') && ig.endsWith('*')) { if (core && lower.includes(core)) return true; }
      else if (ig.startsWith('*')) { if (lower.endsWith(core)) return true; }
      else if (ig.endsWith('*')) { if (lower.startsWith(core)) return true; }
      else { if (lower.includes(core)) return true; }
    } else if (name === ig) return true;
    else if (full.replace(/\\/g, '/').toLowerCase().includes(ig.toLowerCase())) return true;
  }
  return false;
}

function relToRoot(p) { return path.relative(BACKUP_ROOT, p).replace(/\\/g, '/'); }

async function copyFile(src, dest, stats) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  let need = true;
  try {
    const [s, d] = await Promise.all([fs.stat(src), fs.stat(dest)]);
    if (d.mtimeMs >= s.mtimeMs) need = false;
  } catch { /* 目标不存在 -> 需要复制 */ }
  if (need) {
    if (!dryRun) await fs.copyFile(src, dest);
    stats.copied++;
    stats.copiedList.push(relToRoot(dest));
  } else {
    stats.skipped++;
  }
}

async function copyDir(src, dest, ignore, stats) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (shouldIgnore(e.name, s, ignore)) { stats.ignored++; continue; }
    // 跟随符号链接：各 agent 的 skills 目录大量用 symlink 指向全局中心
    // (.agents/skills)，不 follow 会静默跳过、导致技能内容漏备份。
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const real = await fs.stat(s); // stat 默认跟随链接
        isDir = real.isDirectory();
        isFile = real.isFile();
      } catch { stats.ignored++; continue; }
    }
    if (isDir) {
      await copyDir(s, d, ignore, stats);
    } else if (isFile) {
      await copyFile(s, d, stats);
    }
  }
}

// mirror 模式：删掉目标有、源没有的文件
async function pruneMirror(src, dest, ignore, stats) {
  let entries;
  try { entries = await fs.readdir(dest, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const d = path.join(dest, e.name);
    const s = path.join(src, e.name);
    const srcExists = await fs.stat(s).then(() => true).catch(() => false);
    // 源侧物理不存在，或被白名单显式忽略（不纳入备份）的项，目标里都不应保留
    const srcKept = srcExists && !shouldIgnore(e.name, s, ignore);
    if (!srcKept) {
      if (!dryRun) await fs.rm(d, { recursive: true, force: true });
      stats.pruned++;
      stats.prunedList.push(relToRoot(d));
    } else if (e.isDirectory()) {
      await pruneMirror(s, d, ignore, stats);
    }
  }
}

async function backupOne(item, stats) {
  const dest = path.join(BACKUP_ROOT, item.dest);
  try {
    const st = await fs.stat(item.src);
    if (item.type === 'file') {
      if (!st.isFile()) throw new Error('src 不是文件: ' + item.src);
      await copyFile(item.src, dest, stats);
    } else {
      if (!st.isDirectory()) throw new Error('src 不是目录: ' + item.src);
      await copyDir(item.src, dest, item.ignore, stats);
      if (mirror) await pruneMirror(item.src, dest, item.ignore, stats);
    }
    stats.ok.push(item.name);
  } catch (err) {
    stats.errors.push(`${item.name}: ${err.message}`);
  }
}

async function main() {
  await fs.mkdir(BACKUP_ROOT, { recursive: true });
  const stats = { copied: 0, skipped: 0, ignored: 0, pruned: 0, ok: [], errors: [], copiedList: [], prunedList: [] };
  // 本地时间（toISOString 是 UTC，会与用户手动执行时间差 8 小时对不上）
  const ts = new Date().toLocaleString('sv-SE', { hour12: false }).replace('T', ' ');

  for (const item of SOURCES) await backupOne(item, stats);

  const summary = `[${ts}] mode=${dryRun ? 'dry-run' : (mirror ? 'mirror' : 'incr')} ` +
    `copied=${stats.copied} skipped=${stats.skipped} ignored=${stats.ignored} pruned=${stats.pruned} errors=${stats.errors.length}`;

  let log = '';
  log += `\n${summary}\n`;
  for (const f of stats.copiedList) log += `  + ${f}\n`;
  for (const f of stats.prunedList) log += `  - ${f}\n`;
  for (const e of stats.errors) log += `  ! ${e}\n`;

  if (!dryRun) {
    // 新记录插到文件头部（时间倒序：最新一次在最上面，免翻到底找）
    let prev = '';
    try { prev = await fs.readFile(LOG_FILE, 'utf8'); } catch { /* 首次无日志 */ }
    await fs.writeFile(LOG_FILE, log + prev, 'utf8');
    const manifest =
      `# Agent 备份清单（自动生成，勿手改）\n\n` +
      `最近同步: ${ts} | 模式: ${dryRun ? 'dry-run' : (mirror ? 'mirror' : 'incr')}\n\n` +
      `| 源 | 状态 | 说明 |\n| --- | --- | --- |\n` +
      SOURCES.map(s => `| ${s.name} | ${stats.errors.find(e => e.startsWith(s.name)) ? 'FAIL' : 'OK'} | ${s.src.replace(HOME, '~')} → ${s.dest} |`).join('\n') +
      `\n\n本次复制 ${stats.copied} 文件 / 跳过 ${stats.skipped} / 忽略 ${stats.ignored}${mirror ? ` / 删除 ${stats.pruned}` : ''} / 错误 ${stats.errors.length}\n`;
    await fs.writeFile(MANIFEST, manifest, 'utf8');
  }

  console.log(summary);
  if (stats.copiedList.length) { console.log('复制:'); stats.copiedList.forEach(f => console.log('  + ' + f)); }
  if (mirror && stats.prunedList.length) { console.log('删除(仅mirror):'); stats.prunedList.forEach(f => console.log('  - ' + f)); }
  if (stats.errors.length) { console.log('错误:'); stats.errors.forEach(e => console.log('  ! ' + e)); }
  if (dryRun) console.log('\n[dry-run] 未实际写入，去掉 --dry-run 重新运行以执行。');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
