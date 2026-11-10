import type { OrbitService } from './service.js';
import type { AutomationEngine } from './automation-engine.js';
import { nowIso } from '../lib/util.js';

export class CronScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly service: OrbitService,
    private readonly engine: AutomationEngine,
    private readonly intervalMs = 15_000,
    private readonly logger: Pick<Console, 'error' | 'info'> = console,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick(now = nowIso()): number {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = this.service.listDueCronAutomations(now);
      for (const automation of due) {
        const run = this.engine.runOnce(
          automation,
          'cron',
          { payload: { scheduledAt: automation.nextRunAt } },
          [],
        );
        if (run.status === 'failed') {
          this.logger.error(`[scheduler] automation ${automation.id} failed: ${run.error}`);
        }
      }
      return due.length;
    } finally {
      this.running = false;
    }
  }
}
