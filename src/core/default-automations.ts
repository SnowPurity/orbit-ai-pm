import type { Db } from '../db/index.js';
import { transaction } from '../db/index.js';
import { nextCronRun } from '../lib/cron.js';
import { newId, nowIso } from '../lib/util.js';

interface AgentOption {
  id: string;
  name: string;
}

interface ActionSpec {
  type: 'add_comment' | 'enqueue_agent';
  config: Record<string, unknown>;
}

interface DefaultTemplate {
  name: string;
  triggerType: 'hook' | 'cron';
  trigger: Record<string, unknown>;
  requiresAgent: boolean;
  action: (agent: AgentOption | null) => ActionSpec;
}

const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    name: '完成任务自动留痕',
    triggerType: 'hook',
    trigger: { event: 'task.status_changed', filter: { to: 'done' } },
    requiresAgent: false,
    action: () => ({
      type: 'add_comment',
      config: { body: '✅ {{task.ref}} 已由 {{actor.name}} 标记完成，自动化已记录。' },
    }),
  },
  {
    name: '紧急任务自动分诊',
    triggerType: 'hook',
    trigger: { event: 'task.created', filter: { priority: 'urgent' } },
    requiresAgent: true,
    action: (agent) => ({
      type: 'enqueue_agent',
      config: {
        agent: agent!.name,
        title: '紧急任务分诊：{{task.title}}',
        prompt:
          '你是项目运营 Agent。请阅读任务 {{task.ref}}「{{task.title}}」，评估影响、给出下一步行动，并在任务下留下简洁结论。',
      },
    }),
  },
  {
    name: '工作日晨间摘要',
    triggerType: 'cron',
    trigger: { expression: '0 9 * * 1-5' },
    requiresAgent: true,
    action: (agent) => ({
      type: 'enqueue_agent',
      config: {
        agent: agent!.name,
        title: '晨间项目摘要 · {{project.key}}',
        prompt:
          '汇总项目 {{project.name}} 当前进行中、阻塞和即将到期的任务，给出不超过 5 条的风险与建议。日期：{{date}}。',
      },
    }),
  },
];

export function installDefaultAutomations(db: Db, projectId: string): string[] {
  const project = db.prepare('SELECT id, created_by FROM projects WHERE id = ?').get(projectId) as
    | { id: string; created_by: string }
    | undefined;
  if (!project) return [];

  const agent = db
    .prepare(
      `SELECT a.id, a.name FROM project_members m
       JOIN actors a ON a.id = m.actor_id
       WHERE m.project_id = ? AND a.kind = 'agent'
       ORDER BY m.created_at ASC, a.name ASC
       LIMIT 1`,
    )
    .get(projectId) as AgentOption | undefined;

  const existing = new Set(
    (
      db.prepare('SELECT name FROM automations WHERE project_id = ?').all(projectId) as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );

  const timezone = process.env.ORBIT_TIMEZONE?.trim() || 'Asia/Shanghai';
  const installed: string[] = [];

  transaction(db, () => {
    const insertAutomation = db.prepare(
      `INSERT INTO automations
       (id, project_id, task_id, name, enabled, trigger_type, trigger_config, action_type, action_config,
        created_by, next_run_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO events (project_id, task_id, type, actor_id, payload, created_at)
       VALUES (?, NULL, 'automation.created', ?, ?, ?)`,
    );

    for (const template of DEFAULT_TEMPLATES) {
      if (existing.has(template.name)) continue;
      if (template.requiresAgent && !agent) continue;

      const id = newId('aut');
      const createdAt = nowIso();
      const action = template.action(agent ?? null);
      const trigger =
        template.triggerType === 'cron'
          ? { ...template.trigger, timezone }
          : template.trigger;
      const nextRunAt =
        template.triggerType === 'cron'
          ? nextCronRun(String(template.trigger.expression), timezone)
          : null;

      insertAutomation.run(
        id,
        projectId,
        template.name,
        template.triggerType,
        JSON.stringify(trigger),
        action.type,
        JSON.stringify(action.config),
        project.created_by,
        nextRunAt,
        createdAt,
        createdAt,
      );
      insertEvent.run(
        projectId,
        project.created_by,
        JSON.stringify({
          automationId: id,
          name: template.name,
          trigger: template.triggerType,
          scope: 'global',
          taskRef: null,
          source: 'default',
        }),
        createdAt,
      );
      installed.push(template.name);
    }
  });

  return installed;
}

export function backfillDefaultAutomations(db: Db): string[] {
  const projects = db
    .prepare(
      `SELECT p.id FROM projects p
       WHERE NOT EXISTS (SELECT 1 FROM automations a WHERE a.project_id = p.id)
       ORDER BY p.created_at ASC`,
    )
    .all() as Array<{ id: string }>;
  return projects.flatMap((project) => installDefaultAutomations(db, project.id));
}
