# agent-sync

**AI agent 的技能 / 规则 / 记忆「一处维护，处处生效」。**

把所有 agent 的技能、规则块、共享记忆收进一个源目录（`~/.agents/`），用 Windows junction / 符号链接映射到各 agent，再配上备份兜底和一个本地可视化面板。改源一处，所有 agent 立即生效。

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
| `agent-sync rules` | 规则块注入（漂移检测，写前备份） |
| `agent-sync memory` | 记忆层下发（`~/.agents/memory/` → 各 agent） |
| `agent-sync adopt` | 收编：agent 目录里的新装技能 → 移入源 + 补链接 |
| `agent-sync backup` | 增量镜像备份到备份根（`--mirror` 严格清理慎用） |

通用开关：`--dry-run` 预演 · `--yes` 跳过确认 · `--json` 结构化输出（面板数据源）。

## 配置

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

## 从源码构建 exe

```bash
node build/build-exe.mjs   # 产出 build/agent-sync.exe（Node ≥ 22；postject 首次需联网）
node build/pack.mjs        # 打包纯工具文件到 dist/agent-sync/（不含个人数据）
```

## 设计约定（重要）

- 源是唯一实体：新装技能先进 `~/.agents/skills/`，再由 `links` 映射；**禁止**直接往 agent 技能目录写实体（会被巡检报告为冲突/收编候选）
- 记忆共享只收「跨 agent 且长期成立」的事实；对话级信息、仓库里已有的东西不进源
- 备份语义：默认增量镜像绝不删除；`--mirror` 才清理多余文件
