import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { isTrReviewTitle } from '../types.js';

export type Db = DatabaseSync;

const SYSTEM_ACTOR_SQL = `
INSERT OR IGNORE INTO actors (id, name, kind, title, created_at)
VALUES ('act_system', 'Orbit Automation', 'system', 'Automation executor', '1970-01-01T00:00:00.000Z')
`;

export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  migrate(db);
  return db;
}

function ensureAutomationTaskScope(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automations'")
    .get() as { name: string } | undefined;
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(automations)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'task_id')) {
    db.exec('ALTER TABLE automations ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE');
  }
}

function ensureTaskGroupColumn(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'group_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN group_id TEXT REFERENCES task_groups(id) ON DELETE SET NULL');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id)');
}

function ensureActorExternalAgentColumn(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'actors'")
    .get() as { name: string } | undefined;
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(actors)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'external_agent_id')) {
    db.exec('ALTER TABLE actors ADD COLUMN external_agent_id TEXT');
  }
}

function ensureProjectMemberRoleTagColumn(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_members'")
    .get() as { name: string } | undefined;
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(project_members)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'role_tag')) {
    db.exec('ALTER TABLE project_members ADD COLUMN role_tag TEXT');
  }
}

export function backfillTaskAssignees(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_assignees'")
    .get() as { name: string } | undefined;
  if (!table) return;
  db.exec(`
    INSERT OR IGNORE INTO task_assignees (task_id, actor_id, position, created_at)
    SELECT id, assignee_id, 0, created_at FROM tasks WHERE assignee_id IS NOT NULL
  `);
}

function stripStagePrefix(title: string): { name: string; title: string } {
  const match = /^【([^】]+)】(.*)$/.exec(title);
  if (!match) return { name: title.trim(), title: title.trim() };
  return { name: match[1].trim(), title: match[2].trim() };
}

function migrateIpdTaskGroups(db: Db): void {
  const project = db
    .prepare("SELECT id, key FROM projects WHERE UPPER(key) = 'IPD'")
    .get() as { id: string; key: string } | undefined;
  if (!project) return;

  const existing = db
    .prepare('SELECT COUNT(*) AS count FROM task_groups WHERE project_id = ?')
    .get(project.id) as { count: number };
  if (Number(existing.count) > 0) return;

  const parents = db
    .prepare(
      `SELECT t.id, t.number, t.title, t.description, t.created_at, t.created_by
       FROM tasks t
       WHERE t.project_id = ? AND t.parent_task_id IS NULL
         AND EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
       ORDER BY t.number`,
    )
    .all(project.id) as Array<{
    id: string;
    number: number;
    title: string;
    description: string;
    created_at: string;
    created_by: string;
  }>;
  if (parents.length === 0) return;

  const selectChildren = db.prepare(
    'SELECT id, title FROM tasks WHERE parent_task_id = ? ORDER BY number',
  );
  const updateChild = db.prepare(
    'UPDATE tasks SET parent_task_id = NULL, group_id = ?, title = ? WHERE id = ?',
  );
  const insertGroup = db.prepare(
    `INSERT INTO task_groups (id, project_id, name, description, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (project_id, task_id, type, actor_id, payload, created_at)
     VALUES (?, NULL, 'group.created', ?, ?, ?)`,
  );
  const deleteEvents = db.prepare('DELETE FROM events WHERE task_id = ?');
  const deleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');

  transaction(db, () => {
    const migratedAt = new Date().toISOString();
    parents.forEach((parent, index) => {
      const stage = stripStagePrefix(parent.title);
      const groupId = `grp_ipd_stage_${index + 1}`;
      insertGroup.run(
        groupId,
        project.id,
        stage.name,
        parent.description,
        index,
        parent.created_at,
        migratedAt,
      );
      const children = selectChildren.all(parent.id) as Array<{ id: string; title: string }>;
      for (const child of children) {
        updateChild.run(groupId, stripStagePrefix(child.title).title, child.id);
      }
      deleteEvents.run(parent.id);
      deleteTask.run(parent.id);
      insertEvent.run(
        project.id,
        parent.created_by,
        JSON.stringify({
          groupId,
          name: stage.name,
          migratedFrom: `${project.key}-${parent.number}`,
          taskCount: children.length,
        }),
        migratedAt,
      );
    });
  });
}

function ensureTaskKindColumn(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get() as { name: string } | undefined;
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'kind')) {
    db.exec(
      "ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'milestone'))",
    );
  }
}

function ensureStartAtColumn(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
    .get() as { name: string } | undefined;
  if (!table) return;
  const columns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'start_at')) {
    db.exec("ALTER TABLE tasks ADD COLUMN start_at TEXT NOT NULL DEFAULT ''");
  }
}

function backfillTaskStartAt(db: Db): void {
  db.exec("UPDATE tasks SET start_at = created_at WHERE start_at = ''");
}

function markTrReviewMilestones(db: Db): void {
  const rows = db
    .prepare("SELECT id, title FROM tasks WHERE kind = 'task'")
    .all() as Array<{ id: string; title: string }>;
  const milestones = rows.filter((row) => isTrReviewTitle(row.title));
  if (milestones.length === 0) return;
  const updatedAt = new Date().toISOString();
  const update = db.prepare(
    "UPDATE tasks SET kind = 'milestone', version = version + 1, updated_at = ? WHERE id = ?",
  );
  transaction(db, () => {
    for (const milestone of milestones) update.run(updatedAt, milestone.id);
  });
}

export function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version > SCHEMA_VERSION) {
    throw new Error(`Database schema version ${row.user_version} is newer than this app (${SCHEMA_VERSION})`);
  }
  ensureAutomationTaskScope(db);
  ensureActorExternalAgentColumn(db);
  ensureTaskKindColumn(db);
  ensureStartAtColumn(db);
  ensureProjectMemberRoleTagColumn(db);
  db.exec(SCHEMA_SQL);
  ensureTaskGroupColumn(db);
  backfillTaskAssignees(db);
  db.exec(SYSTEM_ACTOR_SQL);
  if (row.user_version < SCHEMA_VERSION) {
    if (row.user_version < 3) migrateIpdTaskGroups(db);
    if (row.user_version < 8) markTrReviewMilestones(db);
    if (row.user_version < 9) backfillTaskStartAt(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function closeDatabase(db: Db): void {
  db.close();
}
