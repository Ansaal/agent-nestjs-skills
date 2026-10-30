---
title: Await the Running Job Before the App Closes
impact: HIGH
impactDescription: app.close() returns while a run is mid-flight; its next query hits a closed database and the work is lost
tags: schedule, shutdown, lifecycle, beforeApplicationShutdown, typeorm
---

## Await the Running Job Before the App Closes

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
