#!/usr/bin/env node
/**
 * md-open —— MCP 工具：用 MD 阅览打开 / 预览 Markdown 文档
 * 零依赖 stdio MCP（换行分隔 JSON-RPC），注册到各 agent 后即可"打开 xxx.md"。
 * 工具：
 *   open_md(path)     拉起 MD 阅览独立窗口（优先面板接口，面板未跑则直接 spawn exe）
 *   preview_md(path)  返回 agent-sync 面板内嵌预览 URL（浏览器/面板内看，自动刷新）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PANEL = 'http://127.0.0.1:7717';
const EXE_CANDIDATES = [
  'D:\\md-viewer\\MD阅览_v1.1.exe',
  'D:\\md-viewer\\src-tauri\\target\\release\\md-viewer.exe',
];

function get(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  });
}

function isMd(p) {
  return typeof p === 'string' && path.isAbsolute(p.trim()) && /\.(md|markdown)$/i.test(p.trim());
}

async function openMd(raw) {
  const p = String(raw || '').trim();
  if (!isMd(p)) return { ok: false, message: '需要 .md/.markdown 绝对路径' };
  const r = await get(`${PANEL}/api/openmd?path=${encodeURIComponent(p)}`);
  if (r.status === 200) return { ok: true, via: 'agent-sync 面板', message: '已用 MD 阅览打开：' + p };
  // 面板未跑：直接找 exe 拉起
  for (const exe of EXE_CANDIDATES) {
    try {
      if (fs.statSync(exe).isFile()) {
        spawn(exe, [p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return { ok: true, via: path.basename(exe), message: '已用 MD 阅览打开：' + p };
      }
    } catch { /* 下一个候选 */ }
  }
  spawn('cmd', ['/c', 'start', '', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return { ok: true, via: 'system', message: 'MD 阅览未找到，已用系统关联程序打开：' + p };
}

function previewMd(raw) {
  const p = String(raw || '').trim();
  if (!isMd(p)) return { ok: false, message: '需要 .md/.markdown 绝对路径' };
  const url = `${PANEL}/mdview?path=${encodeURIComponent(p)}`;
  return {
    ok: true,
    url,
    message: `内嵌预览地址（浏览器打开，2 秒自动刷新）：\n${url}\n独立窗口请改用 open_md 工具。`,
  };
}

const TOOLS = [
  {
    name: 'open_md',
    description: '用 MD 阅览（本地 Markdown 桌面应用）打开一个 .md 文件的独立窗口。当用户要求"打开/看一下某个 md 文档"时调用。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文档绝对路径，如 D:\\sqs\\aiCode\\btw-admin\\docs\\product\\PRD.md' } },
      required: ['path'],
    },
  },
  {
    name: 'preview_md',
    description: '返回一个 Markdown 文档的内嵌预览 URL（agent-sync 面板，自动刷新）。适合给用户一个链接快速扫一眼；正式阅读用 open_md。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文档绝对路径' } },
      required: ['path'],
    },
  },
];

async function callTool(name, args) {
  let result;
  if (name === 'open_md') result = await openMd(args?.path);
  else if (name === 'preview_md') result = previewMd(args?.path);
  else result = { ok: false, message: '未知工具：' + name };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line).catch(() => {});
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method } = msg;
  if (method === 'initialize') {
    send(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'md-open', version: '1.0.0' } });
  } else if (method === 'tools/list') {
    send(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    send(id, await callTool(msg.params?.name, msg.params?.arguments));
  } else if (method === 'ping') {
    send(id, {});
  }
}

function send(id, result) {
  if (id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
