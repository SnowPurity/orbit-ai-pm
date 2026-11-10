import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { findActor } from '../src/auth.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDatabase } from '../src/seed.js';
import { OrbitService } from '../src/core/service.js';
import { FileStore } from '../src/core/file-store.js';
import { LlmWorker, type DeepSeekClient } from '../src/core/llm-worker.js';

test('mentioning an agent replies with a trimmed task context', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mention-'));
  const db = openDatabase(path.join(dir, 'orbit.db'));
  try {
    seedDatabase(db);
    const service = new OrbitService(db, new FileStore(path.join(dir, 'files')));
    const lin = findActor(db, 'act_lin')!;
    const maya = findActor(db, 'act_maya')!;
    const atlas = findActor(db, 'act_atlas')!;

    service.addTaskDependency(lin, 'ORB-2', {
      task: 'ORB-5',
      direction: 'predecessor',
      type: 'finish_to_start',
    });
    await service.attachTaskFile(lin, 'ORB-2', {
      name: 'MCP 契约说明.txt',
      mime: 'text/plain',
      stream: Readable.from(Buffer.from('工具名称与输入 schema')),
    });
    const group = service.createGroup(lin, 'ORB', {
      name: 'MCP 契约',
      description: '负责 MCP 工具契约、错误码与幂等约定。',
    });
    service.updateTask(lin, 'ORB-2', { group: group.id });
    service.createTask(lin, 'ORB', {
      title: '梳理 MCP 相关任务',
      description: '汇总同组任务的接口边界。',
      group: group.id,
    });

    const question = '@Atlas 请结合子任务、依赖和附件，指出当前最大的风险。';
    const comment = service.addComment(lin, 'ORB-2', question);

    const jobs = db
      .prepare(
        "SELECT id, job.prompt, job.context, job.status FROM agent_jobs job WHERE job.id != 'job_demo_1'",
      )
      .all() as Array<{ id: string; prompt: string; context: string; status: string }>;
    assert.equal(jobs.length, 1, 'one reply job per mentioned agent');
    const job = jobs[0]!;
    assert.equal(job.status, 'queued');
    assert.equal(JSON.parse(job.context).kind, 'mention_reply');
    assert.equal(JSON.parse(job.context).commentId, comment.id);
    assert.match(job.prompt, /触发评论/);
    assert.match(job.prompt, /最大的风险/);
    assert.match(job.prompt, /ORB-2/);
    assert.match(job.prompt, /设计 MCP 工具契约/);
    assert.match(job.prompt, /让 Agent 以少量、语义稳定的工具完成项目管理/);
    assert.match(job.prompt, /AI 原生项目管理平台的内部发布项目/);
    assert.match(job.prompt, /任务组：\n- 名称：MCP 契约/);
    assert.match(job.prompt, /负责 MCP 工具契约、错误码与幂等约定/);
    assert.match(job.prompt, /ORB-7/);
    assert.match(job.prompt, /保持工具数量精简/);
    assert.match(job.prompt, /相关任务：/);
    assert.match(job.prompt, /汇总同组任务的接口边界/);
    assert.match(job.prompt, /近期讨论（最近 3 条）/);
    assert.match(job.prompt, /已完成第一版工具清单/);
    assert.ok(!job.prompt.includes('任务统计'), 'stats should be trimmed');
    assert.ok(!job.prompt.includes('任务依赖'), 'dependencies should be trimmed');
    assert.ok(!job.prompt.includes('前置 ORB-5'), 'dependency details should be trimmed');
    assert.ok(!job.prompt.includes('任务附件'), 'files should be trimmed');
    assert.ok(!job.prompt.includes('MCP 契约说明.txt'), 'file names should be trimmed');
    assert.ok(job.prompt.length <= 4_000, 'prompt should respect the character budget');

    db.prepare("DELETE FROM agent_jobs WHERE id = 'job_demo_1'").run();
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fakeClient = {
      chat: async (messages: Array<{ role: string; content: string }>) => {
        requests.push({ messages });
        return '最大风险是 ORB-5 尚未完成，建议先锁定前置依赖，再推进 ORB-7/ORB-8 的契约评审。';
      },
    } as unknown as DeepSeekClient;
    const worker = new LlmWorker(
      service,
      { baseUrl: 'http://llm.test', apiKey: 'test-key', model: 'deepseek-chat' },
      60_000,
      { error: () => {} },
      fakeClient,
    );

    assert.equal(await worker.tick(), 1);
    assert.match(requests[0]!.messages[1]!.content, /AI 原生项目管理平台的内部发布项目/);
    assert.ok(!requests[0]!.messages[1]!.content.includes('MCP 契约说明.txt'));

    const done = db
      .prepare('SELECT status, result FROM agent_jobs WHERE id = ?')
      .get(job.id) as { status: string; result: string };
    assert.equal(done.status, 'done');
    assert.match(done.result, /ORB-5 尚未完成/);

    const reply = db
      .prepare(
        `SELECT c.body, a.name AS author_name FROM comments c JOIN actors a ON a.id = c.author_id
         WHERE c.task_id = 'tsk_orbit_2' ORDER BY c.created_at DESC LIMIT 1`,
      )
      .get() as { body: string; author_name: string };
    assert.equal(reply.author_name, 'Atlas');
    assert.equal(reply.body, done.result);

    const mentionJobs = db
      .prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE context LIKE '%mention_reply%'")
      .get() as { count: number };
    assert.equal(Number(mentionJobs.count), 1, 'agent replies must not trigger another agent reply');

    service.addComment(maya, 'ORB-2', '@Atlas 补充一个边界条件。');
    service.addComment(atlas, 'ORB-2', '@Atlas 自检');
    const after = db
      .prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE context LIKE '%mention_reply%'")
      .get() as { count: number };
    assert.equal(Number(after.count), 2, 'only human mentions enqueue replies');
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('subtask mentions include the parent task description', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mention-parent-'));
  const db = openDatabase(path.join(dir, 'orbit.db'));
  try {
    seedDatabase(db);
    const service = new OrbitService(db, new FileStore(path.join(dir, 'files')));
    const lin = findActor(db, 'act_lin')!;

    service.addComment(lin, 'ORB-7', '@Atlas 这个子任务和上级任务是什么关系？');

    const job = db
      .prepare("SELECT prompt FROM agent_jobs WHERE context LIKE '%mention_reply%'")
      .get() as { prompt: string };
    assert.match(job.prompt, /上级任务：/);
    assert.match(job.prompt, /ORB-2 \[/);
    assert.match(job.prompt, /让 Agent 以少量、语义稳定的工具完成项目管理/);
    assert.match(job.prompt, /相关任务：/);
    assert.match(job.prompt, /补充错误码与幂等约定/);
    assert.ok(!job.prompt.includes('任务依赖'));
    assert.ok(!job.prompt.includes('任务附件'));
    assert.ok(job.prompt.length <= 4_000);
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
