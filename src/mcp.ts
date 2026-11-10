#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError, OrbitClient } from './client.js';
import {
  DEPENDENCY_TYPES,
  HOOK_EVENTS,
  JOB_STATUSES,
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from './types.js';

let client: OrbitClient;
try {
  client = new OrbitClient({ asAgent: true });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const server = new McpServer(
  { name: 'orbit', version: '0.1.0' },
  {
    instructions:
      'Orbit is an AI-native project manager. Start with list_projects and get_project. Use task refs such as ORB-12 in all calls. Tasks have kind=task (normal) or kind=milestone; TR review tasks are milestones. Task groups organize top-level tasks into board groups shown on the left; list_groups shows them and create_task accepts a group. Subtasks can nest arbitrarily: pass parent to create_task for any task. Task dependencies use add_task_dependency with predecessor/successor direction and one of the four dependency types. request_ai_suggestion enqueues an Agent Job for task analysis. Claim a job before completing it. Cron and hook automations share the same actions; omit task for a global rule or pass a task ref to scope it.',
  },
);

async function safe(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  } catch (error) {
    const message =
      error instanceof ApiError
        ? `${error.status} ${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      isError: true,
      content: [{ type: 'text', text: message }],
    };
  }
}

const projectArg = z.string().min(1).describe('Project id or key, e.g. ORB or MOUSE-REQ');
const taskArg = z.string().min(1).describe('Task ref or id, e.g. ORB-12 or MOUSE-REQ-1');
const filterSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .describe('Exact-match filter against event payload, e.g. {"to":"done"}');

const dependencyDirectionSchema = z.enum(['predecessor', 'successor']);
const dependencyTypeSchema = z.enum(DEPENDENCY_TYPES);

const automationTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('cron'),
    expression: z.string().min(1).describe('Cron expression, e.g. 0 9 * * 1-5'),
    timezone: z.string().default(process.env.ORBIT_TIMEZONE ?? 'Asia/Shanghai'),
  }),
  z.object({
    type: z.literal('hook'),
    event: z.enum(HOOK_EVENTS),
    filter: filterSchema.default({}),
  }),
]);

const automationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_task'),
    config: z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      kind: z.enum(TASK_KINDS).optional(),
      assignee: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('add_comment'),
    config: z.object({ body: z.string().min(1) }),
  }),
  z.object({
    type: z.literal('enqueue_agent'),
    config: z.object({
      agent: z.string().min(1),
      prompt: z.string().min(1),
      title: z.string().optional(),
      auto: z.boolean().optional().describe('Mark as an auto rule created by assignee sync'),
      assignee: z.string().optional(),
      source: z.literal('assignee').optional(),
    }),
  }),
]);

server.registerTool(
  'list_projects',
  {
    title: 'List projects',
    description: 'List projects visible to the authenticated human or agent.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => safe(() => client.listProjects()),
);

server.registerTool(
  'get_project',
  {
    title: 'Get project',
    description: 'Get project metadata, members, and top-level task counts.',
    inputSchema: { project: projectArg },
    annotations: { readOnlyHint: true },
  },
  async ({ project }) => safe(() => client.getProject(project)),
);

server.registerTool(
  'get_board',
  {
    title: 'Get board',
    description:
      'Get the project board snapshot: tasks grouped by status (top-level only), task groups, and project stats.',
    inputSchema: { project: projectArg },
    annotations: { readOnlyHint: true },
  },
  async ({ project }) => safe(() => client.getBoard(project)),
);

server.registerTool(
  'list_tasks',
  {
    title: 'List tasks',
    description:
      'List project tasks. By default only top-level tasks are returned; set includeSubtasks=true or parent to inspect subtasks.',
    inputSchema: {
      project: projectArg,
      status: z.enum(TASK_STATUSES).optional(),
      assignee: z
        .string()
        .optional()
        .describe('Actor name/id, "me", or "unassigned"'),
      query: z.string().optional().describe('Search title and description'),
      includeSubtasks: z.boolean().optional(),
      parent: taskArg.optional().describe('Return only subtasks of this parent'),
      group: z
        .string()
        .optional()
        .describe('Task group id/name, or "none" for ungrouped tasks'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ project, status, assignee, query, includeSubtasks, parent, group, limit }) =>
    safe(() =>
      client.listTasks(project, {
        status,
        assignee,
        query,
        includeSubtasks,
        parent,
        group,
        limit,
      }),
    ),
);

server.registerTool(
  'list_groups',
  {
    title: 'List task groups',
    description:
      'List board task groups with task counts and completion progress. Use a group id or name in create_task/update_task.',
    inputSchema: { project: projectArg },
    annotations: { readOnlyHint: true },
  },
  async ({ project }) => safe(() => client.listGroups(project)),
);

server.registerTool(
  'get_group',
  {
    title: 'Get task group',
    description: 'Get one task group with its counts, progress, and description.',
    inputSchema: { id: z.string().min(1).describe('Task group id') },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => safe(() => client.getGroup(id)),
);

server.registerTool(
  'create_group',
  {
    title: 'Create task group',
    description:
      'Create a task group. Groups organize top-level tasks into board groups on the left; they do not replace parent/subtask hierarchy.',
    inputSchema: {
      project: projectArg,
      name: z.string().min(1).max(120),
      description: z.string().max(20_000).optional(),
      position: z.number().int().min(0).optional(),
    },
  },
  async ({ project, ...input }) => safe(() => client.createGroup(project, input)),
);

server.registerTool(
  'update_group',
  {
    title: 'Update task group',
    description:
      'Rename, re-describe, or reorder a task group. Moving a task group does not move tasks between groups.',
    inputSchema: {
      id: z.string().min(1).describe('Task group id'),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(20_000).optional(),
      position: z.number().int().min(0).optional(),
    },
    annotations: { idempotentHint: true },
  },
  async ({ id, ...input }) => safe(() => client.updateGroup(id, input)),
);

server.registerTool(
  'delete_group',
  {
    title: 'Delete task group',
    description: 'Delete a task group. Its tasks are kept and become ungrouped.',
    inputSchema: { id: z.string().min(1).describe('Task group id') },
    annotations: { destructiveHint: true },
  },
  async ({ id }) =>
    safe(async () => {
      await client.deleteGroup(id);
      return { removed: true, id };
    }),
);

server.registerTool(
  'get_task',
  {
    title: 'Get task',
    description: 'Get one task with description, subtasks, comments, dependencies, and version.',
    inputSchema: { task: taskArg },
    annotations: { readOnlyHint: true },
  },
  async ({ task }) => safe(() => client.getTask(task)),
);

server.registerTool(
  'create_task',
  {
    title: 'Create task',
    description:
      'Create a task or nested subtask. Pass parent=ORB-2 to add a subtask; subtasks can themselves become parents. Returns the new stable ref.',
    inputSchema: {
      project: projectArg,
      title: z.string().min(1).max(200),
      description: z.string().max(20_000).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      kind: z.enum(TASK_KINDS).optional().describe('task = normal task; milestone = milestone task'),
      assignee: z.string().nullable().optional().describe('Actor name/id; null to leave unassigned'),
      assignees: z
        .array(z.string())
        .max(10)
        .optional()
        .describe('Multiple assignees (actor names/ids). Takes precedence over assignee.'),
      startAt: z.string().optional().describe('ISO date or YYYY-MM-DD; defaults to creation time'),
      dueAt: z.string().nullable().optional().describe('ISO date or YYYY-MM-DD'),
      labels: z.array(z.string()).max(10).optional(),
      parent: z.string().nullable().optional().describe('Parent task ref for a subtask'),
      group: z
        .string()
        .nullable()
        .optional()
        .describe('Task group id/name; subtasks inherit the parent group when omitted'),
    },
  },
  async ({ project, ...input }) => safe(() => client.createTask(project, input)),
);

server.registerTool(
  'update_task',
  {
    title: 'Update task',
    description:
      'Update task fields. Pass version to reject concurrent edits. Completing a parent requires all direct subtasks to be done; completing the last subtask auto-completes ancestors.',
    inputSchema: {
      task: taskArg,
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(20_000).optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      kind: z.enum(TASK_KINDS).optional(),
      assignee: z.string().nullable().optional(),
      assignees: z
        .array(z.string())
        .max(10)
        .optional()
        .describe('Replace all assignees; takes precedence over assignee. Pass [] to unassign.'),
      startAt: z.string().optional().describe('ISO date or YYYY-MM-DD'),
      dueAt: z.string().nullable().optional(),
      labels: z.array(z.string()).max(10).optional(),
      group: z.string().nullable().optional().describe('Task group id/name; null to ungroup'),
      version: z.number().int().positive().optional(),
    },
  },
  async ({ task, ...input }) => safe(() => client.updateTask(task, input)),
);

server.registerTool(
  'add_task_dependency',
  {
    title: 'Add task dependency',
    description:
      'Create a dependency between two tasks in the same project. direction=predecessor means relatedTask is before task; successor means relatedTask comes after. Types: finish_to_start, finish_to_finish, start_to_start, start_to_finish. Cycles and duplicates are rejected.',
    inputSchema: {
      task: taskArg,
      relatedTask: taskArg.describe('The other task in the dependency'),
      direction: dependencyDirectionSchema,
      type: dependencyTypeSchema,
    },
  },
  async ({ task, relatedTask, direction, type }) =>
    safe(() => client.addTaskDependency(task, { task: relatedTask, direction, type })),
);

server.registerTool(
  'remove_task_dependency',
  {
    title: 'Remove task dependency',
    description:
      'Remove a dependency by id. Use get_task to read dependency ids from dependencies.predecessors/successors.',
    inputSchema: {
      task: taskArg,
      dependencyId: z.string().min(1).describe('Dependency id from get_task'),
    },
    annotations: { destructiveHint: true },
  },
  async ({ task, dependencyId }) =>
    safe(async () => {
      await client.removeTaskDependency(task, dependencyId);
      return { removed: true, dependencyId };
    }),
);

server.registerTool(
  'request_ai_suggestion',
  {
    title: 'Request AI suggestion',
    description:
      'Enqueue an Agent Job that analyzes a task using project progress, task context, and the knowledge base. The worker posts the answer as a task comment. Pass agent to override the default project Agent. One active suggestion per task.',
    inputSchema: {
      task: taskArg,
      agent: z.string().optional().describe('Agent name/id; defaults to task agent or first project Agent'),
    },
  },
  async ({ task, agent }) => safe(() => client.requestAiSuggestion(task, agent ? { agent } : {})),
);

server.registerTool(
  'comment_on_task',
  {
    title: 'Comment on task',
    description: 'Append a comment to a task. This emits a comment.created hook event.',
    inputSchema: {
      task: taskArg,
      body: z.string().min(1).max(20_000),
    },
  },
  async ({ task, body }) => safe(() => client.commentOnTask(task, body)),
);

server.registerTool(
  'list_activity',
  {
    title: 'List activity',
    description: 'Read the append-only project event stream for audit and automation observation.',
    inputSchema: {
      project: projectArg,
      after: z.number().int().min(0).optional().describe('Only event ids greater than this'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ project, after, limit }) => safe(() => client.listActivity(project, { after, limit })),
);

server.registerTool(
  'list_automations',
  {
    title: 'List automations',
    description:
      'List cron and hook automations with scope (global or task), trigger, action, next run, and last status.',
    inputSchema: { project: projectArg },
    annotations: { readOnlyHint: true },
  },
  async ({ project }) => safe(() => client.listAutomations(project)),
);

server.registerTool(
  'get_automation',
  {
    title: 'Get automation',
    description: 'Get one automation with its configuration and recent run records.',
    inputSchema: { id: z.string().min(1).describe('Automation id') },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => safe(() => client.getAutomation(id)),
);

server.registerTool(
  'create_automation',
  {
    title: 'Create automation',
    description:
      'Create a cron or event-hook automation. Omit task for a global rule, or pass a task ref to scope it to one task. Both trigger types use create_task, add_comment, or enqueue_agent actions; cron + add_comment requires a task scope.',
    inputSchema: {
      project: projectArg,
      name: z.string().min(1).max(120),
      enabled: z.boolean().optional(),
      task: z
        .string()
        .nullable()
        .optional()
        .describe('Task ref/id to scope the rule; omit or null for a global rule'),
      trigger: automationTriggerSchema,
      action: automationActionSchema,
    },
  },
  async ({ project, name, enabled, task, trigger, action }) =>
    safe(() => client.createAutomation(project, { name, enabled, task, trigger, action })),
);

server.registerTool(
  'update_automation',
  {
    title: 'Update automation',
    description:
      'Update an automation. Omitted fields keep their current values; pass task=null to make it global.',
    inputSchema: {
      id: z.string().min(1).describe('Automation id'),
      name: z.string().min(1).max(120).optional(),
      enabled: z.boolean().optional(),
      task: z
        .string()
        .nullable()
        .optional()
        .describe('Task ref/id to scope the rule; null to make it global'),
      trigger: automationTriggerSchema.optional(),
      action: automationActionSchema.optional(),
    },
    annotations: { idempotentHint: true },
  },
  async ({ id, ...input }) => safe(() => client.updateAutomation(id, input)),
);

server.registerTool(
  'delete_automation',
  {
    title: 'Delete automation',
    description: 'Delete an automation and stop future cron or hook runs.',
    inputSchema: { id: z.string().min(1).describe('Automation id') },
    annotations: { destructiveHint: true },
  },
  async ({ id }) =>
    safe(async () => {
      await client.deleteAutomation(id);
      return { removed: true, id };
    }),
);

server.registerTool(
  'run_automation',
  {
    title: 'Run automation',
    description: 'Trigger an automation immediately and return its run record.',
    inputSchema: { id: z.string().min(1).describe('Automation id') },
  },
  async ({ id }) => safe(() => client.runAutomation(id)),
);

server.registerTool(
  'list_jobs',
  {
    title: 'List agent jobs',
    description:
      'List the agent inbox. Pass agent="me" to find jobs assigned to or claimed by the current actor.',
    inputSchema: {
      project: projectArg,
      status: z.enum(JOB_STATUSES).optional(),
      agent: z.string().optional().describe('Agent name/id or "me"'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ project, status, agent, limit }) =>
    safe(() => client.listJobs(project, { status, agent, limit })),
);

server.registerTool(
  'get_job',
  {
    title: 'Get agent job',
    description: 'Get one agent job by id, including prompt, context, result, and claim state.',
    inputSchema: { id: z.string().min(1).describe('Job id') },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => safe(() => client.getJob(id)),
);

server.registerTool(
  'create_job',
  {
    title: 'Create agent job',
    description: 'Enqueue work for an agent. Optionally attach it to a task and target a specific agent.',
    inputSchema: {
      project: projectArg,
      title: z.string().min(1).max(200),
      prompt: z.string().min(1).max(20_000),
      task: z.string().nullable().optional(),
      agent: z.string().nullable().optional(),
      context: z.record(z.string(), z.unknown()).optional(),
    },
  },
  async ({ project, ...input }) => safe(() => client.createJob(project, input)),
);

server.registerTool(
  'claim_job',
  {
    title: 'Claim agent job',
    description: 'Claim a queued job before doing the work. Claiming is required before completion.',
    inputSchema: { id: z.string().min(1) },
  },
  async ({ id }) => safe(() => client.claimJob(id)),
);

server.registerTool(
  'complete_job',
  {
    title: 'Complete agent job',
    description: 'Complete or fail a claimed job with a result. Optionally comment on the linked task separately.',
    inputSchema: {
      id: z.string().min(1),
      result: z.string().min(1).max(100_000),
      failed: z.boolean().optional(),
    },
  },
  async ({ id, result, failed }) => safe(() => client.completeJob(id, result, failed)),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
