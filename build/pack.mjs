#!/usr/bin/env node
/**
 * agent-sync 发布打包：把「纯工具文件」拷进 dist/agent-sync/（不含任何个人数据）
 * ---------------------------------------------------------------
 * 产物可直接：zip 发人 / 推到开源仓库 / npm publish（需先定 LICENSE）
 * 用法：node build/pack.mjs   （打包后自动用 dist 独立跑一次 check 验证）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DIST = path.join(ROOT, 'dist', 'agent-sync');

const FILES = [
  'cli.mjs',
  'sync.mjs',
  'server.mjs',
  'backup-agents.mjs',
  'package.json',
  'web/index.html',
  'README.md',
];

// dist 已是 git 仓库：绝不整目录删除（保 .git），只覆盖工具文件并清掉运行产物
await fs.mkdir(DIST, { recursive: true });
for (const f of FILES) {
  const src = path.join(ROOT, f);
  const dest = path.join(DIST, f);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}
// 运行产物（sync.mjs 落日志的兜底位置）不入库
for (const junk of ['sync-log.txt', 'MANIFEST.md']) {
  await fs.rm(path.join(DIST, junk), { force: true });
}
await fs.writeFile(path.join(DIST, '.gitignore'), 'sync-log.txt\nMANIFEST.md\nbackups/\n');
console.log(`[pack] 已拷贝 ${FILES.length} 个文件 → ${DIST}`);

// 独立运行验证（check 是只读的）
const r = spawnSync(process.execPath, [path.join(DIST, 'cli.mjs'), 'check'], { encoding: 'utf8' });
const pass = r.stdout.includes('全部一致') || r.stdout.includes('待处理');
console.log(`[pack] dist 独立运行验证：${pass ? '✓ 通过' : '✗ 失败'}\n---\n${r.stdout.trim().split('\n').slice(-4).join('\n')}`);
process.exit(pass ? 0 : 1);
