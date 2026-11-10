import type { OrbitService, DomainEvent } from './service.js';
import type { Actor, AgentJob, Automation, AutomationRun, Comment, Task } from '../types.js';

const MAX_CHAIN_LENGTH = 4;

interface RunContext {
  actorId?: string;
  taskId?: string | null;
  event?: DomainEvent;
  payload?: Record<string, unknown>;
}

interface TemplateContext {
  project: { key: string; name: string };
  actor: Actor;
  task: Task | null;
  eventType: string;
  date: string;
}

export function renderTemplate(template: string, context: TemplateContext): string {
  const values: Record<string, unknown> = {
    project: context.project,
    actor: context.actor,
    task: context.task,
    event: { type: context.eventType },
    date: context.date,
  };
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    let value: unknown = values;
    for (const segment of path.split('.')) {
      if (value === null || value === undefined || typeof value !== 'object') return '';
      value = (value as Record<string, unknown>)[segment];
    }
    return value === null || value === undefined ? '' : String(value);
  });
}

function matchesFilter(filter: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => String(payload[key] ?? '') === String(expected));
}

export class AutomationEngine {
  constructor(
    private readonly service: OrbitService,
    private readonly logger: Pick<Console, 'error'> = console,
  ) {}

  onEvent(event: DomainEvent, chain: string[] = []): void {
    if (chain.length >= MAX_CHAIN_LENGTH) {
      this.logger.error(`[automation] chain depth limit reached for event ${event.id}`);
      return;
    }
    const automations = this.service.listHookAutomations(event.projectId, event.type);
    for (const automation of automations) {
      if (chain.includes(automation.id)) continue;
      if (automation.trigger.type !== 'hook') continue;
      if (automation.taskId && automation.taskId !== event.taskId) continue;
      if (!matchesFilter(automation.trigger.filter, event.payload)) continue;
      this.runOnce(
        automation,
        'hook',
        { actorId: event.actorId, taskId: event.taskId, event, payload: event.payload },
        chain,
      );
    }
  }

  runOnce(
    automation: Automation,
    triggerType: 'cron' | 'hook' | 'manual',
    context: RunContext = {},
    chain: string[] = [],
  ): AutomationRun {
    const taskId = context.taskId ?? automation.taskId ?? null;
    const effectiveContext: RunContext = { ...context, taskId };
    const triggerPayload: Record<string, unknown> =
      triggerType === 'hook' && context.event
        ? {
            eventId: context.event.id,
            eventType: context.event.type,
            taskId: context.event.taskId,
            payload: context.event.payload,
          }
        : triggerType === 'cron'
          ? { scheduledAt: automation.nextRunAt, firedAt: new Date().toISOString(), taskId }
          : { actorId: context.actorId ?? null, taskId };

    const run = this.service.startAutomationRun(automation.id, triggerType, triggerPayload);
    const nextChain = [...chain, automation.id];

    try {
      if (triggerType === 'cron') {
        this.service.advanceCron(automation.id);
      }
      const result = this.execute(automation, effectiveContext, nextChain);
      return this.service.finishAutomationRun(run.id, automation.id, 'success', result, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[automation] ${automation.id} failed: ${message}`);
      return this.service.finishAutomationRun(run.id, automation.id, 'failed', null, message);
    }
  }

  private execute(
    automation: Automation,
    context: RunContext,
    chain: string[],
  ): Record<string, unknown> {
    const actor = this.service.getActor(context.actorId ?? 'act_system');
    const task = this.service.taskForTemplate(context.taskId ?? null);
    const project = this.service.projectByRef(automation.projectId);
    const templateContext: TemplateContext = {
      project: { key: project.key, name: project.name },
      actor,
      task,
      eventType: context.event?.type ?? '',
      date: new Date().toISOString().slice(0, 10),
    };

    const action = automation.action;
    if (action.type === 'create_task') {
      const title = renderTemplate(action.config.title, templateContext).trim();
      const description = renderTemplate(action.config.description ?? '', templateContext).trim();
      if (!title) throw new Error('Rendered task title is empty');
      const created = this.service.createTaskFromAction(
        automation,
        action.config,
        { title, description },
        chain,
      );
      return { type: 'task.created', taskId: created.id, ref: created.ref, title: created.title };
    }

    if (action.type === 'add_comment') {
      if (!task) throw new Error('add_comment requires a task trigger context');
      const body = renderTemplate(action.config.body, templateContext).trim();
      if (!body) throw new Error('Rendered comment is empty');
      const comment: Comment = this.service.addComment(this.service.systemActor(), task.id, body, { chain });
      return {
        type: 'comment.created',
        commentId: comment.id,
        taskId: task.id,
        taskRef: task.ref,
      };
    }

    if (action.type === 'enqueue_agent') {
      const agent = this.service.agentMember(automation.projectId, action.config.agent);
      const title = renderTemplate(
        action.config.title ?? `Agent job · ${automation.name}`,
        templateContext,
      ).trim();
      const prompt = renderTemplate(action.config.prompt, templateContext).trim();
      if (!prompt) throw new Error('Rendered agent prompt is empty');
      const job: AgentJob = this.service.createJob(this.service.systemActor(), automation.projectId, {
        title: title || `Agent job · ${automation.name}`,
        prompt,
        agent: agent.id,
        task: task?.id ?? null,
        context: {
          automationId: automation.id,
          automationName: automation.name,
          triggerType: context.event ? 'hook' : 'cron',
          eventId: context.event?.id ?? null,
          eventType: context.event?.type ?? null,
          triggeredBy: actor.id,
        },
      });
      return {
        type: 'agent_job.created',
        jobId: job.id,
        title: job.title,
        agent: agent.name,
        taskRef: job.taskRef,
      };
    }

    throw new Error(`Unsupported action type: ${(action as { type: string }).type}`);
  }
}
