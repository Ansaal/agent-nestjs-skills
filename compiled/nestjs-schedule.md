# NestJS Schedule

**Version 2.0.0-ansaal**
Ansaal/agent-nestjs-skills
October 2026

> **Note:**
> This document is mainly for agents and LLMs to follow when maintaining,
> generating, or refactoring NestJS codebases. Humans may also find it
> useful, but guidance here is optimized for automation and consistency
> by AI-assisted workflows.

---

## Abstract

Scheduled jobs in NestJS with `@nestjs/schedule`. Use when adding `@Cron()`, `@Interval()` or `@Timeout()` jobs, registering jobs at runtime through `SchedulerRegistry`, reading a job's delay from the environment, handling failures or slow runs in a job, shutting down while a job runs, or testing scheduled jobs.

---

## Table of Contents

1. [Job Design](#1-job-design) — **CRITICAL**
   - 1.1 [Give Every Wall-Clock Cron a timeZone](#11-give-every-wall-clock-cron-a-timezone)
   - 1.2 [Validate Interval Delays Read From the Environment](#12-validate-interval-delays-read-from-the-environment)
   - 1.3 [Start Runtime Jobs Yourself and Handle Their Errors](#13-start-runtime-jobs-yourself-and-handle-their-errors)
   - 1.4 [Catch and Log Failures Inside the Job](#14-catch-and-log-failures-inside-the-job)
   - 1.5 [Prevent Overlapping Runs of a Slow Job](#15-prevent-overlapping-runs-of-a-slow-job)
   - 1.6 [Keep the Scheduled Method a One-Line Entry Point](#16-keep-the-scheduled-method-a-one-line-entry-point)
2. [Lifecycle](#2-lifecycle) — **HIGH**
   - 2.1 [Await the Running Job Before the App Closes](#21-await-the-running-job-before-the-app-closes)
   - 2.2 [Import ScheduleModule.forRoot() Once and Keep Jobs on Singleton Providers](#22-import-schedulemodule-forroot-once-and-keep-jobs-on-singleton-providers)
3. [Testing Jobs](#3-testing-jobs) — **HIGH**
   - 3.1 [Park Timers in Tests and Call the Job's Work Method](#31-park-timers-in-tests-and-call-the-job-s-work-method)
   - 3.2 [Test the Schedule With nextDates() and the Wiring With Fake Timers](#32-test-the-schedule-with-nextdates-and-the-wiring-with-fake-timers)

---

## 1. Job Design

**Section Impact: CRITICAL**

### 1.1 Give Every Wall-Clock Cron a timeZone

**Impact: HIGH** — Without it a nightly job fires at a different hour on every host whose TZ differs, and silently moves when the container image changes

`@Cron()` without `timeZone` reads the expression in the process's time zone. In the probe, `@Cron('0 0 2 * * *')` next fired at `02:00:00Z` under `TZ=UTC` and at `06:00:00Z` under `TZ=America/New_York`; the same expression with `timeZone: 'Europe/Berlin'` fired at `01:00:00Z` on both hosts. Containers usually run in UTC, laptops do not, so a job meant for "2 a.m. local" runs at a different hour in development and production. Set `timeZone` (an IANA name) on every cron that names a time of day; `CronExpression.EVERY_*` intervals don't need one.

Daylight-saving switches are handled by cron 4.4.0, the version `@nestjs/schedule` 12.0.2 pins: `nextDates()` in Europe/Berlin showed `02:00` and `02:30` on 2027-03-28 (the hour that does not exist) both firing at 03:00 CEST (`01:00:00Z`), and `02:30` on 2027-10-31 (the hour that occurs twice) listed once, at the first occurrence (`00:30:00Z`). If a job must run exactly every 24 h, use `utcOffset` or a UTC hour instead. A misspelt zone fails `app.init()` with `CronError: Invalid timezone.`, so the typo cannot ship unnoticed if the app is booted once in CI.

Six-field expressions start with seconds (`'0 0 2 * * *'` is 02:00:00); five-field ones start with minutes. Give each cron a `name` so tests and code can reach it through `SchedulerRegistry.getCronJob(name)`.

**Incorrect (runs at 02:00 in whatever zone the host is in):**

```typescript
@Cron('0 0 2 * * *')
async sendNightlyReports(): Promise<void> {
  await this.reports.sendAll();
}
```

**Correct (named, pinned to a zone, no overlapping runs, one tenant's failure does not stop the others):**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReportsService } from './reports.service.js';

export const NIGHTLY_REPORT = 'reports:nightly';

@Injectable()
export class NightlyReportJob {
  private readonly logger = new Logger(NightlyReportJob.name);

  constructor(private readonly reports: ReportsService) {}

  // 02:00 in Berlin on every host, whatever TZ the container runs in; a run still going at the next fire time is not doubled.
  @Cron('0 0 2 * * *', { name: NIGHTLY_REPORT, timeZone: 'Europe/Berlin', waitForCompletion: true })
  async tick(): Promise<void> {
    await this.sendAll();
  }

  /** Sends every tenant's report; a tenant that fails is logged and the rest still get theirs. */
  async sendAll(): Promise<{ sent: number; failed: number }> {
    const tenants = await this.reports.tenants();
    let sent = 0;
    for (const tenantId of tenants) {
      try {
        await this.reports.sendFor(tenantId);
        sent++;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error('Nightly report failed', { tenantId }, err); // not retried before the next night: failed for good
      }
    }
    this.logger.log('Nightly reports sent', { sent, failed: tenants.length - sent });
    return { sent, failed: tenants.length - sent };
  }
}
```

The per-tenant catch follows `job-handle-errors`: with tenants `t-1`, `t-bad`, `t-2` and `t-bad` refused, `sendAll()` resolved `{ sent: 2, failed: 1 }`, `t-1` and `t-2` got their reports, and the error line carried `{ tenantId: 't-bad' }` with the `Error`. Without the catch, the first refusal ends the run and the scheduler logs it without the tenant. Retrying a refused send within the run is `nestjs-resilience`. The test that pins these fire times with `nextDates()` is in `test-schedule-and-wiring`.

Reference: [NestJS – Task scheduling: Declarative cron jobs](https://docs.nestjs.com/techniques/task-scheduling#declarative-cron-jobs), [cron – timeZone](https://github.com/kelektiv/node-cron#cronjob)

---

### 1.2 Validate Interval Delays Read From the Environment

**Impact: HIGH** — A malformed or too-large delay makes the job run every millisecond; a value set after import is ignored

`@Interval(name, ms)` and `@Timeout(name, ms)` store `ms` when the class is decorated, which is when its file is imported; `ScheduleModule` passes it to `setInterval()` at bootstrap. An env-driven delay is therefore read once, at import, before any provider exists, so `ConfigService` cannot supply it and a test that sets `process.env` in `beforeAll` is too late (the probe's 50 ms default still ticked 5 times in 300 ms after `beforeAll` set 3 600 000). Set test values in Vitest's `test.env` (`test-call-the-work`).

Node does not reject a bad delay; it replaces it with 1 ms and prints a warning:

```
(node:90878) TimeoutOverflowWarning: 99999999999 does not fit into a 32-bit signed integer.
Timeout duration was set to 1.
(node:90878) TimeoutNaNWarning: NaN is not a number.
Timeout duration was set to 1.
```

`Number('5s')` is `NaN`, and anything above 2 147 483 647 ms (24.8 days) overflows: both jobs ran 175 times in 200 ms. Validate the value where it is read so a bad setting stops the app at startup. When the delay must come from `ConfigService` or the database, register the timer at runtime instead (`job-dynamic-registry`).

**Incorrect (unvalidated: `BATCH_POLL_MS=5s` polls the database every millisecond):**

```typescript
const POLL_MS = Number(process.env.BATCH_POLL_MS ?? 5_000);

@Interval('batches:process', POLL_MS)
async tick(): Promise<void> {
  await this.processPending();
}
```

**Correct (`src/common/env-ms.ts`, used at the top of the job's file):**

```typescript
/** Largest delay setInterval/setTimeout accept; above it, and for NaN, Node fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** Reads a timer delay from the environment and fails at startup instead of polling every millisecond. */
export function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new Error(`${name} must be a whole number of milliseconds between 1 and ${MAX_TIMER_MS}, got "${raw}"`);
  }
  return value;
}
```

```typescript
import { envMs } from '../common/env-ms.js';

// Read when this file is imported, before any test hook runs: set it in vitest.config.ts `test.env`.
const POLL_MS = envMs('BATCH_POLL_MS', 5_000);
```

With `BATCH_POLL_MS=5s`, `node dist/main.js` stops before Nest starts: `Error: BATCH_POLL_MS must be a whole number of milliseconds between 1 and 2147483647, got "5s"`.

Reference: [Node.js – setInterval](https://nodejs.org/api/timers.html#setintervalcallback-delay-args), [NestJS – Task scheduling: Declarative intervals](https://docs.nestjs.com/techniques/task-scheduling#declarative-intervals)

---

### 1.3 Start Runtime Jobs Yourself and Handle Their Errors

**Impact: HIGH** — A registered job that was never started does nothing; a failing dynamic interval crashes the process; dynamic cron errors bypass the Nest logger

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

---

### 1.4 Catch and Log Failures Inside the Job

**Impact: CRITICAL** — The scheduler's own catch logs a bare error with no job name or ids, and one bad item aborts the rest of the run

`@nestjs/schedule` 12.0.2 wraps every decorated `@Cron()`, `@Interval()` and `@Timeout()` method in `try { await method() } catch (error) { logger.error(error) }` with the context `Scheduler`. A throwing job therefore neither crashes the process nor stops its schedule: in the probe an `@Interval` that threw on every run kept firing (67 runs in 2.1 s at 30 ms, sync and async alike). But the only trace is the error itself:

```
{"level":"error",...,"message":"downstream unavailable (run 36)","context":"Scheduler","error":{"name":"Error","message":"downstream unavailable (run 36)","stack":"Error: downstream unavailable (run 36)\n    at Failing.tick (...)\n    at Timeout._onTimeout (.../@nestjs/schedule/dist/schedule.explorer.js:121:33)..."}}
```

No job name, no batch id, no attempt count, and the run stopped at the first failing item, so the batches after it waited for the next tick. Catch inside the job, per unit of work, and log by the level policy (`nestjs-logging`): `warn` when the item will be retried on a later run, `error` once it has failed for good, with the ids as fields and the caught error, normalised to an `Error`, as the third argument. Record the outcome so the next run neither retries forever nor forgets the item.

Record it through the app-wide `TransactionRunner` (`nestjs-typeorm`, `orm-atomic-writes`), single statements included. On better-sqlite3, a direct `repository.update()` sent while a request's transaction is open runs inside that transaction and is rolled back with it, and the already-handled batch becomes eligible again. A crash between `handle()` and the recorded outcome also hands the batch to the next run, so `handle()` must be idempotent (`nestjs-resilience`, `idempotency-processed-events`).

Retrying a downstream call within the run (backoff, circuit breaker) and dead-letter records are `nestjs-resilience`; this rule covers what the job does with the failure that remains. Jobs registered at runtime through `SchedulerRegistry` do not get the scheduler's catch: see `job-dynamic-registry`.

**Incorrect (one failure ends the run; the log line says nothing about which job or batch; writes bypass the `TransactionRunner`):**

```typescript
@Interval('batches:process', POLL_MS)
async tick(): Promise<void> {
  const pending = await this.batches.findBy({ status: 'RECEIVED' });
  for (const batch of pending) {
    await this.handler.handle(batch); // throws for one batch: the rest wait for the next tick
    await this.batches.update({ id: batch.id }, { status: 'PROCESSED' });
  }
}
```

**Correct (catch per batch, warn while it will be retried, error when it is given up, every write through the runner):**

```typescript
const MAX_ATTEMPTS = 3;

/** Catches per batch: one bad batch neither stops the run nor reaches the scheduler's generic log line. */
private async processOne(batch: Batch): Promise<boolean> {
  const attempts = batch.attempts + 1;
  try {
    await this.handler.handle(batch);
    await this.record(batch.id, { status: 'PROCESSED', attempts });
    return true;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (attempts < MAX_ATTEMPTS) {
      this.logger.warn('Batch failed, retrying on the next run', { batchId: batch.id, attempts }, err);
      await this.record(batch.id, { attempts });
    } else {
      this.logger.error('Batch failed for good', { batchId: batch.id, attempts }, err);
      await this.record(batch.id, { status: 'FAILED', attempts });
    }
    return false;
  }
}

/** Every write goes through the app-wide TransactionRunner (nestjs-typeorm), single statements included. */
private record(id: string, changes: Pick<Batch, 'attempts'> & Partial<Pick<Batch, 'status'>>): Promise<unknown> {
  return this.transactions.run((manager) => manager.update(Batch, { id }, changes));
}
```

`processAll()` (`job-no-overlap`) calls it for every pending batch and logs one summary line. Proven: with one failing batch, three `processPending()` calls left it `{ status: 'FAILED', attempts: 3 }` while the other batch was `PROCESSED` after the first run; the first `warn` carried `{ batchId: 'b-bad', attempts: 1 }` and the `Error` `downstream rejected b-bad`. A request transaction that rolled back while the run was queued left the job's `PROCESSED` write in place. What still escapes (the pending-batch read itself failing) reaches the scheduler's catch above, and the next tick tries again.

Reference: [NestJS – Task scheduling](https://docs.nestjs.com/techniques/task-scheduling)

---

### 1.5 Prevent Overlapping Runs of a Slow Job

**Impact: CRITICAL** — A run that outlasts its interval starts again while still running, and every instance runs every job

`@Interval()` is a plain `setInterval()`: the next tick fires on time whether or not the previous run's promise has settled. `@Cron()` does the same unless `waitForCompletion: true`. In the probe (`@nestjs/schedule` 12.0.2, cron 4.4.0), a 300 ms job on a 50 ms `@Interval` had up to 6 runs in progress at once; a 2.5 s job on an every-second `@Cron` had 3; the same cron with `waitForCompletion: true` had 1, and cron skipped the ticks that fired during the run. Overlapping runs read the same pending rows and process them twice.

- `@Cron()`: set `waitForCompletion: true`.
- `@Interval()` has no option: make the work method single-flight, so a tick during a run joins that run instead of starting a second one.

Both guards are per process. Two instances of the app run every job twice, and the guard does not see the other instance's run: `@WithoutOverlapping()` and `@OnOneInstance()` from `nestjs-locks` (`job-without-overlapping`) own exclusion across instances.

**Incorrect (each tick starts a new run while the last one is still going):**

```typescript
@Interval('batches:process', 5_000)
async tick(): Promise<void> {
  await this.processAll(); // takes 20 s on a backlog: four runs process the same batches
}

@Cron('0 */5 * * * *', { name: 'reports:refresh' })
async refresh(): Promise<void> {
  await this.reports.rebuildAll();
}
```

**Correct (`@Interval`: single-flight work method):**

```typescript
@Injectable()
export class BatchProcessor {
  private readonly logger = new Logger(BatchProcessor.name);
  private running: Promise<number> | undefined;

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly handler: BatchHandler,
  ) {}

  @Interval('batches:process', POLL_MS)
  async tick(): Promise<void> {
    await this.processPending();
  }

  /** One run per instance: a tick that fires during a run joins it instead of starting a second one. */
  processPending(): Promise<number> {
    this.running ??= this.processAll().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async processAll(): Promise<number> {
    // Read through the runner too: the result decides writes, so it must not see another request's uncommitted rows.
    const pending = await this.transactions.run((manager) =>
      manager.find(Batch, { where: { status: 'RECEIVED' }, order: { receivedAt: 'ASC' } }),
    );
    if (pending.length === 0) {
      this.logger.debug('No pending batches');
      return 0;
    }
    let processed = 0;
    for (const batch of pending) {
      if (await this.processOne(batch)) processed++; // job-handle-errors
    }
    this.logger.log('Processed pending batches', { processed, failed: pending.length - processed });
    return processed;
  }
}
```

Proven: two concurrent `processPending()` calls both resolved `1` and the batch handler ran once. Callers outside the schedule (tests, an admin endpoint) get the same guarantee.

**Correct (`@Cron`: skip ticks while a run is in progress):**

```typescript
@Cron('0 0 2 * * *', { name: NIGHTLY_REPORT, timeZone: 'Europe/Berlin', waitForCompletion: true })
async tick(): Promise<void> {
  await this.sendAll();
}
```

`waitForCompletion` guards only the scheduled tick; a direct `sendAll()` call is not guarded. If the app runs on more than one instance, use `nestjs-locks` instead of these per-process guards.

Reference: [NestJS – Task scheduling](https://docs.nestjs.com/techniques/task-scheduling), [cron – CronJob options](https://github.com/kelektiv/node-cron#cronjob)

---

### 1.6 Keep the Scheduled Method a One-Line Entry Point

**Impact: CRITICAL** — Work inside the decorated method only runs when the timer fires, so tests wait on real time; a log line per tick floods the log

`@nestjs/schedule` calls the decorated method with no arguments, wraps it in its own `try/catch`, and ignores what it returns. Put nothing in it but `await this.processPending()`, and put the work in a plain public method that returns a result. Tests, an admin endpoint or a CLI command can then call and await the work directly (`test-call-the-work`), and the schedule stays a one-line concern that `nestjs-locks` decorators can wrap.

Log per the level policy (`nestjs-logging`): one `log` line per run that did work, with counts as fields; `debug` for an empty tick. A 5 s poll that logs every tick at `log` writes 17 280 lines a day that say nothing. Observed with `ConsoleLogger({ json: true })`:

```
{"level":"log",...,"message":"Processed pending batches","context":"BatchProcessor","params":{"processed":2,"failed":0}}
{"level":"debug",...,"message":"No pending batches","context":"BatchProcessor"}
```

**Incorrect (work only reachable through the timer, a `log` line per tick, fields concatenated into the message):**

```typescript
@Interval('batches:process', 5_000)
async tick(): Promise<void> {
  this.logger.log('Batch tick started');
  const pending = await this.batches.findBy({ status: 'RECEIVED' });
  for (const batch of pending) {
    await this.handler.handle(batch);
    await this.batches.update({ id: batch.id }, { status: 'PROCESSED' });
  }
  this.logger.log(`Processed ${pending.length} batches`);
}
```

**Correct (`tick()` delegates; the work returns what it did and logs once):**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { envMs } from '../common/env-ms.js';
import { TransactionRunner } from '../database/transaction-runner.js';
import { BatchHandler } from './batch-handler.js';
import { Batch } from './batch.entity.js';

const POLL_MS = envMs('BATCH_POLL_MS', 5_000);

@Injectable()
export class BatchProcessor {
  private readonly logger = new Logger(BatchProcessor.name);

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly handler: BatchHandler,
  ) {}

  /** Scheduled entry point, nothing else: tests call processPending(). */
  @Interval('batches:process', POLL_MS)
  async tick(): Promise<void> {
    await this.processPending();
  }

  async processPending(): Promise<number> {
    const pending = await this.transactions.run((manager) =>
      manager.find(Batch, { where: { status: 'RECEIVED' }, order: { receivedAt: 'ASC' } }),
    );
    if (pending.length === 0) {
      this.logger.debug('No pending batches');
      return 0;
    }
    let processed = 0;
    for (const batch of pending) {
      if (await this.processOne(batch)) processed++;
    }
    this.logger.log('Processed pending batches', { processed, failed: pending.length - processed });
    return processed;
  }
}
```

`processOne()` catches per batch and records each outcome through the `TransactionRunner` (`job-handle-errors`); `envMs()` validates the delay (`job-delay-from-env`). The full class, with the single-flight guard and the shutdown drain, is in `job-no-overlap` and `lifecycle-drain-on-shutdown`.

Reference: [NestJS – Task scheduling](https://docs.nestjs.com/techniques/task-scheduling)

---

## 2. Lifecycle

**Section Impact: HIGH**

### 2.1 Await the Running Job Before the App Closes

**Impact: HIGH** — app.close() returns while a run is mid-flight; its next query hits a closed database and the work is lost

`app.close()` (and `SIGTERM` with `enableShutdownHooks()`) runs `onModuleDestroy` → `beforeApplicationShutdown` → closes the HTTP server → `onApplicationShutdown`. `@nestjs/schedule` 12.0.2 clears its timers in `beforeApplicationShutdown` but does not wait for a run in progress: `clearInterval()` cannot, and cron's `stop()` is not awaited even with `waitForCompletion`. `@nestjs/typeorm` destroys the `DataSource` in `onApplicationShutdown`. In the probe, a job inside 300 ms of work when `close()` was called carried on after `close()` returned, and its next write failed, logged by the scheduler after the app was gone:

```
{"level":"error",...,"message":"TypeError: The database connection is not open","context":"Scheduler","error":{"name":"QueryFailedError",...}}
```

The batch stayed `RECEIVED`. In production that is a run cut off at every deploy; in tests it is an error logged after `afterEach(() => app.close())`, once the test that started the run has already passed.

Keep the in-flight run as a promise (the single-flight guard from `job-no-overlap` already does) and await it in `beforeApplicationShutdown()`. That hook runs after `onModuleDestroy` and before `onApplicationShutdown`, so the database is still open. A run that failed was already logged by its caller; swallow it here so shutdown completes.

**Incorrect (nothing tracks the run; close() returns mid-run):**

```typescript
@Interval('batches:process', POLL_MS)
async tick(): Promise<void> {
  const pending = await this.batches.findBy({ status: 'RECEIVED' });
  for (const batch of pending) {
    await this.handler.handle(batch);
    await this.batches.update({ id: batch.id }, { status: 'PROCESSED' }); // DataSource already destroyed
  }
}
```

**Correct (the single-flight promise is awaited before the database closes):**

```typescript
@Injectable()
export class BatchProcessor implements BeforeApplicationShutdown {
  private running: Promise<number> | undefined;

  @Interval('batches:process', POLL_MS)
  async tick(): Promise<void> {
    await this.processPending();
  }

  /** One run per instance: a tick that fires during a run joins it instead of starting a second one. */
  processPending(): Promise<number> {
    this.running ??= this.processAll().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** app.close() clears the timer but does not wait for a run in progress. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.running?.catch(() => undefined); // a failed run was already logged by its caller
  }
}
```

Proven with the full class (constructor, `processAll()` and `processOne()` from `job-no-overlap` and `job-handle-errors`):

```typescript
it('lets the run finish before the database closes', async () => {
  const app = await createTestApp(); // nestjs-testing
  await app.get(TransactionRunner).run((manager) => manager.insert(Batch, { id: 'b-1' }));
  app.get(BatchHandler).delayMs = 300;

  const run = app.get(BatchProcessor).processPending();
  await app.close();

  await expect(run).resolves.toBe(1);
});
```

Without the `beforeApplicationShutdown()` body the same test fails: `AssertionError: promise rejected "QueryFailedError: TypeError: The database… { …(3) }" instead of resolving` (re-run with the batch writes going through the `TransactionRunner`).

Bound the wait by your platform's grace period (Kubernetes sends `SIGKILL` 30 s after `SIGTERM` by default): a run that may take longer should process in small units and stop between them, so the next instance picks up the rest.

Reference: [NestJS – Lifecycle events: Application shutdown](https://docs.nestjs.com/fundamentals/lifecycle-events#application-shutdown)

---

### 2.2 Import ScheduleModule.forRoot() Once and Keep Jobs on Singleton Providers

**Impact: HIGH** — Without forRoot() no job ever fires; jobs on request-scoped providers are skipped with only a warning

Install with `pnpm add @nestjs/schedule` (12.0.2 depends on `cron` 4.4.0 and accepts `@nestjs/common`/`@nestjs/core` `^11.0.0 || ^12.0.0`). `ScheduleModule.forRoot()` returns a global module: import it once, in `AppModule`, and every `@Cron()`, `@Interval()` and `@Timeout()` method on any controller or provider in the app is found. Feature modules import nothing; `SchedulerRegistry` is injectable everywhere.

When things happen, from the 12.0.2 source and the probe:

- `onModuleInit`: the explorer collects the decorated methods. Duplicate names fail here: `app.init()` rejects with `Interval with the given name (sync) already exists. Ignored.` (the job is not ignored; the app does not start).
- `onApplicationBootstrap`: the timers are armed. After `compile()` alone nothing ran and `getIntervals()` was `[]`; after `app.init()` it was `['ticker']` and a 20 ms interval ran 4 times in 100 ms. So every e2e test that calls `app.init()` runs the jobs (`test-call-the-work`).
- `beforeApplicationShutdown`: every interval, timeout and cron job in the registry is cleared, decorated or dynamic; 0 further runs after `app.close()`. A run in progress is not awaited (`lifecycle-drain-on-shutdown`).

Without `forRoot()` the decorators are inert metadata: a 10 ms `@Interval` ran 0 times, and injecting `SchedulerRegistry` fails with `Nest could not find SchedulerRegistry element (this provider does not exist in the current context)`. Jobs only register on static (singleton) providers. A request-scoped provider, or a singleton that injects one, is skipped and the app starts anyway:

```
{"level":"warn",...,"message":"Cannot register cron job \"RequestScoped@tick\" because it is defined in a non static provider.","context":"Scheduler"}
{"level":"warn",...,"message":"Cannot register interval \"DependsOnRequestScoped@tick\" because it is defined in a non static provider.","context":"Scheduler"}
```

**Incorrect (no `forRoot()`; the job's provider depends on a request-scoped service):**

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([Batch])],
  providers: [RequestContext /* Scope.REQUEST */, BatchProcessor /* injects RequestContext */],
})
export class BatchesModule {}

@Module({ imports: [TypeOrmModule.forRoot(dataSourceOptions), BatchesModule] })
export class AppModule {}
```

**Correct (`forRoot()` once in the root module; jobs on default-scoped providers):**

```typescript
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BatchesModule } from './batches/batches.module.js';
import { dataSourceOptions } from './data-source.js';
import { DatabaseModule } from './database/database.module.js';
import { ReportsModule } from './reports/reports.module.js';

@Module({
  imports: [
    // Once, in the root module: it is global and starts every decorated job in the app.
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot(dataSourceOptions),
    DatabaseModule, // the global TransactionRunner every job writes through
    BatchesModule,
    ReportsModule,
  ],
})
export class AppModule {}
```

```typescript
@Module({ providers: [BatchHandler, BatchProcessor] })
export class BatchesModule {}
```

`dataSourceOptions`, `DatabaseModule` and its `TransactionRunner` are `nestjs-typeorm`; `BatchProcessor` reads and writes through the runner, so `BatchesModule` needs no `TypeOrmModule.forFeature()`. `main.ts` calls `app.enableShutdownHooks()` (`nestjs-setup`), so `SIGTERM` runs the shutdown hooks that stop the timers. Every instance of the app runs every job; exclusion across instances is `nestjs-locks`.

Reference: [NestJS – Task scheduling](https://docs.nestjs.com/techniques/task-scheduling), [NestJS – Lifecycle events](https://docs.nestjs.com/fundamentals/lifecycle-events)

---

## 3. Testing Jobs

**Section Impact: HIGH**

### 3.1 Park Timers in Tests and Call the Job's Work Method

**Impact: HIGH** — Jobs started by app.init() fire mid-test against the test's data; waiting for a tick makes tests slow and flaky

`app.init()` in an e2e test arms every job (`lifecycle-register-once`). A 5 s poll then fires inside a slow test and processes rows the test has not finished arranging, or races the test's own call. Sleeping until the timer fires is slower still and fails on a loaded CI machine.

Give each env-driven delay a `<JOB>_POLL_MS` test value in `test.env` that no test outlives (`3600000`, one hour; at most 2 147 483 647, see `job-delay-from-env`). `test.env` is applied before the test files import the app; `process.env` assignments in the test file or in `beforeAll` come too late, because the delay was read at import. Then call the job's work method directly and await what it returns (`job-thin-entrypoint`). A cron at a fixed hour such as 02:00 Berlin does not need parking; a seconds-level `CronExpression` does: read its expression from the environment the same way.

The one `vitest.config.ts`, with the keys other skills add, is `nestjs-setup`; booting `AppModule` through `createTestApp()` is `nestjs-testing`.

**Incorrect (waits for the real timer; races it if the poll is short):**

```typescript
it('processes received batches', async () => {
  await batches.save([{ id: 'b-1' }, { id: 'b-2' }]);
  await new Promise((resolve) => setTimeout(resolve, 6_000)); // one 5 s tick, hopefully
  expect(await batches.findBy({ status: 'PROCESSED' })).toHaveLength(2);
}, 10_000);
```

**Correct (the key this skill adds to `test.env` in `vitest.config.ts`, one per env-driven timer):**

```typescript
// The batch interval is armed by app.init() but never fires during a test.
BATCH_POLL_MS: '3600000',
```

**Correct (`test/batches.e2e-spec.ts`: the test runs the work itself):**

```typescript
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource, type Repository } from 'typeorm';
import { BatchHandler } from '../src/batches/batch-handler.js';
import { Batch } from '../src/batches/batch.entity.js';
import { BatchProcessor } from '../src/batches/batch.processor.js';
import { TransactionRunner } from '../src/database/transaction-runner.js';
import { createTestApp } from './support/test-app.js';

describe('Process pending batches', () => {
  let app: NestExpressApplication;
  let batches: Repository<Batch>;

  beforeEach(async () => {
    app = await createTestApp(); // arms 'batches:process' at BATCH_POLL_MS=3600000: it never fires here
    batches = app.get(DataSource).getRepository(Batch);
    return () => app.close(); // stops the interval
  });

  const arrange = (...ids: string[]) =>
    app.get(TransactionRunner).run((manager) => manager.insert(Batch, ids.map((id) => ({ id }))));
  // The test runs the work itself instead of waiting for the timer.
  const processPending = () => app.get(BatchProcessor).processPending();

  it('marks every received batch processed', async () => {
    await arrange('b-1', 'b-2');

    await expect(processPending()).resolves.toBe(2);

    expect(await batches.findBy({ status: 'PROCESSED' })).toHaveLength(2);
  });

  it('does nothing on an empty tick', async () => {
    await expect(processPending()).resolves.toBe(0);
  });

  it('retries a failed batch on the next run and gives up after the third attempt', async () => {
    await arrange('b-ok', 'b-bad');
    app.get(BatchHandler).failIds.add('b-bad');

    await expect(processPending()).resolves.toBe(1);
    await processPending();
    await processPending();

    expect(await batches.findOneByOrFail({ id: 'b-bad' })).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(await batches.findOneByOrFail({ id: 'b-ok' })).toMatchObject({ status: 'PROCESSED', attempts: 1 });
  });
});
```

`BatchHandler` here is the probe's stand-in with a `failIds` set; in a real suite, replace the outbound dependency with `overrideProvider()` as `nestjs-testing` describes. That the timer itself is wired to `processPending()` is checked once, with fake timers (`test-schedule-and-wiring`).

Reference: [Vitest – test.env](https://vitest.dev/config/#env), [NestJS – Testing](https://docs.nestjs.com/fundamentals/testing)

---

### 3.2 Test the Schedule With nextDates() and the Wiring With Fake Timers

**Impact: MEDIUM-HIGH** — Wrong cron expressions and time zones ship untested, or tests wait hours of real time to see a job fire

Three different things can be wrong, and each has its own cheap test:

1. **The work**: call the work method (`test-call-the-work`). Most tests are this.
2. **The schedule** (expression, `timeZone`, DST): ask cron. `SchedulerRegistry.getCronJob(name).nextDates(n)` returns the next `n` fire times as Luxon `DateTime`s, computed from `Date.now()`. Fake only `Date` and set the clock; no timer runs.
3. **The wiring** (the decorator calls the work method at that time): one test with fake timers. Install them before `app.init()`, because that is where `@nestjs/schedule` calls `setInterval()` and cron calls `setTimeout()`. With fake timers installed after `init()`, `advanceTimersByTimeAsync(3_600_000)` produced 0 calls: the real timer was already armed. Fake only what the job uses: `setInterval`/`clearInterval` for `@Interval`; `setTimeout`/`clearTimeout`/`Date` for `@Cron` (cron 4.4.0 computes the delay from the clock and arms a `setTimeout`).

Spy on the work method with a resolved value, so the wiring test does not also exercise the work. Fake timers for retry backoff are `nestjs-testing`.

**Incorrect (fake timers after init; asserting the hour by waiting):**

```typescript
it('fires the job', async () => {
  await app.init();
  vi.useFakeTimers(); // too late: the real interval is already armed
  const processPending = vi.spyOn(app.get(BatchProcessor), 'processPending');
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(processPending).toHaveBeenCalled(); // 0 calls
});
```

**Correct (`test/nightly-report.e2e-spec.ts`: schedule, work and wiring of a `@Cron`):**

```typescript
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { NIGHTLY_REPORT, NightlyReportJob } from '../src/reports/nightly-report.job.js';
import { ReportsService } from '../src/reports/reports.service.js';
import { createTestApp } from './support/test-app.js';

describe('Nightly report', () => {
  let app: NestExpressApplication;

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it('runs at 02:00 Berlin time, across the DST switch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-26T12:00:00Z'));
    app = await createTestApp();

    const next = app.get(SchedulerRegistry).getCronJob(NIGHTLY_REPORT).nextDates(3);

    expect(next.map((date) => date.toUTC().toISO())).toEqual([
      '2027-03-27T01:00:00.000Z', // 02:00 CET
      '2027-03-28T01:00:00.000Z', // 02:00 does not exist on the switch day: 03:00 CEST
      '2027-03-29T00:00:00.000Z', // 02:00 CEST
    ]);
  });

  it('sends a report for every tenant', async () => {
    app = await createTestApp();

    await expect(app.get(NightlyReportJob).sendAll()).resolves.toEqual({ sent: 2, failed: 0 });

    expect(app.get(ReportsService).sent).toEqual(['t-1', 't-2']);
  });

  it('fires the job at the scheduled time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); // before init(): cron arms its timer there
    vi.setSystemTime(new Date('2027-03-27T00:59:00Z'));
    app = await createTestApp();
    const sendAll = vi.spyOn(app.get(NightlyReportJob), 'sendAll').mockResolvedValue({ sent: 0, failed: 0 });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(sendAll).toHaveBeenCalledTimes(1);
  });
});
```

**Correct (`@Interval` wiring, with `BATCH_POLL_MS=3600000` from `test.env`):**

```typescript
describe('Interval wiring', () => {
  afterEach(() => vi.useRealTimers());

  it('calls processPending every BATCH_POLL_MS', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // before init(): the interval is created there
    const app = await createTestApp();
    const processPending = vi.spyOn(app.get(BatchProcessor), 'processPending').mockResolvedValue(0);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(processPending).toHaveBeenCalledTimes(1);

    await app.close();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(processPending).toHaveBeenCalledTimes(1);
  });
});
```

Exactly one call after one fake hour also proves `test.env` reached the decorator: with the 5 s default it would have been 720. Both suites ran with TypeORM on better-sqlite3 booting under the faked timers. `createTestApp()` is `nestjs-testing`'s helper; `tick()` calls `this.processPending()`, so a spy on the instance catches the scheduled call.

Reference: [Vitest – vi.useFakeTimers](https://vitest.dev/api/vi#vi-usefaketimers), [cron – CronJob.nextDates](https://github.com/kelektiv/node-cron#cronjob)

---

## References

- https://docs.nestjs.com
- https://github.com/nestjs/nest
- https://typeorm.io
- https://github.com/typestack/class-validator
- https://github.com/goldbergyoni/nodebestpractices

---

*Generated by build-agents.ts on 2026-10-30*
