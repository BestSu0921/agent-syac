#!/usr/bin/env node
/**
 * agent-sync exe 构建脚本（Node SEA 单文件封装）
 * ---------------------------------------------------------------
 * 产物：build/agent-sync.exe（双击 = 启动面板并自动打开浏览器）
 * 依赖：本机 node（≥22，含 sea/postject 能力）；postject 首次经 npx 拉取（需网络）
 * 用法：node build/build-exe.mjs
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const EXE = path.join(HERE, 'agent-sync.exe');

const log = (m) => console.log('[build] ' + m);

// 1. sea-config（资产：引擎 + 面板页）
const seaConfig = {
  main: 'sea-bootstrap.cjs',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useAssets: true,
  assets: {
    'server.mjs': '../server.mjs',
    'sync.mjs': '../sync.mjs',
    'backup-agents.mjs': '../backup-agents.mjs',
    'web/index.html': '../web/index.html',
  },
};
await fs.writeFile(path.join(HERE, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));

// 2. 生成注入 blob
log('生成 SEA blob…');
execSync('node --experimental-sea-config sea-config.json', { cwd: HERE, stdio: 'inherit' });

// 3. 复制 node.exe 为产物（exe 被占用 = 面板可能正在运行）
log('复制 node 运行时…');
try {
  await fs.copyFile(process.execPath, EXE);
} catch (e) {
  console.error('[build] 复制失败：' + e.message);
  console.error('[build] 若 agent-sync.exe 正在运行（面板开着），请先退出再构建。');
  process.exit(1);
}

// 4. 注入 blob（postject 首次运行需联网拉包）
log('注入 blob（postject，首次需联网）…');
try {
  execSync('npx --yes postject agent-sync.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    { cwd: HERE, stdio: 'inherit', timeout: 180000 });
} catch (e) {
  console.error('\n[build] postject 注入失败（多半是离线）。手动执行：');
  console.error('  cd ' + HERE);
  console.error('  npx --yes postject agent-sync.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
  process.exit(1);
}

const mb = (fsSync.statSync(EXE).size / 1024 / 1024).toFixed(1);
log(`完成 → ${EXE}（${mb} MB）。双击即可启动面板。`);

// 5. 冒烟测试：换端口起 exe，探 /api/status
log('冒烟测试（端口 7718）…');
const child = spawn(EXE, [], {
  env: { ...process.env, AGENT_SYNC_PORT: '7718', AGENT_SYNC_AUTOOPEN: '0' },
  stdio: 'ignore',
});
const ok = await new Promise((resolve) => {
  let tries = 0;
  const t = setInterval(async () => {
    tries++;
    try {
      const r = await fetch('http://127.0.0.1:7718/api/status');
      if (r.ok) { clearInterval(t); resolve(true); }
    } catch { if (tries > 20) { clearInterval(t); resolve(false); } }
  }, 500);
});
child.kill();
log(ok ? '✓ exe 冒烟测试通过' : '✗ exe 未能响应（查看上方日志排查）');
process.exit(ok ? 0 : 1);
