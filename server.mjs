#!/usr/bin/env node
/**
 * agent-sync 面板服务
 * ---------------------------------------------------------------
 * 只读本地数据 + 调 sync.mjs / backup-agents.mjs，不做任何业务逻辑。
 * 只监听 127.0.0.1，单机工具，无鉴权。
 *
 *   GET  /            面板页面（web/index.html）
 *   GET  /api/status  状态汇总（links/rules 预演 + 备份 + 日志尾 + 30 天心跳，缓存 20s）
 *   POST /api/run     执行命令 {cmd: links|rules|adopt|backup, dryRun: bool}
 *                     → NDJSON 流式输出 {t:'line',s}…{t:'done',code}
 *                     adopt 正式执行由服务端代答 --yes（确认在面板里做）
 *   GET  /mdview      Markdown 内嵌预览页（?path=绝对路径，2s 轮询自动刷新）
 *   GET  /api/md      读 md 内容 {name, mtime, content}（?path=，仅 .md/.markdown）
 *   GET  /api/mdstat  轮询 mtime（?path=）
 *   GET  /api/mdasset 读相对图片资源（?path=，仅图片扩展名，供预览页 <img>）
 *   GET  /api/openmd  用 MD 阅览/系统关联程序打开 ?path=（弹出独立窗口）
 */

import http from 'node:http';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
// exe 模式：AGENT_SYNC_HOME = 启动器解包出的应用目录；源码模式 = 本文件所在目录
const APP_ROOT = process.env.AGENT_SYNC_HOME || path.dirname(fileURLToPath(import.meta.url));
// 备份/日志根与端口：读 ~/.agents/sync.config.json（backupRoot / port）
const CONFIG = await fs.readFile(path.join(HOME, '.agents', 'sync.config.json'), 'utf8').then(JSON.parse).catch(() => ({}));
const BACKUP_ROOT = CONFIG.backupRoot || APP_ROOT;
const PORT = Number(process.env.AGENT_SYNC_PORT || CONFIG.port || 7717);
const SYNC = path.join(APP_ROOT, 'sync.mjs');
const BACKUP = path.join(APP_ROOT, 'backup-agents.mjs');
const INDEX = path.join(APP_ROOT, 'web', 'index.html');
const LOG_FILE = path.join(BACKUP_ROOT, 'sync-log.txt');
const ALLOW = ['links', 'rules', 'adopt', 'memory', 'mcp', 'backup', 'all'];

// 技能库：源目录各技能的 name + SKILL.md 描述，合并 catalog.json 的分类与短标签
async function getSkills() {
  const out = [];
  let entries = [];
  const skillsBase = path.join(HOME, '.agents', 'skills');
  try { entries = await fs.readdir(skillsBase, { withFileTypes: true }); } catch { return out; }
  let catalog = {};
  try { catalog = JSON.parse(await fs.readFile(path.join(skillsBase, 'catalog.json'), 'utf8')); } catch { /* 无目录数据则全部未分类 */ }
  const meta = new Map();
  for (const [cat, items] of Object.entries(catalog)) {
    for (const [name, item] of Object.entries(items || {})) {
      const o = typeof item === 'string' ? { short: item } : item;
      meta.set(name, { cat, short: o.short || '', tag: o.tag || '通用' });
    }
  }
  for (const e of entries) {
    if (e.name === 'README.md' || e.name.startsWith('.') || e.name === 'catalog.json') continue;
    const dir = path.join(skillsBase, e.name);
    if (!(await fs.stat(dir).then((s) => s.isDirectory()).catch(() => false))) continue;
    let desc = '';
    try {
      const raw = (await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
      let dm = fm.match(/^description:\s*(["'])([\s\S]*?)\1\s*$/m) || fm.match(/^description:\s*(.+)$/m);
      if (!dm) {
        // YAML 块描述（description: |）：拼接缩进行
        const block = fm.match(/^description:\s*\|[^\n]*\n((?:[ \t]+.*\n?)*)/m);
        if (block) dm = [, , block[1].replace(/^[ \t]+/gm, '').replace(/\s+/g, ' ').trim()];
      }
      if (dm) desc = (dm[2] || dm[1]).trim();
    } catch { /* 无 SKILL.md 的目录：留空描述 */ }
    const m = meta.get(e.name);
    out.push({ name: e.name, desc, cat: m?.cat || '未分类', short: m?.short || desc.slice(0, 20), tag: m?.tag || '通用' });
  }
  return out;
}

// ---------- 状态汇总（缓存 20s） ----------
let cache = { at: 0, data: null };

function jrun(args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true });
  try { return JSON.parse(r.stdout); }
  catch { return { error: (r.stderr || r.stdout || 'no output').slice(0, 500) }; }
}

async function tailLines(file, n) {
  try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).slice(0, n); }
  catch { return []; }
}

// 近 30 天心跳：按日聚合摘要行（dry-run 不计；errors>0 记红）
function heartbeat(summaries) {
  const byDay = new Map();
  for (const l of summaries) {
    const m = l.match(/^\[(\d{4}-\d{2}-\d{2})[^\]]*\].*errors=(\d+)/);
    if (!m || /mode=dry-run/.test(l)) continue;
    const d = byDay.get(m[1]) || { runs: 0, errs: 0 };
    d.runs++; d.errs += Number(m[2]);
    byDay.set(m[1], d);
  }
  const out = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000);
    const key = dt.toLocaleString('sv-SE').slice(0, 10);
    const d = byDay.get(key);
    out.push({
      s: !d ? 'off' : d.errs > 0 ? 'err' : 'ok',
      label: `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))} · ` +
             (d ? `${d.runs} 次运行${d.errs ? ` · ${d.errs} 错误` : ''}` : '无记录'),
    });
  }
  return out;
}

async function getStatus(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.at < 20000) return cache.data;
  const links = jrun([SYNC, 'links', '--json', '--dry-run']);
  const rules = jrun([SYNC, 'rules', '--json', '--dry-run']);
  const memory = jrun([SYNC, 'memory', '--json', '--dry-run']);
  // 全文读日志，只取 [时间] 开头的摘要行（备份会写入上万条"复制了某文件"行，必须过滤）
  const all = await tailLines(LOG_FILE, 200000);
  const summaries = all.filter((l) => /^\[\d{4}-/.test(l));
  const backupLine = summaries.find((l) => /mode=(incr|mirror)/.test(l)) || '';
  const bm = backupLine.match(/^\[([^\]]+)\].*(mode=\w+).*errors=(\d+)/) || [];
  const data = {
    sourceCount: links.perAgent?.[0]?.total ?? null,
    perAgent: links.perAgent || [],
    conflicts: links.conflicts || [],
    adoptCandidates: links.adoptCandidates || [],
    rules: { ok: rules.ok || 0, actions: rules.actions || [], errors: rules.errors || [] },
    memory: { ok: memory.ok || 0, actions: memory.actions || [], errors: memory.errors || [] },
    projects: links.projects || [],
    backup: bm.length ? { ts: bm[1], mode: bm[2].replace('mode=', ''), errors: Number(bm[3]) } : null,
    logTail: summaries.slice(0, 30),
    days: heartbeat(summaries),
    skills: await getSkills(),
  };
  if (links.error) data.error = 'links 巡检失败: ' + links.error;
  cache = { at: now, data };
  return data;
}

// ---------- HTTP ----------
async function readBody(req) {
  let b = '';
  for await (const c of req) b += c;
  try { return JSON.parse(b || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await fs.readFile(INDEX));
      return;
    }
    if (url === '/logo.png' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(await fs.readFile(path.join(APP_ROOT, 'web', 'logo.png')));
      return;
    }
    if (url === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(await getStatus()));
      return;
    }
    if (url === '/api/open' && req.method === 'GET') {
      openPanel(`http://127.0.0.1:${PORT}/`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      return;
    }
    if (url === '/mdview' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await fs.readFile(path.join(APP_ROOT, 'web', 'mdview.html')));
      return;
    }
    if (url === '/api/md' && req.method === 'GET') {
      const p = resolveLocalFile(new URL(req.url, 'http://x').searchParams.get('path'), MD_EXT);
      if (!p) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"需要 .md 绝对路径"}'); return; }
      try {
        const { mtime, content } = await readMdFile(p);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: p, name: path.basename(p), mtime, content }));
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (url === '/api/mdstat' && req.method === 'GET') {
      const p = resolveLocalFile(new URL(req.url, 'http://x').searchParams.get('path'), MD_EXT);
      if (!p) { res.writeHead(400); res.end('{"error":"bad path"}'); return; }
      try {
        const s = await fs.stat(p);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, mtime: Math.floor(s.mtimeMs) }));
      } catch {
        res.writeHead(404); res.end('{"error":"gone"}');
      }
      return;
    }
    if (url === '/api/mdasset' && req.method === 'GET') {
      const p = resolveLocalFile(new URL(req.url, 'http://x').searchParams.get('path'), IMG_EXT);
      if (!p) { res.writeHead(400); res.end('bad path'); return; }
      try {
        const buf = await fs.readFile(p);
        const ext = path.extname(p).toLowerCase().slice(1);
        const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(buf);
      } catch {
        res.writeHead(404); res.end('not found');
      }
      return;
    }
    if (url === '/api/openmd' && req.method === 'GET') {
      const p = resolveLocalFile(new URL(req.url, 'http://x').searchParams.get('path'), MD_EXT);
      if (!p) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"需要 .md 绝对路径"}'); return; }
      const exe = await mdViewerExe();
      if (exe) spawn(exe, [p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      else spawn('cmd', ['/c', 'start', '', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, via: exe ? 'md-viewer' : 'system' }));
      return;
    }
    if (url === '/api/run' && req.method === 'POST') {
      const { cmd, dryRun } = await readBody(req);
      if (!ALLOW.includes(cmd)) { res.writeHead(400); res.end('bad cmd'); return; }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      const send = (o) => res.write(JSON.stringify(o) + '\n');

      // 步骤序列：all = 按序全跑（预演各步 --dry-run；正式执行时 adopt 由服务端代答 --yes）
      let steps;
      if (cmd === 'all') {
        steps = [['links'], ['adopt'], ['rules'], ['memory'], ['backup']].map(([name]) => {
          const a = name === 'backup' ? [BACKUP] : [SYNC, name];
          if (dryRun) a.push('--dry-run');
          else if (name === 'adopt') a.push('--yes');
          return { name, args: a };
        });
      } else {
        const a = cmd === 'backup' ? [BACKUP] : [SYNC, cmd];
        if (dryRun) a.push('--dry-run');
        else if (cmd === 'adopt') a.push('--yes');
        steps = [{ name: cmd, args: a }];
      }

      (async () => {
        for (const { name, args } of steps) {
          if (cmd === 'all') send({ t: 'line', s: `━━━ 步骤：${name} ━━━` });
          await new Promise((resolve) => {
            const child = spawn(process.execPath, args, { windowsHide: true });
            let buf = '';
            child.stdout.on('data', (c) => {
              buf += c.toString();
              let i;
              while ((i = buf.indexOf('\n')) >= 0) {
                const l = buf.slice(0, i);
                buf = buf.slice(i + 1);
                if (l.trim()) send({ t: 'line', s: l });
              }
            });
            child.stderr.on('data', (c) => {
              for (const l of c.toString().split('\n')) if (l.trim()) send({ t: 'line', s: l });
            });
            child.on('error', (e) => { send({ t: 'line', s: 'FATAL ' + e.message }); resolve(); });
            child.on('close', (code) => { if (buf.trim()) send({ t: 'line', s: buf }); send({ t: 'done', name, code }); resolve(); });
          });
        }
        res.end();
      })();
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// 单实例语义：端口被占 = 已有实例在跑。Tauri 壳的场合由其单实例插件聚焦窗口，本进程静默退出；
// node 独立运行场合（--open/开始菜单 bat）请求运行中实例重开面板窗口。
server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    if (process.env.AGENT_SYNC_TAURI !== '1') {
      try { await fetch(`http://127.0.0.1:${PORT}/api/open`); } catch { }
    }
    process.exit(0);
  }
  throw e;
});

function openPanel(url) {
  spawn('cmd', ['/c', 'start', 'msedge', `--app=${url}`], { detached: true, stdio: 'ignore', windowsHide: true })
    .on('error', () => {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    });
}

// ---------- Markdown 预览支持 ----------
const MD_EXT = /\.(md|markdown)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
// MD 阅览 exe 候选：配置优先，其次安装/构建的常见位置；都没有则回退系统关联程序
async function mdViewerExe() {
  const candidates = [
    CONFIG.mdviewer,
    'D:\\md-viewer\\MD阅览_v1.1.exe',
    'D:\\md-viewer\\src-tauri\\target\\release\\md-viewer.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if ((await fs.stat(c)).isFile()) return c; } catch { /* 下一个 */ }
  }
  return null;
}

function resolveLocalFile(raw, exts) {
  const p = decodeURIComponent(raw || '').trim();
  if (!path.isAbsolute(p) || !exts.test(p)) return null;
  return p;
}

async function readMdFile(p) {
  const stat = await fs.stat(p);
  const buf = await fs.readFile(p);
  let text = buf.toString('utf8');
  // UTF-8 解码出现替换符且原字节非空，按 GBK 兜底（与 MD 阅览行为一致）
  if (text.includes('\uFFFD')) text = buf.toString('latin1');
  return { mtime: Math.floor(stat.mtimeMs), content: text.replace(/^\uFEFF/, '') };
}

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`agent-sync 面板 → ${url}  (Ctrl+C 停止)`);
  // 打开方式：优先 Edge 应用窗口（无地址栏，似桌面应用）；失败退回默认浏览器
  if (process.argv.includes('--open') || process.env.AGENT_SYNC_AUTOOPEN === '1') openPanel(url);
});
