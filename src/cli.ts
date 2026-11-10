#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import {
  ApiError,
  OrbitClient,
  loadDemoConfig,
  projectRoot,
  type CreateTaskPayload,
  type UpdateTaskPayload,
} from './client.js';
import { HOOK_EVENTS, TASK_KINDS, TASK_PRIORITIES, TASK_STATUSES } from './types.js';
import type {
  ActivityEvent,
  AgentJob,
  Automation,
  AutomationAction,
  AutomationRun,
  AutomationTrigger,
  Board,
  HookEvent,
  Project,
  ProjectDetail,
  Task,
  TaskDetail,
  TaskGroup,
  TaskKind,
  TaskPriority,
  TaskStatus,
} from './types.js';

interface GlobalOptions {
  json?: boolean;
  api?: string;
  token?: string;
  as?: 'human' | 'agent';
}

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function color(code: keyof typeof ansi, value: string): string {
  return useColor ? `${ansi[code]}${value}${ansi.reset}` : value;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function charWidth(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff))
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(value: string): number {
  return [...stripAnsi(value)].reduce((sum, char) => sum + charWidth(char), 0);
}

function clip(value: string, max: number): string {
  if (displayWidth(value) <= max) return value;
  let result = '';
  let width = 0;
  for (const char of value) {
    const next = charWidth(char);
    if (width + next > max - 1) break;
    result += char;
    width += next;
  }
  return `${result}…`;
}

function pad(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - displayWidth(value)))}`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index] ?? ''))),
  );
  const line = (cells: string[]) => cells.map((cell, index) => pad(cell, widths[index])).join('  ');
  const divider = widths.map((width) => '─'.repeat(width)).join('  ');
  return [line(headers.map((header) => color('bold', header))), divider, ...rows.map(line)].join('\n');
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function statusLabel(status: string): string {
  const mapping: Record<string, [keyof typeof ansi, string]> = {
    todo: ['dim', 'TODO'],
    doing: ['blue', 'DOING'],
    review: ['yellow', 'REVIEW'],
    done: ['green', 'DONE'],
    queued: ['yellow', 'QUEUED'],
    claimed: ['blue', 'CLAIMED'],
    failed: ['red', 'FAILED'],
    success: ['green', 'SUCCESS'],
    running: ['blue', 'RUNNING'],
  };
  const [code, label] = mapping[status] ?? ['dim', status.toUpperCase()];
  return color(code, label);
}

function actorName(value: { name: string } | null | undefined): string {
  return value?.name ?? '-';
}

function assigneeNames(task: { assignee: { name: string } | null; assignees?: Array<{ name: string }> }): string {
  const names = task.assignees?.map((assigned) => assigned.name) ?? [];
  return names.length > 0 ? names.join('、') : actorName(task.assignee);
}

function triggerLabel(trigger: AutomationTrigger): string {
  if (trigger.type === 'cron') {
    return `cron ${trigger.expression} (${trigger.timezone})`;
  }
  const filter = Object.keys(trigger.filter).length > 0 ? ` ${JSON.stringify(trigger.filter)}` : '';
  return `hook ${trigger.event}${filter}`;
}

function actionLabel(action: AutomationAction): string {
  if (action.type === 'create_task') return `create_task: ${action.config.title}`;
  if (action.type === 'add_comment') return 'add_comment';
  return `enqueue_agent: ${action.config.agent}`;
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function clientFor(command: Command): OrbitClient {
  const options = command.optsWithGlobals() as GlobalOptions;
  if (options.as && options.as !== 'human' && options.as !== 'agent') {
    throw new Error('--as must be "human" or "agent"');
  }
  return new OrbitClient({
    apiUrl: options.api,
    token: options.token,
    asAgent: options.as === 'agent',
  });
}

function wantsJson(command: Command): boolean {
  return Boolean((command.optsWithGlobals() as GlobalOptions).json);
}

function printProject(project: ProjectDetail): void {
  console.log(`${color('bold', `${project.key}  ${project.name}`)}  ${color('dim', project.status)}`);
  if (project.description) console.log(project.description);
  console.log(
    `任务 ${project.stats.total}  待办 ${project.stats.todo}  进行 ${project.stats.doing}  待验收 ${project.stats.review}  完成 ${project.stats.done}`,
  );
  console.log(`成员: ${project.members.map((member) => `${member.actor.name}(${member.actor.kind === 'agent' ? 'agent' : member.role}${member.roleTag ? ` · ${member.roleTag}` : ''})`).join(', ')}`);
}

function printTaskDetail(task: TaskDetail): void {
  console.log(`${color('bold', `${task.ref}  ${task.title}`)}  ${statusLabel(task.status)}`);
  console.log(
    `类型: ${task.kind === 'milestone' ? '里程碑任务' : '普通任务'}  优先级: ${task.priority}  负责人: ${assigneeNames(task)}  开始: ${fmtDate(task.startAt)}  截止: ${fmtDate(task.dueAt)}`,
  );
  console.log(
    `项目: ${task.projectKey}  任务组: ${task.groupName ?? '未分组'}${task.parent ? `  父任务: ${task.parent.ref} ${task.parent.title}` : ''}`,
  );
  if (task.labels.length > 0) console.log(`标签: ${task.labels.join(', ')}`);
  if (task.progress.total > 0) {
    console.log(`子任务: ${task.progress.done}/${task.progress.total} 完成`);
  }
  if (task.description) {
    console.log('');
    console.log(task.description);
  }
  if (task.subtasks.length > 0) {
    console.log('');
    console.log(color('bold', '子任务'));
    for (const subtask of task.subtasks) {
      console.log(`  ${subtask.ref}  ${statusLabel(subtask.status)}  ${subtask.title}  @${assigneeNames(subtask)}`);
    }
  }
  if (task.comments.length > 0) {
    console.log('');
    console.log(color('bold', '评论'));
    for (const comment of task.comments) {
      console.log(`  ${color('dim', fmtDate(comment.createdAt))}  ${color('cyan', comment.author.name)}: ${comment.body}`);
    }
  }
}

function printGroups(groups: TaskGroup[]): void {
  if (groups.length === 0) {
    console.log('No task groups.');
    return;
  }
  console.log(
    table(
      ['ID', 'NAME', 'DONE', 'TOTAL', 'DESCRIPTION'],
      groups.map((group) => [
        group.id,
        clip(group.name, 28),
        String(group.progress.done),
        String(group.progress.total),
        clip(group.description, 52),
      ]),
    ),
  );
}

function printGroup(group: TaskGroup): void {
  console.log(`${color('bold', group.name)}  ${color('dim', `${group.progress.done}/${group.progress.total} done`)}`);
  console.log(`ID: ${group.id}  Project: ${group.projectKey}  Position: ${group.position}`);
  if (group.description) {
    console.log('');
    console.log(group.description);
  }
}

function printBoard(board: Board): void {
  console.log(`${color('bold', `${board.project.key}  ${board.project.name}`)}  ${color('dim', `${board.stats.total} tasks`)}`);
  if (board.groups.length > 0) {
    console.log('');
    console.log(color('bold', '任务组'));
    for (const group of board.groups) {
      console.log(
        `  ${clip(group.name, 30)}  ${color('dim', `${group.progress.done}/${group.progress.total} done`)}`,
      );
    }
  }
  for (const column of board.columns) {
    console.log('');
    console.log(`${statusLabel(column.status)} ${color('dim', `(${column.tasks.length})`)}`);
    if (column.tasks.length === 0) {
      console.log(color('dim', '  —'));
      continue;
    }
    for (const task of column.tasks) {
      const parent = task.progress.total > 0 ? color('dim', ` [${task.progress.done}/${task.progress.total}]`) : '';
      console.log(`  ${task.ref}  ${clip(task.title, 46)}  @${assigneeNames(task)}  ${task.priority}${parent}`);
    }
  }
}

function printActivity(events: ActivityEvent[]): void {
  if (events.length === 0) {
    console.log('No activity.');
    return;
  }
  console.log(
    table(
      ['ID', 'TIME', 'ACTOR', 'TYPE', 'TASK'],
      events.map((event) => [
        String(event.id),
        fmtDate(event.createdAt),
        event.actor.name,
        event.type,
        event.taskRef ?? '-',
      ]),
    ),
  );
}

function printAutomations(automations: Automation[]): void {
  if (automations.length === 0) {
    console.log('No automations.');
    return;
  }
  console.log(
    table(
      ['ID', 'SCOPE', 'NAME', 'TRIGGER', 'ACTION', 'ON', 'LAST'],
      automations.map((automation) => [
        automation.id,
        automation.taskRef ?? color('dim', 'global'),
        clip(automation.name, 26),
        clip(triggerLabel(automation.trigger), 40),
        clip(actionLabel(automation.action), 34),
        automation.enabled ? color('green', 'yes') : color('dim', 'no'),
        automation.lastStatus ?? '-',
      ]),
    ),
  );
}

function printJobs(jobs: AgentJob[]): void {
  if (jobs.length === 0) {
    console.log('No agent jobs.');
    return;
  }
  console.log(
    table(
      ['ID', 'STATUS', 'AGENT', 'TASK', 'TITLE'],
      jobs.map((job) => [
        job.id,
        statusLabel(job.status),
        actorName(job.agent),
        job.taskRef ?? '-',
        clip(job.title, 46),
      ]),
    ),
  );
}

function printJob(job: AgentJob): void {
  console.log(`${color('bold', job.title)}  ${statusLabel(job.status)}`);
  console.log(`ID: ${job.id}  Agent: ${actorName(job.agent)}  任务: ${job.taskRef ?? '-'}`);
  console.log('');
  console.log(job.prompt);
  if (job.result) {
    console.log('');
    console.log(color('bold', '结果'));
    console.log(job.result);
  }
}

function printRun(run: AutomationRun): void {
  console.log(`运行 ${run.id}  ${statusLabel(run.status)}  ${run.triggerType}`);
  if (run.result) {
    console.log(JSON.stringify(run.result, null, 2));
  }
  if (run.error) {
    console.error(color('red', run.error));
  }
}

function parseFilter(value: string | undefined): Record<string, string | number | boolean> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--filter must be a JSON object');
  }
  return parsed as Record<string, string | number | boolean>;
}

function addOne(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();
program
  .name('orbit')
  .description('Orbit AI-native project management CLI (human tables + machine JSON)')
  .version('0.1.0')
  .option('--json', 'emit stable JSON instead of human tables')
  .option('--api <url>', 'Orbit API URL (default: .orbitrc.json / ORBIT_API_URL)')
  .option('--token <token>', 'override actor token (default: .orbitrc.json / ORBIT_TOKEN)')
  .addOption(new Option('--as <identity>', 'use the human or agent demo token').choices(['human', 'agent']));

program
  .command('me')
  .description('show the authenticated actor')
  .action(async (_options, command: Command) => {
    const actor = await clientFor(command).me();
    if (wantsJson(command)) return printJson(actor);
    console.log(`${color('bold', actor.name)}  ${actor.kind}  ${actor.title ?? ''}`.trim());
  });

program
  .command('projects')
  .description('list projects you can access')
  .action(async (_options, command: Command) => {
    const projects = await clientFor(command).listProjects();
    if (wantsJson(command)) return printJson(projects);
    console.log(
      table(
        ['KEY', 'NAME', 'TODO', 'DOING', 'REVIEW', 'DONE', 'ROLE'],
        projects.map((project) => [
          project.key,
          clip(project.name, 34),
          String(project.stats.todo),
          String(project.stats.doing),
          String(project.stats.review),
          String(project.stats.done),
          project.role ?? '-',
        ]),
      ),
    );
  });

program
  .command('project <ref>')
  .description('show project details and members')
  .action(async (ref: string, _options, command: Command) => {
    const project = await clientFor(command).getProject(ref);
    if (wantsJson(command)) return printJson(project);
    printProject(project);
  });

program
  .command('board <project>')
  .description('show the top-level task board')
  .action(async (project: string, _options, command: Command) => {
    const board = await clientFor(command).getBoard(project);
    if (wantsJson(command)) return printJson(board);
    printBoard(board);
  });

program
  .command('groups <project>')
  .description('list task groups (left board rail)')
  .action(async (project: string, _options, command: Command) => {
    const groups = await clientFor(command).listGroups(project);
    if (wantsJson(command)) return printJson(groups);
    printGroups(groups);
  });

program
  .command('group <id>')
  .description('show a task group')
  .action(async (id: string, _options, command: Command) => {
    const group = await clientFor(command).getGroup(id);
    if (wantsJson(command)) return printJson(group);
    printGroup(group);
  });

program
  .command('group-create <project> <name>')
  .description('create a task group')
  .option('--description <text>')
  .option('--position <n>', 'board order (default: append)')
  .action(async (project: string, name: string, options, command: Command) => {
    const group = await clientFor(command).createGroup(project, {
      name,
      description: options.description,
      position: options.position !== undefined ? Number(options.position) : undefined,
    });
    if (wantsJson(command)) return printJson(group);
    console.log(`已创建任务组 ${color('bold', group.id)}  ${group.name}`);
  });

program
  .command('group-update <id>')
  .description('rename or reorder a task group')
  .option('--name <name>')
  .option('--description <text>')
  .option('--position <n>')
  .action(async (id: string, options, command: Command) => {
    const patch: { name?: string; description?: string; position?: number } = {};
    if (options.name !== undefined) patch.name = options.name;
    if (options.description !== undefined) patch.description = options.description;
    if (options.position !== undefined) patch.position = Number(options.position);
    if (Object.keys(patch).length === 0) throw new Error('No fields to update');
    const group = await clientFor(command).updateGroup(id, patch);
    if (wantsJson(command)) return printJson(group);
    console.log(`已更新任务组 ${color('bold', group.id)}  ${group.name}`);
  });

program
  .command('group-delete <id>')
  .description('delete a task group; its tasks become ungrouped')
  .action(async (id: string, _options, command: Command) => {
    await clientFor(command).deleteGroup(id);
    if (wantsJson(command)) return printJson({ id, deleted: true });
    console.log(`已删除任务组 ${color('bold', id)}`);
  });

program
  .command('tasks <project>')
  .description('list top-level tasks (use --all for subtasks)')
  .option('--status <status>', `filter status: ${TASK_STATUSES.join(', ')}`)
  .option('--assignee <ref>', 'filter by actor name/id, "me", or "unassigned"')
  .option('--query <text>', 'search title and description')
  .option('--parent <ref>', 'list subtasks of a task')
  .option('--group <ref>', 'filter by task group id/name, or "none"')
  .option('--all', 'include subtasks')
  .option('--limit <n>', 'max results (1-100)')
  .action(async (project: string, options, command: Command) => {
    const tasks = await clientFor(command).listTasks(project, {
      status: options.status as TaskStatus | undefined,
      assignee: options.assignee,
      query: options.query,
      parent: options.parent,
      group: options.group,
      includeSubtasks: Boolean(options.all),
      limit: options.limit ? Number(options.limit) : undefined,
    });
    if (wantsJson(command)) return printJson(tasks);
    console.log(
      table(
        ['REF', 'STATUS', 'PRIORITY', 'ASSIGNEE', 'GROUP', 'SUBTASKS', 'TITLE'],
        tasks.map((task) => [
          task.ref,
          statusLabel(task.status),
          task.priority,
          assigneeNames(task),
          task.groupName ?? '-',
          task.progress.total ? `${task.progress.done}/${task.progress.total}` : '-',
          clip(task.title, 38),
        ]),
      ),
    );
  });

program
  .command('task <ref>')
  .description('show a task with subtasks and comments')
  .action(async (ref: string, _options, command: Command) => {
    const task = await clientFor(command).getTask(ref);
    if (wantsJson(command)) return printJson(task);
    printTaskDetail(task);
  });

program
  .command('create <project> <title>')
  .description('create a task; pass --parent to create a subtask')
  .option('--description <text>')
  .option('--status <status>', TASK_STATUSES.join(', '))
  .option('--priority <priority>', TASK_PRIORITIES.join(', '))
  .option('--kind <kind>', TASK_KINDS.join(', '))
  .option('--assignee <ref>', 'actor name/id')
  .option('--assignees <refs>', 'comma-separated actor names/ids (overrides --assignee)')
  .option('--start <date>', 'ISO date or YYYY-MM-DD (defaults to creation time)')
  .option('--due <date>', 'ISO date or YYYY-MM-DD')
  .option('--label <label>', 'repeatable label', addOne, [])
  .option('--parent <ref>', 'parent task ref (subtasks can nest)')
  .option('--group <ref>', 'task group id/name (subtasks inherit the parent group)')
  .action(async (project: string, title: string, options, command: Command) => {
    const payload: CreateTaskPayload = {
      title,
      description: options.description,
      status: options.status as TaskStatus | undefined,
      priority: options.priority as TaskPriority | undefined,
      kind: options.kind as TaskKind | undefined,
      assignee: options.assignee,
      assignees: options.assignees
        ? String(options.assignees)
            .split(',')
            .map((ref) => ref.trim())
            .filter(Boolean)
        : undefined,
      startAt: options.start,
      dueAt: options.due,
      labels: options.label.length > 0 ? options.label : undefined,
      parent: options.parent,
      group: options.group,
    };
    const task = await clientFor(command).createTask(project, payload);
    if (wantsJson(command)) return printJson(task);
    console.log(`已创建 ${color('bold', task.ref)}  ${task.title}`);
  });

program
  .command('update <ref>')
  .description('update a task; use assignee=none to unassign')
  .option('--title <title>')
  .option('--description <text>')
  .option('--status <status>', TASK_STATUSES.join(', '))
  .option('--priority <priority>', TASK_PRIORITIES.join(', '))
  .option('--kind <kind>', TASK_KINDS.join(', '))
  .option('--assignee <ref>', 'actor name/id, or "none"')
  .option('--assignees <refs>', 'comma-separated actor names/ids, or "none" to clear')
  .option('--start <date>', 'ISO date or YYYY-MM-DD')
  .option('--due <date>', 'ISO date, YYYY-MM-DD, or "none"')
  .option('--group <ref>', 'task group id/name, or "none"')
  .option('--version <n>', 'optimistic concurrency version')
  .action(async (ref: string, options, command: Command) => {
    const payload: UpdateTaskPayload = {};
    if (options.title !== undefined) payload.title = options.title;
    if (options.description !== undefined) payload.description = options.description;
    if (options.status !== undefined) payload.status = options.status as TaskStatus;
    if (options.priority !== undefined) payload.priority = options.priority as TaskPriority;
    if (options.kind !== undefined) payload.kind = options.kind as TaskKind;
    if (options.assignee !== undefined) {
      payload.assignee = options.assignee === 'none' ? null : options.assignee;
    }
    if (options.assignees !== undefined) {
      payload.assignees =
        options.assignees === 'none'
          ? []
          : String(options.assignees)
              .split(',')
              .map((ref) => ref.trim())
              .filter(Boolean);
    }
    if (options.start !== undefined) payload.startAt = options.start;
    if (options.due !== undefined) payload.dueAt = options.due === 'none' ? null : options.due;
    if (options.group !== undefined) {
      payload.group = options.group === 'none' ? null : options.group;
    }
    if (options.version !== undefined) payload.version = Number(options.version);
    if (Object.keys(payload).length === 0) throw new Error('No fields to update');
    const task = await clientFor(command).updateTask(ref, payload);
    if (wantsJson(command)) return printJson(task);
    console.log(`已更新 ${color('bold', task.ref)}  ${statusLabel(task.status)}  ${task.title}`);
  });

program
  .command('comment <ref> <body>')
  .description('add a comment to a task')
  .action(async (ref: string, body: string, _options, command: Command) => {
    const comment = await clientFor(command).commentOnTask(ref, body);
    if (wantsJson(command)) return printJson(comment);
    console.log(`${color('cyan', comment.author.name)}: ${comment.body}`);
  });

program
  .command('activity <project>')
  .description('show recent project events')
  .option('--after <id>', 'only events with id greater than this')
  .option('--limit <n>', 'max results (1-100)')
  .action(async (project: string, options, command: Command) => {
    const events = await clientFor(command).listActivity(project, {
      after: options.after ? Number(options.after) : undefined,
      limit: options.limit ? Number(options.limit) : undefined,
    });
    if (wantsJson(command)) return printJson(events);
    printActivity(events);
  });

program
  .command('automations <project>')
  .description('list cron and hook automations')
  .action(async (project: string, _options, command: Command) => {
    const automations = await clientFor(command).listAutomations(project);
    if (wantsJson(command)) return printJson(automations);
    printAutomations(automations);
  });

program
  .command('automation <id>')
  .description('show an automation and its recent runs')
  .action(async (id: string, _options, command: Command) => {
    const automation = await clientFor(command).getAutomation(id);
    if (wantsJson(command)) return printJson(automation);
    console.log(`${color('bold', automation.name)}  ${automation.enabled ? color('green', 'enabled') : color('dim', 'disabled')}`);
    console.log(`ID: ${automation.id}  Scope: ${automation.taskRef ?? 'global'}  Trigger: ${triggerLabel(automation.trigger)}`);
    console.log(`Action: ${actionLabel(automation.action)}`);
    console.log(`Next: ${fmtDate(automation.nextRunAt)}  Last: ${fmtDate(automation.lastRunAt)}  Runs: ${automation.runCount}`);
    if (automation.runs.length > 0) {
      console.log('');
      console.log(color('bold', '最近运行'));
      for (const run of automation.runs) {
        console.log(`  ${fmtDate(run.startedAt)}  ${statusLabel(run.status)}  ${run.triggerType}  ${run.error ?? ''}`);
      }
    }
  });

program
  .command('automation-create <project>')
  .description('create a cron or hook automation; both share the same action types')
  .requiredOption('--name <name>', 'automation name')
  .option('--task <ref>', 'scope this rule to one task (default: global)')
  .option('--on <event>', `hook event: ${HOOK_EVENTS.join(', ')}`)
  .option('--cron <expression>', 'cron expression, e.g. "0 9 * * 1-5"')
  .option('--timezone <tz>', 'cron timezone (default: ORBIT_TIMEZONE / Asia/Shanghai)')
  .option('--filter <json>', 'hook filter object, e.g. {"to":"done"}')
  .requiredOption('--action <type>', 'action type')
  .option('--title <title>', 'create_task title or agent job title')
  .option('--description <text>', 'create_task description')
  .option('--body <text>', 'add_comment body')
  .option('--priority <priority>', TASK_PRIORITIES.join(', '))
  .option('--kind <kind>', `create_task kind: ${TASK_KINDS.join(', ')}`)
  .option('--assignee <ref>', 'create_task assignee')
  .option('--agent <ref>', 'enqueue_agent target agent')
  .option('--prompt <prompt>', 'enqueue_agent prompt')
  .option('--disabled', 'create disabled')
  .action(async (project: string, options, command: Command) => {
    if (Boolean(options.on) === Boolean(options.cron)) {
      throw new Error('Pass exactly one of --on or --cron');
    }
    let trigger: AutomationTrigger;
    if (options.on) {
      if (!HOOK_EVENTS.includes(options.on as HookEvent)) {
        throw new Error(`Unknown hook event: ${options.on}`);
      }
      trigger = {
        type: 'hook',
        event: options.on as HookEvent,
        filter: parseFilter(options.filter),
      };
    } else {
      trigger = {
        type: 'cron',
        expression: options.cron,
        timezone: options.timezone ?? process.env.ORBIT_TIMEZONE ?? 'Asia/Shanghai',
      };
    }

    let action: AutomationAction;
    if (options.action === 'create_task') {
      if (!options.title) throw new Error('create_task requires --title');
      action = {
        type: 'create_task',
        config: {
          title: options.title,
          description: options.description,
          priority: options.priority as TaskPriority | undefined,
          kind: options.kind as TaskKind | undefined,
          assignee: options.assignee,
        },
      };
    } else if (options.action === 'add_comment') {
      if (!options.body) throw new Error('add_comment requires --body');
      action = { type: 'add_comment', config: { body: options.body } };
    } else if (options.action === 'enqueue_agent') {
      if (!options.agent || !options.prompt) {
        throw new Error('enqueue_agent requires --agent and --prompt');
      }
      action = {
        type: 'enqueue_agent',
        config: { agent: options.agent, prompt: options.prompt, title: options.title },
      };
    } else {
      throw new Error('--action must be create_task, add_comment, or enqueue_agent');
    }

    const automation = await clientFor(command).createAutomation(project, {
      name: options.name,
      enabled: !options.disabled,
      task: options.task ?? null,
      trigger,
      action,
    });
    if (wantsJson(command)) return printJson(automation);
    console.log(`已创建自动化 ${color('bold', automation.id)}  ${automation.name}`);
    console.log(`  范围: ${automation.taskRef ?? '全局'}  ${triggerLabel(automation.trigger)} -> ${actionLabel(automation.action)}`);
  });

program
  .command('automation-run <id>')
  .description('trigger an automation immediately')
  .action(async (id: string, _options, command: Command) => {
    const run = await clientFor(command).runAutomation(id);
    if (wantsJson(command)) return printJson(run);
    printRun(run);
  });

program
  .command('jobs <project>')
  .description('list agent jobs')
  .option('--status <status>', 'queued, claimed, done, failed')
  .option('--mine', 'only jobs for or claimed by the current actor')
  .option('--agent <ref>', 'filter by agent')
  .option('--limit <n>', 'max results (1-100)')
  .action(async (project: string, options, command: Command) => {
    const jobs = await clientFor(command).listJobs(project, {
      status: options.status,
      agent: options.mine ? 'me' : options.agent,
      limit: options.limit ? Number(options.limit) : undefined,
    });
    if (wantsJson(command)) return printJson(jobs);
    printJobs(jobs);
  });

program
  .command('job <id>')
  .description('show an agent job')
  .action(async (id: string, _options, command: Command) => {
    const job = await clientFor(command).getJob(id);
    if (wantsJson(command)) return printJson(job);
    printJob(job);
  });

program
  .command('job-create <project>')
  .description('enqueue a job for an agent')
  .requiredOption('--title <title>')
  .requiredOption('--prompt <prompt>')
  .option('--task <ref>', 'related task')
  .option('--agent <ref>', 'target agent (must be an agent member)')
  .action(async (project: string, options, command: Command) => {
    const job = await clientFor(command).createJob(project, {
      title: options.title,
      prompt: options.prompt,
      task: options.task,
      agent: options.agent,
    });
    if (wantsJson(command)) return printJson(job);
    console.log(`已创建 Job ${color('bold', job.id)}  ${job.title}`);
  });

program
  .command('job-claim <id>')
  .description('claim a queued agent job')
  .action(async (id: string, _options, command: Command) => {
    const job = await clientFor(command).claimJob(id);
    if (wantsJson(command)) return printJson(job);
    printJob(job);
  });

program
  .command('job-complete <id> <result>')
  .description('complete a claimed agent job')
  .option('--failed', 'mark the job failed')
  .action(async (id: string, result: string, options, command: Command) => {
    const job = await clientFor(command).completeJob(id, result, Boolean(options.failed));
    if (wantsJson(command)) return printJson(job);
    console.log(`Job ${color('bold', job.id)} -> ${statusLabel(job.status)}`);
  });

program
  .command('mcp-config')
  .description('print a ready-to-paste MCP client config using the demo agent token')
  .action(() => {
    const config = loadDemoConfig();
    if (!config?.agentToken) {
      throw new Error('No demo agent token found. Run `npm run setup` first.');
    }
    const root = projectRoot();
    const distEntry = path.join(root, 'dist', 'mcp.js');
    const sourceEntry = path.join(root, 'src', 'mcp.ts');
    const useDist = fs.existsSync(distEntry);
    const output = {
      mcpServers: {
        orbit: {
          command: useDist ? process.execPath : path.join(root, 'node_modules', '.bin', 'tsx'),
          args: [useDist ? distEntry : sourceEntry],
          env: {
            ORBIT_API_URL: process.env.ORBIT_API_URL ?? config.apiUrl,
            ORBIT_TOKEN: config.agentToken,
          },
        },
      },
    };
    console.log(JSON.stringify(output, null, 2));
  });

program.addHelpText(
  'after',
  `
Examples:
  orbit projects
  orbit board ORB
  orbit task ORB-2
  orbit groups IPD
  orbit create IPD "补充 TR4 检查表" --group 开发
  orbit tasks IPD --group 验证
  orbit create ORB "Review MCP contract" --priority high --assignee Atlas
  orbit update ORB-9 --status done
  orbit jobs ORB --mine --as agent
  orbit job-claim job_xxx --as agent
  orbit automation-create ORB --name "Done note" --on task.status_changed --filter '{"to":"done"}' --action add_comment --body "Done by {{actor.name}}"

All list/get commands support --json for Agent-friendly output.
`,
);

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof ApiError) {
    console.error(color('red', `${error.status} ${error.code}: ${error.message}`));
    if (error.details) console.error(JSON.stringify(error.details, null, 2));
  } else {
    console.error(color('red', error instanceof Error ? error.message : String(error)));
  }
  process.exitCode = 1;
});
