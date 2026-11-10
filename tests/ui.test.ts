import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDatabase } from '../src/seed.js';
import { buildApp } from '../src/app.js';

test('UI serves the app shell and static assets', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ui-test-'));
  const dbPath = path.join(dir, 'orbit.db');
  const db = openDatabase(dbPath);
  seedDatabase(db);
  const config = loadConfig({ dbPath, schedulerEnabled: false, logLevel: 'silent' });
  const { app } = buildApp({ db, config, logger: false, scheduler: false });

  t.after(async () => {
    await app.close();
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const root = await app.inject({ method: 'GET', url: '/' });
  assert.equal(root.statusCode, 302);
  assert.equal(root.headers.location, '/ui');

  const page = await app.inject({ method: 'GET', url: '/ui' });
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers['content-type']), /text\/html/);
  assert.match(String(page.headers['content-security-policy']), /default-src 'self'/);
  assert.match(page.body, /id="app"/);
  assert.match(page.body, /\/ui\/app\.js/);

  for (const url of ['/ui/me', '/ui/tasks/ORB-2', '/ui/projects/ORB/board', '/ui/projects/ORB/automations', '/ui/projects/ORB/board/tasks/ORB-2']) {
    const deepLink = await app.inject({ method: 'GET', url });
    assert.equal(deepLink.statusCode, 200);
    assert.match(String(deepLink.headers['content-type']), /text\/html/);
    assert.match(deepLink.body, /id="app"/);
  }

  for (const [url, type] of [
    ['/ui/app.js', /javascript/],
    ['/ui/styles.css', /text\/css/],
  ] as const) {
    const asset = await app.inject({ method: 'GET', url });
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers['content-type']), type);
    assert.ok(asset.body.length > 1_000);
  }

  const appJs = await app.inject({ method: 'GET', url: '/ui/app.js' });
  assert.equal(appJs.statusCode, 200);
  assert.match(appJs.body, /\/api\/v1\/events\/stream/);
  assert.match(appJs.body, /\/notifications\?limit=50/);
  assert.ok(!appJs.body.includes('notifications?project='));
  assert.match(appJs.body, /notifications\/read/);
  assert.match(appJs.body, /mention-hints/);
  assert.match(appJs.body, /mention-picker/);
  assert.match(appJs.body, /data-mention-search/);
  assert.match(appJs.body, /filterMentionOptions/);
  assert.match(appJs.body, /mentionTokensHtml/);
  assert.match(appJs.body, /is-linked/);
  assert.match(appJs.body, /pick-mention/);
  assert.match(appJs.body, /activity-digest/);
  assert.match(appJs.body, /edit-group/);
  assert.match(appJs.body, /编辑任务组/);
  assert.match(appJs.body, /这个任务组负责什么？支持 Markdown/);
  assert.match(appJs.body, /\/presence\?project=/);
  assert.match(appJs.body, /toggle-presence/);
  assert.match(appJs.body, /enable-browser-notifications/);
  assert.match(appJs.body, /new Notification\(/);
  assert.match(appJs.body, /id="file-form"/);
  assert.match(appJs.body, /uploadProgressHtml/);
  assert.match(appJs.body, /download-file/);
  assert.match(appJs.body, /delete-file/);
  assert.match(appJs.body, /\/api\/v1\/files\/\$\{encodeURIComponent\(id\)\}\/download/);
  assert.match(appJs.body, /TASK_KIND_LABEL/);
  assert.match(appJs.body, /name="kind"/);
  assert.match(appJs.body, /task-kind milestone/);
  assert.match(appJs.body, /\/me\/tasks\?/);
  assert.match(appJs.body, /my-task-row/);
  assert.match(appJs.body, /loadMyTasks/);
  assert.match(appJs.body, /my-kind-filter/);
  assert.match(appJs.body, /全部类型/);
  assert.match(appJs.body, /my-task-filter/);
  assert.match(appJs.body, /params\.set\('q', query\)/);
  assert.match(appJs.body, /data-action="my-stat"/);
  assert.match(appJs.body, /title="筛选\$\{label\}任务"/);
  assert.match(appJs.body, /data-action="delete-group"/);
  assert.match(appJs.body, /confirm-delete-group/);
  assert.match(appJs.body, /移入「未分组」/);
  assert.match(appJs.body, /renderRichTextHtml/);
  assert.match(appJs.body, /data-action="edit-description"/);
  assert.match(appJs.body, /id="description-form"/);
  assert.match(appJs.body, /renderRichTextHtml\(comment\.body\)/);
  assert.match(appJs.body, /可用 ORB-12 \/ #ORB \/ #\[组名\] 引用/);
  assert.match(appJs.body, /focus-main-desc/);

  const citationsJs = await app.inject({ method: 'GET', url: '/ui/citations.js' });
  assert.equal(citationsJs.statusCode, 200);
  assert.match(citationsJs.body, /export function renderRichText/);
  assert.match(citationsJs.body, /data-group-focus/);
  assert.match(appJs.body, /params\.set\('overdue', 'true'\)/);
  assert.match(appJs.body, /创建时间/);
  assert.match(appJs.body, /开始时间/);
  assert.match(appJs.body, /截止时间/);
  assert.match(appJs.body, /完成时间/);
  assert.match(appJs.body, /data-task-time/);
  assert.match(appJs.body, /toDateTimeLocal/);
  assert.match(appJs.body, /dependency_blocked/);
  assert.match(appJs.body, /dependencyBlockers/);
  assert.match(appJs.body, /is-blocked/);
  assert.match(appJs.body, /dependency-unmet/);
  assert.match(appJs.body, /dependency-block-hint/);
  assert.match(appJs.body, /data-role-tag/);
  assert.match(appJs.body, /actor-role-picker/);
  assert.match(appJs.body, /data-role-tag-select/);
  assert.match(appJs.body, /member-role-tag/);
  assert.match(appJs.body, /joinRoleTag/);
  assert.match(appJs.body, /\/memberships/);
  assert.match(appJs.body, /projectDescriptionHtml/);
  assert.match(appJs.body, /<textarea name="description" rows="5" maxlength="20000" placeholder="写下项目说明/);
  assert.match(appJs.body, /projectDescriptionHtml/);
  assert.match(appJs.body, /function renderProjectInfoModal/);
  assert.match(appJs.body, /id="project-info-form"/);
  assert.match(appJs.body, /submitProjectInfo/);
  assert.match(appJs.body, /project_key_taken/);
  assert.match(appJs.body, /data-action="edit-project"/);
  assert.match(appJs.body, /MOUSE-REQ-1/);
  assert.match(appJs.body, /maxlength="20" minlength="2"/);
  assert.match(appJs.body, /data-action="new-project"/);
  assert.match(appJs.body, /function renderNewProjectModal/);
  assert.match(appJs.body, /id="new-project-form"/);
  assert.match(appJs.body, /submitNewProject/);
  assert.ok(
    appJs.body.indexOf('data-action="new-project"') < appJs.body.indexOf('id="project-select"'),
    'new-project button should precede the project selector',
  );
  assert.match(appJs.body, /name === 'task'/);
  assert.match(appJs.body, /function taskOnlyPath/);
  assert.match(appJs.body, /function withTaskQuery/);
  assert.match(appJs.body, /function taskOnlyHtml/);
  assert.match(appJs.body, /withTaskQuery\(MY_TASKS_PATH/);
  assert.match(appJs.body, /openTaskFromNotification/);
  assert.match(appJs.body, /\/tasks\/\$\{encodeURIComponent\(ref\)\}/);
  assert.match(appJs.body, /boardHasFiles/);
  assert.match(appJs.body, /boardFilesFilter/);
  assert.match(appJs.body, /data-action="board-files-filter"/);
  assert.match(appJs.body, /card-file/);

  const styles = await app.inject({ method: 'GET', url: '/ui/styles.css' });
  assert.equal(styles.statusCode, 200);
  for (const selector of ['.notify-panel', '.notify-badge', '.mention-chip', '.mention-chip.is-linked', '.mention-picker', '.mention-search', '.mention-option', '.mention-ref', '.activity-digest', '.live-state', '.group-rename', '.presence-panel', '.presence-chip', '.notify-permission', '.member-online', '.file-row', '.file-upload-progress', '.file-ext', '.file-pick', '.task-kind.milestone', '.my-stats', '.my-stat.active', '.my-task-row', '.my-relation.assigned', '.my-filters', '.my-filter input', '.group-delete', '.focus-main-desc', '.group-cell-desc', '.task-description a', '.comment-body a.ref-link', '.status-switch button.is-blocked', '.dependency-unmet', '.dependency-block-hint', '.description-form', '.meta-grid .overdue', '.member-role-tag', '.actor-role-picker', '.assignee-chip .role-tag', '.project-description', '.project-info-edit', '.topbar-mid .new-project', '.task-only-card', '.board-filter', '.board-empty-card', '.card-file']) {
    assert.ok(styles.body.includes(selector), `styles should include ${selector}`);
  }

  const missing = await app.inject({ method: 'GET', url: '/ui/missing.js' });
  assert.equal(missing.statusCode, 404);
});
