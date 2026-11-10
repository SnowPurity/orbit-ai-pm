import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import { authenticate } from './auth.js';
import { AppError } from './lib/errors.js';
import { OrbitService } from './core/service.js';
import { FileStore } from './core/file-store.js';
import { AutomationEngine } from './core/automation-engine.js';
import { CronScheduler } from './core/scheduler.js';
import { WeKnoraClient, WeKnoraWorker } from './core/weknora-worker.js';
import { WeKnoraCitationResolver } from './core/weknora-citations.js';
import { LlmWorker } from './core/llm-worker.js';
import { registerRoutes } from './http/routes.js';
import { registerUi } from './http/ui.js';
import type { Actor } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

export interface AppBundle {
  app: FastifyInstance;
  service: OrbitService;
  engine: AutomationEngine;
  scheduler: CronScheduler;
  worker: WeKnoraWorker | LlmWorker | null;
}

export interface BuildAppOptions {
  db: Db;
  config: AppConfig;
  logger?: boolean;
  scheduler?: boolean;
}

export function buildApp(options: BuildAppOptions): AppBundle {
  const { db, config } = options;
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    bodyLimit: 1_000_000,
  });

  const files = new FileStore(config.filesDir);
  const service = new OrbitService(db, files, {
    maxUploadBytes: config.maxUploadBytes,
    taskFileLimit: config.taskFileLimit,
    projectQuotaBytes: config.projectStorageQuotaBytes,
  });
  const engine = new AutomationEngine(service);
  service.attachEngine(engine);
  const scheduler = new CronScheduler(service, engine);
  const worker = config.llm
    ? new LlmWorker(service, config.llm, 5_000, console, undefined, config.weknora)
    : config.weknora
      ? new WeKnoraWorker(service, config.weknora)
      : null;
  const citationResolver = config.weknora
    ? new WeKnoraCitationResolver(new WeKnoraClient(config.weknora))
    : null;

  app.decorateRequest('actor', undefined);

  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/api/v1')) return;
    request.actor = authenticate(db, request.headers.authorization);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: error.issues,
        },
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      return reply.code(409).send({
        error: { code: 'conflict', message: 'A unique field is already in use' },
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.code(statusCode).send({
        error: {
          code: 'bad_request',
          message: error instanceof Error ? error.message : 'Bad request',
        },
      });
    }
    request.log.error(error);
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found` },
    });
  });

  app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 4,
      parts: 6,
    },
  });
  app.register(registerRoutes, {
    service,
    weknoraUiUrl: config.weknoraUiUrl,
    citationResolver,
    maxUploadBytes: config.maxUploadBytes,
  });
  app.register(registerUi);

  if (options.scheduler ?? config.schedulerEnabled) {
    app.addHook('onReady', async () => {
      scheduler.start();
      worker?.start();
    });
    app.addHook('onClose', async () => {
      scheduler.stop();
      worker?.stop();
    });
  }

  return { app, service, engine, scheduler, worker };
}
