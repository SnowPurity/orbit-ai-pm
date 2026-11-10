import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDatabase } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import { issueToken } from '../src/auth.js';
import { WeKnoraWorker, type WeKnoraClient } from '../src/core/weknora-worker.js';

interface ApiResponse<T = unknown> {
  status: number;
  body: { data?: T; error?: { code: string; message: string; details?: unknown } };
}

test('Orbit backend integration', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-test-'));
  const dbPath = path.join(dir, 'orbit.db');
  const db = openDatabase(dbPath);
  const seed = seedDatabase(db);
  assert(seed.humanToken && seed.agentToken);
  const config = loadConfig({ dbPath, schedulerEnabled: false, logLevel: 'silent' });
  const bundle = buildApp({ db, config, logger: false, scheduler: false });
  const { app, service, scheduler } = bundle;

  t.after(async () => {
    await app.close();
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const human = { authorization: `Bearer ${seed.humanToken}` };
  const agent = { authorization: `Bearer ${seed.agentToken}` };

  async function api<T = unknown>(
    method: string,
    url: string,
    headers: Record<string, string> = human,
    payload?: unknown,
  ): Promise<ApiResponse<T>> {
    const response = await app.inject({ method, url, headers, payload });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : {} };
  }

  await t.test('health is public and API requires a token', async () => {
    const health = await api('GET', '/health', {});
    assert.equal(health.status, 200);
    const unauthorized = await api('GET', '/api/v1/projects', {});
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error?.code, 'unauthorized');
  });

  await t.test('seeded board hides subtasks and reports progress', async () => {
    const board = await api<{
      columns: Array<{ status: string; tasks: Array<{ ref: string }> }>;
      stats: { total: number };
    }>('GET', '/api/v1/projects/ORB/board');
    assert.equal(board.status, 200);
    assert.equal(board.body.data?.stats.total, 6);
    const refs = board.body.data?.columns.flatMap((column) => column.tasks.map((task) => task.ref)) ?? [];
    assert(!refs.includes('ORB-7'));
    assert(refs.includes('ORB-2'));

    const task = await api<{ ref: string; progress: { done: number; total: number }; subtasks: unknown[] }>(
      'GET',
      '/api/v1/tasks/ORB-2',
    );
    assert.equal(task.status, 200);
    assert.deepEqual(task.body.data?.progress, { done: 1, total: 2 });
    assert.equal(task.body.data?.subtasks.length, 2);
  });

  await t.test('task groups drive board grouping and cascade to subtasks', async () => {
    const created = await api<{ id: string; name: string; progress: { done: number; total: number } }>(
      'POST',
      '/api/v1/projects/ORB/groups',
      human,
      { name: '发布准备', description: '上市前的发布与渠道检查' },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.data?.name, '发布准备');
    assert.deepEqual(created.body.data?.progress, { done: 0, total: 0 });
    const groupId = created.body.data?.id ?? '';

    const duplicate = await api('POST', '/api/v1/projects/ORB/groups', human, {
      name: '发布准备',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error?.code, 'group_name_taken');

    const second = await api<{ id: string }>('POST', '/api/v1/projects/ORB/groups', human, {
      name: '验证准备',
    });
    assert.equal(second.status, 201);
    const secondId = second.body.data?.id ?? '';

    const task = await api<{ ref: string; groupId: string; groupName: string; version: number }>(
      'POST',
      '/api/v1/projects/ORB/tasks',
      human,
      { title: '发布检查单', group: groupId },
    );
    assert.equal(task.status, 201);
    assert.equal(task.body.data?.groupId, groupId);
    assert.equal(task.body.data?.groupName, '发布准备');
    const taskRef = task.body.data?.ref ?? '';
    const taskVersion = task.body.data?.version ?? 1;

    const child = await api<{ ref: string; groupId: string }>(
      'POST',
      '/api/v1/projects/ORB/tasks',
      human,
      { title: '渠道清单', parent: taskRef },
    );
    assert.equal(child.status, 201);
    assert.equal(child.body.data?.groupId, groupId);

    const mismatch = await api('POST', '/api/v1/projects/ORB/tasks', human, {
      title: '跨组子任务',
      parent: taskRef,
      group: secondId,
    });
    assert.equal(mismatch.status, 400);

    await api('POST', '/api/v1/projects/ORB/tasks', human, {
      title: '验证计划',
      group: secondId,
    });

    const filtered = await api<Array<{ ref: string }>>(
      'GET',
      `/api/v1/projects/ORB/tasks?group=${encodeURIComponent(groupId)}`,
    );
    assert.deepEqual(filtered.body.data?.map((item) => item.ref), [taskRef]);

    const ungrouped = await api<Array<{ ref: string }>>(
      'GET',
      '/api/v1/projects/ORB/tasks?group=none',
    );
    assert(!ungrouped.body.data?.some((item) => item.ref === taskRef));

    const board = await api<{
      groups: Array<{ id: string; name: string; taskCount: number }>;
    }>('GET', '/api/v1/projects/ORB/board');
    const lane = board.body.data?.groups.find((group) => group.id === groupId);
    assert.equal(lane?.taskCount, 1);
    assert.equal(lane?.name, '发布准备');

    const moved = await api<{ groupId: string; groupName: string }>(
      'PATCH',
      `/api/v1/tasks/${taskRef}`,
      human,
      { group: secondId, version: taskVersion },
    );
    assert.equal(moved.status, 200);
    assert.equal(moved.body.data?.groupName, '验证准备');

    const movedChild = await api<{ groupId: string }>('GET', `/api/v1/tasks/${child.body.data?.ref}`);
    assert.equal(movedChild.body.data?.groupId, secondId);

    const renamed = await api<{ name: string; description: string }>(
      'PATCH',
      `/api/v1/groups/${secondId}`,
      human,
      {
        name: '验证与发布',
        description: '由 **验证** 与发布阶段组成，参考 ORB-1。',
      },
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data?.name, '验证与发布');
    assert.equal(renamed.body.data?.description, '由 **验证** 与发布阶段组成，参考 ORB-1。');
    const boardAfterRename = await api<{
      groups: Array<{ id: string; name: string; description: string }>;
    }>('GET', '/api/v1/projects/ORB/board');
    const renamedLane = boardAfterRename.body.data?.groups.find((group) => group.id === secondId);
    assert.equal(renamedLane?.description, '由 **验证** 与发布阶段组成，参考 ORB-1。');
    const refreshed = await api<{ groupName: string }>('GET', `/api/v1/tasks/${taskRef}`);
    assert.equal(refreshed.body.data?.groupName, '验证与发布');

    const removed = await api('DELETE', `/api/v1/groups/${secondId}`, human);
    assert.equal(removed.status, 204);
    const ungroupedTask = await api<{ groupId: string | null; groupName: string | null }>(
      'GET',
      `/api/v1/tasks/${taskRef}`,
    );
    assert.equal(ungroupedTask.body.data?.groupId, null);
    assert.equal(ungroupedTask.body.data?.groupName, null);

    await api('DELETE', `/api/v1/groups/${groupId}`, human);
    const activity = await api<Array<{ type: string }>>(
      'GET',
      '/api/v1/projects/ORB/activity?limit=100',
    );
    const types = activity.body.data?.map((event) => event.type) ?? [];
    assert(types.includes('group.created'));
    assert(types.includes('group.updated'));
    assert(types.includes('group.deleted'));
  });

  await t.test('task kind defaults to normal and can become a milestone', async () => {
    const normal = await api<{ ref: string; kind: string }>('POST', '/api/v1/projects/ORB/tasks', human, {
      title: '普通任务类型检查',
    });
    assert.equal(normal.status, 201);
    assert.equal(normal.body.data?.kind, 'task');

    const milestone = await api<{ ref: string; kind: string }>(
      'POST',
      '/api/v1/projects/ORB/tasks',
      human,
      { title: '里程碑类型检查', kind: 'milestone' },
    );
    assert.equal(milestone.status, 201);
    assert.equal(milestone.body.data?.kind, 'milestone');

    const updated = await api<{ kind: string }>(
      'PATCH',
      `/api/v1/tasks/${normal.body.data?.ref}`,
      human,
      { kind: 'milestone', version: 1 },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data?.kind, 'milestone');

    const invalid = await api('POST', '/api/v1/projects/ORB/tasks', human, {
      title: '非法类型',
      kind: 'epic',
    });
    assert.equal(invalid.status, 400);
  });

  await t.test('task start time defaults to creation and both times are editable', async () => {
    type TimeTask = { ref: string; startAt: string; createdAt: string; dueAt: string | null; version: number };
    const created = await api<TimeTask>('POST', '/api/v1/projects/ORB/tasks', human, {
      title: '时间字段检查',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data?.startAt, created.body.data?.createdAt);
    assert.equal(created.body.data?.dueAt, null);

    const startAt = '2026-12-01T10:00:00.000Z';
    const dueAt = '2026-12-05T18:00:00.000Z';
    const updated = await api<TimeTask>(
      'PATCH',
      `/api/v1/tasks/${created.body.data?.ref}`,
      human,
      { startAt, dueAt, version: created.body.data?.version },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data?.startAt, startAt);
    assert.equal(updated.body.data?.dueAt, dueAt);

    const clearedDue = await api<TimeTask>(
      'PATCH',
      `/api/v1/tasks/${updated.body.data?.ref}`,
      human,
      { dueAt: null, version: updated.body.data?.version },
    );
    assert.equal(clearedDue.status, 200);
    assert.equal(clearedDue.body.data?.dueAt, null);
    assert.equal(clearedDue.body.data?.startAt, startAt);

    const invalid = await api(
      'PATCH',
      `/api/v1/tasks/${created.body.data?.ref}`,
      human,
      { startAt: 'not-a-date', version: clearedDue.body.data?.version },
    );
    assert.equal(invalid.status, 400);
  });

  await t.test('nested subtasks are supported and completion cascades upward', async () => {
    const childOfDone = await api(
      'POST',
      '/api/v1/projects/ORB/tasks',
      human,
      { title: '已完成父任务的新子任务', parent: 'ORB-1' },
    );
    assert.equal(childOfDone.status, 409);
    assert.equal(childOfDone.body.error?.code, 'parent_done');

    const nested = await api<{ ref: string }>(
      'POST',
      '/api/v1/projects/ORB/tasks',
      human,
      { title: '三级任务', parent: 'ORB-8' },
    );
    assert.equal(nested.status, 201);
    const nestedRef = nested.body.data?.ref ?? '';

    const middle = await api<{ status: string; subtasks: Array<{ ref: string }> }>(
      'GET',
      '/api/v1/tasks/ORB-8',
    );
    assert.equal(middle.body.data?.subtasks.some((task) => task.ref === nestedRef), true);

    const prematureMiddle = await api('PATCH', '/api/v1/tasks/ORB-8', human, { status: 'done' });
    assert.equal(prematureMiddle.status, 409);
    assert.equal(prematureMiddle.body.error?.code, 'subtasks_incomplete');

    const completedNested = await api('PATCH', `/api/v1/tasks/${nestedRef}`, human, { status: 'done' });
    assert.equal(completedNested.status, 200);

    const finishedMiddle = await api<{ status: string; comments: Array<{ body: string }> }>(
      'GET',
      '/api/v1/tasks/ORB-8',
    );
    assert.equal(finishedMiddle.body.data?.status, 'done');
    assert(
      finishedMiddle.body.data?.comments.some((comment) => comment.body === '子任务已经全部完成'),
      'expected the middle task to be completed by automation',
    );

    const finishedParent = await api<{ status: string }>('GET', '/api/v1/tasks/ORB-2');
    assert.equal(finishedParent.body.data?.status, 'done');
  });

  await t.test('status hook adds an automatic comment', async () => {
    const updated = await api<{ ref: string; comments: Array<{ body: string; author: { kind: string } }> }>(
      'PATCH',
      '/api/v1/tasks/ORB-3',
      human,
      { status: 'done' },
    );
    assert.equal(updated.status, 200);
    const automatic = updated.body.data?.comments.find(
      (comment) => comment.author.kind === 'system' && comment.body.includes('ORB-3'),
    );
    assert(automatic, 'expected an automatic completion comment');

    const detail = await api<{ lastStatus: string; runCount: number; lastRun: { status: string } }>(
      'GET',
      '/api/v1/automations/aut_completion_note',
    );
    assert.equal(detail.body.data?.lastStatus, 'success');
    assert((detail.body.data?.runCount ?? 0) >= 1);
    assert.equal(detail.body.data?.lastRun.status, 'success');
  });

  await t.test('urgent task hook enqueues an agent job', async () => {
    const created = await api<{ ref: string; title: string }>(
      'POST',
      '/api/v1/projects/ORB/tasks',
      human,
      { title: '紧急：公网演示入口', priority: 'urgent', assignee: 'Lin' },
    );
    assert.equal(created.status, 201);
    const jobs = await api<Array<{ taskRef: string; status: string; agent: { name: string } }>>(
      'GET',
      '/api/v1/projects/ORB/jobs',
    );
    const job = jobs.body.data?.find((item) => item.taskRef === created.body.data?.ref);
    assert(job);
    assert.equal(job.status, 'queued');
    assert.equal(job.agent.name, 'Atlas');

    const normal = await api<{ ref: string }>('POST', '/api/v1/projects/ORB/tasks', human, {
      title: '普通任务不应触发分诊',
      priority: 'medium',
    });
    const after = await api<Array<{ taskRef: string }>>('GET', '/api/v1/projects/ORB/jobs');
    assert(!after.body.data?.some((item) => item.taskRef === normal.body.data?.ref));
  });

  await t.test('cron automation can be run manually and by the scheduler', async () => {
    const manual = await api<{ status: string; result: { type: string; jobId: string } }>(
      'POST',
      '/api/v1/automations/aut_morning_digest/run',
    );
    assert.equal(manual.status, 200);
    assert.equal(manual.body.data?.status, 'success');
    assert.equal(manual.body.data?.result.type, 'agent_job.created');

    db.prepare("UPDATE automations SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE id = 'aut_morning_digest'").run();
    const before = service.listJobs(service.getActor('act_lin'), 'ORB').length;
    const fired = scheduler.tick();
    assert.equal(fired, 1);
    const after = service.listJobs(service.getActor('act_lin'), 'ORB').length;
    assert.equal(after, before + 1);
    const row = db
      .prepare("SELECT next_run_at FROM automations WHERE id = 'aut_morning_digest'")
      .get() as unknown as { next_run_at: string };
    assert(new Date(row.next_run_at).getTime() > Date.now());
  });

  await t.test('automations can be created and deleted', async () => {
    const created = await api<{ id: string; name: string }>(
      'POST',
      '/api/v1/projects/ORB/automations',
      human,
      {
        name: '临时自动化',
        trigger: { type: 'hook', event: 'task.created', filter: { priority: 'low' } },
        action: { type: 'add_comment', config: { body: '临时规则' } },
      },
    );
    assert.equal(created.status, 201);
    const id = created.body.data?.id ?? '';

    const deleted = await api('DELETE', `/api/v1/automations/${id}`, human);
    assert.equal(deleted.status, 204);

    const missing = await api('GET', `/api/v1/automations/${id}`, human);
    assert.equal(missing.status, 404);

    const activity = await api<Array<{ type: string; payload: { automationId?: string } }>>(
      'GET',
      '/api/v1/projects/ORB/activity?limit=50',
    );
    assert(
      activity.body.data?.some(
        (event) => event.type === 'automation.deleted' && event.payload.automationId === id,
      ),
    );
  });

  await t.test('task-scoped automations only run for their task', async () => {
    const taskA = await api<{ ref: string }>('POST', '/api/v1/projects/ORB/tasks', human, {
      title: '范围规则任务 A',
    });
    const taskB = await api<{ ref: string }>('POST', '/api/v1/projects/ORB/tasks', human, {
      title: '范围规则任务 B',
    });
    const refA = taskA.body.data?.ref ?? '';
    const refB = taskB.body.data?.ref ?? '';

    const created = await api<{ id: string; scope: string; taskRef: string }>(
      'POST',
      '/api/v1/projects/ORB/automations',
      human,
      {
        name: '仅任务 A 留痕',
        task: refA,
        trigger: { type: 'hook', event: 'task.status_changed', filter: { to: 'doing' } },
        action: { type: 'add_comment', config: { body: '任务级规则命中 {{task.ref}}' } },
      },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.data?.scope, 'task');
    assert.equal(created.body.data?.taskRef, refA);
    const hookId = created.body.data?.id ?? '';

    const movedA = await api('PATCH', `/api/v1/tasks/${refA}`, human, { status: 'doing' });
    assert.equal(movedA.status, 200);
    const detailA = await api<{ comments: Array<{ body: string; author: { kind: string } }> }>(
      'GET',
      `/api/v1/tasks/${refA}`,
    );
    assert(
      detailA.body.data?.comments.some(
        (comment) => comment.author.kind === 'system' && comment.body.includes(refA),
      ),
    );

    await api('PATCH', `/api/v1/tasks/${refB}`, human, { status: 'doing' });
    const detailB = await api<{ comments: Array<{ body: string }> }>('GET', `/api/v1/tasks/${refB}`);
    assert(!detailB.body.data?.comments.some((comment) => comment.body.includes('任务级规则命中')));

    const unscopedCron = await api(
      'POST',
      '/api/v1/projects/ORB/automations',
      human,
      {
        name: '全局定时评论',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'add_comment', config: { body: 'no task context' } },
      },
    );
    assert.equal(unscopedCron.status, 400);

    const scopedCron = await api<{ id: string; scope: string }>(
      'POST',
      '/api/v1/projects/ORB/automations',
      human,
      {
        name: '任务 A 定时提醒',
        task: refA,
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'add_comment', config: { body: '定时提醒 {{task.ref}}' } },
      },
    );
    assert.equal(scopedCron.status, 201);
    assert.equal(scopedCron.body.data?.scope, 'task');
    const cronId = scopedCron.body.data?.id ?? '';
    const run = await api<{ status: string; result: { taskRef: string } }>(
      'POST',
      `/api/v1/automations/${cronId}/run`,
    );
    assert.equal(run.status, 200);
    assert.equal(run.body.data?.status, 'success');
    assert.equal(run.body.data?.result.taskRef, refA);

    const refreshed = await api<{ comments: Array<{ body: string }> }>('GET', `/api/v1/tasks/${refA}`);
    assert(refreshed.body.data?.comments.some((comment) => comment.body.includes('定时提醒')));

    await api('DELETE', `/api/v1/automations/${hookId}`, human);
    await api('DELETE', `/api/v1/automations/${cronId}`, human);
  });

  await t.test('agent job is assignee-only and follows claim/complete lifecycle', async () => {
    const humanClaim = await api('POST', '/api/v1/jobs/job_demo_1/claim', human);
    assert.equal(humanClaim.status, 409);
    assert.equal(humanClaim.body.error?.code, 'job_assigned_elsewhere');

    const claimed = await api<{ status: string; claimedBy: { name: string } }>(
      'POST',
      '/api/v1/jobs/job_demo_1/claim',
      agent,
    );
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.data?.status, 'claimed');
    assert.equal(claimed.body.data?.claimedBy.name, 'Atlas');

    const completed = await api<{ status: string; result: string }>(
      'POST',
      '/api/v1/jobs/job_demo_1/complete',
      agent,
      { result: '已补充 5 个失败场景，并评论到 ORB-2。' },
    );
    assert.equal(completed.status, 200);
    assert.equal(completed.body.data?.status, 'done');
    assert(completed.body.data?.result.includes('5 个失败场景'));
  });

  await t.test('optimistic version and activity stream work', async () => {
    const task = await api<{ version: number }>('GET', '/api/v1/tasks/ORB-6');
    const version = task.body.data?.version ?? 0;
    const updated = await api('PATCH', '/api/v1/tasks/ORB-6', human, {
      title: '编写 3 分钟演示脚本（修订）',
      version,
    });
    assert.equal(updated.status, 200);
    const stale = await api('PATCH', '/api/v1/tasks/ORB-6', human, {
      title: '过期写入',
      version,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error?.code, 'version_conflict');

    const activity = await api<Array<{ type: string; taskRef: string | null }>>(
      'GET',
      '/api/v1/projects/ORB/activity?limit=50',
    );
    assert((activity.body.data?.length ?? 0) > 10);
    assert(activity.body.data?.some((event) => event.type === 'comment.created'));
    assert(activity.body.data?.some((event) => event.type === 'job.created'));
  });

  await t.test('tasks support multiple assignees and assignee filters', async () => {
    const created = await api<{
      ref: string;
      version: number;
      assignee: { name: string } | null;
      assignees: Array<{ name: string }>;
    }>('POST', '/api/v1/projects/ORB/tasks', human, {
      title: '多负责人联调',
      assignees: ['Lin', 'Maya'],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.data?.assignees.map((item) => item.name), ['Lin', 'Maya']);
    assert.equal(created.body.data?.assignee?.name, 'Lin');
    const ref = created.body.data?.ref ?? '';

    const mayaTasks = await api<Array<{ ref: string }>>(
      'GET',
      '/api/v1/projects/ORB/tasks?assignee=Maya&limit=100',
    );
    assert(mayaTasks.body.data?.some((task) => task.ref === ref));

    const updated = await api<{ version: number; assignees: Array<{ name: string }> }>(
      'PATCH',
      `/api/v1/tasks/${ref}`,
      human,
      { assignees: ['Maya'], version: created.body.data?.version },
    );
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.data?.assignees.map((item) => item.name), ['Maya']);

    const cleared = await api<{ assignees: unknown[] }>('PATCH', `/api/v1/tasks/${ref}`, human, {
      assignees: [],
      version: updated.body.data?.version,
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data?.assignees.length, 0);

    const unassigned = await api<Array<{ ref: string }>>(
      'GET',
      '/api/v1/projects/ORB/tasks?assignee=unassigned&limit=100',
    );
    assert(unassigned.body.data?.some((task) => task.ref === ref));
  });

  await t.test('people and agents can be created and added to a project', async () => {
    const created = await api<{ id: string; name: string; kind: string; externalAgentId: string }>(
      'POST',
      '/api/v1/actors',
      human,
      { name: '代码评审 Agent', kind: 'agent', title: '自动评审', externalAgentId: 'wk-agent-demo' },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.data?.kind, 'agent');
    assert.equal(created.body.data?.externalAgentId, 'wk-agent-demo');
    const agentId = created.body.data?.id ?? '';

    const duplicate = await api('POST', '/api/v1/actors', human, {
      name: '代码评审 Agent',
      kind: 'agent',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error?.code, 'actor_name_taken');

    const added = await api<Array<{ actor: { id: string }; role: string }>>(
      'POST',
      '/api/v1/projects/ORB/members',
      human,
      { actor: agentId, role: 'member' },
    );
    assert.equal(added.status, 201);
    assert(added.body.data?.some((member) => member.actor.id === agentId));

    const directory = await api<Array<{ id: string; kind: string }>>('GET', '/api/v1/actors?kind=agent');
    assert(directory.body.data?.some((actor) => actor.id === agentId));
    assert(!directory.body.data?.some((actor) => actor.kind === 'system'));

    const temp = await api<{ id: string }>('POST', '/api/v1/actors', human, { name: '临时成员' });
    assert.equal(temp.status, 201);
    const tempId = temp.body.data?.id ?? '';
    const tempAdded = await api('POST', '/api/v1/projects/ORB/members', human, {
      actor: tempId,
      role: 'member',
    });
    assert.equal(tempAdded.status, 201);
    const removed = await api('DELETE', `/api/v1/projects/ORB/members/${tempId}`, human);
    assert.equal(removed.status, 204);
    const members = await api<Array<{ actor: { id: string } }>>('GET', '/api/v1/projects/ORB/members');
    assert(!members.body.data?.some((member) => member.actor.id === tempId));
  });

  await t.test('project role tags are one per project and editable by owners or the member', async () => {
    const maya = { authorization: `Bearer ${issueToken(db, 'act_maya').token}` };

    const seeded = await api<Array<{ actor: { id: string }; roleTag: string | null }>>(
      'GET',
      '/api/v1/projects/ORB/members',
    );
    assert.equal(seeded.body.data?.find((member) => member.actor.id === 'act_maya')?.roleTag, '产品设计');

    const ownProject = await api<{ key: string }>('POST', '/api/v1/projects', maya, {
      key: 'MROLE',
      name: 'Maya role project',
    });
    assert.equal(ownProject.status, 201);

    const memberships = await api<Array<{ project: { key: string }; roleTag: string | null }>>(
      'GET',
      '/api/v1/actors/act_maya/memberships',
    );
    assert.deepEqual(memberships.body.data?.map((entry) => entry.project.key), ['ORB']);

    const selfEdit = await api<Array<{ actor: { id: string }; roleTag: string | null }>>(
      'PATCH',
      '/api/v1/projects/ORB/members/act_maya',
      maya,
      { roleTag: '体验负责人' },
    );
    assert.equal(selfEdit.status, 200);
    assert.equal(selfEdit.body.data?.find((member) => member.actor.id === 'act_maya')?.roleTag, '体验负责人');

    const forbidden = await api('PATCH', '/api/v1/projects/ORB/members/act_lin', maya, { roleTag: '越权' });
    assert.equal(forbidden.status, 403);

    const ownerEdit = await api<Array<{ actor: { id: string }; roleTag: string | null }>>(
      'PATCH',
      '/api/v1/projects/ORB/members/act_maya',
      human,
      { roleTag: '设计负责人' },
    );
    assert.equal(ownerEdit.status, 200);
    assert.equal(ownerEdit.body.data?.find((member) => member.actor.id === 'act_maya')?.roleTag, '设计负责人');

    const cleared = await api<Array<{ actor: { id: string }; roleTag: string | null }>>(
      'PATCH',
      '/api/v1/projects/ORB/members/act_maya',
      human,
      { roleTag: null },
    );
    assert.equal(cleared.body.data?.find((member) => member.actor.id === 'act_maya')?.roleTag, null);

    const tooLong = await api('PATCH', '/api/v1/projects/ORB/members/act_maya', human, {
      roleTag: 'x'.repeat(41),
    });
    assert.equal(tooLong.status, 400);
  });

  await t.test('project descriptions are editable by members and recorded as events', async () => {
    const updated = await api<{ description: string }>('PATCH', '/api/v1/projects/ORB', human, {
      description: '## 项目说明\n\n联调见 ORB-2 和 #[发布准备]，背景见 #ORB。',
    });
    assert.equal(updated.status, 200);
    assert.match(updated.body.data?.description ?? '', /ORB-2/);

    const detail = await api<{ description: string }>('GET', '/api/v1/projects/ORB');
    assert.match(detail.body.data?.description ?? '', /发布准备/);

    const activity = await api<Array<{ type: string; payload: { key?: string } }>>(
      'GET',
      '/api/v1/projects/ORB/activity?limit=10',
    );
    assert(
      activity.body.data?.some(
        (event) => event.type === 'project.updated' && event.payload.key === 'ORB',
      ),
    );

    const maya = { authorization: `Bearer ${issueToken(db, 'act_maya').token}` };
    const memberEdit = await api('PATCH', '/api/v1/projects/ORB', maya, {
      description: '成员也可以更新项目说明',
    });
    assert.equal(memberEdit.status, 200);

    const outsider = await api('PATCH', '/api/v1/projects/MROLE', human, {
      description: '越权修改',
    });
    assert.equal(outsider.status, 403);
  });

  await t.test('project name and key are editable and task refs follow the key', async () => {
    const created = await api('POST', '/api/v1/projects', human, {
      key: 'PINFO',
      name: '项目信息编辑',
    });
    assert.equal(created.status, 201);
    const task = await api<{ ref: string }>('POST', '/api/v1/projects/PINFO/tasks', human, {
      title: '改代号前的任务',
    });
    assert.equal(task.body.data?.ref, 'PINFO-1');

    const renamed = await api<{ key: string; name: string }>('PATCH', '/api/v1/projects/PINFO', human, {
      key: 'pinfo2',
      name: '项目信息已更新',
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data?.key, 'PINFO2');
    assert.equal(renamed.body.data?.name, '项目信息已更新');

    const moved = await api<{ ref: string; projectKey: string }>('GET', '/api/v1/tasks/PINFO2-1');
    assert.equal(moved.status, 200);
    assert.equal(moved.body.data?.ref, 'PINFO2-1');
    assert.equal(moved.body.data?.projectKey, 'PINFO2');

    const old = await api('GET', '/api/v1/projects/PINFO');
    assert.equal(old.status, 404);

    const duplicate = await api('PATCH', '/api/v1/projects/PINFO2', human, { key: 'ORB' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error?.code, 'project_key_taken');

    const invalid = await api('PATCH', '/api/v1/projects/PINFO2', human, { key: '9BAD' });
    assert.equal(invalid.status, 400);
  });

  await t.test('project keys support hyphenated sub-project suffixes', async () => {
    const created = await api<{ key: string }>('POST', '/api/v1/projects', human, {
      key: 'mouse-req',
      name: '鼠标需求子项目',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data?.key, 'MOUSE-REQ');

    const task = await api<{ ref: string; projectKey: string }>(
      'POST',
      '/api/v1/projects/MOUSE-REQ/tasks',
      human,
      { title: '需求条目' },
    );
    assert.equal(task.status, 201);
    assert.equal(task.body.data?.ref, 'MOUSE-REQ-1');
    assert.equal(task.body.data?.projectKey, 'MOUSE-REQ');

    const child = await api<{ ref: string; parentRef: string }>(
      'POST',
      '/api/v1/projects/MOUSE-REQ/tasks',
      human,
      { title: '需求子项', parent: 'MOUSE-REQ-1' },
    );
    assert.equal(child.body.data?.ref, 'MOUSE-REQ-2');
    assert.equal(child.body.data?.parentRef, 'MOUSE-REQ-1');

    const fetched = await api<{ ref: string; projectKey: string }>(
      'GET',
      '/api/v1/tasks/MOUSE-REQ-2',
    );
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data?.projectKey, 'MOUSE-REQ');

    const renamed = await api<{ key: string }>('PATCH', '/api/v1/projects/MOUSE-REQ', human, {
      key: 'mouse-test',
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data?.key, 'MOUSE-TEST');
    const moved = await api<{ ref: string }>('GET', '/api/v1/tasks/MOUSE-TEST-1');
    assert.equal(moved.body.data?.ref, 'MOUSE-TEST-1');

    const duplicate = await api('POST', '/api/v1/projects', human, {
      key: 'MOUSE-TEST',
      name: '重复子项目',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error?.code, 'project_key_taken');

    for (const key of ['MOUSE--REQ', 'MOUSE-', '-MOUSE', 'MOUSE_REQ', 'M']) {
      const invalid = await api('POST', '/api/v1/projects', human, { key, name: '非法代号' });
      assert.equal(invalid.status, 400, `expected 400 for ${key}`);
    }
  });

  await t.test('assigning an Agent-suffixed member creates a fixed automation', async () => {
    const task = await api<{ ref: string }>('POST', '/api/v1/projects/ORB/tasks', human, {
      title: '自动评审规则任务',
      assignees: ['代码评审 Agent'],
    });
    assert.equal(task.status, 201);
    const ref = task.body.data?.ref ?? '';

    const automations = await api<
      Array<{
        id: string;
        scope: string;
        taskRef: string | null;
        trigger: { type: string; event?: string; filter?: Record<string, unknown> };
        action: { type: string; config: { auto?: boolean; agent?: string } };
      }>
    >('GET', '/api/v1/projects/ORB/automations');
    const auto = automations.body.data?.find(
      (automation) =>
        automation.scope === 'task' &&
        automation.taskRef === ref &&
        automation.action.type === 'enqueue_agent' &&
        automation.action.config.auto === true,
    );
    assert(auto, 'expected an automatic agent automation');
    assert.equal(auto?.trigger.type, 'hook');
    assert.equal(auto?.trigger.event, 'task.status_changed');
    assert.deepEqual(auto?.trigger.filter, { to: 'review' });
    assert.equal(auto?.action.config.agent, '代码评审 Agent');

    const jobs = await api<Array<{ taskRef: string | null; status: string; agent: { name: string } }>>(
      'GET',
      '/api/v1/projects/ORB/jobs',
    );
    const job = jobs.body.data?.find(
      (item) => item.taskRef === ref && item.agent.name === '代码评审 Agent',
    );
    assert(job, 'expected the automatic job to be enqueued');
    assert.equal(job?.status, 'queued');

    const detail = await api<{ version: number }>('GET', `/api/v1/tasks/${ref}`);
    const unassigned = await api('PATCH', `/api/v1/tasks/${ref}`, human, {
      assignees: [],
      version: detail.body.data?.version,
    });
    assert.equal(unassigned.status, 200);

    const after = await api<Array<{ id: string }>>('GET', '/api/v1/projects/ORB/automations');
    assert(!after.body.data?.some((automation) => automation.id === auto?.id));

    const fakeClient = {
      createSession: async () => 'session-test',
      chat: async () => '自动评审：建议补充回滚方案与监控告警。',
    } as unknown as WeKnoraClient;
    const worker = new WeKnoraWorker(
      service,
      { baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key', defaultAgentId: null },
      60_000,
      { error: () => {} },
      fakeClient,
    );
    const processed = await worker.tick();
    assert.equal(processed, 1);
    const workerJobs = await api<Array<{ id: string; taskRef: string | null; status: string; result: string }>>(
      'GET',
      '/api/v1/projects/ORB/jobs?limit=100',
    );
    const finished = workerJobs.body.data?.find((item) => item.taskRef === ref);
    assert.equal(finished?.status, 'done');
    assert(finished?.result.includes('回滚方案'));

    const commented = await api<{ comments: Array<{ body: string; author: { kind: string } }> }>(
      'GET',
      `/api/v1/tasks/${ref}`,
    );
    assert(
      commented.body.data?.comments.some(
        (comment) => comment.author.kind === 'agent' && comment.body.includes('回滚方案'),
      ),
    );
    assert.equal(await worker.tick(), 0);
  });

  await t.test('personal task feed aggregates related tasks across joined projects', async () => {
    const project = await api('POST', '/api/v1/projects', human, {
      key: 'MYP',
      name: '个人页测试',
    });
    assert.equal(project.status, 201);

    const assignedTask = await api<{ ref: string; projectKey: string }>(
      'POST',
      '/api/v1/projects/MYP/tasks',
      human,
      { title: '个人页指派任务', assignees: ['Lin'], status: 'todo' },
    );
    const createdTask = await api<{ ref: string }>('POST', '/api/v1/projects/MYP/tasks', human, {
      title: '个人页创建任务',
      status: 'done',
    });
    const milestoneTask = await api<{ ref: string; kind: string }>(
      'POST',
      '/api/v1/projects/MYP/tasks',
      human,
      { title: '个人页里程碑', kind: 'milestone', assignees: ['Lin'], status: 'todo' },
    );
    const overdueTask = await api<{ ref: string; dueAt: string }>(
      'POST',
      '/api/v1/projects/MYP/tasks',
      human,
      { title: '个人页逾期', assignees: ['Lin'], status: 'todo', dueAt: '2000-01-01' },
    );
    assert.equal(assignedTask.status, 201);
    assert.equal(createdTask.status, 201);
    assert.equal(milestoneTask.status, 201);
    assert.equal(overdueTask.status, 201);
    assert.equal(milestoneTask.body.data?.kind, 'milestone');
    const assignedRef = assignedTask.body.data?.ref ?? '';
    const createdRef = createdTask.body.data?.ref ?? '';
    const milestoneRef = milestoneTask.body.data?.ref ?? '';
    const overdueRef = overdueTask.body.data?.ref ?? '';

    const related = await api<{
      items: Array<{ ref: string; projectKey: string; status: string }>;
      stats: { total: number; done: number };
    }>('GET', '/api/v1/me/tasks?scope=related&limit=100');
    assert.equal(related.status, 200);
    const relatedRefs = related.body.data?.items.map((task) => task.ref) ?? [];
    assert(relatedRefs.includes(assignedRef));
    assert(relatedRefs.includes(createdRef));
    assert(related.body.data?.items.some((task) => task.projectKey === 'MYP'));
    assert.equal(related.body.data?.stats.total, relatedRefs.length);
    assert.ok((related.body.data?.stats.done ?? 0) >= 1);

    const assigned = await api<{ items: Array<{ ref: string }> }>(
      'GET',
      '/api/v1/me/tasks?scope=assigned&limit=100',
    );
    const assignedRefs = assigned.body.data?.items.map((task) => task.ref) ?? [];
    assert(assignedRefs.includes(assignedRef));
    assert(!assignedRefs.includes(createdRef));

    const created = await api<{ items: Array<{ ref: string }> }>(
      'GET',
      '/api/v1/me/tasks?scope=created&limit=100',
    );
    const createdRefs = created.body.data?.items.map((task) => task.ref) ?? [];
    assert(createdRefs.includes(createdRef));
    assert(createdRefs.includes(assignedRef));

    const milestones = await api<{ items: Array<{ ref: string; kind: string }> }>(
      'GET',
      '/api/v1/me/tasks?scope=assigned&kind=milestone&limit=100',
    );
    assert.deepEqual(milestones.body.data?.items.map((task) => task.ref), [milestoneRef]);
    const normalTasks = await api<{ items: Array<{ ref: string }> }>(
      'GET',
      '/api/v1/me/tasks?scope=assigned&kind=task&limit=100',
    );
    const normalRefs = normalTasks.body.data?.items.map((task) => task.ref) ?? [];
    assert(normalRefs.includes(assignedRef));
    assert(!normalRefs.includes(milestoneRef));
    assert.equal((await api('GET', '/api/v1/me/tasks?kind=epic')).status, 400);

    const searched = await api<{ items: Array<{ ref: string }> }>(
      'GET',
      `/api/v1/me/tasks?scope=related&q=${encodeURIComponent('个人页里程碑')}&limit=100`,
    );
    assert.deepEqual(searched.body.data?.items.map((task) => task.ref), [milestoneRef]);
    const noMatch = await api<{ items: unknown[] }>(
      'GET',
      `/api/v1/me/tasks?scope=related&q=${encodeURIComponent('不存在的任务关键词')}&limit=100`,
    );
    assert.equal(noMatch.body.data?.items.length, 0);

    const overdue = await api<{ items: Array<{ ref: string; status: string; dueAt: string }> }>(
      'GET',
      '/api/v1/me/tasks?scope=assigned&overdue=true&limit=100',
    );
    const overdueRefs = overdue.body.data?.items.map((task) => task.ref) ?? [];
    assert(overdueRefs.includes(overdueRef));
    assert(
      overdue.body.data?.items.every(
        (task) => task.status !== 'done' && new Date(task.dueAt).getTime() < Date.now(),
      ),
    );

    const done = await api<{ items: Array<{ ref: string; status: string }> }>(
      'GET',
      '/api/v1/me/tasks?status=done&limit=100',
    );
    assert(done.body.data?.items.every((task) => task.status === 'done'));
    assert((done.body.data?.items.map((task) => task.ref) ?? []).includes(createdRef));

    const firstPage = await api<{ items: Array<{ ref: string }>; hasMore: boolean }>(
      'GET',
      '/api/v1/me/tasks?scope=related&limit=1&offset=0',
    );
    const secondPage = await api<{ items: Array<{ ref: string }>; hasMore: boolean }>(
      'GET',
      '/api/v1/me/tasks?scope=related&limit=1&offset=1',
    );
    assert.equal(firstPage.body.data?.hasMore, true);
    assert.equal(firstPage.body.data?.items.length, 1);
    assert.notEqual(firstPage.body.data?.items[0]?.ref, secondPage.body.data?.items[0]?.ref);

    const unauthorized = await api('GET', '/api/v1/me/tasks', {});
    assert.equal(unauthorized.status, 401);
  });
});
