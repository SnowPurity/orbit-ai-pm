import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDatabase } from '../src/seed.js';
import { OrbitService } from '../src/core/service.js';
import {
  backfillDefaultAutomations,
  installDefaultAutomations,
} from '../src/core/default-automations.js';

const DEFAULT_NAMES = ['完成任务自动留痕', '紧急任务自动分诊', '工作日晨间摘要'];

function listAutomationNames(db: ReturnType<typeof openDatabase>, projectId: string): string[] {
  return (
    db
      .prepare('SELECT name FROM automations WHERE project_id = ? ORDER BY name')
      .all(projectId) as Array<{ name: string }>
  ).map((row) => row.name);
}

test('default automations are installed once and include agent rules when an agent joins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-defaults-'));
  const db = openDatabase(path.join(dir, 'orbit.db'));
  try {
    seedDatabase(db);
    db.prepare("DELETE FROM automations WHERE project_id = 'prj_orbit'").run();

    const installed = installDefaultAutomations(db, 'prj_orbit');
    assert.deepEqual([...installed].sort(), [...DEFAULT_NAMES].sort());
    assert.deepEqual(listAutomationNames(db, 'prj_orbit').sort(), [...installed].sort());

    assert.deepEqual(installDefaultAutomations(db, 'prj_orbit'), []);
    assert.deepEqual(backfillDefaultAutomations(db), []);

    const service = new OrbitService(db);
    const lin = service.getActor('act_lin');
    const project = service.createProject(lin, { key: 'NEW', name: '新项目' });
    assert.deepEqual(listAutomationNames(db, project.id), ['完成任务自动留痕']);

    service.addProjectMember(lin, 'NEW', 'act_atlas');
    assert.deepEqual(listAutomationNames(db, project.id).sort(), [...DEFAULT_NAMES].sort());
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
