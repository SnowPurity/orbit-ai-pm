import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderRichText } from '../public/citations.js';
import { loadConfig } from '../src/config.js';
import { WeKnoraCitationResolver } from '../src/core/weknora-citations.js';
import type { WeKnoraClient } from '../src/core/weknora-worker.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { seedDatabase } from '../src/seed.js';
import { buildApp } from '../src/app.js';

const KB_ID = '3381654a-1ad2-4b60-b908-f9d131570849';
const CHUNK_ID = '76685ebd-3537-4e42-ae8d-58da5b701281';
const KNOWLEDGE_ID = '91d31429-7c52-4046-b2b9-57df968920b9';

test('rich text mentions render as red linked highlights', () => {
  const html = renderRichText('@Atlas 请评审，@Maya 确认清单。', {
    mentionNames: ['Atlas', 'Maya', 'Lin'],
  });
  assert.match(html, /<span class="mention-ref">@Atlas<\/span>/);
  assert.match(html, /<span class="mention-ref">@Maya<\/span>/);
  assert.doesNotMatch(html, /@Lin/);

  const unknown = renderRichText('@Nobody 看一下', { mentionNames: ['Atlas'] });
  assert.doesNotMatch(unknown, /mention-ref/);
});

test('task, project and group descriptions link tasks, subtasks, projects and task groups', () => {
  const html = renderRichText(
    '先做 ORB-12 和子任务 ORB-7，再查看 #IPD，参考 #[概念阶段]。未知 #ZZZ 与 ABC-9 保持原样。',
    {
      projectKey: 'ORB',
      projects: [
        { key: 'ORB', name: '演示项目' },
        { key: 'IPD', name: '模板项目' },
      ],
      groups: [{ id: 'grp_concept', name: '概念阶段' }],
    },
  );
  assert.match(html, /class="ref-link task-ref" href="\/ui\/projects\/ORB\/board\/tasks\/ORB-12" data-link/);
  assert.match(html, /class="ref-link task-ref" href="\/ui\/projects\/ORB\/board\/tasks\/ORB-7" data-link/);
  assert.match(html, /class="ref-link project-ref" href="\/ui\/projects\/IPD\/board" data-link title="模板项目"/);
  assert.match(html, /class="ref-link group-ref" href="\/ui\/projects\/ORB\/board" data-link data-group-focus="grp_concept"/);
  assert.match(html, /#ZZZ/);
  assert.doesNotMatch(html, /task-ref[^>]*>ABC-9/);

  const unsafe = renderRichText('<img src=x onerror=alert(1)> ORB-1', {
    projectKey: 'ORB',
    projects: [{ key: 'ORB', name: '演示项目' }],
    groups: [],
  });
  assert.doesNotMatch(unsafe, /<img/);
  assert.match(unsafe, /&lt;img/);
});

test('descriptions share mention and reference rendering with comments', () => {
  const html = renderRichText('@Lin 跟进 ORB-12，参考项目 #IPD 与任务组 #[概念阶段]。', {
    mentionNames: ['Lin'],
    projectKey: 'ORB',
    projects: [
      { key: 'ORB', name: '演示项目' },
      { key: 'IPD', name: '模板项目' },
    ],
    groups: [{ id: 'grp_concept', name: '概念阶段' }],
  });
  assert.match(html, /<span class="mention-ref">@Lin<\/span>/);
  assert.match(html, /class="ref-link task-ref"/);
  assert.match(html, /class="ref-link project-ref"/);
  assert.match(html, /class="ref-link group-ref"/);
});

test('hyphenated project keys resolve task and project references', () => {
  const html = renderRichText('任务 MOUSE-REQ-1，项目 #MOUSE-REQ，未知 MOUSE-TST-1。', {
    projectKey: 'MOUSE-REQ',
    projects: [
      { key: 'MOUSE-REQ', name: '鼠标需求子项目' },
      { key: 'MOUSE-REQ-TEST', name: '鼠标测试子项目' },
    ],
    groups: [],
  });
  assert.match(
    html,
    /class="ref-link task-ref" href="\/ui\/projects\/MOUSE-REQ\/board\/tasks\/MOUSE-REQ-1" data-link/,
  );
  assert.match(
    html,
    /class="ref-link project-ref" href="\/ui\/projects\/MOUSE-REQ\/board" data-link/,
  );
  assert.match(html, /MOUSE-TST-1/);
  assert.doesNotMatch(html, /MOUSE-TST-1<\/a>/);
});

test('comment citations render as WeKnora knowledge base links', () => {
  const html = renderRichText(
    `市场分析显示需求稳定<kb doc="游戏鼠标与电竞外设市场分析" chunk_id="${CHUNK_ID}" kb_id="${KB_ID}" />。`,
    { uiUrl: 'http://weknora.test:8088' },
  );

  assert.match(html, /市场分析显示需求稳定/);
  assert.match(html, new RegExp(`href="http://weknora\\.test:8088/platform/knowledge-bases/${KB_ID}"`));
  assert.match(html, /target="_blank"/);
  assert.match(html, /游戏鼠标与电竞外设市场分析/);
  assert.match(html, /知识库/);
  assert.doesNotMatch(html, /<kb /);
});

test('resolved citations deep link to the source document', () => {
  const html = renderRichText(
    `<kb doc="市场分析" chunk_id="${CHUNK_ID}" kb_id="${KB_ID}" />`,
    {
      uiUrl: 'http://weknora.test:8088/',
      knowledgeMap: { [CHUNK_ID]: { knowledgeId: KNOWLEDGE_ID, knowledgeBaseId: KB_ID } },
    },
  );

  assert.match(
    html,
    new RegExp(
      `href="http://weknora\\.test:8088/platform/knowledge-bases/${KB_ID}\\?knowledge_id=${KNOWLEDGE_ID}"`,
    ),
  );
  assert.match(html, /文章/);
  assert.doesNotMatch(html, />知识库</);
});

test('comments render Markdown with safe links and escaped raw HTML', () => {
  const html = renderRichText(
    '# 结论\n\n**重点** 与 `code`\n\n- 第一项\n- 第二项\n\n[文档](https://example.com)',
  );
  assert.match(html, /<h1>结论<\/h1>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<li>第一项<\/li>/);
  assert.match(
    html,
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">文档<\/a>/,
  );

  const unsafe = renderRichText(
    '[x](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>',
  );
  assert.doesNotMatch(unsafe, /href="javascript:/);
  assert.doesNotMatch(unsafe, /<img/);
  assert.doesNotMatch(unsafe, /<script>/);
  assert.match(unsafe, /&lt;script&gt;/);
});

test('comments link tasks, projects and task groups', () => {
  const html = renderRichText(
    '@Atlas 看下 ORB-12 的子任务 ORB-7，关联项目 #IPD 与任务组 #[概念阶段]，未知 #ZZZ 与 ABC-9 保持原样。',
    {
      mentionNames: ['Atlas'],
      projectKey: 'ORB',
      projects: [
        { key: 'ORB', name: '演示项目' },
        { key: 'IPD', name: '模板项目' },
      ],
      groups: [{ id: 'grp_concept', name: '概念阶段' }],
    },
  );
  assert.match(html, /<span class="mention-ref">@Atlas<\/span>/);
  assert.match(html, /class="ref-link task-ref" href="\/ui\/projects\/ORB\/board\/tasks\/ORB-12" data-link/);
  assert.match(html, /class="ref-link task-ref" href="\/ui\/projects\/ORB\/board\/tasks\/ORB-7" data-link/);
  assert.match(html, /class="ref-link project-ref" href="\/ui\/projects\/IPD\/board" data-link/);
  assert.match(html, /class="ref-link group-ref" href="\/ui\/projects\/ORB\/board" data-link data-group-focus="grp_concept"/);
  assert.match(html, /#ZZZ/);
  assert.doesNotMatch(html, /class="ref-link[^>]*>ABC-9/);

  const withoutOptions = renderRichText('关联 ORB-12 与 #ORB');
  assert.doesNotMatch(withoutOptions, /class="ref-link/);
  assert.match(withoutOptions, /ORB-12/);
});

test('comment references coexist with citations and do not rewrite citation attributes', () => {
  const html = renderRichText(
    `参考 ORB-12 与 <kb doc="ORB-12 评审记录" chunk_id="${CHUNK_ID}" kb_id="${KB_ID}" />`,
    {
      uiUrl: 'http://weknora.test:8088',
      projectKey: 'ORB',
      projects: [{ key: 'ORB', name: '演示项目' }],
      groups: [],
    },
  );
  assert.equal((html.match(/class="ref-link task-ref"/g) ?? []).length, 1);
  assert.match(html, /knowledge-bases\/3381654a-1ad2-4b60-b908-f9d131570849/);
  assert.match(html, /ORB-12 评审记录/);
});

test('citation resolver dedupes and caches chunk lookups', async () => {
  const calls: string[] = [];
  const client = {
    getChunk: async (chunkId: string) => {
      calls.push(chunkId);
      return chunkId === 'chunk-1'
        ? { knowledgeId: KNOWLEDGE_ID, knowledgeBaseId: KB_ID }
        : null;
    },
  };
  const resolver = new WeKnoraCitationResolver(client as unknown as WeKnoraClient);

  const first = await resolver.resolve(['chunk-1', 'chunk-1', 'missing']);
  assert.deepEqual(first, {
    'chunk-1': { knowledgeId: KNOWLEDGE_ID, knowledgeBaseId: KB_ID },
  });
  assert.deepEqual(calls.sort(), ['chunk-1', 'missing']);

  calls.length = 0;
  const second = await resolver.resolve(['chunk-1', 'missing']);
  assert.deepEqual(second, first);
  assert.deepEqual(calls, ['missing']);
});

test('comment citations escape text and handle multiple or unresolved markers', () => {
  const unsafe = renderRichText(
    '<script>alert(1)</script><kb doc="A &amp; B" chunk_id="c1" kb_id="kb-1" /> 和 <kb doc="C" chunk_id="c2" kb_id="kb-2" />',
    { uiUrl: 'http://weknora.test' },
  );
  assert.doesNotMatch(unsafe, /<script>/);
  assert.match(unsafe, /&lt;script&gt;/);
  assert.equal((unsafe.match(/class="kb-citation"/g) ?? []).length, 2);
  assert.match(unsafe, /A &amp;amp; B/);
  assert.match(unsafe, /knowledge-bases\/kb-1/);
  assert.match(unsafe, /knowledge-bases\/kb-2/);

  const unresolved = renderRichText('<kb doc="D" chunk_id="c3" kb_id="kb-3" />');
  assert.match(unresolved, /<span class="kb-citation"/);
  assert.doesNotMatch(unresolved, /href=/);
});

test('runtime exposes the derived WeKnora UI base', async () => {
  const saved = {
    apiUrl: process.env.WEKNORA_API_URL,
    apiKey: process.env.WEKNORA_API_KEY,
    uiUrl: process.env.WEKNORA_UI_URL,
  };
  process.env.WEKNORA_API_URL = 'http://weknora.test:8088/api/v1';
  process.env.WEKNORA_API_KEY = 'test-key';
  delete process.env.WEKNORA_UI_URL;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-citations-'));
  const dbPath = path.join(dir, 'orbit.db');
  const db = openDatabase(dbPath);
  const seed = seedDatabase(db);
  const config = loadConfig({ dbPath, schedulerEnabled: false, logLevel: 'silent' });
  const bundle = buildApp({ db, config, logger: false, scheduler: false });

  try {
    assert.equal(config.weknoraUiUrl, 'http://weknora.test:8088');
    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/runtime',
      headers: { authorization: `Bearer ${seed.humanToken}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body).data, {
      weknora: { uiUrl: 'http://weknora.test:8088' },
      files: {
        maxUploadBytes: config.maxUploadBytes,
        taskFileLimit: config.taskFileLimit,
      },
    });
    const asset = await bundle.app.inject({ method: 'GET', url: '/ui/citations.js' });
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers['content-type']), /javascript/);

    const vendor = await bundle.app.inject({
      method: 'GET',
      url: '/ui/vendor/markdown-it.mjs',
    });
    assert.equal(vendor.statusCode, 200);
    assert.match(String(vendor.headers['content-type']), /javascript/);
    assert.match(vendor.body, /markdown-it/);

    const license = await bundle.app.inject({
      method: 'GET',
      url: '/ui/vendor/markdown-it.LICENSE',
    });
    assert.equal(license.statusCode, 200);

    const resolve = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/weknora/citations/resolve',
      headers: {
        authorization: `Bearer ${seed.humanToken}`,
        'content-type': 'application/json',
      },
      payload: { chunkIds: [] },
    });
    assert.equal(resolve.statusCode, 200);
    assert.deepEqual(JSON.parse(resolve.body).data, { citations: {} });

    const invalid = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/weknora/citations/resolve',
      headers: {
        authorization: `Bearer ${seed.humanToken}`,
        'content-type': 'application/json',
      },
      payload: { chunkIds: [''] },
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await bundle.app.close();
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [
      ['WEKNORA_API_URL', saved.apiUrl],
      ['WEKNORA_API_KEY', saved.apiKey],
      ['WEKNORA_UI_URL', saved.uiUrl],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
