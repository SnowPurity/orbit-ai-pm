import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDatabase } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import type { TaskDetail } from '../src/types.js';

test('unmet predecessor dependencies soft-block status progression by type', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-dependencies-block-'));
  const dbPath = path.join(dir, 'orbit.db');
  const db = openDatabase(dbPath);
  const seed = seedDatabase(db);
  const config = loadConfig({ dbPath, schedulerEnabled: false, logLevel: 'silent' });
  const bundle = buildApp({ db, config, logger: false, scheduler: false });
  const human = { authorization: `Bearer ${seed.humanToken}` };

  const create = async (title: string): Promise<string> => {
    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/projects/ORB/tasks',
      headers: human,
      payload: { title },
    });
    assert.equal(response.statusCode, 201);
    return JSON.parse(response.body).data.ref as string;
  };

  const add = (successor: string, task: string, type: string) =>
    bundle.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${successor}/dependencies`,
      headers: human,
      payload: { task, direction: 'predecessor', type },
    });

  const patch = (ref: string, payload: Record<string, unknown>) =>
    bundle.app.inject({ method: 'PATCH', url: `/api/v1/tasks/${ref}`, headers: human, payload });

  const statusOf = async (ref: string): Promise<string> => {
    const response = await bundle.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${ref}`,
      headers: human,
    });
    assert.equal(response.statusCode, 200);
    return JSON.parse(response.body).data.status as string;
  };

  try {
    // finish_to_start: blocks starting until the predecessor is done
    const pred = await create('阻塞验证-前置');
    const succ = await create('阻塞验证-后置');
    assert.equal((await add(succ, pred, 'finish_to_start')).statusCode, 201);

    const blockedStart = await patch(succ, { status: 'doing' });
    assert.equal(blockedStart.statusCode, 409);
    const blockedStartBody = JSON.parse(blockedStart.body);
    assert.equal(blockedStartBody.error.code, 'dependency_blocked');
    const unmet = blockedStartBody.error.details.unmet;
    assert.equal(unmet.length, 1);
    assert.ok(unmet[0].dependencyId);
    assert.equal(unmet[0].type, 'finish_to_start');
    assert.equal(unmet[0].requirement, 'done');
    assert.deepEqual(unmet[0].task, { id: unmet[0].task.id, ref: pred, title: '阻塞验证-前置', status: 'todo' });
    assert.equal(await statusOf(succ), 'todo');

    const titleEdit = await patch(succ, { title: '阻塞验证-后置（改名）' });
    assert.equal(titleEdit.statusCode, 200);
    assert.equal(JSON.parse(titleEdit.body).data.title, '阻塞验证-后置（改名）');

    assert.equal((await patch(pred, { status: 'done' })).statusCode, 200);
    const unblocked = await patch(succ, { status: 'doing' });
    assert.equal(unblocked.statusCode, 200);
    assert.equal(JSON.parse(unblocked.body).data.status, 'doing');

    // start_to_start: blocks starting until the predecessor starts
    const s2sPred = await create('阻塞验证-S2S 前置');
    const s2sSucc = await create('阻塞验证-S2S 后置');
    await add(s2sSucc, s2sPred, 'start_to_start');
    assert.equal((await patch(s2sSucc, { status: 'doing' })).statusCode, 409);
    await patch(s2sPred, { status: 'doing' });
    assert.equal((await patch(s2sSucc, { status: 'doing' })).statusCode, 200);

    // finish_to_finish: starting is allowed, completion is blocked until the predecessor is done
    const f2fPred = await create('阻塞验证-F2F 前置');
    const f2fSucc = await create('阻塞验证-F2F 后置');
    await add(f2fSucc, f2fPred, 'finish_to_finish');
    assert.equal((await patch(f2fSucc, { status: 'doing' })).statusCode, 200);
    const f2fBlocked = await patch(f2fSucc, { status: 'done' });
    assert.equal(f2fBlocked.statusCode, 409);
    assert.equal(JSON.parse(f2fBlocked.body).error.details.unmet[0].requirement, 'done');
    await patch(f2fPred, { status: 'done' });
    assert.equal((await patch(f2fSucc, { status: 'done' })).statusCode, 200);

    // start_to_finish: completion needs the predecessor to have started
    const s2fPred = await create('阻塞验证-S2F 前置');
    const s2fSucc = await create('阻塞验证-S2F 后置');
    await add(s2fSucc, s2fPred, 'start_to_finish');
    assert.equal((await patch(s2fSucc, { status: 'doing' })).statusCode, 200);
    const s2fBlocked = await patch(s2fSucc, { status: 'done' });
    assert.equal(s2fBlocked.statusCode, 409);
    assert.equal(JSON.parse(s2fBlocked.body).error.details.unmet[0].requirement, 'started');
    await patch(s2fPred, { status: 'doing' });
    assert.equal((await patch(s2fSucc, { status: 'done' })).statusCode, 200);

    // moving backwards is not blocked by predecessor state
    await patch(f2fPred, { status: 'todo' });
    assert.equal((await patch(f2fSucc, { status: 'doing' })).statusCode, 200);
  } finally {
    await bundle.app.close();
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task dependencies support four types, both directions, multiple links and validation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-dependencies-'));
  const dbPath = path.join(dir, 'orbit.db');
  const db = openDatabase(dbPath);
  const seed = seedDatabase(db);
  const config = loadConfig({ dbPath, schedulerEnabled: false, logLevel: 'silent' });
  const bundle = buildApp({ db, config, logger: false, scheduler: false });
  const human = { authorization: `Bearer ${seed.humanToken}` };

  const detail = async (ref: string): Promise<TaskDetail> => {
    const response = await bundle.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${ref}`,
      headers: human,
    });
    assert.equal(response.statusCode, 200);
    return JSON.parse(response.body).data as TaskDetail;
  };

  const add = (ref: string, payload: Record<string, unknown>) =>
    bundle.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${ref}/dependencies`,
      headers: human,
      payload,
    });

  try {
    const initial = await detail('ORB-2');
    assert.deepEqual(initial.dependencies, { predecessors: [], successors: [] });

    const first = await add('ORB-2', {
      task: 'ORB-1',
      direction: 'predecessor',
      type: 'finish_to_start',
    });
    assert.equal(first.statusCode, 201);
    const firstDetail = JSON.parse(first.body).data as TaskDetail;
    assert.equal(firstDetail.dependencies.predecessors.length, 1);
    assert.equal(firstDetail.dependencies.predecessors[0].task.ref, 'ORB-1');
    assert.equal(firstDetail.dependencies.predecessors[0].type, 'finish_to_start');

    const second = await add('ORB-2', {
      task: 'ORB-3',
      direction: 'predecessor',
      type: 'start_to_start',
    });
    assert.equal(second.statusCode, 201);
    const secondDetail = JSON.parse(second.body).data as TaskDetail;
    assert.equal(secondDetail.dependencies.predecessors.length, 2);

    for (const [task, type] of [
      ['ORB-4', 'finish_to_finish'],
      ['ORB-5', 'start_to_finish'],
    ] as const) {
      const response = await add('ORB-2', { task, direction: 'successor', type });
      assert.equal(response.statusCode, 201);
    }

    const withSuccessors = await detail('ORB-2');
    assert.deepEqual(
      withSuccessors.dependencies.successors.map((link) => [link.task.ref, link.type]),
      [
        ['ORB-4', 'finish_to_finish'],
        ['ORB-5', 'start_to_finish'],
      ],
    );

    const reverse = await detail('ORB-1');
    assert.equal(reverse.dependencies.successors[0].task.ref, 'ORB-2');
    assert.equal(reverse.dependencies.successors[0].type, 'finish_to_start');

    const duplicate = await add('ORB-2', {
      task: 'ORB-1',
      direction: 'predecessor',
      type: 'start_to_start',
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(JSON.parse(duplicate.body).error?.code, 'dependency_exists');

    const self = await add('ORB-2', {
      task: 'ORB-2',
      direction: 'predecessor',
      type: 'finish_to_start',
    });
    assert.equal(self.statusCode, 400);

    const cycle = await add('ORB-2', {
      task: 'ORB-1',
      direction: 'successor',
      type: 'finish_to_start',
    });
    assert.equal(cycle.statusCode, 409);
    assert.equal(JSON.parse(cycle.body).error?.code, 'dependency_cycle');

    const dependencyId = withSuccessors.dependencies.successors[0].id;
    const removed = await bundle.app.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/ORB-2/dependencies/${dependencyId}`,
      headers: human,
    });
    assert.equal(removed.statusCode, 204);
    const afterRemove = await detail('ORB-2');
    assert.deepEqual(
      afterRemove.dependencies.successors.map((link) => link.task.ref),
      ['ORB-5'],
    );

    const events = db
      .prepare(
        "SELECT type, payload FROM events WHERE task_id = 'tsk_orbit_2' AND type LIKE 'task.dependency_%' ORDER BY id",
      )
      .all() as Array<{ type: string; payload: string }>;
    assert.equal(events.filter((event) => event.type === 'task.dependency_added').length, 4);
    assert.equal(events.filter((event) => event.type === 'task.dependency_removed').length, 1);
    assert.match(events[0].payload, /ORB-1/);
  } finally {
    await bundle.app.close();
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
