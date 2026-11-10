import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OrbitService } from '../core/service.js';
import type { WeKnoraCitationResolver } from '../core/weknora-citations.js';
import { badRequest, payloadTooLarge } from '../lib/errors.js';
import type { ActivityEvent } from '../types.js';
import {
  ActivityQuerySchema,
  AddDependencySchema,
  AddMemberSchema,
  AiSuggestionSchema,
  CompleteJobSchema,
  CreateActorSchema,
  CreateAutomationSchema,
  CreateCommentSchema,
  CreateGroupSchema,
  CreateJobSchema,
  CreateProjectSchema,
  CreateTaskSchema,
  JobListQuerySchema,
  MarkNotificationsReadSchema,
  MyTasksQuerySchema,
  NotificationQuerySchema,
  PresenceQuerySchema,
  ResolveCitationsSchema,
  TaskListQuerySchema,
  UpdateActorSchema,
  UpdateAutomationSchema,
  UpdateGroupSchema,
  UpdateMemberRoleTagSchema,
  UpdateProjectSchema,
  UpdateTaskSchema,
} from './schemas.js';

function ok<T>(data: T, meta?: Record<string, unknown>) {
  return meta ? { data, meta } : { data };
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'attachment';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function registerRoutes(
  app: FastifyInstance,
  options: {
    service: OrbitService;
    weknoraUiUrl?: string | null;
    citationResolver?: WeKnoraCitationResolver | null;
    maxUploadBytes: number;
  },
): Promise<void> {
  const { service, weknoraUiUrl = null, citationResolver = null, maxUploadBytes } = options;
  app.get('/health', async () => {
    const row = service.db.prepare('SELECT 1 AS ok').get() as { ok: number };
    return {
      status: row.ok === 1 ? 'ok' : 'error',
      service: 'orbit',
      time: new Date().toISOString(),
    };
  });

  app.get('/api/v1/runtime', async () =>
    ok({
      weknora: weknoraUiUrl ? { uiUrl: weknoraUiUrl } : null,
      files: {
        maxUploadBytes,
        taskFileLimit: service.fileLimits.taskFileLimit,
      },
    }),
  );

  app.post('/api/v1/weknora/citations/resolve', async (request) => {
    const input = ResolveCitationsSchema.parse(request.body ?? {});
    const citations = citationResolver ? await citationResolver.resolve(input.chunkIds) : {};
    return ok({ citations });
  });

  app.get('/api/v1/me', async (request) => ok(request.actor));

  app.get('/api/v1/me/tasks', async (request) => {
    const query = MyTasksQuerySchema.parse(request.query);
    const result = service.listMyTasks(request.actor!, {
      scope: query.scope,
      status: query.status,
      kind: query.kind,
      overdue: query.overdue,
      query: query.q,
      limit: query.limit,
      offset: query.offset,
    });
    return ok(result, { count: result.items.length, hasMore: result.hasMore });
  });

  app.get<{ Querystring: { kind?: string } }>('/api/v1/actors', async (request) => {
    const kind = request.query.kind === 'human' || request.query.kind === 'agent' ? request.query.kind : undefined;
    const actors = service.listActors(request.actor!, kind);
    return ok(actors, { count: actors.length });
  });

  app.post('/api/v1/actors', async (request, reply) => {
    const input = CreateActorSchema.parse(request.body);
    const actor = service.createActor(request.actor!, input);
    return reply.code(201).send(ok(actor));
  });

  app.patch<{ Params: { ref: string } }>('/api/v1/actors/:ref', async (request) => {
    const input = UpdateActorSchema.parse(request.body);
    return ok(service.updateActor(request.actor!, request.params.ref, input));
  });

  app.get<{ Params: { ref: string } }>('/api/v1/actors/:ref/memberships', async (request) => {
    const memberships = service.listActorMemberships(request.actor!, request.params.ref);
    return ok(memberships, { count: memberships.length });
  });

  app.get<{ Params: { ref: string } }>('/api/v1/projects/:ref/members', async (request) => {
    const members = service.listProjectMembers(request.actor!, request.params.ref);
    return ok(members, { count: members.length });
  });

  app.post<{ Params: { ref: string } }>('/api/v1/projects/:ref/members', async (request, reply) => {
    const input = AddMemberSchema.parse(request.body);
    const members = service.addProjectMember(
      request.actor!,
      request.params.ref,
      input.actor,
      input.role,
      input.roleTag,
    );
    return reply.code(201).send(ok(members, { count: members.length }));
  });

  app.patch<{ Params: { ref: string; actor: string } }>(
    '/api/v1/projects/:ref/members/:actor',
    async (request) => {
      const input = UpdateMemberRoleTagSchema.parse(request.body);
      const members = service.updateProjectMemberRoleTag(
        request.actor!,
        request.params.ref,
        request.params.actor,
        input.roleTag,
      );
      return ok(members, { count: members.length });
    },
  );

  app.delete<{ Params: { ref: string; actor: string } }>(
    '/api/v1/projects/:ref/members/:actor',
    async (request, reply) => {
      service.removeProjectMember(request.actor!, request.params.ref, request.params.actor);
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/projects', async (request) => {
    const projects = service.listProjects(request.actor!);
    return ok(projects, { count: projects.length });
  });

  app.post('/api/v1/projects', async (request, reply) => {
    const input = CreateProjectSchema.parse(request.body);
    const project = service.createProject(request.actor!, input);
    return reply.code(201).send(ok(project));
  });

  app.get<{ Params: { ref: string } }>('/api/v1/projects/:ref', async (request) => {
    return ok(service.getProject(request.actor!, request.params.ref));
  });

  app.patch<{ Params: { ref: string } }>('/api/v1/projects/:ref', async (request) => {
    const input = UpdateProjectSchema.parse(request.body);
    return ok(service.updateProject(request.actor!, request.params.ref, input));
  });

  app.get<{ Params: { ref: string } }>('/api/v1/projects/:ref/board', async (request) => {
    return ok(service.getBoard(request.actor!, request.params.ref));
  });

  app.get<{ Params: { ref: string } }>('/api/v1/projects/:ref/groups', async (request) => {
    const groups = service.listGroups(request.actor!, request.params.ref);
    return ok(groups, { count: groups.length });
  });

  app.post<{ Params: { ref: string } }>(
    '/api/v1/projects/:ref/groups',
    async (request, reply) => {
      const input = CreateGroupSchema.parse(request.body);
      const group = service.createGroup(request.actor!, request.params.ref, input);
      return reply.code(201).send(ok(group));
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/groups/:id', async (request) => {
    return ok(service.getGroup(request.actor!, request.params.id));
  });

  app.patch<{ Params: { id: string } }>('/api/v1/groups/:id', async (request) => {
    const current = service.getGroup(request.actor!, request.params.id);
    const patch = UpdateGroupSchema.parse(request.body);
    return ok(
      service.updateGroup(request.actor!, request.params.id, {
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        position: patch.position ?? current.position,
      }),
    );
  });

  app.delete<{ Params: { id: string } }>('/api/v1/groups/:id', async (request, reply) => {
    service.deleteGroup(request.actor!, request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { ref: string } }>('/api/v1/projects/:ref/tasks', async (request) => {
    const query = TaskListQuerySchema.parse(request.query);
    const tasks = service.listTasks(request.actor!, request.params.ref, {
      status: query.status,
      assignee: query.assignee,
      query: query.q,
      includeSubtasks: query.includeSubtasks,
      parent: query.parent,
      group: query.group,
      limit: query.limit,
    });
    return ok(tasks, { count: tasks.length });
  });

  app.post<{ Params: { ref: string } }>('/api/v1/projects/:ref/tasks', async (request, reply) => {
    const input = CreateTaskSchema.parse(request.body);
    const task = service.createTask(request.actor!, request.params.ref, input);
    return reply.code(201).send(ok(task));
  });

  app.get<{ Params: { ref: string } }>('/api/v1/projects/:ref/activity', async (request) => {
    const query = ActivityQuerySchema.parse(request.query);
    const result = service.listActivity(request.actor!, request.params.ref, query);
    return ok(result.items, result.meta);
  });

  type StreamQuery = { after?: string };
  const streamActivity = async (
    request: FastifyRequest,
    reply: FastifyReply,
    scope: { projectKey?: string; projectIds: Set<string> },
  ) => {
    const parsedAfter = Number((request.query as StreamQuery).after ?? 0);
    const after = Number.isFinite(parsedAfter) ? Math.max(0, Math.floor(parsedAfter)) : 0;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    raw.write('retry: 3000\n\n');
    let closed = false;
    let unsubscribe = () => {};
    const releasePresence = service.markOnline(request.actor!.id);
    const send = (event: ActivityEvent) => {
      raw.write(`id: ${event.id}\nevent: domain\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      releasePresence();
      clearInterval(heartbeat);
    };
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        raw.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, 15_000);
    heartbeat.unref?.();
    raw.on('close', cleanup);
    raw.on('error', cleanup);

    let cursor = after;
    for (;;) {
      const batch = (
        scope.projectKey
          ? service.listActivity(request.actor!, scope.projectKey, { after: cursor, limit: 100 })
          : service.listActivityForActor(request.actor!, { after: cursor, limit: 100 })
      ).items.reverse();
      if (batch.length === 0) break;
      for (const event of batch) {
        send(event);
        cursor = event.id;
      }
      if (batch.length < 100) break;
    }
    raw.write(`event: ready\ndata: ${JSON.stringify({ lastId: cursor })}\n\n`);
    unsubscribe = service.onActivity((event) => {
      if (closed || !scope.projectIds.has(event.projectId)) return;
      try {
        send(event);
      } catch {
        cleanup();
      }
    });
  };

  app.get<{ Querystring: StreamQuery }>('/api/v1/events/stream', async (request, reply) => {
    const projects = service.listProjects(request.actor!);
    await streamActivity(request, reply, {
      projectIds: new Set(projects.map((project) => project.id)),
    });
  });

  app.get<{ Params: { ref: string }; Querystring: StreamQuery }>(
    '/api/v1/projects/:ref/events/stream',
    async (request, reply) => {
      const project = service.getProject(request.actor!, request.params.ref);
      await streamActivity(request, reply, {
        projectKey: project.key,
        projectIds: new Set([project.id]),
      });
    },
  );

  app.get('/api/v1/notifications', async (request) => {
    const query = NotificationQuerySchema.parse(request.query);
    const result = service.listNotifications(request.actor!, {
      project: query.project,
      unreadOnly: query.unread,
      limit: query.limit,
    });
    return ok({ items: result.items, unread: result.unread }, { count: result.items.length });
  });

  app.get('/api/v1/presence', async (request) => {
    const query = PresenceQuerySchema.parse(request.query);
    const presence = service.listPresence(request.actor!, query.project);
    return ok(presence, { count: presence.actors.length });
  });

  app.post('/api/v1/notifications/read', async (request) => {
    const input = MarkNotificationsReadSchema.parse(request.body ?? {});
    return ok(service.markNotificationsRead(request.actor!, input));
  });

  app.get<{ Params: { ref: string } }>('/api/v1/projects/:ref/automations', async (request) => {
    const automations = service.listAutomations(request.actor!, request.params.ref);
    return ok(automations, { count: automations.length });
  });

  app.post<{ Params: { ref: string } }>(
    '/api/v1/projects/:ref/automations',
    async (request, reply) => {
      const input = CreateAutomationSchema.parse(request.body);
      const automation = service.createAutomation(request.actor!, request.params.ref, input);
      return reply.code(201).send(ok(automation));
    },
  );

  app.get<{ Params: { ref: string } }>('/api/v1/projects/:ref/jobs', async (request) => {
    const query = JobListQuerySchema.parse(request.query);
    const jobs = service.listJobs(request.actor!, request.params.ref, query);
    return ok(jobs, { count: jobs.length });
  });

  app.post<{ Params: { ref: string } }>('/api/v1/projects/:ref/jobs', async (request, reply) => {
    const input = CreateJobSchema.parse(request.body);
    const job = service.createJob(request.actor!, request.params.ref, input);
    return reply.code(201).send(ok(job));
  });

  app.get<{ Params: { ref: string } }>('/api/v1/tasks/:ref', async (request) => {
    return ok(service.getTask(request.actor!, request.params.ref));
  });

  app.patch<{ Params: { ref: string } }>('/api/v1/tasks/:ref', async (request) => {
    const input = UpdateTaskSchema.parse(request.body);
    return ok(service.updateTask(request.actor!, request.params.ref, input));
  });

  app.post<{ Params: { ref: string } }>('/api/v1/tasks/:ref/comments', async (request, reply) => {
    const input = CreateCommentSchema.parse(request.body);
    const comment = service.addComment(request.actor!, request.params.ref, input.body);
    return reply.code(201).send(ok(comment));
  });

  app.post<{ Params: { ref: string } }>(
    '/api/v1/tasks/:ref/ai-suggestion',
    async (request, reply) => {
      const input = AiSuggestionSchema.parse(request.body ?? {});
      const job = service.createTaskAiSuggestion(request.actor!, request.params.ref, input);
      return reply.code(202).send(ok(job));
    },
  );

  app.get<{ Params: { ref: string } }>('/api/v1/tasks/:ref/files', async (request) => {
    const files = service.listTaskFiles(request.actor!, request.params.ref);
    return ok(files, { count: files.length });
  });

  app.post<{ Params: { ref: string } }>('/api/v1/tasks/:ref/files', async (request, reply) => {
    if (!request.isMultipart()) throw badRequest('Expected multipart/form-data');
    try {
      const part = await request.file();
      if (!part) throw badRequest('A file is required');
      const file = await service.attachTaskFile(request.actor!, request.params.ref, {
        name: part.filename,
        mime: part.mimetype,
        stream: part.file,
      });
      return reply.code(201).send(ok(file));
    } catch (error) {
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        const limitMb = Math.floor(maxUploadBytes / 1024 / 1024);
        throw payloadTooLarge(`File exceeds the ${limitMb} MB limit`);
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/files/:id/download', async (request, reply) => {
    const { file, absolutePath } = await service.openTaskFile(request.actor!, request.params.id);
    const etag = `"${file.sha256}"`;
    reply.headers({
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'content-disposition': contentDisposition(file.name),
      'content-length': String(file.sizeBytes),
      etag,
    });
    if (request.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }
    return reply.type('application/octet-stream').send(createReadStream(absolutePath));
  });

  app.delete<{ Params: { ref: string; id: string } }>(
    '/api/v1/tasks/:ref/files/:id',
    async (request, reply) => {
      await service.deleteTaskFile(request.actor!, request.params.ref, request.params.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { ref: string } }>(
    '/api/v1/tasks/:ref/dependencies',
    async (request, reply) => {
      const input = AddDependencySchema.parse(request.body);
      const task = service.addTaskDependency(request.actor!, request.params.ref, input);
      return reply.code(201).send(ok(task));
    },
  );

  app.delete<{ Params: { ref: string; id: string } }>(
    '/api/v1/tasks/:ref/dependencies/:id',
    async (request, reply) => {
      service.removeTaskDependency(request.actor!, request.params.ref, request.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>('/api/v1/automations/:id', async (request) => {
    return ok(service.getAutomation(request.actor!, request.params.id));
  });

  app.patch<{ Params: { id: string } }>('/api/v1/automations/:id', async (request) => {
    const current = service.getAutomation(request.actor!, request.params.id);
    const patch = UpdateAutomationSchema.parse(request.body);
    const merged = {
      name: patch.name ?? current.name,
      enabled: patch.enabled ?? current.enabled,
      task: patch.task,
      trigger: patch.trigger ?? current.trigger,
      action: patch.action ?? current.action,
    };
    return ok(service.updateAutomation(request.actor!, request.params.id, merged));
  });

  app.delete<{ Params: { id: string } }>('/api/v1/automations/:id', async (request, reply) => {
    service.deleteAutomation(request.actor!, request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/v1/automations/:id/run', async (request) => {
    return ok(await service.runAutomation(request.actor!, request.params.id));
  });

  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', async (request) => {
    return ok(service.getJob(request.actor!, request.params.id));
  });

  app.post<{ Params: { id: string } }>('/api/v1/jobs/:id/claim', async (request) => {
    return ok(service.claimJob(request.actor!, request.params.id));
  });

  app.post<{ Params: { id: string } }>('/api/v1/jobs/:id/complete', async (request) => {
    const input = CompleteJobSchema.parse(request.body);
    return ok(service.completeJob(request.actor!, request.params.id, input.result, input.failed));
  });
}
