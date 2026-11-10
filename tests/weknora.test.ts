import assert from 'node:assert/strict';
import test from 'node:test';
import { WeKnoraClient } from '../src/core/weknora-worker.js';

test('WeKnora client creates a session and parses SSE answer deltas', async () => {
  const bodies: string[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/sessions')) {
      return new Response(JSON.stringify({ data: { id: 'session-1' }, success: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    bodies.push(String(init?.body ?? ''));
    const sse = [
      'event:message\ndata:{"response_type":"agent_query","content":"","done":true}\n\n',
      'event:message\ndata:{"response_type":"answer","content":"Hello","done":false,"data":{"event_id":"e1"}}\n\n',
      'event:message\ndata:{"response_type":"answer","content":" world","done":false}\n\n',
    ].join('');
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream;charset=utf-8' },
    });
  }) as unknown as typeof fetch;

  const client = new WeKnoraClient(
    { baseUrl: 'http://weknora.test/api/v1', apiKey: 'test-key', defaultAgentId: 'agent-1' },
    fakeFetch,
  );
  const sessionId = await client.createSession('orbit test');
  assert.equal(sessionId, 'session-1');
  const answer = await client.chat(sessionId, 'ping', 'agent-1');
  assert.equal(answer, 'Hello world');
  assert(bodies[0]?.includes('"agent_id":"agent-1"'));
  assert(bodies[0]?.includes('"query":"ping"'));
});
