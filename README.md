# Orbit

AI 原生的项目管理平台 demo。Agent 不是外挂，而是与人类共享同一套项目、任务、事件和自动化的正式参与者。

当前包含：**技术选型、数据库、后端、MCP、CLI、cron/hook 自动化、极简 Web UI、跨项目个人任务页、任务组、普通/里程碑任务类型、多负责人、任务附件、人员与 Agent 管理、WeKnora 文本评审、SSE 实时动态与 @提及通知，以及一个 IPD 六阶段模板项目**。
## 为什么是 AI-native

- **Agent 是 Actor**：人类和 Agent 都有身份、token、负责人字段和项目成员关系。
- **Agent Job 收件箱**：cron/hook 不直接调用模型，而是把工作放入 Job 队列，Agent 通过 MCP 领取、完成。
- **唯一事实源**：REST 是唯一写入入口，CLI 和 MCP 都是薄客户端，不存在第二套业务逻辑。
- **事件流可观察**：每次任务/评论/自动化写入都会进入 append-only Event Log，人和 Agent 都能读取；Web UI 通过 SSE 实时接收新事件。
- **@提及与未读**：评论中用 `@成员名` 提及项目成员，服务端生成通知；顶栏铃铛汇总所有项目的未读，点击可跨项目直达任务。授权后可开启浏览器桌面通知，@提及会直接推送到系统通知。评论框提供带搜索的成员列表，成功关联的提及红色高亮。
- **@Agent 自动回复**：人工评论提及 Agent 时，服务端创建回复 Job，Agent 会结合项目说明、任务组说明、当前任务、上级任务、子任务、相关任务和最近 3 条讨论生成评论回复；依赖、附件和项目统计不再进入 Prompt，整体受字符预算裁剪；Agent 之间的提及不会触发循环回复。
- **在线成员**：SSE 连接用于维护在线状态，顶栏显示当前项目在线人数，点击可查看在线成员；成员页同步显示在线标识。
- **新建项目**：顶栏项目下拉框左侧的「+ 新建项目」按钮可直接填写名称、代号与说明创建项目，创建者自动成为负责人；代号支持 `MOUSE-REQ` 这类尾标，任务 ref 形如 `MOUSE-REQ-1`。
- **统一自动化**：cron 和 hook 共享同一套 Automation、Action、Run Log 与递归保护。
- **稳定任务引用**：`ORB-12` 这类 ref 同时适人类沟通和 Agent 工具调用。
- **双模输出**：CLI 默认人类可读表格，`--json` 给 Agent 稳定结构化输出。

## 快速开始

要求 Node.js >= 22.13。

```bash
npm install
npm run setup
npm run dev
```

另开一个终端：

```bash
npm run orbit -- me
npm run orbit -- projects
npm run orbit -- board ORB
npm run orbit -- board IPD
npm run orbit -- task ORB-2
```

浏览器访问 `http://127.0.0.1:8787/ui`，输入 `.orbitrc.json` 中的 `humanToken` 即可连接。

`npm run setup` 会：

1. 创建 `data/orbit.db`；
2. 写入演示项目 `ORB`（8 个任务）、IPD 模板项目 `IPD`（6 个任务组、30 个任务）、6 条自动化与 2 个 Agent Job；
3. 生成 `.orbitrc.json`（权限 600、已 gitignore），包含人类 Lin 和 Agent Atlas 的 demo token。

`setup` 可重复执行：已存在的项目不会重复写入。

想重置演示数据，先停止服务，再执行：

```bash
npm run db:reset
```

> Token 只用于本地 demo。生产环境必须替换为正式身份系统，并且不要在日志或仓库中输出 token。

## Web UI

启动服务后打开 `http://127.0.0.1:8787/ui`，输入 `.orbitrc.json` 中的 `humanToken`。Token 只保存在浏览器 localStorage，不会写入页面或服务端日志。

前端无框架，由 Fastify 直接托管 `public/`；评论、项目说明、任务说明与任务组说明共用同一套富文本渲染，使用开源库 [markdown-it](https://github.com/markdown-it/markdown-it) 渲染 Markdown，构建时由 esbuild 打包为本地 ESM（`public/vendor/markdown-it.mjs`），不依赖 CDN。渲染关闭原始 HTML、默认拦截 `javascript:` 等危险链接，并为外链加上 `target="_blank"` 与 `rel="noopener noreferrer"`：

- 看板：四列状态、优先级、多负责人头像和子任务进度；里程碑任务显示「里程碑」标识；带附件的任务在卡片右上角显示 📎 角标，顶部工具栏提供「📎 含附件」筛选（含匹配数量，分组/单组视图同时生效）；存在任务组时切换为分组看板，任务组在左侧从上到下排列并显示数量、进度与说明（Markdown 渲染，支持 `@提及` 和任务/项目/任务组引用）；项目名称、代号和说明可在看板顶部的「编辑项目」弹窗中编辑；说明按 Markdown 渲染并支持 `@提及` 与任务/项目/任务组引用；修改代号后任务 ref（如 ORB-12）与 URL 会随之变化；
- 视图切换：看板支持「分组 / 单组」两种视图；单组视图在左侧选择任务组，右侧只显示该组从待办到完成的任务，选择会保存在本地；
- 任务抽屉：状态流转、多负责人编辑（勾选加入、取消移除）、子任务跳转与任意层级嵌套创建、附件上传/下载/删除（带进度）、任务说明（Markdown 渲染，自动解析 `@提及` 与任务/项目/任务组引用，可直接编辑）、评论（Markdown 渲染，含标题、列表、代码、表格、链接与 WeKnora 引用，同样解析 `@提及` 与任务/项目/任务组引用）、AI 建议，以及默认收起的前置/后置依赖模块（完成才开始、完成才完成、开始才开始、开始才完成；前置未满足时按类型软阻塞状态前进，并返回 `409 dependency_blocked` 与未满足列表）；抽屉支持独立路径 `/ui/tasks/:ref`，不需要先进入项目页面；
- 动态：任务、评论、自动化、成员与 Agent Job 事件流；
- 自动化：全局/指定任务两类规则、hook/cron 创建、删除、手动运行和 Agent 任务队列；自动生成的 Agent 规则会显示「自动规则」标识；
- 成员：项目负责人/成员列表、新建人员或 Agent、绑定 WeKnora Agent ID、加入/移出项目，Agent 无需 Token；每个项目成员可设置一个项目角色标签（如「产品经理」「项目运营」），在成员卡片、任务负责人和提及列表中展示；
- 我的任务：`/ui/me` 汇总所有参与项目中与自己相关（指派给我或我创建）的任务，按项目分组，支持「全部相关 / 指派给我 / 我创建的」、状态（含逾期）、任务类型与关键词筛选，顶部显示完成、进行中、待验收、逾期等统计，点击统计卡可直接按该状态筛选；点击任务通过 `?task=<ref>` 在当前页侧栏打开，不离开我的任务页；
- 路由：`/ui/me` 为个人任务页；项目视图为 `/ui/projects/:key/board|activity|automations|members`，任务详情为 `/ui/projects/:key/:view/tasks/:ref` 或独立的 `/ui/tasks/:ref`；`?task=<ref>` 可在当前页面叠加任务抽屉；
- 项目代号：2–20 个字母/数字，首字符为字母，支持用 `-` 分隔的尾标子项目（每段以字母开头），例如 `MOUSE-REQ`，其任务 ref 自动为 `MOUSE-REQ-1`、项目引用写 `#MOUSE-REQ`；
- SPA：使用 History API 导航，支持深链接、浏览器前进/后退，服务端对项目与独立任务路由回退到 `index.html`。

窄屏下看板横向滚动，任务详情以全屏抽屉呈现；`/` 会重定向到 `/ui`。

### 任务附件

- 元数据写入 SQLite 的 `task_files` 表，文件内容存放在 `ORBIT_FILES_DIR`（默认 `./data/files`），不使用 BLOB。
- 上传使用 `multipart/form-data`，单文件默认上限 50MB；每个任务默认最多 20 个附件，项目默认配额 2GB。
- 上传、下载、删除都要求 Bearer token 且调用者是项目成员；删除仅限上传者或项目负责人。
- 下载响应固定 `Content-Disposition: attachment` + `application/octet-stream` + `nosniff`，不做同源 inline 预览，避免用户上传的 HTML/SVG 造成存储型 XSS。
- Web UI 通过带 Bearer 的 `fetch` 取 Blob 后触发浏览器下载，不把 token 放进 URL。
- 文件按随机 ID 落盘，显示名只用于界面与下载头；写入采用临时文件 + 原子 rename，DB 写入失败会清理已写文件。
- 备份必须同时覆盖 SQLite 数据库与 `ORBIT_FILES_DIR`。

```bash
ORBIT_FILES_DIR=./data/files
ORBIT_MAX_UPLOAD_MB=50
ORBIT_TASK_FILE_LIMIT=20
ORBIT_PROJECT_QUOTA_MB=2048
```

## 人员、Agent 与 WeKnora

- 人员和 Agent 都是全局 `Actor`，项目通过 `project_members` 关联；权限角色为 `owner` 或 `member`。
- 每个成员关系还可带一个项目角色标签 `roleTag`（最长 40 字符，可空），描述成员在该项目中的职责分工，类似 IPD 的角色；它与全局职位 `title` 不同，一个人在不同项目可以有不同标签，但同一项目最多一个。项目负责人可修改任意成员的标签，普通成员只能修改自己的；「编辑人员」弹窗只展示与当前用户共同参与的项目，并通过下拉框选择项目后编辑对应标签。
- 管理员在「成员」视图新建人员/Agent 并加入项目。Agent 不需要 token，也不会签发 token；它的执行权限来自“被项目接纳”和“被任务指派”。
- Agent 可绑定 `externalAgentId`（WeKnora Agent ID）；未绑定时回退到 `WEKNORA_AGENT_ID`。
- 后台 Agent Worker 每 5 秒扫描排队中的 Agent Job，将回复以 Agent 身份写入任务评论，并完成 Job；失败时 Job 标记为 `failed` 并记录原因。
- 设置 `DEEPSEEK_API_KEY` 时启动内置 LLM Worker；同时配置 WeKnora 时，任务级「AI 建议」与已绑定 WeKnora 的 Agent 回复优先走 WeKnora RAG，其余 Job 走 DeepSeek。
- LLM / WeKnora 配置只从服务端环境变量读取，API Key 不会返回给前端：

```bash
DEEPSEEK_API_KEY=<server-side-key>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```


```bash
WEKNORA_API_URL=http://127.0.0.1:8088/api/v1
WEKNORA_API_KEY=<server-side-key>
WEKNORA_AGENT_ID=<optional-default-agent-id>
WEKNORA_UI_URL=http://127.0.0.1:8088
```

`WEKNORA_UI_URL` 可选；未设置时由 `WEKNORA_API_URL` 自动去掉 `/api/v1` 推导，用于把评论中的知识库引用渲染成可点击链接。

未设置 `DEEPSEEK_API_KEY` 且未设置 `WEKNORA_API_URL` 与 `WEKNORA_API_KEY` 时不启动 Worker，Agent Job 仍可被外部 Agent 通过 claim/complete 处理。

### AI 建议与 RAG 路由

任务抽屉中的「AI 建议」会创建一条 `context.kind = task_ai_suggestion` 的 Agent Job。服务端在创建 Job 时组装 Prompt，包含：

- 当前进度：项目任务统计、任务状态、子任务完成度、截止/逾期情况；
- 任务信息：标题、描述、负责人、任务组、标签、父/子/同级任务；
- 项目知识库：项目说明、任务组说明、同组相关任务、最近讨论摘录。

Worker 的处理路径：

| 场景 | 执行方 | 说明 |
| --- | --- | --- |
| AI 建议 + 配置了 WeKnora | WeKnora Agent | 调用 `sessions` + `agent-chat`；使用 Agent 的 `externalAgentId`，未绑定时回退 `WEKNORA_AGENT_ID` |
| @Agent 回复 + Agent 已绑定 WeKnora | WeKnora Agent | 使用该 Agent 的 `externalAgentId`；裁剪后的上下文作为查询发送 |
| @Agent 回复 + 未绑定 WeKnora | DeepSeek | 使用包含项目/任务组/父任务/子任务/相关任务说明的 `mention_reply` Prompt |
| 其他 Agent Job + 配置了 DeepSeek | DeepSeek | Orbit 内置 LLM Worker 直接调用 OpenAI 兼容接口 |
| AI 建议 + WeKnora 调用失败 | DeepSeek | 单个 Job 回退，不影响其他任务 |
| 未配置 DeepSeek、仅配置 WeKnora | WeKnora | 所有 Job 由 WeKnora Worker 处理 |

评论 @Agent 时，服务端会在评论事务提交后创建 `context.kind = mention_reply` 的 Agent Job。Prompt 包含：触发评论与作者、项目说明与任务统计、当前任务及其父/同级任务、全部子任务、前置/后置依赖、附件清单、同组相关任务和最近 10 条讨论。只有人类作者的提及会触发回复；Agent/系统评论不会再次创建回复 Job，避免循环。

需要特别区分：

- WeKnora 路径中，真正调用 LLM 的是 WeKnora 内部配置的模型（例如 `deepseek-flash`）；Orbit 只负责发送查询和接收 SSE 回答，不会在该路径上调用自己的 `DeepSeekClient`。
- WeKnora 在内部完成查询改写/扩展、关键词与向量召回、rerank 和回答生成；是否检索、检索哪些库由 WeKnora Agent 配置决定（如 `kb_selection_mode`、`keyword_threshold`、`vector_threshold`），Orbit 不参与其中的向量检索。
- 回答中的 `<kb doc="..." chunk_id="..." kb_id="..." />` 是 WeKnora 的引用标记，会原样写入任务评论；前端会把标记渲染为知识库链接，而不是显示原始标签。打开任务时，前端会用 `chunk_id` 调用 `POST /api/v1/weknora/citations/resolve`，由服务端（持有 API Key）查询 WeKnora 的 chunk 归属，链接因此带上 `?knowledge_id={knowledge_id}` 直接定位到具体文章；解析失败时回退为知识库级链接。
- Orbit 的「项目知识库」是项目描述、任务组、相关任务和讨论等结构化上下文，不是向量库；它与 WeKnora 配置的外部知识库是两份不同来源，不能混为一谈。

## IPD 模板项目

`npm run setup` 会幂等写入项目 `IPD`（`【模板】IPD 新产品开发`），按集成产品开发（Integrated Product Development）的六个阶段组织为任务组：

```text
概念 → CDCP → 计划 → PDCP → 开发 → TR3/TR4/TR5
     → 验证 → TR6 → ADCP → 发布 → 生命周期 → LDCP
```

- 6 个任务组（概念、计划、开发、验证、发布、生命周期），每组 5 个任务，共 30 个任务；
- 覆盖 CDCP/PDCP/ADCP/LDCP 决策评审与 TR1–TR6 技术评审；TR1–TR6 技术评审自动标记为里程碑任务；
- 包含需求分解 `RR → IR → SR → AR`、DFX、EVT/DVT/PVT 等关键活动；
- 3 条自动化：阶段门完成留痕、紧急风险分诊、每周阶段门健康检查；
- 1 个 Agent Job：CDCP 材料完整性检查。

任务组是结构化字段（`tasks.group_id`），看板在左侧按组展示任务，也可用 `GET /api/v1/projects/IPD/tasks?group=概念` 或 `npm run orbit -- tasks IPD --group 概念` 按组筛选。分组/单组视图的任务组标题旁提供「编辑」和「删除」，编辑弹窗可修改名称与说明（说明按 Markdown 渲染，支持 `@提及` 和任务/项目/任务组引用）；删除前需二次确认，组内任务会自动移入「未分组」而不会被删除。

## 核心模型

```text
Actor(human/agent/system)
  └─ ProjectMember ─ Project
                       ├─ TaskGroup (看板左侧任务组栏 / 阶段)
                       ├─ Task (可属于一个任务组，可嵌套子任务)
                       │   ├─ Comment
                       │   ├─ Event
                       │   └─ AgentJob
                       └─ Automation (global | task; cron | hook)
                           └─ AutomationRun
```

固定任务状态：`todo / doing / review / done`。

任务类型：`kind` 取 `task`（普通任务）或 `milestone`（里程碑任务），默认 `task`。REST、CLI（`--kind`）、MCP 与自动化的 `create_task` 都支持该字段；IPD 模板中的 TR1–TR6 技术评审自动作为里程碑，旧数据库升级到 schema v8 时会按标题一次性回填。

任务时间：`startAt`（开始时间）默认为创建时间，`dueAt`（截止时间）可选，两者都可通过 REST、CLI（`--start` / `--due`）、MCP 与任务抽屉中的日期控件修改；任务抽屉同时展示创建时间与完成时间。旧数据库升级到 schema v9 时会用 `created_at` 回填 `start_at`。

负责人规则：

- 一个任务可以有多个负责人，关系保存在 `task_assignees`；`tasks.assignee_id` 保存第一位负责人以兼容旧接口；
- 创建/更新接受 `assignees` 数组（最多 10 个项目成员），`assignee` 单值字段仍然可用；
- 当被指派的成员名称以 `Agent` 结尾（不区分大小写）且任务未完成时，自动创建一条任务级规则：`task.status_changed → review` 时派发 `enqueue_agent`，并立即运行一次；
- 自动规则的 Prompt 固定为评审指令，不需要手动配置；从任务中移除该 Agent 时，对应自动规则会被删除；
- 新建项目默认安装自动化（完成任务留痕；项目有 Agent 成员时还会安装紧急任务分诊和工作日晨间摘要）；
- Agent Job 由 LLM/WeKnora Worker 或外部 Agent 领取，不会阻塞原请求。

任务组规则：

- 任务组是项目内的横向分类，与父子层级正交；每组名称在项目内唯一；
- 组进度只统计顶层任务（`parent_task_id IS NULL`）；
- 子任务默认继承父任务的任务组，显式指定不同任务组会返回 `400`；
- 顶层任务移动任务组时，其所有层级子任务同步移动；
- 删除任务组不会删除任务，组内任务变为未分组。

子任务规则：

- 支持多层嵌套，子任务下可以继续创建子任务；
- 子任务有独立 ref，例如父任务 `ORB-2`，子任务 `ORB-7`；
- 看板只显示顶层任务，任务详情返回直接子任务和 `done/total` 进度；抽屉中每个子任务旁都有「+ 子任务」按钮，可直接在其下继续嵌套；
- 父任务完成前必须完成全部直接子任务，否则返回 `409 subtasks_incomplete`；逐层满足后，完成状态会向上递归级联；
- 最后一层子任务完成时，系统自动完成其父任务，并以 Orbit Automation 身份评论「子任务已经全部完成」；
- 任务更新支持 `version` 乐观并发控制。

完整设计见 [docs/design.md](docs/design.md)。

## CLI

CLI 默认输出可读表格，所有查询类命令都支持 `--json`。

```bash
# 查看
npm run orbit -- board ORB
npm run orbit -- tasks ORB --status todo
npm run orbit -- tasks ORB --all
npm run orbit -- tasks IPD --group 概念
npm run orbit -- task ORB-2
npm run orbit -- activity ORB --limit 20
npm run orbit -- automations ORB
npm run orbit -- jobs ORB
npm run orbit -- jobs ORB --mine --as agent

# 任务组
npm run orbit -- groups IPD
npm run orbit -- group grp_ipd_stage_1
npm run orbit -- group-create IPD "风险跟踪" --description "跨阶段风险"
npm run orbit -- group-update grp_ipd_stage_1 --name "概念与立项"
npm run orbit -- group-delete grp_ipd_stage_1

# 任务
npm run orbit -- create ORB "整理发布风险" --priority high --assignee Atlas
npm run orbit -- create ORB "联合评审" --assignees "Lin,Maya"
npm run orbit -- create ORB "补充错误码" --parent ORB-2 --assignee Atlas
npm run orbit -- create IPD "补充阶段门检查表" --group 验证
npm run orbit -- update ORB-3 --status doing
npm run orbit -- update ORB-3 --assignee none
npm run orbit -- update ORB-3 --group none
npm run orbit -- comment ORB-2 "已确认工具契约"

# Agent Job
npm run orbit -- job-claim job_demo_1 --as agent
npm run orbit -- job-complete job_demo_1 "已补充 5 个失败场景" --as agent

# 自动化
npm run orbit -- automation aut_completion_note
npm run orbit -- automation-run aut_morning_digest
npm run orbit -- automation-create ORB \
  --name "高优任务分诊" \
  --on task.created \
  --filter '{"priority":"urgent"}' \
  --action enqueue_agent \
  --agent Atlas \
  --prompt "评估 {{task.ref}} 的影响并给出下一步"
npm run orbit -- automation-create ORB \
  --name "ORB-2 完成留痕" \
  --task ORB-2 \
  --on task.status_changed \
  --filter '{"to":"done"}' \
  --action add_comment \
  --body "{{task.ref}} 已完成"
```

全局参数可放在子命令后：

```bash
npm run orbit -- projects --json
npm run orbit -- me --as agent
```

## MCP

MCP 使用 stdio transport，以 Agent token 调用 REST API。

```bash
npm run build
npm run orbit -- mcp-config
```

把输出粘贴到支持 MCP 的客户端配置中，例如：

```json
{
  "mcpServers": {
    "orbit": {
      "command": "/usr/bin/node",
      "args": ["/绝对路径/dist/mcp.js"],
      "env": {
        "ORBIT_API_URL": "http://127.0.0.1:8787",
        "ORBIT_TOKEN": "<agent token>"
      }
    }
  }
}
```

MCP 工具共 28 个：

| 工具 | 用途 |
|---|---|
| `list_projects` / `get_project` | 观察项目与成员 |
| `get_board` | 看板视图（任务组 + 任务） |
| `list_groups` / `get_group` / `create_group` / `update_group` / `delete_group` | 任务组完整生命周期 |
| `list_tasks` / `get_task` | 观察任务、嵌套子任务、评论、依赖 |
| `create_task` / `update_task` / `comment_on_task` | 写入任务与评论（支持 `group`、`parent`） |
| `add_task_dependency` / `remove_task_dependency` | 管理任务依赖 |
| `request_ai_suggestion` | 请求 Agent 生成任务 AI 建议评论 |
| `list_activity` | 读取事件流 |
| `list_automations` / `get_automation` / `create_automation` / `update_automation` / `delete_automation` / `run_automation` | 自动化完整生命周期 |
| `list_jobs` / `get_job` / `create_job` / `claim_job` / `complete_job` | Agent Job 生命周期 |

MCP 聚焦项目协作流程。人员与成员管理（`actors`、`projects/:ref/members`）仍通过 UI/REST 完成，不暴露给 Agent，避免 Agent 自行扩权。

Agent 的推荐循环：

```text
list_jobs(agent="me")
  → claim_job
  → get_task / get_project / list_tasks
  → update_task / comment_on_task / create_task
  → complete_job
```

## REST API

Base URL: `http://127.0.0.1:8787`

除 `/health` 外都需要：

```http
Authorization: Bearer <actor-token>
```

响应统一包裹：

```json
{ "data": {}, "meta": {} }
```

错误统一：

```json
{ "error": { "code": "subtasks_incomplete", "message": "...", "details": {} } }
```

主要接口：

```text
GET    /health
GET    /api/v1/me
GET    /api/v1/actors?kind=human|agent
POST   /api/v1/actors
PATCH  /api/v1/actors/:ref
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:ref
PATCH  /api/v1/projects/:ref              # { name?, key?, description? }
GET    /api/v1/projects/:ref/board
GET    /api/v1/projects/:ref/members
POST   /api/v1/projects/:ref/members      # { actor, role, roleTag? }
PATCH  /api/v1/projects/:ref/members/:actor   # { roleTag: string|null }
DELETE /api/v1/projects/:ref/members/:actor
GET    /api/v1/actors/:ref/memberships    # 共同项目及角色标签
GET    /api/v1/projects/:ref/groups
POST   /api/v1/projects/:ref/groups
GET    /api/v1/projects/:ref/tasks
POST   /api/v1/projects/:ref/tasks
GET    /api/v1/projects/:ref/activity
GET    /api/v1/events/stream                 # 全局 SSE（Actor 可见项目），?after=<lastEventId>
GET    /api/v1/projects/:ref/events/stream   # 单项目 SSE，支持 ?after=<lastEventId>
GET    /api/v1/me/tasks                      # 跨项目个人任务，?scope=related|assigned|created&status=&kind=&overdue=true&q=&limit=&offset=
GET    /api/v1/notifications                 # 跨项目收件箱，可选 ?project=ORB&unread=true
POST   /api/v1/notifications/read            # { ids }、{ project } 或 {} 全部已读
GET    /api/v1/presence                      # 在线成员，可选 ?project=ORB
GET    /api/v1/projects/:ref/automations
POST   /api/v1/projects/:ref/automations
GET    /api/v1/projects/:ref/jobs
POST   /api/v1/projects/:ref/jobs
GET    /api/v1/groups/:id
PATCH  /api/v1/groups/:id
DELETE /api/v1/groups/:id
GET    /api/v1/tasks/:ref
PATCH  /api/v1/tasks/:ref
GET    /api/v1/tasks/:ref/files              # 附件列表
POST   /api/v1/tasks/:ref/files              # multipart/form-data，字段名 file
GET    /api/v1/files/:id/download            # 鉴权下载，attachment
DELETE /api/v1/tasks/:ref/files/:id          # 上传者或项目负责人
POST   /api/v1/tasks/:ref/comments
POST   /api/v1/tasks/:ref/ai-suggestion
POST   /api/v1/tasks/:ref/dependencies
DELETE /api/v1/tasks/:ref/dependencies/:id
GET    /api/v1/automations/:id
PATCH  /api/v1/automations/:id
DELETE /api/v1/automations/:id
POST   /api/v1/automations/:id/run
GET    /api/v1/jobs/:id
POST   /api/v1/jobs/:id/claim
POST   /api/v1/jobs/:id/complete
```

任务创建/更新同时接受 `assignee`（单个，兼容旧接口）和 `assignees`（数组，最多 10 人）；只要请求里出现 `assignees`，就以数组为准。

## Automation

快速入门见 [docs/cron-hook.md](docs/cron-hook.md)。

一个 Automation 模型，两类触发器：

```json
{
  "name": "完成后自动留痕",
  "trigger": {
    "type": "hook",
    "event": "task.status_changed",
    "filter": { "to": "done" }
  },
  "action": {
    "type": "add_comment",
    "config": { "body": "{{task.ref}} 已由 {{actor.name}} 完成" }
  }
}
```

```json
{
  "name": "工作日晨间摘要",
  "trigger": {
    "type": "cron",
    "expression": "0 9 * * 1-5",
    "timezone": "Asia/Shanghai"
  },
  "action": {
    "type": "enqueue_agent",
    "config": {
      "agent": "Atlas",
      "prompt": "汇总 {{project.name}} 的风险与待办"
    }
  }
}
```

- 规则范围：省略 `task` 为全局规则；传任务 ref（如 `"ORB-2"`）则只响应该任务
- Hook 事件：`task.created`、`task.updated`、`task.status_changed`、`task.assigned`、`comment.created`
- Action：`create_task`、`add_comment`、`enqueue_agent`
- `add_comment` 可用于 hook，或指定任务的 cron；全局 cron 没有任务上下文
- 模板变量：`{{project.key}}`、`{{project.name}}`、`{{task.ref}}`、`{{task.title}}`、`{{task.status}}`、`{{actor.name}}`、`{{event.type}}`、`{{date}}`
- 每次运行写 `AutomationRun`，记录 success/failed、结果和错误
- 同一事件链最多 4 层，且不会再次执行链中的同一个自动化

## 测试

服务端测试使用独立的临时 SQLite 数据库：

```bash
npm test
```

MCP 协议测试：

```bash
npm run smoke:mcp
```

可视化接口测试报告：

```bash
npm run test:report
```

该命令会运行完整的 REST 集成测试并采集覆盖率，生成：

- `reports/api-test-report.html`：单文件可视化报告，含测试结果、接口覆盖矩阵、行/分支/函数覆盖率和源码级覆盖明细；
- `reports/junit.xml`、`reports/lcov.info`：可接入 CI 的标准报告。

生产构建：

```bash
npm run build
npm start
```

## 目录

```text
src/
  app.ts                 Fastify 应用、鉴权、错误处理
  server.ts              HTTP 入口与 cron scheduler
  client.ts              共享 REST Client（CLI/MCP）
  cli.ts                 双模 CLI
  mcp.ts                 MCP stdio server
  auth.ts                token 签发与鉴权
  seed.ts                演示数据
  templates/
    ipd.ts               IPD 六阶段模板项目
  core/
    service.ts           领域服务与事件写入
    file-store.ts        附件磁盘存储、sha256 与原子写入
    automation-engine.ts hook/cron 统一执行器
    scheduler.ts         cron 调度循环
    weknora-worker.ts    WeKnora Agent 会话与文本评论执行器
  db/
    schema.ts            SQLite schema
    index.ts             连接、迁移、事务
  http/
    routes.ts            REST 路由
    schemas.ts           Zod 入参校验
    ui.ts                Web UI 静态资源托管
  types.ts               对外类型
public/
  index.html             应用外壳
  app.js                 原生 JS 前端逻辑
  styles.css             极简样式
scripts/
  setup.ts               初始化/重置演示数据
  mcp-smoke.ts           MCP 协议冒烟
tests/
  api.test.ts            后端集成测试
  files.test.ts          附件上传/下载/权限/配额测试
  ipd.test.ts            IPD 模板集成测试
  role-tags.test.ts      项目角色标签迁移与种子数据测试
  ui.test.ts             UI 静态资源测试
docs/
  design.md              完整设计稿
  cron-hook.md           Cron 与 Hook 自动化入门
```

## 当前边界

- 单机、单进程 SQLite demo，不适用于多实例部署；
- 角色 `owner/member`：项目成员可以将人员/Agent 加入项目；只有负责人可以授予负责人角色或移除其他成员；项目角色标签由负责人修改，普通成员只能修改自己的；人员与 Agent 的全局创建仅限人类 Actor；
- 没有正式登录页、Sprint、自定义字段；Web UI 使用本地 demo token，仅面向单机演示；通知仅覆盖 @提及且收件箱跨项目汇总，不做邮件/IM 推送；
- 附件为本地磁盘存储，只适合单实例；不支持 inline 预览、公开分享链接、断点续传、对象存储和病毒扫描；删除任务/项目后的物理文件需要额外 GC；
- 实时能力基于单进程内存广播 + SSE；多实例部署需要引入共享事件总线，断线重连依靠事件 id 回放；
- cron 失败不自动重试；多实例需要数据库级抢占或外部队列；
- 没有外部 Webhook 入口/出口；如有需要应作为“事件适配器”，而不是第三类 Automation；
- 任务组没有阶段门状态、自动流转和按组统计报表；
- Agent 读取任务内容时仍需防 prompt injection，生产环境要增加内容信任边界和审批策略。
