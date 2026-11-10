import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDatabase } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import { issueToken } from '../src/auth.js';
import { nowIso } from '../src/lib/util.js';
import type { TaskDetail } from '../src/types.js';

function multipart(filename: string, content: string | Buffer, type = 'text/plain') {
  const boundary = `----orbit${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(content), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function objectFiles(filesDir: string): string[] {
  const root = path.join(filesDir, 'objects');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function setup(overrides: Partial<AppConfig> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-files-'));
  const dbPath = path.join(dir, 'orbit.db');
  const db = openDatabase(dbPath);
  const seed = seedDatabase(db);
  const config = loadConfig({
    dbPath,
    filesDir: path.join(dir, 'files'),
    schedulerEnabled: false,
    logLevel: 'silent',
    ...overrides,
  });
  const bundle = buildApp({ db, config, logger: false, scheduler: false });
  await bundle.app.ready();
  return {
    dir,
    db,
    seed,
    config,
    bundle,
    human: { authorization: `Bearer ${seed.humanToken}` },
    async cleanup() {
      await bundle.app.close();
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('task files upload, download, authorize and delete', async () => {
  const ctx = await setup();
  const { app } = ctx.bundle;
  const { human } = ctx;
  try {
    const content = 'hello attachment';
    const upload = multipart('需求说明.txt', content);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/ORB-2/files',
      headers: { ...human, ...upload.headers },
      payload: upload.payload,
    });
    assert.equal(created.statusCode, 201, created.body);
    const file = JSON.parse(created.body).data as {
      id: string;
      name: string;
      sizeBytes: number;
      sha256: string;
      taskRef: string;
      uploadedBy: { name: string };
    };
    assert.equal(file.name, '需求说明.txt');
    assert.equal(file.sizeBytes, Buffer.byteLength(content));
    assert.equal(file.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(file.taskRef, 'ORB-2');
    assert.equal(file.uploadedBy.name, 'Lin');

    const detail = await app.inject({ method: 'GET', url: '/api/v1/tasks/ORB-2', headers: human });
    const task = JSON.parse(detail.body).data as TaskDetail;
    assert.equal(task.files.length, 1);
    assert.equal(task.files[0].id, file.id);
    assert.equal(task.fileCount, 1);

    const board = await app.inject({ method: 'GET', url: '/api/v1/projects/ORB/board', headers: human });
    const boardTasks = (JSON.parse(board.body).data as {
      columns: Array<{ tasks: Array<{ ref: string; fileCount: number }> }>;
    }).columns.flatMap((column) => column.tasks);
    assert.equal(boardTasks.find((entry) => entry.ref === 'ORB-2')?.fileCount, 1);
    assert.equal(boardTasks.find((entry) => entry.ref === 'ORB-3')?.fileCount, 0);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/tasks/ORB-2/files', headers: human });
    assert.equal(listed.statusCode, 200);
    assert.equal(JSON.parse(listed.body).meta.count, 1);

    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/files/${file.id}/download`,
      headers: human,
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, content);
    assert.equal(download.headers['content-type'], 'application/octet-stream');
    assert.match(String(download.headers['content-disposition']), /^attachment;/);
    assert.match(String(download.headers['content-disposition']), /filename\*=UTF-8''/);
    assert.match(String(download.headers['content-disposition']), /%E9%9C%80%E6%B1%82/);
    assert.equal(download.headers['x-content-type-options'], 'nosniff');
    assert.equal(download.headers.etag, `"${file.sha256}"`);

    const cached = await app.inject({
      method: 'GET',
      url: `/api/v1/files/${file.id}/download`,
      headers: { ...human, 'if-none-match': `"${file.sha256}"` },
    });
    assert.equal(cached.statusCode, 304);

    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/v1/files/${file.id}/download`,
    });
    assert.equal(anonymous.statusCode, 401);

    ctx.db
      .prepare('INSERT INTO actors (id, name, kind, title, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('act_outsider', 'Outsider', 'human', null, nowIso());
    const outsider = { authorization: `Bearer ${issueToken(ctx.db, 'act_outsider').token}` };
    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/v1/files/${file.id}/download`,
      headers: outsider,
    });
    assert.equal(forbidden.statusCode, 403);

    const maya = { authorization: `Bearer ${issueToken(ctx.db, 'act_maya').token}` };
    const memberDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/ORB-2/files/${file.id}`,
      headers: maya,
    });
    assert.equal(memberDelete.statusCode, 403);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/ORB-2/files/${file.id}`,
      headers: human,
    });
    assert.equal(deleted.statusCode, 204);
    assert.deepEqual(objectFiles(ctx.config.filesDir), []);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/v1/files/${file.id}/download`,
      headers: human,
    });
    assert.equal(gone.statusCode, 404);

    const events = ctx.db
      .prepare("SELECT type FROM events WHERE type LIKE 'file.%' ORDER BY id")
      .all() as Array<{ type: string }>;
    assert.deepEqual(events.map((event) => event.type), ['file.uploaded', 'file.deleted']);

    const empty = multipart('empty.txt', '');
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/ORB-3/files',
      headers: { ...human, ...empty.headers },
      payload: empty.payload,
    });
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.body, /Empty files/);
    assert.deepEqual(objectFiles(ctx.config.filesDir), []);
  } finally {
    await ctx.cleanup();
  }
});

test('task file limits reject oversized and excess uploads', async () => {
  const ctx = await setup({
    maxUploadBytes: 8,
    taskFileLimit: 2,
    projectStorageQuotaBytes: 1024 * 1024,
  });
  const { app } = ctx.bundle;
  const { human } = ctx;
  try {
    const oversized = multipart('big.txt', '123456789');
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/ORB-3/files',
      headers: { ...human, ...oversized.headers },
      payload: oversized.payload,
    });
    assert.equal(tooLarge.statusCode, 413, tooLarge.body);
    assert.equal(JSON.parse(tooLarge.body).error.code, 'payload_too_large');
    assert.deepEqual(objectFiles(ctx.config.filesDir), []);

    for (let index = 0; index < 2; index += 1) {
      const part = multipart(`note-${index}.txt`, '1234');
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/v1/tasks/ORB-3/files',
        headers: { ...human, ...part.headers },
        payload: part.payload,
      });
      assert.equal(accepted.statusCode, 201, accepted.body);
    }
    assert.equal(objectFiles(ctx.config.filesDir).length, 2);

    const third = multipart('note-2.txt', '1234');
    const excess = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/ORB-3/files',
      headers: { ...human, ...third.headers },
      payload: third.payload,
    });
    assert.equal(excess.statusCode, 400, excess.body);
    assert.match(excess.body, /at most 2 files/);
    assert.equal(objectFiles(ctx.config.filesDir).length, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('project quota rejects uploads and removes the written object', async () => {
  const ctx = await setup({
    maxUploadBytes: 8,
    taskFileLimit: 20,
    projectStorageQuotaBytes: 6,
  });
  const { app } = ctx.bundle;
  const { human } = ctx;
  try {
    const first = multipart('one.txt', '1234');
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/ORB-4/files',
      headers: { ...human, ...first.headers },
      payload: first.payload,
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
    assert.equal(objectFiles(ctx.config.filesDir).length, 1);

    const second = multipart('two.txt', '1234');
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/ORB-4/files',
      headers: { ...human, ...second.headers },
      payload: second.payload,
    });
    assert.equal(rejected.statusCode, 413, rejected.body);
    assert.match(rejected.body, /quota is full/);
    assert.equal(objectFiles(ctx.config.filesDir).length, 1);

    const detail = await app.inject({ method: 'GET', url: '/api/v1/tasks/ORB-4', headers: human });
    const task = JSON.parse(detail.body).data as TaskDetail;
    assert.equal(task.files.length, 1);
  } finally {
    await ctx.cleanup();
  }
});
