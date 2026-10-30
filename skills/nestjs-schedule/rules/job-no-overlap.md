---
title: Prevent Overlapping Runs of a Slow Job
impact: CRITICAL
impactDescription: A run that outlasts its interval starts again while still running, and every instance runs every job
tags: schedule, interval, cron, overlap, waitForCompletion, concurrency
---

## Prevent Overlapping Runs of a Slow Job

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
