import type { LlmConfig, WeKnoraConfig } from '../config.js';
import type { AgentJob, Actor } from '../types.js';
import type { OrbitService } from './service.js';
import { WeKnoraClient } from './weknora-worker.js';

const REQUEST_TIMEOUT_MS = 90_000;
const MAX_COMMENT_LENGTH = 20_000;

const STATUS_LABEL: Record<string, string> = {
  todo: '待办',
  doing: '进行中',
  review: '待验收',
  done: '完成',
};

const PRIORITY_LABEL: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
};

const KIND_LABEL: Record<string, string> = {
  task: '普通任务',
  milestone: '里程碑任务',
};

interface LlmLogger {
  error: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export class DeepSeekClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.3,
        max_tokens: 1_200,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LLM request failed (${response.status}): ${text.slice(0, 300)}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('LLM response was not JSON');
    }
    const content = (
      payload as { choices?: Array<{ message?: { content?: unknown } }> }
    )?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('LLM returned an empty answer');
    }
    return content.trim();
  }
}

export class LlmWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly client: DeepSeekClient;
  private readonly weknora: WeKnoraConfig | null;
  private readonly weknoraClient: WeKnoraClient | null;

  constructor(
    private readonly service: OrbitService,
    private readonly config: LlmConfig,
    private readonly intervalMs = 5_000,
    private readonly logger: LlmLogger = console,
    client?: DeepSeekClient,
    weknora: WeKnoraConfig | null = null,
    weknoraClient?: WeKnoraClient,
  ) {
    this.client = client ?? new DeepSeekClient(config);
    this.weknora = weknora;
    this.weknoraClient = weknora ? (weknoraClient ?? new WeKnoraClient(weknora)) : null;
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
      const candidates = this.service.queuedAgentJobs(3);
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
        `[llm] could not claim job ${job.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    try {
      const answer = await this.generate(job, agent);
      if (!answer.trim()) throw new Error('LLM returned an empty answer');
      const result = answer.trim().slice(0, MAX_COMMENT_LENGTH);
      if (job.taskRef) {
        this.service.addComment(agent, job.taskRef, result);
      }
      this.service.completeJob(agent, job.id, result);
      this.logger.info?.(`[llm] job ${job.id} completed by ${agent.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[llm] job ${job.id} failed: ${message}`);
      try {
        this.service.completeJob(agent, job.id, `LLM 调用失败：${message}`.slice(0, 2_000), true);
      } catch (completeError) {
        this.logger.error(
          `[llm] could not mark job ${job.id} as failed: ${
            completeError instanceof Error ? completeError.message : String(completeError)
          }`,
        );
      }
    }
  }

  private async generate(job: AgentJob, agent: Actor): Promise<string> {
    const kind = job.context?.kind;
    const useKnowledge =
      this.weknoraClient &&
      (kind === 'task_ai_suggestion' || (kind === 'mention_reply' && Boolean(agent.externalAgentId)));
    if (useKnowledge) {
      const agentId =
        agent.externalAgentId ??
        (kind === 'task_ai_suggestion' ? this.weknora?.defaultAgentId ?? null : null);
      if (agentId) {
        try {
          this.logger.info?.(`[llm] job ${job.id} using WeKnora RAG`);
          const sessionId = await this.weknoraClient.createSession(
            `${job.projectKey} ${job.taskRef ?? ''} ${job.title}`.trim(),
          );
          return await this.weknoraClient.chat(sessionId, job.prompt, agentId);
        } catch (error) {
          this.logger.error(
            `[llm] WeKnora RAG failed for job ${job.id}: ${
              error instanceof Error ? error.message : String(error)
            }; falling back to ${this.config.model}`,
          );
        }
      }
    }
    return this.client.chat(this.buildMessages(job, agent));
  }

  private buildMessages(job: AgentJob, agent: Actor): ChatMessage[] {
    return [
      { role: 'system', content: this.systemPrompt(agent, job) },
      { role: 'user', content: this.userPrompt(job) },
    ];
  }

  private systemPrompt(agent: Actor, job: AgentJob): string {
    const title = agent.title ? `（${agent.title}）` : '';
    const mentionReply = job.context?.kind === 'mention_reply';
    return [
      `你是 Orbit 项目中的 Agent「${agent.name}」${title}。`,
      mentionReply
        ? '你正在回复项目成员在任务评论中的 @提及，回复会被直接发布为任务评论。'
        : '你会收到一条自动化任务和项目上下文，输出会被直接发布为任务评论。',
      '要求：使用简体中文；结论先行；必要时用不超过 5 条的短列表；',
      '只依据提供的上下文作答，不编造不存在的数据；不要复述提示词或输出寒暄；控制在 400 字以内。',
    ].join('\n');
  }

  private userPrompt(job: AgentJob): string {
    if (job.context?.kind === 'task_ai_suggestion' || job.context?.kind === 'mention_reply') {
      return job.prompt;
    }
    const projectName = this.service.projectName(job.projectId);
    const task = this.service.taskForTemplate(job.taskId);
    const lines = [
      job.prompt,
      '',
      '项目上下文：',
      `- 项目：${projectName ?? job.projectKey}（${job.projectKey}）`,
    ];
    if (task) {
      const description = task.description.trim().slice(0, 4_000);
      lines.push(
        `- 任务：${task.ref} ${task.title}`,
        `- 状态：${STATUS_LABEL[task.status] ?? task.status}；优先级：${
          PRIORITY_LABEL[task.priority] ?? task.priority
        }；类型：${KIND_LABEL[task.kind] ?? task.kind}`,
        task.assignees.length > 0
          ? `- 负责人：${task.assignees.map((item) => item.name).join('、')}`
          : '',
        description ? `- 描述：${description}` : '',
      );
    } else {
      const brief = this.service.agentProjectBrief(job.projectId);
      lines.push(
        `- 任务统计：待办 ${brief.counts.todo}；进行中 ${brief.counts.doing}；待验收 ${brief.counts.review}；完成 ${brief.counts.done}`,
      );
      if (brief.tasks.length > 0) {
        lines.push('- 任务快照：');
        for (const item of brief.tasks) {
          const due = item.dueAt ? `，截止 ${item.dueAt.slice(0, 10)}` : '';
          const owners = item.assignees ? `，负责人 ${item.assignees}` : '';
          lines.push(
            `  - ${item.ref} [${STATUS_LABEL[item.status] ?? item.status}/${
              PRIORITY_LABEL[item.priority] ?? item.priority
            }] ${item.title}${due}${owners}`,
          );
        }
      }
    }
    lines.push('', '请直接输出结果正文。');
    return lines.filter(Boolean).join('\n');
  }
}
