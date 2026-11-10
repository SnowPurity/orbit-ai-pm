import type { Db } from './db/index.js';
import { backfillTaskAssignees, transaction } from './db/index.js';
import { issueToken } from './auth.js';
import { nextCronRun } from './lib/cron.js';
import { nowIso } from './lib/util.js';

export interface SeedResult {
  seeded: boolean;
  projectId: string;
  projectKey: string;
  humanToken?: string;
  agentToken?: string;
}

const DAY = 24 * 60 * 60 * 1000;

function at(offsetDays: number, hour = 9): string {
  const date = new Date(Date.now() + offsetDays * DAY);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

export function seedDatabase(db: Db): SeedResult {
  const existing = db.prepare('SELECT id, key FROM projects LIMIT 1').get() as
    | { id: string; key: string }
    | undefined;
  if (existing) {
    return { seeded: false, projectId: existing.id, projectKey: existing.key };
  }

  return transaction(db, () => {
    const createdAt = nowIso();
    const insertActor = db.prepare(
      `INSERT INTO actors (id, name, kind, title, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    insertActor.run('act_lin', 'Lin', 'human', 'Project lead', createdAt);
    insertActor.run('act_maya', 'Maya', 'human', 'Product designer', createdAt);
    insertActor.run('act_atlas', 'Atlas', 'agent', 'Project operations agent', createdAt);

    const humanToken = issueToken(db, 'act_lin').token;
    const agentToken = issueToken(db, 'act_atlas').token;

    db.prepare(
      `INSERT INTO projects (id, key, name, description, status, color, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(
      'prj_orbit',
      'ORB',
      'Orbit 发布',
      'AI 原生项目管理平台的内部发布项目。Agent 与人类共享任务、事件和自动化。',
      '#5B8DEF',
      'act_lin',
      createdAt,
      createdAt,
    );

    const addMember = db.prepare(
      `INSERT INTO project_members (project_id, actor_id, role, role_tag, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    addMember.run('prj_orbit', 'act_lin', 'owner', '项目负责人', createdAt);
    addMember.run('prj_orbit', 'act_maya', 'member', '产品设计', createdAt);
    addMember.run('prj_orbit', 'act_atlas', 'member', '项目运营', createdAt);

    const insertTask = db.prepare(
      `INSERT INTO tasks
       (id, project_id, number, parent_task_id, title, description, status, priority,
        assignee_id, created_by, start_at, due_at, labels, version, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    );

    const tasks = [
      {
        id: 'tsk_orbit_1', number: 1, parent: null,
        title: '完成项目与任务数据模型',
        description: 'Project、Task、子任务、Comment、Event 的 SQLite schema 与迁移。',
        status: 'done', priority: 'high', assignee: 'act_lin',
        due: at(0, 12), labels: ['backend', 'data'],
      },
      {
        id: 'tsk_orbit_2', number: 2, parent: null,
        title: '设计 MCP 工具契约',
        description: '让 Agent 以少量、语义稳定的工具完成项目管理。',
        status: 'doing', priority: 'high', assignee: 'act_atlas',
        due: at(2), labels: ['mcp', 'agent'],
      },
      {
        id: 'tsk_orbit_3', number: 3, parent: null,
        title: '实现人机双模 CLI',
        description: '默认表格输出，--json 提供稳定机器输出。',
        status: 'todo', priority: 'medium', assignee: 'act_maya',
        due: at(4), labels: ['cli'],
      },
      {
        id: 'tsk_orbit_4', number: 4, parent: null,
        title: '接入 cron 与 hook 自动化',
        description: '统一 Automation 模型，共享动作与运行日志。',
        status: 'review', priority: 'high', assignee: 'act_lin',
        due: at(1), labels: ['automation'],
      },
      {
        id: 'tsk_orbit_5', number: 5, parent: null,
        title: '确认演示环境与访问地址',
        description: '需要确认本地演示还是公网访问，以及 Agent 运行位置。',
        status: 'todo', priority: 'urgent', assignee: 'act_lin',
        due: at(1, 18), labels: ['demo', 'blocker'],
      },
      {
        id: 'tsk_orbit_6', number: 6, parent: null,
        title: '编写 3 分钟演示脚本',
        description: '覆盖 Agent 领取 Job、创建风险任务、hook 自动留痕。',
        status: 'todo', priority: 'medium', assignee: 'act_atlas',
        due: at(5), labels: ['demo'],
      },
      {
        id: 'tsk_orbit_7', number: 7, parent: 'tsk_orbit_2',
        title: '定义工具名称与输入 schema',
        description: '保持工具数量精简，动词和对象命名一致。',
        status: 'done', priority: 'high', assignee: 'act_atlas',
        due: at(1, 12), labels: ['mcp'],
      },
      {
        id: 'tsk_orbit_8', number: 8, parent: 'tsk_orbit_2',
        title: '补充错误码与幂等约定',
        description: '所有写操作返回稳定 ref；冲突必须给出可读错误。',
        status: 'doing', priority: 'medium', assignee: 'act_atlas',
        due: at(3), labels: ['mcp', 'contract'],
      },
    ] as const;

    for (const task of tasks) {
      insertTask.run(
        task.id,
        'prj_orbit',
        task.number,
        task.parent,
        task.title,
        task.description,
        task.status,
        task.priority,
        task.assignee,
        'act_lin',
        createdAt,
        task.due,
        JSON.stringify(task.labels),
        createdAt,
        createdAt,
        task.status === 'done' ? createdAt : null,
      );
    }

    backfillTaskAssignees(db);

    const insertComment = db.prepare(
      `INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    insertComment.run(
      'cmt_demo_1',
      'tsk_orbit_2',
      'act_atlas',
      '已完成第一版工具清单，建议保留 15 个以内，并以项目/任务/活动/自动化为四条主线。',
      at(-1, 10),
    );
    insertComment.run(
      'cmt_demo_2',
      'tsk_orbit_4',
      'act_lin',
      'hook 需要支持条件过滤，否则状态每次变化都会触发。',
      at(-1, 15),
    );

    const insertEvent = db.prepare(
      `INSERT INTO events (project_id, task_id, type, actor_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertEvent.run('prj_orbit', null, 'project.created', 'act_lin', JSON.stringify({ key: 'ORB' }), at(-3));
    for (const task of tasks) {
      insertEvent.run(
        'prj_orbit',
        task.id,
        'task.created',
        'act_lin',
        JSON.stringify({ status: task.status, priority: task.priority, parentId: task.parent }),
        at(-2, 10),
      );
    }

    const automations = [
      {
        id: 'aut_completion_note',
        name: '完成任务自动留痕',
        triggerType: 'hook' as const,
        triggerConfig: { event: 'task.status_changed', filter: { to: 'done' } },
        actionType: 'add_comment' as const,
        actionConfig: { body: '✅ {{task.ref}} 已由 {{actor.name}} 标记完成，自动化已记录。' },
        nextRunAt: null as string | null,
      },
      {
        id: 'aut_urgent_triage',
        name: '紧急任务自动分诊',
        triggerType: 'hook' as const,
        triggerConfig: { event: 'task.created', filter: { priority: 'urgent' } },
        actionType: 'enqueue_agent' as const,
        actionConfig: {
          agent: 'Atlas',
          title: '紧急任务分诊：{{task.title}}',
          prompt:
            '你是项目运营 Agent。请阅读任务 {{task.ref}}「{{task.title}}」，评估影响、给出下一步行动，并在任务下留下简洁结论。',
        },
        nextRunAt: null as string | null,
      },
      {
        id: 'aut_morning_digest',
        name: '工作日晨间摘要',
        triggerType: 'cron' as const,
        triggerConfig: { expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' },
        actionType: 'enqueue_agent' as const,
        actionConfig: {
          agent: 'Atlas',
          title: '晨间项目摘要 · {{project.key}}',
          prompt:
            '汇总项目 {{project.name}} 当前进行中、阻塞和即将到期的任务，给出不超过 5 条的风险与建议。日期：{{date}}。',
        },
        nextRunAt: nextCronRun('0 9 * * 1-5', 'Asia/Shanghai'),
      },
    ];

    const insertAutomation = db.prepare(
      `INSERT INTO automations
       (id, project_id, name, enabled, trigger_type, trigger_config, action_type, action_config,
        created_by, next_run_at, created_at, updated_at)
       VALUES (?, 'prj_orbit', ?, 1, ?, ?, ?, ?, 'act_lin', ?, ?, ?)`,
    );
    for (const automation of automations) {
      insertAutomation.run(
        automation.id,
        automation.name,
        automation.triggerType,
        JSON.stringify(automation.triggerConfig),
        automation.actionType,
        JSON.stringify(automation.actionConfig),
        automation.nextRunAt,
        createdAt,
        createdAt,
      );
    }

    db.prepare(
      `INSERT INTO agent_jobs
       (id, project_id, task_id, agent_id, title, prompt, context, status, created_by, created_at)
       VALUES (?, 'prj_orbit', 'tsk_orbit_2', 'act_atlas', ?, ?, ?, 'queued', 'act_lin', ?)`,
    ).run(
      'job_demo_1',
      '为 MCP 契约补充失败场景',
      '检查 ORB-2 的子任务，列出 Agent 调用 MCP 时最可能遇到的 5 个失败场景，并直接评论到任务上。',
      JSON.stringify({ taskId: 'tsk_orbit_2', taskRef: 'ORB-2', source: 'seed' }),
      createdAt,
    );

    return {
      seeded: true,
      projectId: 'prj_orbit',
      projectKey: 'ORB',
      humanToken,
      agentToken,
    };
  });
}

export function issueMissingDemoTokens(db: Db): { humanToken: string; agentToken: string } {
  return {
    humanToken: issueToken(db, 'act_lin').token,
    agentToken: issueToken(db, 'act_atlas').token,
  };
}
