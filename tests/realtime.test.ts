import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { issueToken } from '../src/auth.js';
import { seedDatabase } from '../src/seed.js';
import { buildApp } from '../src/app.js';

test('realtime activity stream and mention notifications', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-realtime-'));
  const dbPath = path.join(dir, 'orbit.db');
  const db = openDatabase(dbPath);
  const seed = seedDatabase(db);
  const mayaToken = issueToken(db, 'act_maya').token;
  const config = loadConfig({ dbPath, schedulerEnabled: false, logLevel: 'silent' });
  const { app } = buildApp({ db, config, logger: false, scheduler: false });

  const human = { authorization: `Bearer ${seed.humanToken!}` };
  const atlas = { authorization: `Bearer ${seed.agentToken!}` };
  const maya = { authorization: `Bearer ${mayaToken}` };

  t.after(async () => {
    await app.close();
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function api<T = unknown>(
    method: string,
    url: string,
    headers: Record<string, string> = human,
    payload?: unknown,
  ) {
    const response = await app.inject({ method, url, headers, payload });
    return {
      status: response.statusCode,
      body: response.body ? JSON.parse(response.body) : {},
    } as { status: number; body: { data?: T; error?: { code: string } } };
  }

  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const controller = new AbortController();

  try {
    const unauthorized = await fetch(
      `http://127.0.0.1:${port}/api/v1/projects/ORB/events/stream`,
    );
    assert.equal(unauthorized.status, 401);
    const globalUnauthorized = await fetch(`http://127.0.0.1:${port}/api/v1/events/stream`);
    assert.equal(globalUnauthorized.status, 401);

    const stream = await fetch(
      `http://127.0.0.1:${port}/api/v1/projects/ORB/events/stream?after=0`,
      { headers: human, signal: controller.signal },
    );
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readChunk = () =>
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out reading SSE')), 5_000);
        reader.read().then(
          (chunk) => {
            clearTimeout(timer);
            resolve(chunk);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (buffer.includes(needle)) return;
        const chunk = await readChunk();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      assert.ok(buffer.includes(needle), `stream should include ${needle}`);
    };

    await readUntil('event: ready');

    const presence = await api<{ actors: Array<{ name: string }>; projectKey: string }>(
      'GET',
      '/api/v1/presence?project=ORB',
      human,
    );
    assert.equal(presence.status, 200);
    assert.equal(presence.body.data?.projectKey, 'ORB');
    assert.ok(
      presence.body.data?.actors.some((actor) => actor.name === 'Lin'),
      'the SSE connection should mark Lin online',
    );
    const mayaPresence = await api<{ actors: Array<{ name: string }> }>(
      'GET',
      '/api/v1/presence?project=ORB',
      maya,
    );
    assert.ok(
      mayaPresence.body.data?.actors.some((actor) => actor.name === 'Lin'),
      'project members can see who is online',
    );

    const marker = `SSE-MENTION-${Date.now()}`;
    const comment = await api('POST', '/api/v1/tasks/ORB-2/comments', human, {
      body: `@Maya 请确认发布清单 ${marker}，@maya 记得今天完成，@Atlas 同步一下风险。`,
    });
    assert.equal(comment.status, 201);

    await readUntil(marker);
    assert.match(buffer, /"mentions":\["Atlas","Maya"\]/);

    const mayaNotifications = await api<{
      items: Array<{ id: string; taskRef: string; author: { name: string }; readAt: string | null }>;
      unread: number;
    }>('GET', '/api/v1/notifications?project=ORB', maya);
    assert.equal(mayaNotifications.status, 200);
    assert.equal(mayaNotifications.body.data?.unread, 1);
    assert.equal(mayaNotifications.body.data?.items.length, 1);
    assert.equal(mayaNotifications.body.data?.items[0]?.taskRef, 'ORB-2');
    assert.equal(mayaNotifications.body.data?.items[0]?.author.name, 'Lin');
    assert.equal(mayaNotifications.body.data?.items[0]?.readAt, null);

    const atlasNotifications = await api<{ unread: number }>(
      'GET',
      '/api/v1/notifications?project=ORB',
      atlas,
    );
    assert.equal(atlasNotifications.body.data?.unread, 1);

    const linNotifications = await api<{ unread: number }>(
      'GET',
      '/api/v1/notifications?project=ORB',
      human,
    );
    assert.equal(linNotifications.body.data?.unread, 0, 'authors are not notified for self mentions');

    const mayaId = mayaNotifications.body.data?.items[0]?.id ?? '';
    const read = await api<{ unread: number }>('POST', '/api/v1/notifications/read', maya, {
      ids: [mayaId],
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.data?.unread, 0);

    const unreadOnly = await api<{ items: unknown[]; unread: number }>(
      'GET',
      '/api/v1/notifications?project=ORB&unread=true',
      maya,
    );
    assert.equal(unreadOnly.body.data?.unread, 0);
    assert.equal(unreadOnly.body.data?.items.length, 0);

    await api('POST', '/api/v1/tasks/ORB-2/comments', human, {
      body: '@Maya 再次提醒，@Maya 不要重复通知。',
    });
    const duplicate = await api<{ items: Array<{ id: string }>; unread: number }>(
      'GET',
      '/api/v1/notifications?project=ORB&unread=true',
      maya,
    );
    assert.equal(duplicate.body.data?.unread, 1, 'one notification per actor per comment');
    assert.equal(duplicate.body.data?.items.length, 1);

    const ops = await api('POST', '/api/v1/projects', human, {
      key: 'OPS',
      name: 'Operations',
    });
    assert.equal(ops.status, 201);
    const opsMember = await api('POST', '/api/v1/projects/OPS/members', human, {
      actor: 'act_maya',
      role: 'member',
    });
    assert.equal(opsMember.status, 201);
    const opsTask = await api<{ ref: string }>('POST', '/api/v1/projects/OPS/tasks', human, {
      title: '跨项目任务',
    });
    assert.equal(opsTask.status, 201);
    const opsRef = opsTask.body.data?.ref ?? '';
    assert.ok(opsRef);

    const globalStream = await fetch(
      `http://127.0.0.1:${port}/api/v1/events/stream?after=0`,
      { headers: human, signal: controller.signal },
    );
    assert.equal(globalStream.status, 200);
    const globalReader = globalStream.body!.getReader();
    const globalDecoder = new TextDecoder();
    let globalBuffer = '';
    const readGlobalChunk = () =>
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out reading global SSE')), 5_000);
        globalReader.read().then(
          (chunk) => {
            clearTimeout(timer);
            resolve(chunk);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    const readGlobalUntil = async (needle: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (globalBuffer.includes(needle)) return;
        const chunk = await readGlobalChunk();
        if (chunk.done) break;
        globalBuffer += globalDecoder.decode(chunk.value, { stream: true });
      }
      assert.ok(globalBuffer.includes(needle), `global stream should include ${needle}`);
    };

    await readGlobalUntil('event: ready');
    const opsMarker = `SSE-OPS-${Date.now()}`;
    const opsComment = await api('POST', `/api/v1/tasks/${opsRef}/comments`, maya, {
      body: `@Lin ${opsMarker}`,
    });
    assert.equal(opsComment.status, 201);
    await readGlobalUntil(opsMarker);
    assert.match(globalBuffer, /"taskRef":"OPS-1"/);
    assert.match(globalBuffer, /"projectKey":"OPS"/);

    const linGlobal = await api<{
      items: Array<{ taskRef: string; projectKey: string; author: { name: string } }>;
      unread: number;
    }>('GET', '/api/v1/notifications', human);
    assert.equal(linGlobal.status, 200);
    assert.equal(linGlobal.body.data?.unread, 1);
    assert.equal(linGlobal.body.data?.items[0]?.taskRef, opsRef);
    assert.equal(linGlobal.body.data?.items[0]?.projectKey, 'OPS');
    assert.equal(linGlobal.body.data?.items[0]?.author.name, 'Maya');
  } finally {
    controller.abort();
  }
});
