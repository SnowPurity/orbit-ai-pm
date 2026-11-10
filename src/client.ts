import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActivityEvent,
  Actor,
  AgentJob,
  Automation,
  AutomationAction,
  AutomationRun,
  AutomationTrigger,
  Board,
  Comment,
  JobStatus,
  Project,
  ProjectDetail,
  ProjectMember,
  Task,
  TaskDetail,
  TaskGroup,
  TaskKind,
  TaskPriority,
  TaskStatus,
  DependencyDirection,
  DependencyType,
} from './types.js';
export interface DemoConfig {
  apiUrl: string;
  humanToken?: string;
  agentToken?: string;
  projectKey?: string;
}

export interface ClientOptions {
  apiUrl?: string;
  token?: string;
  asAgent?: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function findConfigPath(): string | null {
  if (process.env.ORBIT_CONFIG_PATH) return path.resolve(process.env.ORBIT_CONFIG_PATH);
  const rootConfig = path.join(projectRoot(), '.orbitrc.json');
  if (fs.existsSync(rootConfig)) return rootConfig;

  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, '.orbitrc.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadDemoConfig(): DemoConfig | null {
  const configPath = findConfigPath();
  if (!configPath) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as DemoConfig;
  } catch {
    return null;
  }
}

export function resolveClientOptions(options: ClientOptions = {}): Required<Pick<ClientOptions, 'apiUrl' | 'token'>> {
  const config = loadDemoConfig();
  const apiUrl = (
    options.apiUrl ??
    process.env.ORBIT_API_URL ??
    config?.apiUrl ??
    'http://127.0.0.1:8787'
  ).replace(/\/+$/, '');
  const token =
    options.token ??
    process.env.ORBIT_TOKEN ??
    (options.asAgent ? config?.agentToken : config?.humanToken);
  if (!token) {
    throw new Error(
      'No API token found. Run `npm run setup`, or set ORBIT_TOKEN / pass --token.',
    );
  }
  return { apiUrl, token };
}

export interface CreateTaskPayload {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  kind?: TaskKind;
  assignee?: string | null;
  assignees?: string[];
  startAt?: string;
  dueAt?: string | null;
  labels?: string[];
  parent?: string | null;
  group?: string | null;
}

export interface UpdateTaskPayload {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  kind?: TaskKind;
  assignee?: string | null;
  assignees?: string[];
  startAt?: string;
  dueAt?: string | null;
  labels?: string[];
  group?: string | null;
  version?: number;
}

export interface CreateGroupPayload {
  name: string;
  description?: string;
  position?: number;
}

export interface UpdateGroupPayload {
  name?: string;
  description?: string;
  position?: number;
}

export class OrbitClient {
  readonly apiUrl: string;
  private readonly token: string;

  constructor(options: ClientOptions = {}) {
    const resolved = resolveClientOptions(options);
    this.apiUrl = resolved.apiUrl;
    this.token = resolved.token;
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.apiUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    const raw = await response.text();
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string; details?: unknown } })?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'http_error',
        error?.message ?? `HTTP ${response.status}`,
        error?.details,
      );
    }

    if (!raw) return undefined as T;
    return (parsed as { data: T }).data;
  }

  me() {
    return this.request<{ id: string; name: string; kind: string; title: string | null }>('GET', '/api/v1/me');
  }

  listProjects() {
    return this.request<Project[]>('GET', '/api/v1/projects');
  }

  getProject(ref: string) {
    return this.request<ProjectDetail>('GET', `/api/v1/projects/${encodeURIComponent(ref)}`);
  }

  createProject(input: { key: string; name: string; description?: string; color?: string }) {
    return this.request<ProjectDetail>('POST', '/api/v1/projects', input);
  }

  getBoard(project: string) {
    return this.request<Board>('GET', `/api/v1/projects/${encodeURIComponent(project)}/board`);
  }

  listActors(kind?: 'human' | 'agent') {
    const query = kind ? `?kind=${kind}` : '';
    return this.request<Actor[]>('GET', `/api/v1/actors${query}`);
  }

  createActor(input: {
    name: string;
    kind?: 'human' | 'agent';
    title?: string | null;
    externalAgentId?: string | null;
  }) {
    return this.request<Actor>('POST', '/api/v1/actors', input);
  }

  updateActor(
    ref: string,
    input: { name?: string; title?: string | null; externalAgentId?: string | null },
  ) {
    return this.request<Actor>('PATCH', `/api/v1/actors/${encodeURIComponent(ref)}`, input);
  }

  listMembers(project: string) {
    return this.request<ProjectMember[]>(
      'GET',
      `/api/v1/projects/${encodeURIComponent(project)}/members`,
    );
  }

  addMember(
    project: string,
    actor: string,
    role: 'owner' | 'member' = 'member',
    roleTag?: string | null,
  ) {
    return this.request<ProjectMember[]>(
      'POST',
      `/api/v1/projects/${encodeURIComponent(project)}/members`,
      { actor, role, ...(roleTag !== undefined ? { roleTag } : {}) },
    );
  }

  removeMember(project: string, actor: string) {
    return this.request<void>(
      'DELETE',
      `/api/v1/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(actor)}`,
    );
  }

  listTasks(
    project: string,
    filters: {
      status?: TaskStatus;
      assignee?: string;
      query?: string;
      includeSubtasks?: boolean;
      parent?: string;
      group?: string;
      limit?: number;
    } = {},
  ) {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.assignee) params.set('assignee', filters.assignee);
    if (filters.query) params.set('q', filters.query);
    if (filters.includeSubtasks) params.set('includeSubtasks', 'true');
    if (filters.parent) params.set('parent', filters.parent);
    if (filters.group) params.set('group', filters.group);
    if (filters.limit) params.set('limit', String(filters.limit));
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return this.request<Task[]>('GET', `/api/v1/projects/${encodeURIComponent(project)}/tasks${query}`);
  }

  getTask(ref: string) {
    return this.request<TaskDetail>('GET', `/api/v1/tasks/${encodeURIComponent(ref)}`);
  }

  listGroups(project: string) {
    return this.request<TaskGroup[]>(
      'GET',
      `/api/v1/projects/${encodeURIComponent(project)}/groups`,
    );
  }

  getGroup(id: string) {
    return this.request<TaskGroup>('GET', `/api/v1/groups/${encodeURIComponent(id)}`);
  }

  createGroup(project: string, input: CreateGroupPayload) {
    return this.request<TaskGroup>(
      'POST',
      `/api/v1/projects/${encodeURIComponent(project)}/groups`,
      input,
    );
  }

  updateGroup(id: string, input: UpdateGroupPayload) {
    return this.request<TaskGroup>('PATCH', `/api/v1/groups/${encodeURIComponent(id)}`, input);
  }

  deleteGroup(id: string) {
    return this.request<void>('DELETE', `/api/v1/groups/${encodeURIComponent(id)}`);
  }

  createTask(project: string, input: CreateTaskPayload) {
    return this.request<TaskDetail>('POST', `/api/v1/projects/${encodeURIComponent(project)}/tasks`, input);
  }

  updateTask(ref: string, input: UpdateTaskPayload) {
    return this.request<TaskDetail>('PATCH', `/api/v1/tasks/${encodeURIComponent(ref)}`, input);
  }

  commentOnTask(ref: string, body: string) {
    return this.request<Comment>('POST', `/api/v1/tasks/${encodeURIComponent(ref)}/comments`, { body });
  }

  requestAiSuggestion(ref: string, input: { agent?: string } = {}) {
    return this.request<AgentJob>(
      'POST',
      `/api/v1/tasks/${encodeURIComponent(ref)}/ai-suggestion`,
      input,
    );
  }

  addTaskDependency(
    ref: string,
    input: { task: string; direction: DependencyDirection; type: DependencyType },
  ) {
    return this.request<TaskDetail>(
      'POST',
      `/api/v1/tasks/${encodeURIComponent(ref)}/dependencies`,
      input,
    );
  }

  removeTaskDependency(ref: string, dependencyId: string) {
    return this.request<void>(
      'DELETE',
      `/api/v1/tasks/${encodeURIComponent(ref)}/dependencies/${encodeURIComponent(dependencyId)}`,
    );
  }

  listActivity(project: string, options: { after?: number; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (options.after) params.set('after', String(options.after));
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return this.request<ActivityEvent[]>(
      'GET',
      `/api/v1/projects/${encodeURIComponent(project)}/activity${query}`,
    );
  }

  listAutomations(project: string) {
    return this.request<Automation[]>('GET', `/api/v1/projects/${encodeURIComponent(project)}/automations`);
  }

  getAutomation(id: string) {
    return this.request<Automation & { runs: AutomationRun[] }>('GET', `/api/v1/automations/${encodeURIComponent(id)}`);
  }

  createAutomation(
    project: string,
    input: {
      name: string;
      enabled?: boolean;
      task?: string | null;
      trigger: AutomationTrigger;
      action: AutomationAction;
    },
  ) {
    return this.request<Automation>('POST', `/api/v1/projects/${encodeURIComponent(project)}/automations`, input);
  }

  updateAutomation(
    id: string,
    input: {
      name?: string;
      enabled?: boolean;
      task?: string | null;
      trigger?: AutomationTrigger;
      action?: AutomationAction;
    },
  ) {
    return this.request<Automation>('PATCH', `/api/v1/automations/${encodeURIComponent(id)}`, input);
  }

  deleteAutomation(id: string) {
    return this.request<void>('DELETE', `/api/v1/automations/${encodeURIComponent(id)}`);
  }

  runAutomation(id: string) {
    return this.request<AutomationRun>('POST', `/api/v1/automations/${encodeURIComponent(id)}/run`);
  }

  listJobs(project: string, filters: { status?: JobStatus; agent?: string; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.agent) params.set('agent', filters.agent);
    if (filters.limit) params.set('limit', String(filters.limit));
    const query = params.size > 0 ? `?${params.toString()}` : '';
    return this.request<AgentJob[]>('GET', `/api/v1/projects/${encodeURIComponent(project)}/jobs${query}`);
  }

  getJob(id: string) {
    return this.request<AgentJob>('GET', `/api/v1/jobs/${encodeURIComponent(id)}`);
  }

  createJob(
    project: string,
    input: {
      title: string;
      prompt: string;
      task?: string | null;
      agent?: string | null;
      context?: Record<string, unknown>;
    },
  ) {
    return this.request<AgentJob>('POST', `/api/v1/projects/${encodeURIComponent(project)}/jobs`, input);
  }

  claimJob(id: string) {
    return this.request<AgentJob>('POST', `/api/v1/jobs/${encodeURIComponent(id)}/claim`);
  }

  completeJob(id: string, result: string, failed = false) {
    return this.request<AgentJob>('POST', `/api/v1/jobs/${encodeURIComponent(id)}/complete`, {
      result,
      failed,
    });
  }
}

