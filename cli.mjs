#!/usr/bin/env node
/**
 * agent-sync 命令行入口（npx / 全局安装用）
 * ---------------------------------------------------------------
 *   agent-sync            一致性巡检（同 check）
 *   agent-sync init       首次引导：探测 agent + 写配置
 *   agent-sync panel      启动面板服务（--open 同时打开浏览器）
 *   agent-sync links|rules|memory|adopt|backup [--dry-run] [--yes]
 *                         其余参数原样透传给引擎
 */

import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.join(HERE, 'sync.mjs');
const BACKUP = path.join(HERE, 'backup-agents.mjs');

const [, , cmd, ...rest] = process.argv;

async function runEngine(args) {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}

async function cmdInit() {
  console.log('agent-sync 初始化\n-----------------');
  // 1. 探测本机 agent（目录存在即视为已装）
  const detect = [
    ['claude-code', path.join(HOME, '.claude')],
    ['workbuddy', path.join(HOME, '.workbuddy')],
    ['zcode', path.join(HOME, '.zcode')],
    ['trae（项目级，无需全局目录）', path.join(HOME, 'AppData', 'Roaming', 'Trae CN')],
  ];
  for (const [name, p] of detect) {
    const ok = await fs.stat(p).then(() => true).catch(() => false);
    console.log(`  ${ok ? '✓' : '·'} ${name}  ${p.replace(HOME, '~')}`);
  }
  // 2. 问备份根目录
  const configFile = path.join(HOME, '.agents', 'sync.config.json');
  const existing = await fs.readFile(configFile, 'utf8').then(JSON.parse).catch(() => null);
  if (existing) {
    const rl0 = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\n已有配置：${configFile}`);
    console.log(JSON.stringify(existing, null, 2));
    const keep = await rl0.question('覆盖它吗？[y/N] ');
    rl0.close();
    if (keep.trim().toLowerCase() !== 'y') { console.log('已取消，现有配置保持不变。'); return; }
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const defRoot = existing?.backupRoot || path.join(HOME, 'agent-sync-backup');
  const answer = (await rl.question(`\n备份保存到哪个目录？（回车 = ${defRoot}）`)).trim();
  rl.close();
  const backupRoot = answer || defRoot;
  // 3. 写配置
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, JSON.stringify({ backupRoot, port: existing?.port || 7717 }, null, 2) + '\n', 'utf8');
  await fs.mkdir(backupRoot, { recursive: true });
  console.log(`\n✓ 配置已写入 ${configFile}`);
  console.log(`✓ 备份根 ${backupRoot}`);
  console.log('\n下一步：');
  console.log('  agent-sync check            # 巡检状态');
  console.log('  agent-sync links            # 建立技能映射');
  console.log('  agent-sync rules            # 注入规则块');
  console.log('  agent-sync memory           # 下发记忆层');
  console.log('  agent-sync backup           # 手动备份一次');
  console.log('  agent-sync panel --open     # 打开可视化面板');
}

(async () => {
  switch (cmd || 'check') {
    case 'init': return cmdInit();
    case 'panel': {
      const { spawn } = await import('node:child_process');
      const args = [path.join(HERE, 'server.mjs'), ...(rest.includes('--open') ? ['--open'] : [])];
      const child = spawn(process.execPath, args, { stdio: 'inherit' });
      process.exitCode = child.status ?? 0;
      return;
    }
    case 'check': return runEngine([SYNC, 'check', ...rest]);
    case 'links': case 'rules': case 'memory': case 'mcp': case 'adopt': return runEngine([SYNC, cmd, ...rest]);
    case 'backup': return runEngine([BACKUP, ...rest]);
    case '--help': case '-h': default:
      if (cmd && !['--help', '-h'].includes(cmd)) console.error(`未知命令: ${cmd}\n`);
      console.log('agent-sync — AI agent 技能/规则/记忆 单源同步\n');
      console.log('  agent-sync              巡检一致性');
      console.log('  agent-sync init         首次引导');
      console.log('  agent-sync panel        打开可视化面板');
      console.log('  agent-sync links        技能映射（含 trae 项目级）');
      console.log('  agent-sync rules        规则块注入');
      console.log('  agent-sync memory       记忆层下发');
      console.log('  agent-sync mcp          项目 MCP 配置下发');
      console.log('  agent-sync adopt        收编新装技能');
      console.log('  agent-sync backup       备份到备份根');
      console.log('\n通用: --dry-run 预演 · --yes 跳过确认 · --json 结构化输出');
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
