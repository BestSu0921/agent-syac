// 构建前准备：把服务脚本 / 面板页 / node 运行时拷进 src-tauri（作为资源与 sidecar 打包）
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));           // tauri-app/
const BACKUP_ROOT = path.dirname(HERE);                              // D:\ai-agent-backup
const S = path.join(HERE, 'src-tauri');

await fs.copyFile(path.join(BACKUP_ROOT, 'server.mjs'), path.join(S, 'resources', 'server.mjs'));
await fs.copyFile(path.join(BACKUP_ROOT, 'sync.mjs'), path.join(S, 'resources', 'sync.mjs'));
await fs.copyFile(path.join(BACKUP_ROOT, 'backup-agents.mjs'), path.join(S, 'resources', 'backup-agents.mjs'));
await fs.copyFile(path.join(BACKUP_ROOT, 'web', 'index.html'), path.join(S, 'resources', 'web', 'index.html'));
await fs.copyFile(path.join(BACKUP_ROOT, 'web', 'mdview.html'), path.join(S, 'resources', 'web', 'mdview.html'));
await fs.copyFile(path.join(BACKUP_ROOT, 'web', 'logo.png'), path.join(S, 'resources', 'web', 'logo.png'));
console.log('[prepare] server.mjs / web 已就位（服务进程用系统 node，不再打包 sidecar）');
