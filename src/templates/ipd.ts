import type { Db } from '../db/index.js';
import { backfillTaskAssignees, transaction } from '../db/index.js';
import { nextCronRun } from '../lib/cron.js';
import { nowIso } from '../lib/util.js';
import { isTrReviewTitle, type TaskKind } from '../types.js';

type SeedStatus = 'todo' | 'doing' | 'review' | 'done';
type SeedPriority = 'low' | 'medium' | 'high' | 'urgent';
type PersonKey = 'lin' | 'maya' | 'atlas';

interface TaskSeed {
  title: string;
  description: string;
  status: SeedStatus;
  priority: SeedPriority;
  kind?: TaskKind;
  assignee: PersonKey;
  labels: string[];
  dueInDays: number;
}

interface PhaseSeed extends TaskSeed {
  stage: string;
  subtasks: TaskSeed[];
}

export interface IpdTemplateResult {
  created: boolean;
  projectId: string;
  projectKey: string;
  taskCount: number;
}

export const IPD_PROJECT_KEY = 'IPD';
const DAY = 24 * 60 * 60 * 1000;

function at(offsetDays: number, hour = 18): string {
  const date = new Date(Date.now() + offsetDays * DAY);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

function resolveActor(
  db: Db,
  id: string,
  name: string,
  kind: 'human' | 'agent',
  title: string,
  createdAt: string,
): string {
  const existing = db
    .prepare('SELECT id FROM actors WHERE id = ? OR name = ? COLLATE NOCASE')
    .get(id, name) as { id: string } | undefined;
  if (existing) return existing.id;
  db.prepare('INSERT INTO actors (id, name, kind, title, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name,
    kind,
    title,
    createdAt,
  );
  return id;
}

const PHASES: PhaseSeed[] = [
  {
    stage: '概念',
    title: '市场机会与产品包定义',
    description:
      '回答“做不做”。完成市场机会评估、客户需求收敛和产品包初稿，形成可决策的投资命题。出口：CDCP 通过。',
    status: 'doing',
    priority: 'high',
    assignee: 'lin',
    labels: ['ipd', 'concept'],
    dueInDays: 14,
    subtasks: [
      {
        title: '市场机会与客户需求洞察',
        description: '细分市场、竞争格局、客户访谈与市场空间测算，输出机会评估结论。',
        status: 'done',
        priority: 'high',
        assignee: 'maya',
        labels: ['concept', 'market'],
        dueInDays: -2,
      },
      {
        title: '组建 PDT，明确 IPMT/PDT/LMT 角色',
        description: '确认产品经理、项目经理、系统工程师及各职能代表，明确决策与交付责任。',
        status: 'done',
        priority: 'high',
        assignee: 'lin',
        labels: ['concept', 'team'],
        dueInDays: -1,
      },
      {
        title: '产品包需求（Offering）初稿 · TR1',
        description: '把客户需求转成产品包需求，明确范围、关键特性与不做什么；TR1 评审需求完整性。',
        status: 'review',
        priority: 'high',
        assignee: 'maya',
        labels: ['tr1', 'offering'],
        dueInDays: 7,
      },
      {
        title: '初版业务计划与商业论证',
        description: '收入、成本、毛利、投入与回收周期假设，形成可被 IPMT 审视的业务计划。',
        status: 'doing',
        priority: 'high',
        assignee: 'lin',
        labels: ['concept', 'business-case'],
        dueInDays: 10,
      },
      {
        title: 'CDCP 概念决策评审',
        description: 'IPMT 决策继续、调整或终止。输入：机会评估、产品包需求、业务计划与风险清单。',
        status: 'todo',
        priority: 'high',
        assignee: 'lin',
        labels: ['cdcp', 'dcp'],
        dueInDays: 14,
      },
    ],
  },
  {
    stage: '计划',
    title: '需求基线与开发计划',
    description:
      '回答“怎么做、要多少资源”。锁定需求与总体方案，完成 DFX、资源预算和风险承诺。出口：PDCP 通过。',
    status: 'todo',
    priority: 'high',
    assignee: 'lin',
    labels: ['ipd', 'plan'],
    dueInDays: 42,
    subtasks: [
      {
        title: '需求分解 RR → IR → SR → AR',
        description: '建立需求追溯链：客户需求到初始需求、系统需求、分配需求，确保无遗漏、无失真。',
        status: 'todo',
        priority: 'high',
        assignee: 'atlas',
        labels: ['plan', 'requirements'],
        dueInDays: 21,
      },
      {
        title: '系统架构与产品规格 · TR2',
        description: '总体架构、接口、关键技术路径与规格基线；TR2 评审方案与需求的匹配度。',
        status: 'todo',
        priority: 'high',
        assignee: 'atlas',
        labels: ['tr2', 'architecture'],
        dueInDays: 28,
      },
      {
        title: 'DFX 需求拆解',
        description: '把可制造性、可测试性、可服务性、可供应性与成本要求前置进设计约束。',
        status: 'todo',
        priority: 'medium',
        assignee: 'maya',
        labels: ['plan', 'dfx'],
        dueInDays: 32,
      },
      {
        title: '项目计划、资源与预算基线',
        description: 'WBS、里程碑、人力与采购预算、关键依赖和风险应对，形成受控基线。',
        status: 'todo',
        priority: 'high',
        assignee: 'lin',
        labels: ['plan', 'resource'],
        dueInDays: 38,
      },
      {
        title: 'PDCP 计划决策评审',
        description: 'IPMT 对需求基线、总体方案、资源与预算做出承诺，通过后进入开发。',
        status: 'todo',
        priority: 'high',
        assignee: 'lin',
        labels: ['pdcp', 'dcp'],
        dueInDays: 42,
      },
    ],
  },
  {
    stage: '开发',
    title: '设计实现与系统集成',
    description:
      '按基线实现产品。完成概要设计、详细设计、实现与单元测试、系统集成和样机，技术评审 TR3–TR5 同步把关。',
    status: 'todo',
    priority: 'high',
    assignee: 'atlas',
    labels: ['ipd', 'develop'],
    dueInDays: 110,
    subtasks: [
      {
        title: '概要设计评审 · TR3',
        description: '模块划分、关键流程、接口与数据模型；确认与系统方案一致。',
        status: 'todo',
        priority: 'high',
        assignee: 'atlas',
        labels: ['tr3', 'design'],
        dueInDays: 55,
      },
      {
        title: '详细设计评审 · TR4',
        description: '关键模块详细设计、异常路径、性能与安全设计；评审可测试性与可维护性。',
        status: 'todo',
        priority: 'high',
        assignee: 'atlas',
        labels: ['tr4', 'design'],
        dueInDays: 68,
      },
      {
        title: '软硬件与结构开发、单元测试',
        description: '按详细设计实现，补齐单元测试与静态检查，保持需求追溯链更新。',
        status: 'todo',
        priority: 'high',
        assignee: 'lin',
        labels: ['develop', 'implementation'],
        dueInDays: 88,
      },
      {
        title: '系统集成与样机评审 · TR5',
        description: '完成系统联调、样机验证与集成测试；TR5 确认产品满足规格且具备进入验证阶段的条件。',
        status: 'todo',
        priority: 'high',
        assignee: 'atlas',
        labels: ['tr5', 'prototype'],
        dueInDays: 102,
      },
      {
        title: '知识产权、合规与 DFX 验证',
        description: '专利检索与申请、法规认证路径、DFX 设计落地检查，形成合规清单。',
        status: 'todo',
        priority: 'medium',
        assignee: 'maya',
        labels: ['develop', 'compliance'],
        dueInDays: 108,
      },
    ],
  },
  {
    stage: '验证',
    title: '测试、量产准备与 ADCP',
    description:
      '独立验证“做得对不对”。完成 EVT/DVT/PVT、缺陷收敛和 TR6，确认制造与服务就绪。出口：ADCP 通过。',
    status: 'todo',
    priority: 'high',
    assignee: 'lin',
    labels: ['ipd', 'verify'],
    dueInDays: 154,
    subtasks: [
      {
        title: '测试方案与用例评审',
        description: '覆盖功能、性能、可靠性、安全与兼容性；明确准入准出标准和缺陷分级。',
        status: 'todo',
        priority: 'high',
        assignee: 'atlas',
        labels: ['verify', 'test-plan'],
        dueInDays: 120,
      },
      {
        title: '工程验证 EVT 与设计验证 DVT',
        description: '验证设计是否满足规格，跟踪缺陷收敛趋势，完成根因分析与回归。',
        status: 'todo',
        priority: 'high',
        assignee: 'atlas',
        labels: ['verify', 'evt-dvt'],
        dueInDays: 132,
      },
      {
        title: '生产验证 PVT 与量产准备',
        description: '验证制造工艺、工装夹具、供应链与良率，确认可生产性与产能爬坡计划。',
        status: 'todo',
        priority: 'high',
        assignee: 'lin',
        labels: ['verify', 'pvt'],
        dueInDays: 142,
      },
      {
        title: 'TR6 量产/发布准备技术评审',
        description: '技术侧确认产品、制造、服务与文档均已就绪，遗留风险有明确闭环计划。',
        status: 'todo',
        priority: 'high',
        assignee: 'atlas',
        labels: ['tr6', 'readiness'],
        dueInDays: 148,
      },
      {
        title: 'ADCP 可获得性决策评审',
        description: 'IPMT 决策是否可上市。输入：验证报告、缺陷收敛、量产与服务准备、上市计划。',
        status: 'todo',
        priority: 'high',
        assignee: 'lin',
        labels: ['adcp', 'dcp'],
        dueInDays: 154,
      },
    ],
  },
  {
    stage: '发布',
    title: '上市与销售就绪',
    description:
      '让产品按时、按量达到一般可获得性。完成发布包、定价渠道、营销赋能、供应与服务准备，转入生命周期管理。',
    status: 'todo',
    priority: 'high',
    assignee: 'maya',
    labels: ['ipd', 'launch'],
    dueInDays: 182,
    subtasks: [
      {
        title: '发布包、定价与渠道策略',
        description: '确定版本、配置、价格带、渠道政策与发布节奏，冻结对外承诺。',
        status: 'todo',
        priority: 'medium',
        assignee: 'maya',
        labels: ['launch', 'gtm'],
        dueInDays: 162,
      },
      {
        title: '营销活动与销售赋能',
        description: '上市传播、销售工具包、竞品话术与培训认证，确保一线可卖、会卖。',
        status: 'todo',
        priority: 'medium',
        assignee: 'maya',
        labels: ['launch', 'marketing'],
        dueInDays: 168,
      },
      {
        title: '供应链、制造与备货就绪',
        description: '产能、物料、库存与交付周期确认，建立上市初期供应保障机制。',
        status: 'todo',
        priority: 'high',
        assignee: 'lin',
        labels: ['launch', 'supply'],
        dueInDays: 172,
      },
      {
        title: '服务、支持与文档准备',
        description: '服务策略、备件、知识库、用户文档与支持流程就绪。',
        status: 'todo',
        priority: 'medium',
        assignee: 'atlas',
        labels: ['launch', 'service'],
        dueInDays: 176,
      },
      {
        title: 'GA 发布与上市监控',
        description: '正式发布并监控首销、质量、交付与客户反馈，触发快速响应。',
        status: 'todo',
        priority: 'high',
        assignee: 'lin',
        labels: ['launch', 'ga'],
        dueInDays: 182,
      },
    ],
  },
  {
    stage: '生命周期',
    title: '运营、变更与退市',
    description:
      '从 GA 到退市。由 LMT 持续管理市场表现、质量、变更与版本，最终通过 LDCP 决策退市并完成知识沉淀。',
    status: 'todo',
    priority: 'medium',
    assignee: 'lin',
    labels: ['ipd', 'lifecycle'],
    dueInDays: 365,
    subtasks: [
      {
        title: '建立 LMT 与生命周期管理计划',
        description: '明确 LMT 成员、例会机制、质量与成本目标，以及生命周期 KPI。',
        status: 'todo',
        priority: 'medium',
        assignee: 'lin',
        labels: ['lifecycle', 'lmt'],
        dueInDays: 210,
      },
      {
        title: '市场表现、质量与客户反馈跟踪',
        description: '跟踪销量、毛利、故障率、客户满意度与竞争变化，形成月度运营视图。',
        status: 'todo',
        priority: 'medium',
        assignee: 'maya',
        labels: ['lifecycle', 'feedback'],
        dueInDays: 250,
      },
      {
        title: '变更、版本与配置管理',
        description: '受控管理需求变更、版本发布与配置基线，评估对成本与交付的影响。',
        status: 'todo',
        priority: 'medium',
        assignee: 'atlas',
        labels: ['lifecycle', 'change'],
        dueInDays: 290,
      },
      {
        title: '退市评估与 LDCP',
        description: '评估停售、停产、停服时点与替代方案，由 IPMT 做出生命周期决策。',
        status: 'todo',
        priority: 'low',
        assignee: 'lin',
        labels: ['ldcp', 'dcp'],
        dueInDays: 340,
      },
      {
        title: '项目复盘与知识资产沉淀',
        description: '复盘决策质量、进度成本偏差与 DFX 效果，沉淀模板、检查表和经验库。',
        status: 'todo',
        priority: 'low',
        assignee: 'atlas',
        labels: ['lifecycle', 'retrospective'],
        dueInDays: 365,
      },
    ],
  },
];

export function seedIpdTemplate(db: Db): IpdTemplateResult {
  const existing = db
    .prepare('SELECT id, key FROM projects WHERE UPPER(key) = UPPER(?)')
    .get(IPD_PROJECT_KEY) as { id: string; key: string } | undefined;
  if (existing) {
    const count = db
      .prepare('SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?')
      .get(existing.id) as { count: number };
    return {
      created: false,
      projectId: existing.id,
      projectKey: existing.key,
      taskCount: Number(count.count),
    };
  }

  return transaction(db, () => {
    const createdAt = nowIso();
    const people: Record<PersonKey, string> = {
      lin: resolveActor(db, 'act_lin', 'Lin', 'human', 'Project lead', createdAt),
      maya: resolveActor(db, 'act_maya', 'Maya', 'human', 'Product designer', createdAt),
      atlas: resolveActor(db, 'act_atlas', 'Atlas', 'agent', 'Project operations agent', createdAt),
    };

    const projectId = 'prj_ipd';
    db.prepare(
      `INSERT INTO projects (id, key, name, description, status, color, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(
      projectId,
      IPD_PROJECT_KEY,
      '【模板】IPD 新产品开发',
      '集成产品开发（IPD）六阶段模板：概念 → 计划 → 开发 → 验证 → 发布 → 生命周期。内置 CDCP/PDCP/ADCP/LDCP 决策评审与 TR1–TR6 技术评审检查点，可直接作为新产品导入项目复用。',
      '#0F766E',
      people.lin,
      createdAt,
      createdAt,
    );

    const addMember = db.prepare(
      'INSERT INTO project_members (project_id, actor_id, role, role_tag, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    addMember.run(projectId, people.lin, 'owner', '项目经理', createdAt);
    addMember.run(projectId, people.maya, 'member', '产品经理', createdAt);
    addMember.run(projectId, people.atlas, 'member', '项目运营', createdAt);

    interface Row extends TaskSeed {
      number: number;
      groupId: string;
    }

    const insertGroup = db.prepare(
      `INSERT INTO task_groups (id, project_id, name, description, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const rows: Row[] = [];
    let number = 0;
    for (const [index, phase] of PHASES.entries()) {
      const groupId = `grp_ipd_stage_${index + 1}`;
      insertGroup.run(groupId, projectId, phase.stage, phase.description, index, createdAt, createdAt);
      number += 1;
      for (const subtask of phase.subtasks) {
        number += 1;
        rows.push({ ...subtask, number, groupId });
      }
    }

    const insertTask = db.prepare(
      `INSERT INTO tasks
       (id, project_id, number, parent_task_id, group_id, title, description, status, priority,
        kind, assignee_id, created_by, start_at, due_at, labels, version, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    const insertTaskEvent = db.prepare(
      `INSERT INTO events (project_id, task_id, type, actor_id, payload, created_at)
       VALUES (?, ?, 'task.created', ?, ?, ?)`,
    );

    for (const row of rows) {
      insertTask.run(
        `tsk_ipd_${row.number}`,
        projectId,
        row.number,
        row.groupId,
        row.title,
        row.description,
        row.status,
        row.priority,
        row.kind ?? (isTrReviewTitle(row.title) ? 'milestone' : 'task'),
        people[row.assignee],
        people.lin,
        createdAt,
        at(row.dueInDays),
        JSON.stringify(row.labels),
        createdAt,
        createdAt,
        row.status === 'done' ? createdAt : null,
      );
    }

    backfillTaskAssignees(db);

    db.prepare(
      `INSERT INTO events (project_id, task_id, type, actor_id, payload, created_at)
       VALUES (?, NULL, 'project.created', ?, ?, ?)`,
    ).run(projectId, people.lin, JSON.stringify({ key: IPD_PROJECT_KEY }), createdAt);

    const insertGroupEvent = db.prepare(
      `INSERT INTO events (project_id, task_id, type, actor_id, payload, created_at)
       VALUES (?, NULL, 'group.created', ?, ?, ?)`,
    );
    for (const [index, phase] of PHASES.entries()) {
      insertGroupEvent.run(
        projectId,
        people.lin,
        JSON.stringify({
          groupId: `grp_ipd_stage_${index + 1}`,
          name: phase.stage,
          taskCount: phase.subtasks.length,
        }),
        createdAt,
      );
    }

    for (const row of [...rows].reverse()) {
      insertTaskEvent.run(
        projectId,
        `tsk_ipd_${row.number}`,
        people.lin,
        JSON.stringify({
          status: row.status,
          priority: row.priority,
          parentId: null,
          groupId: row.groupId,
        }),
        createdAt,
      );
    }

    const insertComment = db.prepare(
      'INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    insertComment.run(
      'cmt_ipd_1',
      'tsk_ipd_6',
      people.atlas,
      'CDCP 评审输入：市场机会评估、产品包需求、初版业务计划、风险与合规清单。评审输出：继续 / 调整 / 终止，以及下一阶段的资源承诺。',
      createdAt,
    );
    insertComment.run(
      'cmt_ipd_2',
      'tsk_ipd_12',
      people.lin,
      'PDCP 关注四件事：需求基线是否锁定、总体方案是否可行、资源预算是否匹配、关键风险是否有承诺的应对。',
      createdAt,
    );

    const automations = [
      {
        id: 'aut_ipd_gate_note',
        name: '阶段门完成自动留痕',
        triggerType: 'hook',
        triggerConfig: { event: 'task.status_changed', filter: { to: 'done' } },
        actionType: 'add_comment',
        actionConfig: {
          body: '✅ {{task.ref}} 已完成。请确认阶段门交付物、评审结论与遗留风险已归档，再推进下一阶段。',
        },
        nextRunAt: null as string | null,
      },
      {
        id: 'aut_ipd_urgent_triage',
        name: 'IPD 紧急风险自动分诊',
        triggerType: 'hook',
        triggerConfig: { event: 'task.created', filter: { priority: 'urgent' } },
        actionType: 'enqueue_agent',
        actionConfig: {
          agent: 'Atlas',
          title: 'IPD 风险分诊：{{task.title}}',
          prompt:
            '你是产品开发运营 Agent。阅读任务 {{task.ref}}「{{task.title}}」，判断它影响的 IPD 阶段与阶段门，给出影响范围、建议责任人和 3 条下一步行动，并评论到任务上。',
        },
        nextRunAt: null as string | null,
      },
      {
        id: 'aut_ipd_weekly_review',
        name: 'IPD 阶段门周检',
        triggerType: 'cron',
        triggerConfig: { expression: '0 10 * * 1', timezone: 'Asia/Shanghai' },
        actionType: 'enqueue_agent',
        actionConfig: {
          agent: 'Atlas',
          title: 'IPD 阶段门周检 · {{project.key}}',
          prompt:
            '检查项目 {{project.name}} 的阶段门健康度：列出逾期、阻塞和 7 天内到期的任务，按 CDCP/PDCP/ADCP/LDCP 指出缺失的评审输入，并给出不超过 5 条本周行动建议。日期：{{date}}。',
        },
        nextRunAt: nextCronRun('0 10 * * 1', 'Asia/Shanghai'),
      },
    ];

    const insertAutomation = db.prepare(
      `INSERT INTO automations
       (id, project_id, name, enabled, trigger_type, trigger_config, action_type, action_config,
        created_by, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const automation of automations) {
      insertAutomation.run(
        automation.id,
        projectId,
        automation.name,
        automation.triggerType,
        JSON.stringify(automation.triggerConfig),
        automation.actionType,
        JSON.stringify(automation.actionConfig),
        people.lin,
        automation.nextRunAt,
        createdAt,
        createdAt,
      );
    }

    db.prepare(
      `INSERT INTO agent_jobs
       (id, project_id, task_id, agent_id, title, prompt, context, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(
      'job_ipd_1',
      projectId,
      'tsk_ipd_6',
      people.atlas,
      'CDCP 材料完整性检查',
      '检查 CDCP 输入是否齐全：市场机会评估、产品包需求、初版业务计划、风险与合规清单。列出缺口，并给出评审前需补齐的 3 项行动。',
      JSON.stringify({ source: 'ipd-template', gate: 'CDCP', taskRef: 'IPD-6' }),
      people.lin,
      createdAt,
    );

    return {
      created: true,
      projectId,
      projectKey: IPD_PROJECT_KEY,
      taskCount: rows.length,
    };
  });
}
