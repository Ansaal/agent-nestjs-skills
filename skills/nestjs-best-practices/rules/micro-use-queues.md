---
title: Use Message Queues for Background Jobs
impact: MEDIUM-HIGH
impactDescription: Queues enable reliable background processing
tags: microservices, queues, bullmq, background-jobs
---

## Use Message Queues for Background Jobs

Move slow or failure-prone work (reports, mail, imports) out of the request into `@nestjs/bullmq`: the request enqueues and returns, a worker processes, and BullMQ re-runs failed attempts. This rule covers the BullMQ mechanics. What to retry, how often, and what happens to work that never succeeds is `nestjs-resilience`: queued work gets one retry layer (BullMQ's `attempts`/`backoff`, not a retrying policy inside `process()` as well), and the final failure becomes a durable dead letter (`dlq-record-final-failure`). BullMQ delivers at least once: a worker that dies mid-job leaves it stalled and another worker runs it again, so processors must be idempotent (`idempotency-processed-events`).

**Incorrect (work in the request; colon in a job id; final failure only logged; error text in fields; open board):**

```typescript
@Post()
async generate(@Body() dto: GenerateReportDto): Promise<Report> {
  return this.reports.build(dto); // minutes inside the request; the client times out
}

await this.queue.add('send', { userId }, { jobId: `welcome:${userId}` }); // rejects: "Custom Id cannot contain :"

@OnWorkerEvent('failed')
onFailed(job: Job, error: Error) {
  this.logger.warn('Job attempt failed', { jobId: job.id, error: error.message }); // message in fields, stack lost
  // after the last attempt nothing is kept but the failed job, and removeOnFail: 5000 deletes it eventually
}

BullBoardModule.forRoot({ route: '/admin/queues', adapter: ExpressAdapter }); // anyone can read payloads, retry and delete jobs
```

**Correct (`queues/queue.module.ts`):**

```typescript
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReportsProcessor, ReportsService, WelcomeMailProcessor, WelcomeMailService } from './queues.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('REDIS_URL') },
        defaultJobOptions: {
          // Attempts and backoff are the retry policy for queued work (nestjs-resilience); no second retry layer inside process()
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 1000,
          removeOnFail: false, // a failed job is removed only once its dead letter is stored (ReportsProcessor.onFailed)
        },
      }),
    }),
    BullModule.registerQueue({ name: 'reports' }, { name: 'welcome-mail' }),
  ],
  providers: [ReportsService, ReportsProcessor, WelcomeMailService, WelcomeMailProcessor],
})
export class QueueModule {}
```

**Correct (`queues/queues.ts`):**

```typescript
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { DeadLetterStore } from '../dead-letter/dead-letter.store.js';
import { ReportBuilder } from './report-builder.js';
import { WelcomeMailer } from './welcome-mailer.js';

export interface GenerateReport {
  reportId: string;
  ownerId: string;
  urgent: boolean;
}

export interface ReportStatus {
  state: string;
  progress: Job['progress'];
}

const toError = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));

@Injectable()
export class ReportsService {
  constructor(@InjectQueue('reports') private readonly reports: Queue<GenerateReport>) {}

  /** The report row exists already; its id is the job id, so a repeated request adds no second job. */
  async requestReport(request: GenerateReport): Promise<{ jobId: string }> {
    await this.reports.add('generate', request, { jobId: request.reportId, priority: request.urgent ? 1 : 10 });
    return { jobId: request.reportId };
  }

  async status(jobId: string): Promise<ReportStatus> {
    const job = await this.reports.getJob(jobId);
    if (!job) throw new NotFoundException();
    return { state: await job.getState(), progress: job.progress };
  }
}

@Processor('reports')
export class ReportsProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportsProcessor.name);
  /** Final failures whose dead letter is stored: only these failed jobs may be removed. */
  private readonly deadLettered = new Set<string>();

  constructor(
    private readonly builder: ReportBuilder,
    private readonly deadLetters: DeadLetterStore,
  ) {
    super();
  }

  async process(job: Job<GenerateReport>): Promise<void> {
    try {
      await this.builder.build(job.data.reportId, (percent) => job.updateProgress(percent));
    } catch (error) {
      const err = toError(error);
      // attemptsMade counts earlier failed attempts: this is the last one when it reaches attempts - 1
      const final = err instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (final && job.id) {
        // A rejecting store fails the job with the store's error; the failed job stays as the only copy
        await this.deadLetters.record({
          key: `reports:${job.data.reportId}`,
          attempts: job.attemptsMade + 1,
          lastError: err.message,
          failedAt: new Date(),
          payload: job.data,
        });
        this.deadLettered.add(job.id);
      }
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<GenerateReport> | undefined, error: Error): Promise<void> {
    const fields = { jobId: job?.id, attempt: job?.attemptsMade };
    if (job && job.finishedOn === undefined) {
      this.logger.warn('Report job attempt failed, will retry', fields, error);
      return;
    }
    this.logger.error('Report job failed', fields, error);
    if (!job?.id || !this.deadLettered.delete(job.id)) return; // no dead letter: keep the failed job
    try {
      await job.remove();
    } catch (removeError) {
      this.logger.warn('Dead-lettered job not removed', fields, toError(removeError));
    }
  }
}

/** Payload holds ids, not personal data: job data is visible in Redis and in Bull Board. */
export interface SendWelcome {
  userId: string;
}

@Injectable()
export class WelcomeMailService {
  constructor(@InjectQueue('welcome-mail') private readonly queue: Queue<SendWelcome>) {}

  /** Custom job ids must not contain ':' (BullMQ rejects them); a repeated enqueue for the same user adds no second job. */
  async enqueue(userId: string): Promise<void> {
    await this.queue.add('send', { userId }, { jobId: `welcome-${userId}`, attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
  }
}

@Processor('welcome-mail')
export class WelcomeMailProcessor extends WorkerHost {
  constructor(private readonly mailer: WelcomeMailer) {
    super();
  }

  /** At-least-once: a stalled job runs again, so send() must skip users it already mailed. */
  async process(job: Job<SendWelcome>): Promise<void> {
    await this.mailer.send(job.data.userId);
  }
}
```

**Correct (`queues/queue-board.module.ts`, never public):**

```typescript
import { createHash, timingSafeEqual } from 'node:crypto';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';
import { Injectable, Module, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';

/** Fixed-length digests: the comparison takes the same time whatever the header's length. */
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Basic auth for the board; behind SSO or a reverse-proxy policy, check that identity here instead. */
@Injectable()
export class QueueBoardAuth implements NestMiddleware {
  private readonly expected: Buffer;

  constructor(config: ConfigService) {
    const credentials = `${config.getOrThrow<string>('QUEUE_BOARD_USER')}:${config.getOrThrow<string>('QUEUE_BOARD_PASSWORD')}`;
    this.expected = digest(`Basic ${Buffer.from(credentials).toString('base64')}`);
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (timingSafeEqual(digest(req.headers.authorization ?? ''), this.expected)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="queues"').status(401).end();
  }
}

@Module({
  imports: [
    BullBoardModule.forRoot({ route: '/admin/queues', adapter: ExpressAdapter, middleware: QueueBoardAuth }),
    BullBoardModule.forFeature({ name: 'reports', adapter: BullMQAdapter }, { name: 'welcome-mail', adapter: BullMQAdapter }),
  ],
})
export class QueueBoardModule {}
```

Probe results (Redis 8.10.2, `bullmq` 6.5.1, `@nestjs/bullmq` 12.0.0, `@bull-board/*` 9.10.5): `jobId: 'welcome:u1'` rejected with `Custom Id cannot contain :`; `welcome-u1` was accepted and processed. Requesting a report twice left one job. A builder that always threw ran 3 times and logged `warn` `Report job attempt failed, will retry` for attempts 1 and 2, then `error` `Report job failed` `{ jobId, attempt: 3 }` with `Error('boom 3')`; the store held one dead letter `{"key":"reports:r2","attempts":3,"lastError":"boom 3"}` and the failed job was gone. With a store whose `record()` threw `dead-letter table locked`, the job stayed in state `failed` with that `failedReason` and no dead letter existed. An `UnrecoverableError` failed after one attempt with one dead letter and one `error` log. The board answered 401 without credentials, with a wrong password and with a longer header, and 200 with the right ones (UI and `/admin/queues/api/queues`). `DeadLetterStore` is the injectable store from `nestjs-resilience`; back it with a migrated table so dead letters survive Redis eviction. If the process dies between `record()` and `job.remove()`, both copies remain, never neither.

Bull Board shows every job's payload and can retry, promote and delete jobs: put it behind your admin authentication (or a reverse-proxy policy) and never route it publicly. Keep personal data out of payloads (ids, not email addresses); Redis and the board keep job data until removal.

`@nestjs/bullmq` consumers extend `WorkerHost` and implement one `process(job)` per queue, dispatching on `job.name` when a queue carries several job types; `@Process()` belongs to the older `@nestjs/bull`. Repeating jobs are job schedulers upserted by id (`queue.upsertJobScheduler('daily-cleanup', { pattern: '0 0 * * *' }, { name: 'cleanup' })`), which stays one scheduler per id across restarts and instances; `RepeatOptions` has `pattern`, not `cron`. Every queue a producer or consumer uses must be registered with `BullModule.registerQueue`. A producer that must not delay the response doesn't leave `enqueue()` unawaited: it calls a `dispatch(): void` that tracks the promise for `drain()` and ends it in a terminal `.catch` (`nestjs-resilience` rule `dlq-record-final-failure`). Workers close at shutdown: `devops-graceful-shutdown`. Log levels and call shape: `nestjs-logging`.

Reference: [NestJS Queues](https://docs.nestjs.com/techniques/queues), [BullMQ Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs)
