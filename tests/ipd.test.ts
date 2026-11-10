import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDatabase } from '../src/seed.js';
import { seedIpdTemplate } from '../src/templates/ipd.js';

test('IPD template seeds a six-stage project with gates and roles', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ipd-'));
  const dbPath = path.join(dir, 'orbit.db');
  const db = openDatabase(dbPath);
  const seed = seedDatabase(db);

  const first = seedIpdTemplate(db);
  assert.equal(first.created, true);
  assert.equal(first.projectKey, 'IPD');
  assert.equal(first.taskCount, 30);

  const duplicate = seedIpdTemplate(db);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.taskCount, 30);

  const milestoneRows = db
    .prepare("SELECT title FROM tasks WHERE project_id = ? AND kind = 'milestone' ORDER BY number")
    .all(first.projectId) as Array<{ title: string }>;
  assert.equal(milestoneRows.length, 6);
  assert(milestoneRows.every((row) => /TR\s*[1-6]|TR\s*评审/i.test(row.title)));
  const normalCount = db
    .prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND kind = 'task'")
    .get(first.projectId) as { count: number };
  assert.equal(normalCount.count, 24);

  const config = loadConfig({ dbPath, schedulerEnabled: false, logLevel: 'silent' });
  const bundle = buildApp({ db, config, logger: false, scheduler: false });

  t.after(async () => {
    await bundle.app.close();
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const headers = { authorization: `Bearer ${seed.humanToken}` };

  const projects = await bundle.app.inject({ method: 'GET', url: '/api/v1/projects', headers });
  assert.equal(projects.statusCode, 200);
  const projectKeys = (JSON.parse(projects.body).data as Array<{ key: string }>).map(
    (project) => project.key,
  );
  assert(projectKeys.includes('ORB'));
  assert(projectKeys.includes('IPD'));

  const board = await bundle.app.inject({
    method: 'GET',
    url: '/api/v1/projects/IPD/board',
    headers,
  });
  assert.equal(board.statusCode, 200);
  const boardData = JSON.parse(board.body).data as {
    stats: { total: number };
    groups: Array<{ name: string; taskCount: number; progress: { done: number; total: number } }>;
    columns: Array<{ tasks: Array<{ ref: string; title: string; groupName: string | null }> }>;
  };
  assert.equal(boardData.stats.total, 30);
  assert.equal(boardData.groups.length, 6);
  assert.deepEqual(
    boardData.groups.map((group) => group.name),
    ['概念', '计划', '开发', '验证', '发布', '生命周期'],
  );
  assert.deepEqual(boardData.groups[0].progress, { done: 2, total: 5 });
  const tasks = boardData.columns.flatMap((column) => column.tasks);
  const refs = tasks.map((task) => task.ref);
  assert(refs.includes('IPD-6'));
  assert(!refs.includes('IPD-1'));
  assert(tasks.every((task) => !task.title.startsWith('【')));
  assert(tasks.every((task) => task.groupName !== null));

  const concept = await bundle.app.inject({ method: 'GET', url: '/api/v1/tasks/IPD-6', headers });
  assert.equal(concept.statusCode, 200);
  const conceptData = JSON.parse(concept.body).data as {
    title: string;
    groupName: string;
    subtasks: unknown[];
    comments: Array<{ body: string }>;
  };
  assert.equal(conceptData.title, 'CDCP 概念决策评审');
  assert.equal(conceptData.groupName, '概念');
  assert.equal(conceptData.subtasks.length, 0);
  assert(conceptData.comments[0].body.includes('CDCP'));

  const tr1 = await bundle.app.inject({ method: 'GET', url: '/api/v1/tasks/IPD-4', headers });
  assert.equal(tr1.statusCode, 200);
  const tr1Data = JSON.parse(tr1.body).data as { title: string; kind: string };
  assert(tr1Data.title.includes('TR1'));
  assert.equal(tr1Data.kind, 'milestone');

  const automations = await bundle.app.inject({
    method: 'GET',
    url: '/api/v1/projects/IPD/automations',
    headers,
  });
  assert.equal(automations.statusCode, 200);
  assert.equal((JSON.parse(automations.body).data as unknown[]).length, 3);

  const jobs = await bundle.app.inject({ method: 'GET', url: '/api/v1/projects/IPD/jobs', headers });
  assert.equal(jobs.statusCode, 200);
  const jobData = JSON.parse(jobs.body).data as Array<{ status: string; taskRef: string }>;
  assert.equal(jobData.length, 1);
  assert.equal(jobData[0].status, 'queued');
  assert.equal(jobData[0].taskRef, 'IPD-6');
});
