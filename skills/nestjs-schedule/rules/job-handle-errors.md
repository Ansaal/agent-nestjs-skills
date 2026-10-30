---
title: Catch and Log Failures Inside the Job
impact: CRITICAL
impactDescription: The scheduler's own catch logs a bare error with no job name or ids, and one bad item aborts the rest of the run
tags: schedule, errors, logging, retries, interval, cron
---

## Catch and Log Failures Inside the Job

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
