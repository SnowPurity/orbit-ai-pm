export const TASK_STATUSES = ['todo', 'doing', 'review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_KINDS = ['task', 'milestone'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export function isTrReviewTitle(title: string): boolean {
  return /\bTR\s*[1-6]\b/i.test(title) || /\bTR\s*评审/i.test(title);
}

export const ACTOR_KINDS = ['human', 'agent', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const JOB_STATUSES = ['queued', 'claimed', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const DEPENDENCY_TYPES = [
  'finish_to_start',
  'finish_to_finish',
  'start_to_start',
  'start_to_finish',
] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];
export type DependencyDirection = 'predecessor' | 'successor';

export const HOOK_EVENTS = [
  'task.created',
  'task.updated',
  'task.status_changed',
  'task.assigned',
  'comment.created',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface Actor {
  id: string;
  name: string;
  kind: ActorKind;
  title: string | null;
  externalAgentId?: string | null;
}

export interface ProjectStats {
  total: number;
  todo: number;
  doing: number;
  review: number;
  done: number;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  color: string;
  role?: 'owner' | 'member';
  stats: ProjectStats;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  actor: Actor;
  role: 'owner' | 'member';
  roleTag: string | null;
}

export interface ActorMembership {
  project: { id: string; key: string; name: string; color: string };
  role: 'owner' | 'member';
  roleTag: string | null;
}

export interface ProjectDetail extends Project {
  members: ProjectMember[];
}

export interface SubtaskProgress {
  done: number;
  total: number;
}

export interface TaskGroup {
  id: string;
  projectId: string;
  projectKey: string;
  name: string;
  description: string;
  position: number;
  taskCount: number;
  progress: SubtaskProgress;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  ref: string;
  number: number;
  projectId: string;
  projectKey: string;
  parentId: string | null;
  parentRef: string | null;
  groupId: string | null;
  groupName: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  kind: TaskKind;
  assignee: Actor | null;
  assignees: Actor[];
  createdBy: Actor;
  startAt: string;
  dueAt: string | null;
  labels: string[];
  version: number;
  progress: SubtaskProgress;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Comment {
  id: string;
  taskId: string;
  body: string;
  author: Actor;
  createdAt: string;
}

export interface TaskParentSummary {
  id: string;
  ref: string;
  title: string;
  status: TaskStatus;
}

export interface TaskDependencyLink {
  id: string;
  type: DependencyType;
  task: TaskParentSummary;
  createdAt: string;
}

export interface TaskDependencies {
  predecessors: TaskDependencyLink[];
  successors: TaskDependencyLink[];
}

export interface TaskFile {
  id: string;
  taskId: string;
  taskRef: string;
  projectId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: Actor;
  createdAt: string;
}

export interface TaskDetail extends Task {
  parent: TaskParentSummary | null;
  subtasks: Task[];
  comments: Comment[];
  dependencies: TaskDependencies;
  files: TaskFile[];
}

export interface ActivityEvent {
  id: number;
  type: string;
  projectId: string;
  projectKey: string;
  taskId: string | null;
  taskRef: string | null;
  actor: Actor;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface NotificationItem {
  id: string;
  kind: 'mention';
  projectId: string;
  projectKey: string;
  taskId: string | null;
  taskRef: string | null;
  taskTitle: string | null;
  commentId: string;
  excerpt: string;
  author: Actor;
  readAt: string | null;
  createdAt: string;
}

export interface CronTrigger {
  type: 'cron';
  expression: string;
  timezone: string;
}

export interface HookTrigger {
  type: 'hook';
  event: HookEvent;
  filter: Record<string, string | number | boolean>;
}

export type AutomationTrigger = CronTrigger | HookTrigger;

export interface CreateTaskAction {
  type: 'create_task';
  config: {
    title: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    kind?: TaskKind;
    assignee?: string;
  };
}

export interface AddCommentAction {
  type: 'add_comment';
  config: { body: string };
}

export interface EnqueueAgentAction {
  type: 'enqueue_agent';
  config: {
    agent: string;
    prompt: string;
    title?: string;
    auto?: boolean;
    assignee?: string;
    source?: 'assignee';
  };
}

export type AutomationAction = CreateTaskAction | AddCommentAction | EnqueueAgentAction;

export interface AutomationRun {
  id: string;
  automationId: string;
  triggerType: 'cron' | 'hook' | 'manual';
  status: 'running' | 'success' | 'failed' | 'skipped';
  triggerPayload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Automation {
  id: string;
  projectId: string;
  scope: 'global' | 'task';
  taskId: string | null;
  taskRef: string | null;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  action: AutomationAction;
  createdBy: Actor;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  lastRun?: AutomationRun | null;
}

export interface AgentJob {
  id: string;
  projectId: string;
  projectKey: string;
  taskId: string | null;
  taskRef: string | null;
  agent: Actor | null;
  claimedBy: Actor | null;
  title: string;
  prompt: string;
  context: Record<string, unknown>;
  status: JobStatus;
  result: string | null;
  createdBy: Actor;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

export interface Board {
  project: { id: string; key: string; name: string };
  columns: Array<{
    status: TaskStatus;
    tasks: Task[];
  }>;
  groups: TaskGroup[];
  stats: ProjectStats;
}

export const MY_TASK_SCOPES = ['related', 'assigned', 'created'] as const;
export type MyTaskScope = (typeof MY_TASK_SCOPES)[number];

export interface MyTaskStats {
  total: number;
  todo: number;
  doing: number;
  review: number;
  done: number;
  overdue: number;
}

export interface MyTasksResult {
  items: Task[];
  stats: MyTaskStats;
  hasMore: boolean;
}

export interface Paginated<T> {
  items: T[];
  meta: { count: number; limit: number };
}
