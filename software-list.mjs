#!/usr/bin/env node
/**
 * 软件清单生成器 —— 新电脑恢复用
 * ---------------------------------------------------------------
 * 扫描本机已安装软件（注册表 Uninstall 键，HKLM+HKCU+64/32 位视图），
 * 生成两类产物到 BACKUP_ROOT/software/：
 *   SOFTWARE-LIST.md      人看的清单（名称/版本/厂商/安装日期），按文件夹分组
 *   winget-packages.json  winget import 机器格式（新电脑可批量装，winget 不可用的条目自动跳过）
 *
 * 由 backup-agents.mjs 每次备份前自动调用，也可单独跑：node software-list.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(ROOT, 'software');

// ---------- 1. 已装软件扫描（调用 software-list.ps1，UTF-8 JSON 输出，中文无乱码） ----------
const tmpJson = path.join(HOME, 'AppData', 'Local', 'Temp', 'sw-list.json');
const seen = new Map();
try {
  execFileSync('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'software-list.ps1')],
    { timeout: 120000, stdio: 'ignore' });
  const raw = JSON.parse((await fs.readFile(tmpJson, 'utf8')).replace(/^\uFEFF/, ''));
  for (const e of (Array.isArray(raw) ? raw : [raw])) {
    const name = e.DisplayName;
    if (!name) continue;
    const id = name.toLowerCase();
    if (!seen.has(id)) {
      seen.set(id, {
        name,
        version: e.DisplayVersion || '',
        publisher: e.Publisher || '',
        date: (e.InstallDate || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
        scope: e.Scope || 'machine',
      });
    }
  }
} catch { /* PowerShell 失败则清单为空并提示 */ }
await fs.rm(tmpJson, { force: true });
const all = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));

// ---------- 2. winget 导出（可选，失败不阻塞） ----------
let wingetJson = null;
try {
  const tmp = path.join(OUT_DIR, 'winget-raw.json');
  await fs.mkdir(OUT_DIR, { recursive: true });
  execFileSync('winget', ['export', '-o', tmp, '--accept-source-agreements', '--disable-interactivity'],
    { encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
  wingetJson = JSON.parse(await fs.readFile(tmp, 'utf8'));
  await fs.rm(tmp, { force: true });
} catch { /* winget 不可用则跳过 */ }

// ---------- 3. 生成 SOFTWARE-LIST.md ----------
const ts = new Date().toLocaleString('sv-SE', { hour12: false }).replace('T', ' ');
let md = `# 本机软件清单（新电脑恢复用）

> 自动生成于 ${ts} ｜ 共 ${all.length} 个 ｜ 由每次备份自动刷新
> 用法：新电脑对照此清单安装；或 \`winget import software/winget-packages.json\` 批量装（装不上的对照本清单手动装）。

| # | 软件 | 版本 | 厂商 | 安装日期 | 范围 |
|---|---|---|---|---|---|
`;
all.forEach((s, i) => {
  const esc = (v) => (v || '').replace(/\|/g, '/');
  md += `| ${i + 1} | ${esc(s.name)} | ${esc(s.version)} | ${esc(s.publisher)} | ${esc(s.date)} | ${s.scope === 'user' ? '用户' : '系统'} |\n`;
});
md += `\n> 范围说明：系统=所有用户可用（装的时候要管理员），用户=仅当前用户。AI 工具链（node/python/git 等）优先装，再装各 agent，最后按 RESTORE.md 恢复数据。\n`;

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, 'SOFTWARE-LIST.md'), md, 'utf8');

// ---------- 4. winget import 文件 ----------
let wingetCount = 0;
if (wingetJson && Array.isArray(wingetJson.Packages)) {
  wingetCount = wingetJson.Packages.length;
  await fs.writeFile(path.join(OUT_DIR, 'winget-packages.json'), JSON.stringify(wingetJson, null, 2), 'utf8');
}

console.log(`[software-list] ${all.length} 个软件已写入 software/SOFTWARE-LIST.md` + (wingetCount ? `，winget 可识别 ${wingetCount} 个（winget-packages.json）` : '（winget 不可用，仅 MD 清单）'));
