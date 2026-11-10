import type { WeKnoraConfig } from '../config.js';
import type { AgentJob, Actor } from '../types.js';
import type { OrbitService } from './service.js';

const REQUEST_TIMEOUT_MS = 90_000;
const CHUNK_LOOKUP_TIMEOUT_MS = 15_000;
const MAX_COMMENT_LENGTH = 20_000;

interface WeKnoraLogger {
  error: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
}

function pickString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.length > 0 ? current : null;
}

export class WeKnoraClient {
  constructor(
    private readonly config: WeKnoraConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      'X-API-Key': this.config.apiKey,
      ...extra,
    };
  }

  async createSession(title: string): Promise<string> {    const response = await this.fetchImpl(`${this.config.baseUrl}/sessions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ title: title.slice(0, 120) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`WeKnora session creation failed (${response.status}): ${text.slice(0, 300)}`);
    }
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('WeKnora session response was not JSON');
    }
    const id =
      pickString(payload, ['data', 'id']) ??
      pickString(payload, ['id']) ??
      pickString(payload, ['data', 'session_id']) ??
      pickString(payload, ['session_id']);
    if (!id) throw new Error('WeKnora session response did not include an id');
    return id;
  }

  async getChunk(chunkId: string): Promise<{ knowledgeId: string; knowledgeBaseId: string } | null> {
    const response = await this.fetchImpl(
      `${this.config.baseUrl}/chunks/by-id/${encodeURIComponent(chunkId)}`,
      {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(CHUNK_LOOKUP_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    const data =
      payload && typeof payload === 'object' && 'data' in payload
        ? (payload as { data: unknown }).data
        : payload;
    const knowledgeId = pickString(data, ['knowledge_id']);
    const knowledgeBaseId = pickString(data, ['knowledge_base_id']);
    return knowledgeId && knowledgeBaseId ? { knowledgeId, knowledgeBaseId } : null;
  }

  async chat(sessionId: string, query: string, agentId: string): Promise<string> {
    const response = await this.fetchImpl(
      `${this.config.baseUrl}/agent-chat/${encodeURIComponent(sessionId)}`,
      {
        method: 'POST',
        headers: this.headers({ accept: 'text/event-stream' }),
        body: JSON.stringify({ query, agent_id: agentId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WeKnora chat failed (${response.status}): ${text.slice(0, 300)}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream') && response.body) {
      return this.consumeStream(response.body);
    }
    const text = await response.text();
    try {
      const payload: unknown = JSON.parse(text);
      return (
        pickString(payload, ['data', 'content']) ??
        pickString(payload, ['content']) ??
        pickString(payload, ['data', 'answer']) ??
        pickString(payload, ['answer']) ??
        ''
      );
    } catch {
      return text;
    }
  }

  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? '';
        for (const event of events) {
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (!data || data === '[DONE]') continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          if (!parsed || typeof parsed !== 'object') continue;
          let event_ = parsed as Record<string, unknown>;
          if (
            !('response_type' in event_) &&
            !('content' in event_) &&
            event_.data &&
            typeof event_.data === 'object'
          ) {
            event_ = event_.data as Record<string, unknown>;
          }
          if (event_.response_type && event_.response_type !== 'answer') continue;
          if (typeof event_.content === 'string') {
            answer += event_.content;
          } else {
            const delta = (
              event_.choices as Array<{ delta?: { content?: unknown } }> | undefined
            )?.[0]?.delta?.content;
            if (typeof delta === 'string') answer += delta;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return answer;
  }
}

export class WeKnoraWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly client: WeKnoraClient;

  constructor(
    private readonly service: OrbitService,
    private readonly config: WeKnoraConfig,
    private readonly intervalMs = 5_000,
    private readonly logger: WeKnoraLogger = console,
    client?: WeKnoraClient,
  ) {
    this.client = client ?? new WeKnoraClient(config);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const candidates = this.service.queuedExternalAgentJobs(3);
      let processed = 0;
      for (const { job, agent } of candidates) {
        await this.process(job, agent);
        processed += 1;
      }
      return processed;
    } finally {
      this.running = false;
    }
  }

  private async process(job: AgentJob, agent: Actor): Promise<void> {
    try {
      this.service.claimJob(agent, job.id);
    } catch (error) {
      this.logger.error(
        `[weknora] could not claim job ${job.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    const agentId = agent.externalAgentId ?? this.config.defaultAgentId;
    if (!agentId) {
      this.failJob(
        job,
        agent,
        `Agent "${agent.name}" 未绑定 WeKnora Agent ID，请在人员管理里补充`,
      );
      return;
    }
    try {
      const sessionId = await this.client.createSession(
        `${job.projectKey} ${job.taskRef ?? ''} ${job.title}`.trim(),
      );
      const answer = (await this.client.chat(sessionId, this.buildQuery(job), agentId)).trim();
      if (!answer) throw new Error('WeKnora returned an empty answer');
      if (job.taskRef) {
        this.service.addComment(agent, job.taskRef, answer.slice(0, MAX_COMMENT_LENGTH));
      }
      this.service.completeJob(agent, job.id, answer.slice(0, MAX_COMMENT_LENGTH));
      this.logger.info?.(`[weknora] job ${job.id} completed by ${agent.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[weknora] job ${job.id} failed: ${message}`);
      this.failJob(job, agent, message);
    }
  }

  private failJob(job: AgentJob, agent: Actor, message: string): void {
    try {
      this.service.completeJob(agent, job.id, `WeKnora 调用失败：${message}`.slice(0, 2000), true);
    } catch (error) {
      this.logger.error(
        `[weknora] could not mark job ${job.id} as failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private buildQuery(job: AgentJob): string {
    if (
      job.context?.kind === 'task_ai_suggestion' ||
      job.context?.kind === 'mention_reply'
    ) {
      return job.prompt;
    }
    const task = this.service.taskForTemplate(job.taskId);
    if (!task) return job.prompt;
    const description = task.description.trim().slice(0, 4_000);
    return [
      job.prompt,
      '',
      '任务上下文：',
      `- 编号：${task.ref}`,
      `- 标题：${task.title}`,
      `- 状态：${task.status}；优先级：${task.priority}`,
      task.assignees.length > 0
        ? `- 负责人：${task.assignees.map((item) => item.name).join('、')}`
        : '',
      description ? `- 描述：${description}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
