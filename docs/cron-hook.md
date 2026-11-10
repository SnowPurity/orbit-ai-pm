# Cron 与 Hook 自动化入门

Orbit 的自动化由 **触发器 + 动作** 组成：

```text
Automation
  ├─ scope  : global（项目内所有任务） | task（仅指定任务）
  ├─ trigger: cron（定时） | hook（事件）
  ├─ action : create_task | add_comment | enqueue_agent
  └─ run log: 每次执行记录 success / failed / skipped
```

cron 和 hook 共用同一套动作、模板变量和运行日志，区别只在“什么时候触发”。

## 规则范围：全局 vs 指定任务

每条规则都可以选择适用范围：

| 范围 | `task` 字段 | 行为 |
|---|---|---|
| 全局规则 | 省略或 `null` | 项目内的任务事件都可能触发 |
| 指定任务规则 | 任务 ref，如 `"IPD-6"` | 只响应该任务的事件；cron / 手动运行也会带上该任务上下文 |

JSON 示例：

```json
{
  "name": "CDCP 前提醒",
  "task": "IPD-6",
  "trigger": { "type": "cron", "expression": "0 9 * * 1" },
  "action": {
    "type": "add_comment",
    "config": { "body": "{{task.ref}} 的 CDCP 材料请及时归档。" }
  }
}
```

指定任务后，`{{task.*}}`、`add_comment` 和 Agent Job 都会关联到该任务。
全局规则没有任务上下文，因此 **cron + add_comment 只能用于指定任务规则**；hook + add_comment 仍然可以从事件中取得任务。

## 1. Cron：按时间触发

使用标准 5 段 cron 表达式：`分 时 日 月 周`，并指定 IANA 时区（默认 `Asia/Shanghai`）。

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
      "title": "晨间项目摘要 · {{project.key}}",
      "prompt": "汇总 {{project.name}} 当前风险与待办。"
    }
  }
}
```

运行方式：

- 启用状态下创建或更新时计算 `nextRunAt`；
- 调度器每 15 秒检查一次，到点执行；
- 触发后自动推进下一次时间；
- 手动运行记录为 `manual`，**不会**改变下一次定时；
- 服务停机期间不补跑历史多次，恢复后最多补一次；
- 失败不自动重试，错误写入运行日志。

## 2. Hook：按事件触发

Hook 订阅领域事件，任务或评论写入成功后触发：

| 事件 | 触发时机 |
|---|---|
| `task.created` | 创建任务 |
| `task.updated` | 修改标题、描述、优先级、截止时间、标签 |
| `task.status_changed` | 任务状态变化 |
| `task.assigned` | 负责人变化 |
| `comment.created` | 新增评论 |

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
    "config": { "body": "{{task.ref}} 已由 {{actor.name}} 标记完成。" }
  }
}
```

### filter

`filter` 对**事件 payload** 做精确匹配，多个键是 AND，值只能是字符串、数字或布尔：

```json
{ "from": "review", "to": "done" }
```

常用可过滤字段：

```text
task.status_changed → from, to, parentId
task.created        → status, priority, assigneeId, parentId
task.assigned       → from, to, parentId
comment.created     → commentId, excerpt, parentId
```

注意：`filter` 看不到任务标题、标签等完整任务字段。需要按这些字段触发时，
建议新增一个带相应 payload 的领域事件，而不是新增 trigger 类型。

### 触发链

- 自动化动作产生的写入可以再次触发 hook；
- 同一条事件链最多 4 层；
- 同一条自动化不会在链中重复执行，避免无限循环。

## 3. 三种动作

| 动作 | cron | hook | 说明 |
|---|---|---|---|
| `create_task` | 是 | 是 | 必须有 `title`，可指定状态、优先级、负责人 |
| `add_comment` | 仅指定任务 | 是 | 需要任务上下文；全局 cron 没有可评论的任务 |
| `enqueue_agent` | 是 | 是 | Agent 必须是项目成员，工作进入 Job 队列 |

模板变量：

```text
{{project.key}}  {{project.name}}
{{task.ref}}     {{task.title}}  {{task.status}}
{{actor.name}}   {{event.type}}  {{date}}
```

## 4. 创建方式

REST：

```text
POST /api/v1/projects/:projectRef/automations
Authorization: Bearer <token>
Content-Type: application/json
```

CLI：

```bash
# hook（全局）
npm run orbit -- automation-create IPD \
  --name "完成后自动留痕" \
  --on task.status_changed \
  --filter '{"to":"done"}' \
  --action add_comment \
  --body "{{task.ref}} 已完成"

# hook（仅指定任务）
npm run orbit -- automation-create IPD \
  --name "CDCP 完成留痕" \
  --task IPD-6 \
  --on task.status_changed \
  --filter '{"to":"done"}' \
  --action add_comment \
  --body "{{task.ref}} 的 CDCP 已关闭"

# cron（全局）
npm run orbit -- automation-create IPD \
  --name "IPD 阶段门周检" \
  --cron "0 10 * * 1" \
  --action enqueue_agent \
  --agent Atlas \
  --prompt "检查 {{project.name}} 的阶段门风险"

# cron（指定任务，可添加评论）
npm run orbit -- automation-create IPD \
  --name "CDCP 周提醒" \
  --task IPD-6 \
  --cron "0 9 * * 1" \
  --action add_comment \
  --body "{{task.ref}} 的 CDCP 材料请及时归档"
```

创建后可在 Web UI 的自动化页直接运行或删除，也可以手动运行：

```bash
npm run orbit -- automation-run <automationId>
```

## 5. 快速对比

| | Cron | Hook |
|---|---|---|
| 触发源 | 时间 | 领域事件 |
| 配置 | `expression` + `timezone` | `event` + `filter` |
| 上下文 | 全局为项目级；指定任务规则带任务 | 任务/评论/操作者 |
| `add_comment` | 仅指定任务规则 | 支持 |
| 典型用途 | 日报、周报、定时巡检 | 状态流转留痕、风险分诊、通知 Agent |

## 6. 当前边界

- 单进程调度，多实例部署需要数据库级抢占或外部队列；
- cron 没有失败重试和补偿；
- 手动运行**全局 hook** 自动化不携带原事件/任务上下文，`add_comment` 会失败；指定任务规则可以直接手动运行；
- 自动化只对创建后发生的事件生效，不回溯历史；
- 没有外部 Webhook 入口/出口；
- 按任务标签等复杂条件触发时，当前需要扩展领域事件或匹配器。
