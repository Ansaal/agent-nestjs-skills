---
title: Keep the Scheduled Method a One-Line Entry Point
impact: CRITICAL
impactDescription: Work inside the decorated method only runs when the timer fires, so tests wait on real time; a log line per tick floods the log
tags: schedule, interval, cron, testing, logging
---

## Keep the Scheduled Method a One-Line Entry Point

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
