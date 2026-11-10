import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDatabase } from '../src/seed.js';
import { OrbitService } from '../src/core/service.js';

test('nested subtasks complete ancestors recursively', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-nested-'));
  const db = openDatabase(path.join(dir, 'orbit.db'));
  try {
    seedDatabase(db);
    const service = new OrbitService(db);
    const lin = service.getActor('act_lin');

    const root = service.createTask(lin, 'ORB', { title: '根任务' });
    const middle = service.createTask(lin, 'ORB', { title: '中间任务', parent: root.ref });
    const leaf = service.createTask(lin, 'ORB', { title: '叶子任务', parent: middle.ref });

    assert.equal(service.getTask(lin, leaf.ref).parent?.ref, middle.ref);
    assert.equal(service.getTask(lin, middle.ref).parent?.ref, root.ref);

    service.updateTask(lin, leaf.ref, { status: 'done' });

    const middleDetail = service.getTask(lin, middle.ref);
    assert.equal(middleDetail.status, 'done');
    assert(middleDetail.comments.some((comment) => comment.body === '子任务已经全部完成'));

    const rootDetail = service.getTask(lin, root.ref);
    assert.equal(rootDetail.status, 'done');
    assert(rootDetail.comments.some((comment) => comment.body === '子任务已经全部完成'));
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('group changes cascade through nested subtasks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-nested-group-'));
  const db = openDatabase(path.join(dir, 'orbit.db'));
  try {
    seedDatabase(db);
    const service = new OrbitService(db);
    const lin = service.getActor('act_lin');
    const group = service.createGroup(lin, 'ORB', { name: '嵌套组' });

    const root = service.createTask(lin, 'ORB', { title: '根任务', group: group.id });
    const middle = service.createTask(lin, 'ORB', { title: '中间任务', parent: root.ref });
    const leaf = service.createTask(lin, 'ORB', { title: '叶子任务', parent: middle.ref });
    assert.equal(service.getTask(lin, middle.ref).groupId, group.id);
    assert.equal(service.getTask(lin, leaf.ref).groupId, group.id);

    service.updateTask(lin, root.ref, { group: null });

    assert.equal(service.getTask(lin, root.ref).groupId, null);
    assert.equal(service.getTask(lin, middle.ref).groupId, null);
    assert.equal(service.getTask(lin, leaf.ref).groupId, null);
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('completing the last subtask completes the parent by automation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cascade-'));
  const db = openDatabase(path.join(dir, 'orbit.db'));
  try {
    seedDatabase(db);
    const service = new OrbitService(db);
    const lin = service.getActor('act_lin');

    const parent = service.createTask(lin, 'ORB', { title: '父任务' });
    const first = service.createTask(lin, 'ORB', { title: '子任务一', parent: parent.ref });
    service.createTask(lin, 'ORB', { title: '子任务二', parent: parent.ref, status: 'done' });

    assert.equal(service.getTask(lin, parent.ref).status, 'todo');

    service.updateTask(lin, first.ref, { status: 'done' });

    const detail = service.getTask(lin, parent.ref);
    assert.equal(detail.status, 'done');
    const comment = detail.comments.find((item) => item.body === '子任务已经全部完成');
    assert(comment, 'expected the automation completion comment');
    assert.equal(comment.author.name, 'Orbit Automation');

    const event = db
      .prepare(
        "SELECT actor_id FROM events WHERE task_id = ? AND type = 'task.status_changed' ORDER BY id DESC LIMIT 1",
      )
      .get(detail.id) as { actor_id: string };
    assert.equal(event.actor_id, 'act_system');
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
