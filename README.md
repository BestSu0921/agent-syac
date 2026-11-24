# agent-sync

**AI agent 的技能 / 规则 / 记忆「一处维护，处处生效」。**

全局通用技能、规则块、共享记忆维护在 `~/.agents/`，用链接或标记块分发；项目专属技能只维护在各项目 `.agents/skills/`，随项目共享，不分发到全局发现目录。两类技能均按其唯一源备份。

```
~/.agents/                    ← 唯一源（skills · rules · memory）
     │ junction 映射                     │ 块注入
     ▼                                  ▼
claude · workbuddy · zcode(原生直读) · trae(项目级 .trae/skills)
     │
     ▼  定时/手动镜像备份
backupRoot（配置任意盘符目录）
```

## 支持的 agent

| agent | 技能 | 规则块 | 说明 |
|---|---|---|---|
| Claude Code | ✓ junction | ✓ 标记块注入 | `~/.claude` |
| WorkBuddy | ✓ junction | ✓ | `~/.workbuddy` |
| ZCode | 原生直读源 | ✓ | 无需映射 |
| Trae | ✓ 项目级（`.trae/skills`） | — | Trae 技能为项目级，按项目清单映射 |

Skill 目录采用 Anthropic `SKILL.md` 格式（Trae 等多家兼容）；规则/记忆用标记块幂等注入（`<!-- synced-rule:名 start … end -->`），重复运行零副作用。

## 快速开始

```bash
# 方式一：npx（需 node ≥ 20）
npx agent-sync init        # 引导：探测 agent + 写配置
npx agent-sync check       # 一致性巡检

# 方式二：单文件 exe（免装 node）
# 下载 agent-sync.exe，双击即启动可视化面板
```

## 命令

| 命令 | 作用 |
|---|---|
| `agent-sync` / `check` | 巡检一致性（只读） |
| `agent-sync init` | 首次引导：探测 agent、写 `~/.agents/sync.config.json` |
| `agent-sync panel [--open]` | 启动本地面板（127.0.0.1，默认端口 7717） |
| `agent-sync links` | 技能映射：源 → 各 agent 目录 + 各 trae 项目 |
| `agent-sync rules` | 同步共享规则块及全局、项目和插件的技能调用规则，支持预演和写前备份 |
| `agent-sync memory` | 记忆层下发（`~/.agents/memory/` → 各 agent） |
| `agent-sync adopt` | 收编：agent 目录里的新装技能 → 移入源 + 补链接 |
| `agent-sync backup` | 增量镜像备份到备份根（`--mirror` 严格清理慎用） |

通用开关：`--dry-run` 预演 · `--yes` 跳过确认 · `--json` 结构化输出（面板数据源）。

## 配置

全局协作约定和专项索引在 `~/.agents/rules/global-collaboration.md`。新增一条独立的全局约定时，在 `~/.agents/rules/<名称>.md` 的说明区写 `<!-- sync-targets: @global -->`，空一行写 `---`，下面写正文。`agent-sync rules` 会合并到已存在的全局入口，只更新同名标记块。`agent-sync rules --dry-run --json` 可查看涉及的文件。

只供按需查阅的正文用 `<!-- reference-targets: @global -->`，其他独立目标仍可用 `sync-targets` 指定。同步会清掉与源一致的旧全文块，遇到手改、重复或不完整的标记会保留现场并报告。共享记忆也可在说明区指定 `sync-targets`，由 `agent-sync memory` 单独下发。

插件触发策略由 `~/.agents/rules/plugin-routing.json` 管理。按插件名在 `descriptions` 中登记技能名与单行描述；Superpowers 的 `skipSessionStartGuide` 控制开场引导，Ponytail 的 `defaultMode` 可设为 `off`。缺少策略文件时跳过插件校正。

Vue 和 UI 的调用约定在 `~/.agents/rules/skill-routing.json`。每项指定技能名、描述、适用范围和登记目录。项目有自己的触发约定时单独登记。已知的旧正文指令用 `replaceLines` 按整行校正。新增项目副本时登记实际技能目录，共享源的映射链接随源生效。

面板同步规则或同步全部时自动应用两份策略。Claude 按安装登记定位版本，Codex 检查指定插件缓存中的版本目录。预演全部技能调用规则用 `agent-sync rules --routing-only --dry-run`；只看插件用 `--plugins-only`。异常入口与写前备份路径见同步日志。

项目技能在 `~/.agents/project-skills.json` 登记，例如：

```json
{"projects":[{"id":"my-project","dir":"D:/work/my-project","autoDiscover":true,"skills":[]}]}
```

- 项目id和技能名使用小写字母、数字及单短横，项目目录为绝对路径；不在登记表放技能正文。登记表缺省为空，格式错误停止执行。
- `autoDiscover:true`自动发现已登记项目里的普通技能目录，忽略映射链接；正式backup将新增技能清单记回登记表。历史已登记但消失的入口仍报告缺失，不自动删除记录或备份；新项目路径需先登记，不全盘猜测归属。
- 同名项目技能按项目id独立存储和备份，不按名称合并；确认具有共同合同和维护责任后才人工提升为全局公共技能。
- `check`/`links --dry-run`检查登记的技能入口、全局同名副本和各agent残留；`links`不分发登记技能，`adopt`不收编它们。冲突只报告，不自动移动或删除。
- `backup`按登记从项目源备份到 `<backupRoot>/project-skills/<项目id>/<技能名>/`，登记表备份到 `global-agents/project-skills.json`；不把备份链接回发现目录，不自动恢复。项目不可达记错误，保留已有备份。
- 新项目直接追加登记即可。`run-backup.ps1`、`sync.bat` 先同步全局规则、技能调用策略和共享记忆，再巡检和备份。
- 回归：`node --test project-skills.test.mjs`。源码更新不代表已发布exe更新，桌面包需重新构建后生效。

`~/.agents/sync.config.json`：

```jsonc
{
  "backupRoot": "~/agent-sync-backup",   // 备份/日志根目录
  "port": 7717                            // 面板端口
}
```

- 技能源：`~/.agents/skills/`、规则源：`~/.agents/rules/`、记忆源：`~/.agents/memory/`
- trae 项目清单：编辑 `sync.mjs` 顶部 `PROJECTS` 数组（项目级接入）
- 定时备份：系统调度里注册 `agent-sync backup`（Windows 可用 schtasks，README 不代管调度）

## 可视化面板

`agent-sync panel --open` 或双击 exe：状态仪表（拓扑图 + agent 卡片 + 30 天心跳）、操作台（预演 → 确认两步落盘）、中文维护日志。暗/浅主题（View Transitions 圆形切换）。只监听 127.0.0.1，无鉴权，数据不出本机。

## Markdown 预览与打开（配合 MD 阅览）

面板服务内置一套 Markdown 阅读接口，配合 [MD 阅览](https://github.com/BestSu0921/md-viewer)（本地 Markdown 桌面应用）使用：

| 入口 | 用法 |
|---|---|
| 内嵌预览 | 浏览器打开 `/mdview?path=D:\xxx\文档.md`——完整 GFM 渲染，2 秒轮询自动刷新（Agent 边写你看） |
| 独立窗口 | `/api/openmd?path=…` 拉起 MD 阅览；自动探测本地 exe（也可在 `sync.config.json` 配 `mdviewer` 字段指定路径），回退系统关联程序 |
| 读内容 | `/api/md?path=` 返回内容 + mtime（UTF-8 / GBK 兜底）；`/api/mdstat` 轻量轮询；`/api/mdasset` 解析文档内相对图片 |

配套 MCP 工具 `md-open`（`mcp/md-open.mjs`，零依赖单文件）：提供 `open_md`（弹出独立窗口）与 `preview_md`（返回预览链接）两个工具，模板在 `~/.agents/mcp/md-open.json`，注册后各 Agent 对话式打开文档。

## 从源码构建桌面应用（Tauri）

```bash
cd tauri-app
npm install            # @tauri-apps/cli（预编译，快）
npx tauri build        # 需 Rust 工具链（rustup + MSVC）；产物在 src-tauri/target/release/
```

桌面壳职责：原生窗口 + 系统托盘 + 单实例 + 拉起 node 服务（系统 node，免打包 sidecar）。

```bash
node build/pack.mjs    # 打包纯工具文件到 dist/agent-sync/（不含个人数据）
```

## 设计约定（重要）

- 全局技能源为 `~/.agents/skills/`，由 `links` 映射；项目技能源为项目 `.agents/skills/`，登记归属后独立备份。禁止在各agent全局技能目录另存实体，也不把项目技能收编成全局技能。
- 记忆共享只收「跨 agent 且长期成立」的事实；对话级信息、仓库里已有的东西不进源
- 备份语义：默认增量镜像绝不删除；`--mirror` 才清理多余文件
