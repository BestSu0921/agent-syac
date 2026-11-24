// 类型：项目技能登记读取模块
// 职责：验证项目归属并生成非自动加载的备份路径
// 主要入口：readProjectSkills、projectSkillNames、projectSkillSources
import fs from 'node:fs/promises';
import path from 'node:path';

export async function readProjectSkills(home) {
  let raw;
  try { raw = await fs.readFile(path.join(home, '.agents', 'project-skills.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const registry = JSON.parse(raw);
  if (!Array.isArray(registry.projects)) throw new Error('project-skills.json: projects必须是数组');
  const ids = new Set();
  const safeName = (name) => typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
  for (const project of registry.projects) {
    if (!project || !safeName(project.id) || ids.has(project.id) || typeof project.dir !== 'string' || !path.isAbsolute(project.dir) || !Array.isArray(project.skills) || project.skills.some((name) => !safeName(name)) || new Set(project.skills).size !== project.skills.length) {
      throw new Error('project-skills.json: 项目id、绝对路径或技能名无效/重复');
    }
    ids.add(project.id);
    if (project.autoDiscover === true) {
      let entries;
      try { entries = await fs.readdir(path.join(project.dir, '.agents', 'skills'), { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const found = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const hasSkill = await fs.stat(path.join(project.dir, '.agents', 'skills', entry.name, 'SKILL.md')).then((s) => s.isFile()).catch(() => false);
        if (!hasSkill) continue;
        if (!safeName(entry.name)) throw new Error(`project-skills.json: 无效技能目录 ${entry.name}`);
        found.push(entry.name);
      }
      // 保留已登记但丢失的名字，供巡检报告，避免离线/误删静默清空记录。
      project.skills = [...new Set([...project.skills, ...found])].sort();
    }
  }
  return registry.projects;
}

export async function recordProjectSkills(home, projects) {
  const file = path.join(home, '.agents', 'project-skills.json');
  if (!projects.length) return;
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  if (JSON.stringify(original.projects) === JSON.stringify(projects)) return;
  await fs.writeFile(file, JSON.stringify({ ...original, projects }, null, 2) + '\n', 'utf8');
}

export function projectSkillNames(projects) {
  return new Set(projects.flatMap((project) => project.skills));
}

export function projectSkillSources(projects) {
  return projects.flatMap((project) => project.skills.map((skill) => ({
    name: `project-${project.id}-${skill}`, type: 'dir',
    src: path.join(project.dir, '.agents', 'skills', skill),
    dest: path.join('project-skills', project.id, skill), ignore: ['node_modules', '.git'], compareContent: true,
  })));
}
