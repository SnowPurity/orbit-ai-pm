import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { seedDatabase } from '../src/seed.js';
import { seedIpdTemplate } from '../src/templates/ipd.js';

test('schema v8 databases add and backfill task start times from creation time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-start-migration-'));
  const dbPath = path.join(dir, 'orbit.db');
  let db = openDatabase(dbPath);
  try {
    seedDatabase(db);
    db.exec('ALTER TABLE tasks DROP COLUMN start_at');
    db.exec('PRAGMA user_version = 8');
    closeDatabase(db);

    db = openDatabase(dbPath);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, SCHEMA_VERSION);

    const rows = db
      .prepare('SELECT start_at, created_at FROM tasks')
      .all() as Array<{ start_at: string; created_at: string }>;
    assert(rows.length > 0);
    assert(rows.every((row) => row.start_at === row.created_at));
  } finally {
    try {
      closeDatabase(db);
    } catch {
      // already closed before reopening
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('schema v7 databases backfill TR review tasks as milestones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-kind-migration-'));
  const dbPath = path.join(dir, 'orbit.db');
  let db = openDatabase(dbPath);
  try {
    seedDatabase(db);
    const template = seedIpdTemplate(db);

    db.prepare("UPDATE tasks SET kind = 'task' WHERE project_id = ?").run(template.projectId);
    db.exec('PRAGMA user_version = 7');
    closeDatabase(db);

    db = openDatabase(dbPath);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, SCHEMA_VERSION);

    const rows = db
      .prepare('SELECT title, kind FROM tasks WHERE project_id = ?')
      .all(template.projectId) as Array<{ title: string; kind: string }>;
    const milestones = rows.filter((row) => row.kind === 'milestone');
    assert.equal(milestones.length, 6);
    assert(milestones.every((row) => /TR\s*[1-6]|TR\s*评审/i.test(row.title)));
    assert.equal(rows.filter((row) => row.kind === 'task').length, 24);
  } finally {
    try {
      closeDatabase(db);
    } catch {
      // already closed before reopening
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
