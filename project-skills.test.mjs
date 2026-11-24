// 类型：同步引擎回归测试
// 职责：验证项目技能登记、全局排除、备份与打包依赖
// 主要入口：node --test project-skills.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readProjectSkills, projectSkillSources, projectSkillNames } from './project-skills.mjs';

const here = import.meta.dirname;
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sync-scope-'));
  t.after(() => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('agent-sync-scope-'));
    return fs.rm(home, { recursive: true, force: true });
  });
  const dir = path.join(home, 'project');
  await fs.mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
  await fs.mkdir(path.join(dir, '.agents', 'skills', 'local-skill'), { recursive: true });
  await fs.writeFile(path.join(dir, '.agents', 'skills', 'local-skill', 'SKILL.md'), 'project source');
  const registry = { projects: [{ id: 'sample', dir, skills: ['local-skill'] }] };
  await fs.writeFile(path.join(home, '.agents', 'project-skills.json'), JSON.stringify(registry));
  await fs.writeFile(path.join(home, '.agents', 'sync.config.json'), JSON.stringify({ backupRoot: path.join(home, 'backup') }));
  return { home, dir };
}
function run(home, script, args) {
  const r = spawnSync(process.execPath, [path.join(here, script), ...args], {
    env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}

test('登记表缺省为空，登记路径仅指向项目并隔离备份目的地', async (t) => {
  const { home, dir } = await fixture(t);
  const registry = await readProjectSkills(home);
  assert.deepEqual([...projectSkillNames(registry)], ['local-skill']);
  const [item] = projectSkillSources(registry);
  assert.equal(item.src, path.join(dir, '.agents', 'skills', 'local-skill'));
  assert.equal(item.dest.replaceAll('\\', '/'), 'project-skills/sample/local-skill');
  await fs.unlink(path.join(home, '.agents', 'project-skills.json'));
  assert.deepEqual(await readProjectSkills(home), []);
});

test('非法名称、重复项目和相对项目路径拒绝执行', async (t) => {
  const { home, dir } = await fixture(t);
  for (const projects of [
    [{ id: '../escape', dir, skills: ['local-skill'] }],
    [{ id: 'sample', dir: '../relative', skills: ['local-skill'] }],
    [{ id: 'sample', dir, skills: ['../escape'] }],
    [{ id: 'sample', dir, skills: ['local-skill', 'local-skill'] }],
    [{ id: 'sample', dir, skills: [] }, { id: 'sample', dir, skills: [] }],
  ]) {
    await fs.writeFile(path.join(home, '.agents', 'project-skills.json'), JSON.stringify({ projects }));
    await assert.rejects(readProjectSkills(home));
  }
});

test('links不分发项目技能，adopt不把同名实体收编回全局，dry-run不创建目录', async (t) => {
  const { home } = await fixture(t);
  for (const [dir, name] of [['.agents', 'global-skill'], ['.agents', 'local-skill'], ['.claude', 'local-skill']]) {
    await fs.mkdir(path.join(home, dir, 'skills', name), { recursive: true });
    await fs.writeFile(path.join(home, dir, 'skills', name, 'SKILL.md'), name);
  }
  const links = JSON.parse(run(home, 'sync.mjs', ['links', '--dry-run', '--json']));
  assert.ok(links.perAgent.every((a) => a.total === 1));
  assert.ok(!links.actions.some((a) => a.type === 'create-link' && a.target === 'local-skill'));
  assert.equal(links.projectSkills[0].globalDuplicates[0], 'local-skill');
  assert.ok(links.projectSkills[0].present.includes('local-skill'));
  const adopt = JSON.parse(run(home, 'sync.mjs', ['adopt', '--dry-run', '--json']));
  assert.ok(!adopt.adoptCandidates.some((a) => a.skill === 'local-skill'));
  await assert.rejects(fs.stat(path.join(home, '.workbuddy')));
});

test('默认backup包含登记表与项目技能，dry-run不落备份，项目不可达明确报错', async (t) => {
  const { home, dir } = await fixture(t);
  run(home, 'backup-agents.mjs', ['--dry-run']);
  await assert.rejects(fs.stat(path.join(home, 'backup')));
  run(home, 'backup-agents.mjs', []);
  assert.equal(await fs.readFile(path.join(home, 'backup', 'project-skills', 'sample', 'local-skill', 'SKILL.md'), 'utf8'), 'project source');
  const source = path.join(dir, '.agents', 'skills', 'local-skill', 'SKILL.md');
  await fs.writeFile(source, 'changed source');
  await fs.utimes(source, new Date(0), new Date(0));
  run(home, 'backup-agents.mjs', []);
  assert.equal(await fs.readFile(path.join(home, 'backup', 'project-skills', 'sample', 'local-skill', 'SKILL.md'), 'utf8'), 'changed source');
  assert.ok(await fs.stat(path.join(home, 'backup', 'global-agents', 'project-skills.json')));
  await fs.rename(dir, `${dir}-offline`);
  const links = JSON.parse(run(home, 'sync.mjs', ['links', '--dry-run', '--json']));
  assert.deepEqual(links.projectSkills[0].missing, ['local-skill']);
  const failed = spawnSync(process.execPath, [path.join(here, 'backup-agents.mjs')], { env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: 'utf8', windowsHide: true });
  assert.equal(failed.status, 1);
  assert.equal(await fs.readFile(path.join(home, 'backup', 'project-skills', 'sample', 'local-skill', 'SKILL.md'), 'utf8'), 'changed source');
});

test('登记项目自动发现新实体技能、忽略全局链接；同名技能按项目分别备份', async (t) => {
  const { home, dir } = await fixture(t);
  const other = path.join(home, 'other');
  await fs.mkdir(path.join(dir, '.agents', 'skills', 'new-skill'), { recursive: true });
  await fs.writeFile(path.join(dir, '.agents', 'skills', 'new-skill', 'SKILL.md'), 'new source');
  await fs.mkdir(path.join(other, '.agents', 'skills', 'local-skill'), { recursive: true });
  await fs.writeFile(path.join(other, '.agents', 'skills', 'local-skill', 'SKILL.md'), 'other source');
  await fs.symlink(path.join(other, '.agents', 'skills', 'local-skill'), path.join(dir, '.agents', 'skills', 'global-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const registryFile = path.join(home, '.agents', 'project-skills.json');
  await fs.writeFile(registryFile, JSON.stringify({ projects: [
    { id: 'sample', dir, skills: ['local-skill'], autoDiscover: true },
    { id: 'other', dir: other, skills: ['local-skill'], autoDiscover: true },
  ] }));
  const discovered = await readProjectSkills(home);
  assert.deepEqual(discovered[0].skills, ['local-skill', 'new-skill']);
  run(home, 'backup-agents.mjs', []);
  assert.equal(await fs.readFile(path.join(home, 'backup', 'project-skills', 'other', 'local-skill', 'SKILL.md'), 'utf8'), 'other source');
  assert.equal(await fs.readFile(path.join(home, 'backup', 'project-skills', 'sample', 'local-skill', 'SKILL.md'), 'utf8'), 'project source');
  const recorded = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  assert.ok(recorded.projects[0].skills.includes('new-skill'));
  assert.ok(!recorded.projects[0].skills.includes('global-link'));
});
