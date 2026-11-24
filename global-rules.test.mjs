import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const clients = ['.codex/AGENTS.md', '.claude/CLAUDE.md', '.workbuddy/SOUL.md',
  '.zcode/AGENTS.md', '.config/opencode/AGENTS.md', '.dsh/AGENTS.md', '.trae-cn/user_rules.md'];

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sync-global-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('agent-sync-global-'));
    await fs.rm(dir, { recursive:true, force:true });
  });
  async function put(name, body) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive:true });
    await fs.writeFile(file, body);
  }
  const read = name => fs.readFile(path.join(dir, name), 'utf8');
  for (const client of clients) await put(client, '客户端自己的约定  \r\n');
  await put('.agents/sync.config.json', JSON.stringify({backupRoot:path.join(dir,'backup')}));
  await fs.mkdir(path.join(dir, 'backup'));
  const env = {...process.env, USERPROFILE:dir, HOME:dir};
  function run(cmd='rules', ...args) {
    const r = spawnSync(process.execPath, [cli, cmd, '--json', ...args], {env, cwd:dir, encoding:'utf8'});
    assert.ok(r.stdout.trim(), r.stderr);
    return JSON.parse(r.stdout);
  }
  const runAsync = async cmd => {
    const {stdout} = await promisify(execFile)(process.execPath, [cli, cmd, '--json'], {env, cwd:dir});
    return JSON.parse(stdout);
  };
  return {put, read, run, runAsync};
}

test('增加和修改全局规则只改自己的块，保留手写、其他规则和记忆', async t => {
  const {put,read,run} = await fixture(t);
  const rule = (text) => '<!-- sync-targets: @global -->\r\n\r\n---\r\n\r\n' + text + '\r\n';
  await put('.agents/rules/shared.md', rule('用户定稿'));
  assert.deepEqual(run('rules','--dry-run').errors, []);
  assert.equal(await read(clients[0]), '客户端自己的约定  \r\n');
  assert.equal(run().actions.length, clients.length);
  await put('.agents/memory/user.md', rule('项目简称'));
  assert.equal(run('memory').actions.length, clients.length);
  await put('.agents/rules/future.v2.md', rule('新规则 $&'));
  assert.equal(run().actions.length, clients.length);
  await put('.agents/rules/future.v2.md', rule('第二版 $& / $1'));
  assert.equal(run().actions.length, clients.length);
  for (const client of clients) {
    const text = await read(client);
    assert.ok(text.startsWith('客户端自己的约定  \r\n'));
    assert.ok(text.includes('用户定稿') && text.includes('项目简称') && text.includes('第二版 $& / $1'));
    assert.equal(text.split('synced-rule:future.v2 start').length, 2);
    assert.ok(!text.includes('sync-targets:'));
  }
  assert.deepEqual(run('rules','--dry-run').actions, []);
  assert.deepEqual(run('memory','--dry-run').actions, []);
});

test('按需正文只清理本规则的完整旧块，保留客户端手改和其他显式目标', async t => {
  const {put,read,run} = await fixture(t);
  const source = '.agents/rules/guide.md';
  await put(source, '<!-- sync-targets: @global -->\n---\n按需正文');
  assert.equal(run().actions.length, clients.length);
  await put(clients[1], (await read(clients[1])).replace('按需正文','手动改的正文'));
  await put('.other/AGENTS.md', '其他入口\n');
  await put(source, '<!-- reference-targets: @global -->\n<!-- sync-targets: ~/.other/AGENTS.md -->\n---\n按需正文');
  const preview = run('rules','--dry-run');
  assert.equal(preview.actions.filter(x=>x.type==='rules-remove').length, clients.length-1);
  assert.equal(preview.errors.length, 1);
  assert.ok((await read(clients[0])).includes('按需正文'));
  assert.equal(run().errors.length, 1);
  assert.ok(!(await read(clients[0])).includes('synced-rule:guide'));
  assert.ok((await read(clients[1])).includes('手动改的正文'));
  assert.ok((await read('.other/AGENTS.md')).includes('按需正文'));
  assert.deepEqual(run('rules','--dry-run').actions, []);
});

test('旧标记残缺时保留整个文件，不吞后来的块和手写内容', async t => {
  const {put,read,run} = await fixture(t);
  const original = '<!-- synced-rule:old start -->\n旧文\n\n手写内容\n';
  await put(clients[0], original);
  await put('.agents/rules/new.md', '<!-- sync-targets: ~/.codex/AGENTS.md -->\n---\n新增');
  const result = run();
  assert.equal(result.errors.length, 1);
  assert.equal(await read(clients[0]), original);
});

test('规则与记忆同时同步也保留双方的块', async t => {
  const {put,read,runAsync} = await fixture(t);
  await put('.agents/rules/shared.md', '<!-- sync-targets: @global -->\n---\n协作约定');
  await put('.agents/memory/user.md', '<!-- sync-targets: @global -->\n---\n我的简称');
  const results = await Promise.all([runAsync('rules'),runAsync('memory')]);
  for (const result of results) assert.deepEqual(result.errors, []);
  for (const client of clients) {
    const text = await read(client);
    assert.ok(text.includes('协作约定') && text.includes('我的简称'));
  }
});
