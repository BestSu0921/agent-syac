'use strict';
/* agent-sync exe 启动器（Node SEA）
 * 两种模式：
 *   1) 面板模式（双击/无参数）：解包内嵌资产到临时目录 → AGENT_SYNC_HOME 指过去 → 启动 server
 *   2) 引擎模式（exe 被以 [某.mjs 参数] 调起，即面板服务用 exe 自己派生子命令）：
 *      直接 import 该脚本，不做面板启动——避免进程无限递归
 */
const { getAsset } = require('node:sea');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ASSETS = ['server.mjs', 'sync.mjs', 'backup-agents.mjs', 'web/index.html'];

const arg1 = process.argv[1] || '';
if (arg1.endsWith('.mjs') && fs.existsSync(arg1)) {
  process.env.AGENT_SYNC_HOME = path.dirname(arg1);
  import(pathToFileURL(arg1).href);
  return;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sync-'));
for (const name of ASSETS) {
  const dest = path.join(tmp, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(getAsset(name)));
}
process.env.AGENT_SYNC_HOME = tmp;
// 双击打开即自动弹面板（构建冒烟测试会显式置 0 关掉）
if (process.env.AGENT_SYNC_AUTOOPEN !== '0') process.env.AGENT_SYNC_AUTOOPEN = '1';
import(pathToFileURL(path.join(tmp, 'server.mjs')).href);
