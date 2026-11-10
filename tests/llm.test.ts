import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDatabase } from '../src/seed.js';
import { OrbitService } from '../src/core/service.js';
import { DeepSeekClient, LlmWorker } from '../src/core/llm-worker.js';

test('DeepSeek client sends chat completions and returns the answer', async () => {
  const requests: Array<{ url: string; body: string; authorization: string }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: String(init?.body ?? ''),
      authorization: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''),
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: ' 建议补充回滚方案 ' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const client = new DeepSeekClient(
    { baseUrl: 'http://llm.test', apiKey: 'test-key', model: 'deepseek-chat' },
    fakeFetch,
  );
  const answer = await client.chat([
    { role: 'system', content: 'system' },
    { role: 'user', content: '请评审 ORB-2' },
  ]);

  assert.equal(answer, '建议补充回滚方案');
  assert.equal(requests[0].url, 'http://llm.test/chat/completions');
  assert.equal(requests[0].authorization, 'Bearer test-key');
  const body = JSON.parse(requests[0].body) as { model: string; messages: Array<{ content: string }> };
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.messages[1].content, '请评审 ORB-2');
});

test('LlmWorker completes queued agent jobs and comments on the task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-llm-'));
  const db = openDatabase(path.join(dir, 'orbit.db'));
  try {
    seedDatabase(db);
    const service = new OrbitService(db);
    const fakeClient = {
      chat: async () => '建议先补充失败场景，再定义重试策略。',
    } as unknown as DeepSeekClient;
    const worker = new LlmWorker(
      service,
      { baseUrl: 'http://llm.test', apiKey: 'test-key', model: 'deepseek-chat' },
      60_000,
      { error: () => {} },
      fakeClient,
    );

    const processed = await worker.tick();
    assert.equal(processed, 1);

    const job = db
      .prepare("SELECT status, result FROM agent_jobs WHERE id = 'job_demo_1'")
      .get() as { status: string; result: string };
    assert.equal(job.status, 'done');
    assert.equal(job.result, '建议先补充失败场景，再定义重试策略。');

    const comment = db
      .prepare(
        "SELECT body FROM comments WHERE task_id = 'tsk_orbit_2' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { body: string };
    assert.equal(comment.body, '建议先补充失败场景，再定义重试策略。');
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
