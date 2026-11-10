import { Cron } from 'croner';
import { badRequest } from './errors.js';

export function nextCronRun(expression: string, timezone: string, from = new Date()): string {
  let job: Cron | undefined;
  try {
    job = new Cron(expression, { timezone, paused: true });
    const next = job.nextRun(from);
    if (!next) {
      throw new Error('Cron expression has no future occurrence');
    }
    return next.toISOString();
  } catch (error) {
    throw badRequest(
      `Invalid cron trigger: ${error instanceof Error ? error.message : String(error)}`,
      { expression, timezone },
    );
  } finally {
    job?.stop();
  }
}

export function assertCron(expression: string, timezone: string): void {
  nextCronRun(expression, timezone);
}
