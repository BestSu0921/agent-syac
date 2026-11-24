import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function put(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
}

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sync-plugin-test-'));
  t.after(() => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('agent-sync-plugin-test-'));
    return fs.rm(home, { recursive: true, force: true });
  });
  const policy = path.join(home, '.agents/rules/plugin-routing.json');
  const backup = path.join(home, 'backup');
  await put(policy, {
    superpowers: { skipSessionStartGuide: true, descriptions: { brainstorming: '需求未定时比较方案。' } },
    ponytail: { defaultMode: 'off', descriptions: { ponytail: '需要持续精简模式时使用。' } },
  });
  await put(path.join(home, '.agents/sync.config.json'), { backupRoot: backup });
  await fs.mkdir(backup, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'), PONYTAIL_DEFAULT_MODE: '' };
  function run(...args) {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'cli.mjs'), 'rules', '--json', ...args], { env, encoding: 'utf8' });
    assert.ok(r.stdout.trim(), r.stderr);
    return { ...JSON.parse(r.stdout), status: r.status };
  }
  return { home, policy, backup, run };
}

const bootstrap = { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start' };
const other = { type: 'command', command: 'echo project-started' };
const old = '\uFEFF---\r\nname: brainstorming\r\ndescription: >-\r\n  Use for everything\r\n  including small edits.\r\nlicense: MIT\r\n---\r\n\r\n# New upstream body\r\n';

test('新版本的规则同步可预演，保留正文、其他钩子与设置，第二次同步零写入', async (t) => {
  const { home, backup, run } = await fixture(t);
  const version = '10.1.0';
  const pkg = path.join(home, '.claude/plugins/cache/superpowers-marketplace/superpowers', version);
  const skill = path.join(pkg, 'skills/brainstorming/SKILL.md');
  const hook = path.join(pkg, 'hooks/hooks.json');
  await put(path.join(pkg, '.claude-plugin/plugin.json'), { name: 'superpowers', version });
  await put(skill, old);
  await put(hook, { hooks: { SessionStart: [{ matcher: 'startup', hooks: [other, bootstrap] }], Stop: [{ hooks: [other] }] } });
  await put(path.join(home, '.claude/plugins/installed_plugins.json'), {
    version: 2, plugins: { 'superpowers@superpowers-marketplace': [{ installPath: pkg, version, scope: 'user' }] },
  });
  const pony = path.join(home, '.codex/plugins/cache/ponytail/ponytail/12.0.0');
  await put(path.join(pony, '.codex-plugin/plugin.json'), { name: 'ponytail', version: '12.0.0', skills: './skills/' });
  await put(path.join(pony, 'skills/ponytail/SKILL.md'), '---\nname: ponytail\ndescription: Any code\n---\nbody\n');
  const config = path.join(home, '.config/ponytail/config.json');
  await put(config, { defaultMode: 'full', mySetting: true });
  const preview = run('--dry-run');
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.actions.length, 4);
  assert.equal(await fs.readFile(skill, 'utf8'), old);
  assert.deepEqual(await fs.readdir(backup), []);
  const applied = run('--plugins-only');
  assert.deepEqual(applied.actions, preview.actions);
  assert.equal(applied.status, 0);
  assert.equal(await fs.readFile(skill, 'utf8'), old.replace('>-\r\n  Use for everything\r\n  including small edits.', '需求未定时比较方案。'));
  assert.deepEqual(JSON.parse(await fs.readFile(hook)), { hooks: { SessionStart: [{ matcher: 'startup', hooks: [other] }], Stop: [{ hooks: [other] }] } });
  assert.deepEqual(JSON.parse(await fs.readFile(config)), { defaultMode: 'off', mySetting: true });
  const time = (await fs.stat(skill)).mtimeMs;
  assert.deepEqual(run().actions, []);
  assert.equal((await fs.stat(skill)).mtimeMs, time);
  assert.equal(await fs.readFile(applied.actions.find(a => a.target === skill).backup, 'utf8'), old);

  const upgraded = path.join(path.dirname(pkg), '11.0.0');
  await fs.cp(pkg, upgraded, { recursive: true });
  const newSkill = path.join(upgraded, 'skills/brainstorming/SKILL.md');
  await put(newSkill, old.replace('New upstream body', 'Version 11 body'));
  await put(path.join(upgraded, '.claude-plugin/plugin.json'), { name: 'superpowers', version: '11.0.0' });
  await put(path.join(home, '.claude/plugins/installed_plugins.json'), {
    version: 2, plugins: { 'superpowers@superpowers-marketplace': [{ installPath: upgraded, version: '11.0.0' }] },
  });
  await put(skill, old);
  const update = run();
  assert.equal(update.status, 0);
  assert.deepEqual(update.actions.map(a => a.target), [newSkill]);
  assert.match(await fs.readFile(newSkill, 'utf8'), /需求未定时比较方案。[^]*Version 11 body/);
  assert.equal(await fs.readFile(skill, 'utf8'), old);
});

test('未安装不创建配置；非法策略不写入；未知启动器不冒充同步成功', async (t) => {
  const { home, policy, run } = await fixture(t);
  assert.deepEqual(run('--dry-run').actions, []);
  await assert.rejects(fs.access(path.join(home, '.config/ponytail')), { code: 'ENOENT' });
  const pkg = path.join(home, '.codex/plugins/cache/superpowers-marketplace/superpowers/11.0.1');
  const manifest = path.join(pkg, '.codex-plugin/plugin.json');
  await put(manifest, { name: 'superpowers', hooks: './hooks/codex.json' });
  const skill = path.join(pkg, 'skills/brainstorming/SKILL.md');
  await put(skill, old);
  const hook = path.join(pkg, 'hooks/codex.json');
  const unknown = { type: 'command', command: 'custom-session-start --new-format' };
  await put(hook, { hooks: { SessionStart: [{ hooks: [unknown] }] } });
  const conflict = run('--plugins-only');
  assert.equal(conflict.status, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(hook)).hooks.SessionStart[0].hooks, [unknown]);
  assert.equal(await fs.readFile(skill, 'utf8'), old);
  await put(policy, { superpowers: { descriptions: { '../outside': 'x' } } });
  const before = await fs.readFile(skill);
  assert.equal(run('--plugins-only').status, 1);
  assert.deepEqual(await fs.readFile(skill), before);
});

test('Codex 升级后的 manifest 内联和独立钩子均精准校正，显式空 hooks 保留', async (t) => {
  const { home, run } = await fixture(t);
  const pkg = path.join(home, '.codex/plugins/cache/superpowers-marketplace/superpowers/20.0.0');
  const manifest = path.join(pkg, '.codex-plugin/plugin.json');
  const makeManifest = hooks => ({ name: 'superpowers', version: '20.0.0', hooks, interface: { displayName: 'New' } });
  const startup = { SessionStart: [{ hooks: [bootstrap] }] };
  await put(manifest, makeManifest([startup, './hooks/codex.json']));
  const hook = path.join(pkg, 'hooks/codex.json');
  await put(hook, { hooks: { ...startup, Stop: [{ hooks: [other] }] } });
  await put(path.join(pkg, 'skills/brainstorming/SKILL.md'), old);
  const unused = path.join(pkg, 'hooks/hooks.json');
  await put(unused, { hooks: startup });
  const dormant = await fs.readFile(unused);
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(manifest)), makeManifest([{}, './hooks/codex.json']));
  assert.deepEqual(JSON.parse(await fs.readFile(hook)), { hooks: { Stop: [{ hooks: [other] }] } });
  assert.deepEqual(await fs.readFile(unused), dormant);
  await put(manifest, makeManifest({}));
  assert.deepEqual(run('--dry-run').actions, []);
});

test('共享与项目技能升级后恢复按需描述、正文约定与发现开关；保留版本差异和换行', async (t) => {
  const { home, backup, run } = await fixture(t);
  const global = path.join(home, '.agents/skills/vue-best-practices');
  const project = path.join(home, 'club/.claude/skills/vue-best-practices');
  const nested = path.join(home, '.agents/skills/taste-skill/taste-skill');
  const scope = 'Consult the reference for the affected topic.';
  const guide = 'Read all four references on every task.';
  const source = '---\r\nname: vue-best-practices\r\ndescription: >\r\n  Any Vue edit\r\ndisable-model-invocation: true\r\n---\r\n\r\n' + guide + '\r\n';
  await put(path.join(global, 'SKILL.md'), '\uFEFF' + source + 'Global v2\r\n');
  await put(path.join(project, 'SKILL.md'), source + 'Club rules v9\r\n');
  await put(path.join(nested, 'SKILL.md'), '---\nname: design-taste-frontend\ndescription: Any page\n---\nNew examples\n');
  const yaml = 'interface:\n  display_name: New\npolicy:\n  allow_implicit_invocation: false # retain\n';
  await put(path.join(global, 'agents/openai.yaml'), yaml);
  const routes = [
    { name: 'vue-best-practices', description: '有响应式问题时参考。', scope, locations: ['~/.agents/skills/vue-best-practices'], replaceLines: { [guide]: scope } },
    { name: 'vue-best-practices', description: '俱乐部组件的数据流排错。', scope, locations: [project], replaceLines: { [guide]: scope } },
    { name: 'design-taste-frontend', description: '需要比较参考站的构图时使用。', scope: '按简报参考。', locations: [nested] },
  ];
  await put(path.join(home, '.agents/rules/skill-routing.json'), routes);
  const preview = run('--routing-only', '--dry-run');
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.actions.length, 4);
  assert.deepEqual(await fs.readdir(backup), []);
  assert.deepEqual(run('--plugins-only', '--dry-run').actions, []);
  assert.deepEqual(run().actions, preview.actions);
  for (const [index, dir] of [global, project].entries()) {
    const actual = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
    assert.ok(actual.includes(routes[index].description));
    assert.ok(actual.includes(index ? 'Club rules v9' : 'Global v2'));
    assert.equal(actual.includes(guide), false);
    assert.equal(actual.split(scope).length, 2);
    assert.match(actual, /disable-model-invocation: false\r\n/);
    assert.equal(actual.replaceAll('\r\n', '').includes('\n'), false);
    assert.equal(actual.startsWith('\uFEFF'), index === 0);
  }
  assert.equal(await fs.readFile(path.join(global, 'agents/openai.yaml'), 'utf8'), yaml.replace('false', 'true'));
  assert.match(await fs.readFile(path.join(nested, 'SKILL.md'), 'utf8'), /按简报参考。[\s\S]*New examples/);
  await assert.rejects(fs.access(path.join(project, 'agents/openai.yaml')), { code: 'ENOENT' });
  assert.deepEqual(run('--routing-only').actions, []);
});

test('frontend-design 的 Codex 兼容包和 Claude 登记版本复用同一约定，保留客户端启用设置', async (t) => {
  const { home, run } = await fixture(t);
  const shared = path.join(home, '.agents/skills/frontend-design');
  const rel = 'plugins/cache/claude-plugins-official/frontend-design/new-version';
  const claude = path.join(home, '.claude', rel);
  const codex = path.join(home, '.codex', rel);
  const route = { name: 'frontend-design', plugin: 'frontend-design', description: '品牌视觉需要辨识度时参考。', scope: '仅按本次品牌需求选用相关章节。', locations: [shared] };
  const old = '---\nname: frontend-design\ndescription: All pages\n---\nNew version assets\n';
  await put(path.join(home, '.agents/rules/skill-routing.json'), [route]);
  await put(path.join(shared, 'SKILL.md'), old);
  for (const pkg of [claude, codex]) {
    await put(path.join(pkg, '.claude-plugin/plugin.json'), { name: 'frontend-design' });
    await put(path.join(pkg, 'skills/frontend-design/SKILL.md'), old);
  }
  await put(path.join(home, '.claude/plugins/installed_plugins.json'), {
    plugins: { 'frontend-design@claude-plugins-official': [{ installPath: claude }] },
  });
  const claudeConfig = path.join(home, '.claude/settings.json');
  const codexConfig = path.join(home, '.codex/config.toml');
  await put(claudeConfig, '{"enabledPlugins":{"frontend-design@claude-plugins-official":false}}');
  await put(codexConfig, '[plugins."frontend-design@claude-plugins-official"]\nenabled = false\n');
  const before = await Promise.all([fs.readFile(claudeConfig), fs.readFile(codexConfig)]);
  assert.equal(run('--plugins-only', '--dry-run').actions.length, 2);
  const result = run('--routing-only');
  assert.deepEqual(result.errors, []);
  assert.equal(result.actions.length, 3);
  assert.deepEqual(await Promise.all([fs.readFile(claudeConfig), fs.readFile(codexConfig)]), before);
  assert.deepEqual(run('--dry-run').actions, []);
});

test('映射链接去重，陌生目标、缺失入口及未知策略格式均保留现场', async (t) => {
  const { home, run } = await fixture(t);
  const shared = path.join(home, '.agents/skills/oil-ui');
  const project = path.join(home, 'sample/.claude/skills');
  const alias = path.join(project, 'oil-ui');
  const external = path.join(home, 'outside');
  const yaml = path.join(shared, 'agents/openai.yaml');
  const old = '---\nname: oil-ui\ndescription: Always\n---\n\n```text\nRead everything\n```\n';
  await put(path.join(shared, 'SKILL.md'), old);
  await put(path.join(external, 'SKILL.md'), old);
  await put(yaml, '\uFEFFpolicy: { allow_implicit_invocation: false } # note\n');
  await fs.mkdir(project, { recursive: true });
  const dirLink = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(shared, alias, dirLink);
  const policy = path.join(home, '.agents/rules/skill-routing.json');
  const route = { name: 'oil-ui', description: '比较界面方向时参考。', scope: '按需参考。', locations: [alias, shared], replaceLines: { 'Read everything': null } };
  await put(policy, [route]);
  const result = run('--routing-only');
  assert.deepEqual(result.errors, []);
  assert.equal(result.actions.length, 2);
  assert.match(await fs.readFile(yaml, 'utf8'), /^\uFEFFpolicy: \{ allow_implicit_invocation: true \} # note/);
  assert.ok((await fs.lstat(alias)).isSymbolicLink());
  assert.match(await fs.readFile(path.join(alias, 'SKILL.md'), 'utf8'), /```text\nRead everything\n```/);
  await fs.symlink(external, path.join(project, 'foreign'), dirLink);
  await put(policy, [{ ...route, locations: [path.join(project, 'foreign'), path.join(project, 'absent')] }]);
  const bad = run('--routing-only');
  assert.equal(bad.status, 1);
  assert.equal(bad.errors.length, 2);
  assert.equal(await fs.readFile(path.join(external, 'SKILL.md'), 'utf8'), old);
  await assert.rejects(fs.access(path.join(project, 'absent')), { code: 'ENOENT' });
  await put(policy, [route]);
  await put(path.join(shared, 'SKILL.md'), old);
  await put(yaml, 'policy: *external_alias\n');
  assert.equal(run().status, 1);
  assert.equal(await fs.readFile(path.join(shared, 'SKILL.md'), 'utf8'), old);
});
