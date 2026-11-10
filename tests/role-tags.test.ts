import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { seedDatabase } from '../src/seed.js';

test('schema v9 databases gain project member role tags without losing memberships', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-role-tag-migration-'));
  const dbPath = path.join(dir, 'orbit.db');
  let db = openDatabase(dbPath);
  try {
    seedDatabase(db);
    db.exec('ALTER TABLE project_members DROP COLUMN role_tag');
    db.exec('PRAGMA user_version = 9');
    closeDatabase(db);

    db = openDatabase(dbPath);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, SCHEMA_VERSION);

    const columns = db.prepare('PRAGMA table_info(project_members)').all() as Array<{ name: string }>;
    assert(columns.some((column) => column.name === 'role_tag'));

    const rows = db
      .prepare('SELECT actor_id, role_tag FROM project_members ORDER BY actor_id')
      .all() as Array<{ actor_id: string; role_tag: string | null }>;
    assert.deepEqual(
      rows.map((row) => row.actor_id),
      ['act_atlas', 'act_lin', 'act_maya'],
    );
    assert(rows.every((row) => row.role_tag === null));
  } finally {
    try {
      closeDatabase(db);
    } catch {
      // already closed before reopening
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seeded projects ship role tags that are scoped to each membership', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-role-tag-seed-'));
  const dbPath = path.join(dir, 'orbit.db');
  const db = openDatabase(dbPath);
  try {
    seedDatabase(db);
    const rows = db
      .prepare(
        `SELECT a.name, pm.role, pm.role_tag
         FROM project_members pm JOIN actors a ON a.id = pm.actor_id
         WHERE pm.project_id = 'prj_orbit'
         ORDER BY a.name`,
      )
      .all() as Array<{ name: string; role: string; role_tag: string | null }>;
    assert.deepEqual(
      rows.map((row) => [row.name, row.role, row.role_tag]),
      [
        ['Atlas', 'member', '项目运营'],
        ['Lin', 'owner', '项目负责人'],
        ['Maya', 'member', '产品设计'],
      ],
    );
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
