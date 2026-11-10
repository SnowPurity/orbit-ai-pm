import { z } from 'zod';
import {
  DEPENDENCY_TYPES,
  HOOK_EVENTS,
  JOB_STATUSES,
  MY_TASK_SCOPES,
  TASK_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '../types.js';

const title = z.string().trim().min(1).max(200);
const description = z.string().max(20_000);
const actorRef = z.string().trim().min(1).max(80);
const filterValue = z.union([z.string(), z.number(), z.boolean()]);

export const CreateProjectSchema = z.object({
  key: z.string().trim().min(2).max(20),
  name: z.string().trim().min(1).max(120),
  description: description.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const UpdateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  key: z.string().trim().min(2).max(20).optional(),
  description: description.optional(),
});

export const CreateTaskSchema = z.object({
  title,
  description: description.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  kind: z.enum(TASK_KINDS).optional(),
  assignee: actorRef.nullable().optional(),
  assignees: z.array(actorRef).max(10).optional(),
  startAt: z.string().trim().min(1).optional(),
  dueAt: z.string().trim().min(1).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  parent: z.string().trim().min(1).nullable().optional(),
  group: z.string().trim().min(1).nullable().optional(),
});

export const CreateGroupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: description.optional(),
  position: z.number().int().min(0).optional(),
});

export const UpdateGroupSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: description.optional(),
  position: z.number().int().min(0).optional(),
});

export const UpdateTaskSchema = z.object({
  title: title.optional(),
  description: description.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  kind: z.enum(TASK_KINDS).optional(),
  assignee: actorRef.nullable().optional(),
  assignees: z.array(actorRef).max(10).optional(),
  startAt: z.string().trim().min(1).optional(),
  dueAt: z.string().trim().min(1).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  group: z.string().trim().min(1).nullable().optional(),
  version: z.number().int().positive().optional(),
});

export const CreateCommentSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});

export const CronTriggerSchema = z.object({
  type: z.literal('cron'),
  expression: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).default(process.env.ORBIT_TIMEZONE ?? 'Asia/Shanghai'),
});

export const HookTriggerSchema = z.object({
  type: z.literal('hook'),
  event: z.enum(HOOK_EVENTS),
  filter: z.record(z.string(), filterValue).default({}),
});

export const AutomationTriggerSchema = z.discriminatedUnion('type', [
  CronTriggerSchema,
  HookTriggerSchema,
]);

export const AutomationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_task'),
    config: z.object({
      title,
      description: description.optional(),
      status: z.enum(TASK_STATUSES).optional(),
      priority: z.enum(TASK_PRIORITIES).optional(),
      kind: z.enum(TASK_KINDS).optional(),
      assignee: actorRef.optional(),
    }),
  }),
  z.object({
    type: z.literal('add_comment'),
    config: z.object({ body: z.string().trim().min(1).max(20_000) }),
  }),
  z.object({
    type: z.literal('enqueue_agent'),
    config: z.object({
      agent: actorRef,
      prompt: z.string().trim().min(1).max(20_000),
      title: title.optional(),
      auto: z.boolean().optional(),
      assignee: actorRef.optional(),
      source: z.literal('assignee').optional(),
    }),
  }),
]);

export const CreateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  task: z.string().trim().min(1).max(80).nullable().optional(),
  trigger: AutomationTriggerSchema,
  action: AutomationActionSchema,
});

export const UpdateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  task: z.string().trim().min(1).max(80).nullable().optional(),
  trigger: AutomationTriggerSchema.optional(),
  action: AutomationActionSchema.optional(),
});

export const CreateJobSchema = z.object({
  title,
  prompt: z.string().trim().min(1).max(20_000),
  task: z.string().trim().min(1).nullable().optional(),
  agent: actorRef.nullable().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const AiSuggestionSchema = z.object({
  agent: actorRef.optional(),
});

export const AddDependencySchema = z.object({
  task: z.string().trim().min(1).max(80),
  direction: z.enum(['predecessor', 'successor']),
  type: z.enum(DEPENDENCY_TYPES),
});

export const ResolveCitationsSchema = z.object({
  chunkIds: z.array(z.string().trim().min(1).max(120)).max(50),
});

export const CompleteJobSchema = z.object({
  result: z.string().trim().min(1).max(100_000),
  failed: z.boolean().optional(),
});

export const CreateActorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['human', 'agent']).default('human'),
  title: z.string().trim().max(120).nullable().optional(),
  externalAgentId: z.string().trim().max(120).nullable().optional(),
});

export const UpdateActorSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().max(120).nullable().optional(),
  externalAgentId: z.string().trim().max(120).nullable().optional(),
});

export const AddMemberSchema = z.object({
  actor: actorRef,
  role: z.enum(['owner', 'member']).default('member'),
  roleTag: z.string().max(40).nullish(),
});

export const UpdateMemberRoleTagSchema = z.object({
  roleTag: z.string().max(40).nullable(),
});

const booleanParam = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1')
  .optional();

export const TaskListQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  assignee: actorRef.optional(),
  q: z.string().trim().max(200).optional(),
  includeSubtasks: booleanParam,
  parent: z.string().trim().min(1).optional(),
  group: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const MyTasksQuerySchema = z.object({
  scope: z.enum(MY_TASK_SCOPES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  kind: z.enum(TASK_KINDS).optional(),
  overdue: booleanParam,
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
});

export const ActivityQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const NotificationQuerySchema = z.object({
  project: z.string().trim().min(1).optional(),
  unread: booleanParam,
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const PresenceQuerySchema = z.object({
  project: z.string().trim().min(1).optional(),
});

export const MarkNotificationsReadSchema = z.object({
  ids: z.array(z.string().trim().min(1)).max(100).optional(),
  project: z.string().trim().min(1).optional(),
});

export const JobListQuerySchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  agent: actorRef.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type CreateProjectBody = z.infer<typeof CreateProjectSchema>;
export type CreateTaskBody = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskBody = z.infer<typeof UpdateTaskSchema>;
export type CreateGroupBody = z.infer<typeof CreateGroupSchema>;
export type UpdateGroupBody = z.infer<typeof UpdateGroupSchema>;
export type CreateCommentBody = z.infer<typeof CreateCommentSchema>;
export type CreateAutomationBody = z.infer<typeof CreateAutomationSchema>;
export type UpdateAutomationBody = z.infer<typeof UpdateAutomationSchema>;
export type CreateJobBody = z.infer<typeof CreateJobSchema>;
export type CompleteJobBody = z.infer<typeof CompleteJobSchema>;
export type CreateActorBody = z.infer<typeof CreateActorSchema>;
export type UpdateActorBody = z.infer<typeof UpdateActorSchema>;
export type AddMemberBody = z.infer<typeof AddMemberSchema>;
export type UpdateMemberRoleTagBody = z.infer<typeof UpdateMemberRoleTagSchema>;
