---
title: Start Runtime Jobs Yourself and Handle Their Errors
impact: HIGH
impactDescription: A registered job that was never started does nothing; a failing dynamic interval crashes the process; dynamic cron errors bypass the Nest logger
tags: schedule, SchedulerRegistry, CronJob, dynamic, cron, interval, errors
---

## Start Runtime Jobs Yourself and Handle Their Errors

Use `SchedulerRegistry` when the schedule is only known at runtime (per tenant, from `ConfigService` or the database). Jobs added there skip everything `ScheduleModule` does for decorated methods:

- `addCronJob(name, job)` only stores the job. A `new CronJob(expression, fn)` (`start` defaults to `false`) registered that way ran 0 times in 1.1 s on an every-second expression. Call `job.start()`.
- Names are unique per kind: a second `addCronJob('x', …)` throws `Cron Job with the given name (x) already exists. Ignored.` despite the wording. To replace a job, build the new one first, then `deleteCronJob(name)` (it stops the old one) and add the new one.
- Errors are not caught by the Nest logger. A dynamic cron whose async `onTick` throws is reported by cron itself as plain text on stderr, past `ConsoleLogger({ json: true })`: `[Cron] error in callback Error: raw boom`. Pass `errorHandler`.
- A dynamic `setInterval()` gets no wrapper at all. An async callback that rejects is an unhandled rejection, and Node 24 ends the process with exit code 1 on the first failure. Catch inside the callback.

`CronJob.from()` validates eagerly: `cronTime: '61 * * * * *'` throws `CronError: Field value (61) is out of range`, and `timeZone: 'Europe/Berlinn'` throws `CronError: Invalid timezone.`. Build the replacement before touching the live job: deleting first and then building left `doesExist('cron', 'reports:t-1')` `false` after a bad update, so the tenant's reports silently stopped. `app.close()` stops dynamic jobs along with the decorated ones (4 registered cron jobs before close, 0 after).

Import `CronJob` from `cron`, installed as a direct dependency at exactly the version `@nestjs/schedule` pins (`npm view @nestjs/schedule@12.0.2 dependencies.cron` → `4.4.0`; `pnpm add -E cron@4.4.0`). Without it pnpm's strict `node_modules` gives `TS2307: Cannot find module 'cron'`; with cron 4.3.5, `addCronJob()` rejects the job: `TS2345: Argument of type '…cron@4.3.5…CronJob<null, null>' is not assignable to parameter of type '…cron@4.4.0…CronJob<null, null>'. … Types have separate declarations of a private property 'second'.` Locks for dynamic jobs on several instances: `nestjs-locks`.

**Incorrect (never started, duplicate name throws, errors bypass the logger, a rejection kills the process):**

```typescript
schedule(tenantId: string, cronTime: string): void {
  this.registry.addCronJob(`reports:${tenantId}`, new CronJob(cronTime, () => this.reports.sendFor(tenantId)));
}

onApplicationBootstrap(): void {
  this.registry.addInterval('inventory:sync', setInterval(() => this.inventory.sync(), this.settings.pollMs));
}
```

**Correct (dynamic cron: validated before replacing by name, pinned zone, logged errors, started):**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ReportsService } from './reports.service.js';

@Injectable()
export class ReportSchedules {
  private readonly logger = new Logger(ReportSchedules.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly reports: ReportsService,
  ) {}

  /** Creates or replaces the tenant's report job. A bad expression or zone throws and leaves the current job running. */
  schedule(tenantId: string, cronTime: string, timeZone: string): void {
    const name = `reports:${tenantId}`;
    // Built first: CronError on an invalid expression or time zone, before the live job is touched.
    const job = CronJob.from({
      name,
      cronTime,
      timeZone,
      waitForCompletion: true,
      onTick: () => this.reports.sendFor(tenantId),
      // Without it, cron reports a failed run with console.error, past the Nest logger.
      errorHandler: (error) =>
        this.logger.error('Report run failed', { tenantId }, error instanceof Error ? error : new Error(String(error))),
    });
    if (this.registry.doesExist('cron', name)) this.registry.deleteCronJob(name); // stops the old job
    this.registry.addCronJob(name, job);
    job.start(); // addCronJob only registers; the job does not run until started
  }

  unschedule(tenantId: string): void {
    const name = `reports:${tenantId}`;
    if (this.registry.doesExist('cron', name)) this.registry.deleteCronJob(name);
  }
}
```

Observed: scheduling `t-1` twice sent its report once per tick; after `schedule('t-1', '61 * * * * *', …)` and `schedule('t-1', '* * * * * *', 'Europe/Berlinn')` both threw, `getCronJob('reports:t-1').isActive` was still `true` and the job sent 2 reports in the next 2.1 s; the failing tenant logged `Report run failed` at error with `{ tenantId: 't-1' }` and the `Error` as the third argument. A failed run is not retried before its next fire time, hence `error`.

**Correct (dynamic interval: the callback catches its own rejection):**

```typescript
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InventoryClient } from './inventory.client.js';
import { InventorySettings } from './inventory.settings.js';

@Injectable()
export class InventoryPoller implements OnApplicationBootstrap {
  private readonly logger = new Logger(InventoryPoller.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly settings: InventorySettings,
    private readonly inventory: InventoryClient,
  ) {}

  onApplicationBootstrap(): void {
    const timer = setInterval(() => {
      // No scheduler wrapper here: an uncaught rejection would end the process.
      this.inventory.sync().catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn('Inventory sync failed, retrying on the next tick', { job: 'inventory:sync' }, err);
      });
    }, this.settings.pollMs);
    this.registry.addInterval('inventory:sync', timer); // app.close() clears it
  }
}
```

With an `InventoryClient` whose `sync()` always rejected, the poller logged `{"level":"warn",...,"message":"Inventory sync failed, retrying on the next tick","context":"InventoryPoller","error":{...},"params":{"job":"inventory:sync"}}` every 100 ms and kept running until `SIGTERM`; without the `.catch()` the process exited with code 1 at the first tick. A failed tick is retried by the next one, hence `warn`. Make the callback single-flight if a run can outlast the delay (`job-no-overlap`).

Reference: [NestJS – Task scheduling: Dynamic schedule module API](https://docs.nestjs.com/techniques/task-scheduling#dynamic-schedule-module-api), [cron – CronJob](https://github.com/kelektiv/node-cron#cronjob)
