import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDatabase } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import { LlmWorker, type DeepSeekClient } from '../src/core/llm-worker.js';
import type { WeKnoraClient } from '../src/core/weknora-worker.js';

test('task AI suggestion queues a grounded agent job and posts the answer as a comment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ai-suggestion-'));
  const dbPath = path.join(dir, 'orbit.db');
  const db = openDatabase(dbPath);
  const seed = seedDatabase(db);
  const config = loadConfig({ dbPath, schedulerEnabled: false, logLevel: 'silent' });
  const bundle = buildApp({ db, config, logger: false, scheduler: false });
  const human = { authorization: `Bearer ${seed.humanToken}` };

  try {
    db.prepare("UPDATE agent_jobs SET status = 'done' WHERE id = 'job_demo_1'").run();

    const created = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/ORB-2/ai-suggestion',
      headers: human,
      payload: {},
    });
    assert.equal(created.statusCode, 202);
    const job = JSON.parse(created.body).data as {
      id: string;
      status: string;
      taskRef: string;
      agent: { name: string };
      prompt: string;
    };
    assert.equal(job.status, 'queued');
    assert.equal(job.taskRef, 'ORB-2');
    assert.equal(job.agent.name, 'Atlas');
    assert.match(job.prompt, /当前进度/);
    assert.match(job.prompt, /任务信息/);
    assert.match(job.prompt, /项目知识库/);
    assert.match(job.prompt, /ORB-2/);
    assert.match(job.prompt, /设计 MCP 工具契约/);
    assert.match(job.prompt, /子任务/);
    assert.match(job.prompt, /AI 原生项目管理平台/);

    const duplicate = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/ORB-2/ai-suggestion',
      headers: human,
      payload: {},
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(JSON.parse(duplicate.body).error?.code, 'ai_suggestion_in_progress');

    const messages: Array<Array<{ role: string; content: string }>> = [];
    const fakeClient = {
      chat: async (input: Array<{ role: string; content: string }>) => {
        messages.push(input);
        return '这个任务的目标是稳定 MCP 工具契约，建议先补齐失败场景。';
      },
    } as unknown as DeepSeekClient;
    const worker = new LlmWorker(
      bundle.service,
      { baseUrl: 'http://llm.test', apiKey: 'test-key', model: 'deepseek-chat' },
      60_000,
      { error: () => {} },
      fakeClient,
    );

    assert.equal(await worker.tick(), 1);

    const stored = db
      .prepare('SELECT status, result FROM agent_jobs WHERE id = ?')
      .get(job.id) as { status: string; result: string };
    assert.equal(stored.status, 'done');
    assert.equal(stored.result, '这个任务的目标是稳定 MCP 工具契约，建议先补齐失败场景。');

    const comment = db
      .prepare(
        "SELECT c.body, a.name AS author FROM comments c JOIN actors a ON a.id = c.author_id WHERE c.task_id = 'tsk_orbit_2' ORDER BY c.created_at DESC LIMIT 1",
      )
      .get() as { body: string; author: string };
    assert.equal(comment.author, 'Atlas');
    assert.equal(comment.body, stored.result);

    const userMessage = messages[0]?.find((message) => message.role === 'user')?.content ?? '';
    assert.match(userMessage, /项目知识库/);
    assert.doesNotMatch(userMessage, /项目上下文：/);
  } finally {
    await bundle.app.close();
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AI suggestion uses WeKnora RAG when it is configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ai-rag-'));
  const dbPath = path.join(dir, 'orbit.db');
  const db = openDatabase(dbPath);
  const seed = seedDatabase(db);
  const config = loadConfig({ dbPath, schedulerEnabled: false, logLevel: 'silent' });
  const bundle = buildApp({ db, config, logger: false, scheduler: false });
  const human = { authorization: `Bearer ${seed.humanToken}` };

  try {
    db.prepare("UPDATE agent_jobs SET status = 'done' WHERE id = 'job_demo_1'").run();

    const created = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/ORB-2/ai-suggestion',
      headers: human,
      payload: {},
    });
    assert.equal(created.statusCode, 202);
    const job = JSON.parse(created.body).data as { id: string; prompt: string };

    const calls: Array<{ title: string; query: string; agentId: string }> = [];
    const fakeWeKnora = {
      createSession: async (title: string) => {
        calls.push({ title, query: '', agentId: '' });
        return 'session-rag';
      },
      chat: async (_sessionId: string, query: string, agentId: string) => {
        calls[calls.length - 1].query = query;
        calls[calls.length - 1].agentId = agentId;
        return '基于知识库，ORB-2 应先稳定 MCP 工具契约<kb doc="鼠标行业市场概览" chunk_id="c1" kb_id="kb1" />。';
      },
    } as unknown as WeKnoraClient;
    const fakeDeepSeek = {
      chat: async () => {
        throw new Error('DeepSeek should not be used for AI suggestions when WeKnora is configured');
      },
    } as unknown as DeepSeekClient;

    const worker = new LlmWorker(
      bundle.service,
      { baseUrl: 'http://llm.test', apiKey: 'test-key', model: 'deepseek-chat' },
      60_000,
      { error: () => {}, info: () => {} },
      fakeDeepSeek,
      { baseUrl: 'http://weknora.test', apiKey: 'wk-test', defaultAgentId: 'agent-rag' },
      fakeWeKnora,
    );

    assert.equal(await worker.tick(), 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].title, /ORB-2/);
    assert.match(calls[0].query, /项目知识库/);
    assert.equal(calls[0].agentId, 'agent-rag');

    const stored = db
      .prepare('SELECT status, result FROM agent_jobs WHERE id = ?')
      .get(job.id) as { status: string; result: string };
    assert.equal(stored.status, 'done');
    assert.match(stored.result, /<kb doc="鼠标行业市场概览"/);

    const comment = db
      .prepare(
        "SELECT c.body, a.name AS author FROM comments c JOIN actors a ON a.id = c.author_id WHERE c.task_id = 'tsk_orbit_2' ORDER BY c.created_at DESC LIMIT 1",
      )
      .get() as { body: string; author: string };
    assert.equal(comment.author, 'Atlas');
    assert.equal(comment.body, stored.result);
  } finally {
    await bundle.app.close();
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
