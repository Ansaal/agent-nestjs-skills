---
title: Handle Async Errors Properly
impact: HIGH
impactDescription: Lost work and silent process deaths from unhandled rejections
tags: error-handling, async, promises
---

## Handle Async Errors Properly

NestJS catches errors from async route handlers, but a promise nobody awaits (fire-and-forget calls, un-awaited work inside event handlers) rejects with no one listening, and Node ends the process on an unhandled rejection. Every promise is awaited, or handed to a `dispatch()` that ends it in its own `catch` and tracks it so tests and shutdown can `drain()` it. The process-level handlers are a last resort that make the crash visible as one structured log line; they never keep the process running. Log levels and call shape: `nestjs-logging`.

**Incorrect (fire-and-forget without error handling):**

```typescript
// Fire-and-forget without error handling
@Injectable()
export class UsersService {
  async createUser(dto: CreateUserDto): Promise<User> {
    const user = await this.usersRepo.insert(dto);

    // Fire and forget - if this fails, the rejection is unhandled and ends the process
    this.emailService.sendWelcome(user.email);

    return user;
  }
}

// Unhandled promise in event handler
@Injectable()
export class OrdersService {
  @OnEvent('order.created')
  handleOrderCreated(event: OrderCreatedEvent) {
    // Not awaited: the emitter can't see the rejection either, so it is unhandled
    this.processOrder(event);
  }
}

// Scheduled task that leaves failures to the scheduler
@Cron('0 0 * * *')
async dailyCleanup(): Promise<void> {
  await this.cleanup.run();
  // @nestjs/schedule catches the rejection and keeps the schedule, but logs
  // only the error message under context 'Scheduler': no job name, no item ids
}

// main.ts: log-and-continue keeps serving after an unknown failure
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason);
});
```

**Correct (explicit async error handling):**

```typescript
// Fire-and-forget through a dispatcher: dispatch() returns void, tracks the promise for drain()
// and ends it in a terminal .catch (nestjs-resilience rule dlq-record-final-failure)
@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly welcomeMail: WelcomeMailDispatcher,
  ) {}

  async createUser(dto: CreateUserDto): Promise<User> {
    const user = await this.usersRepo.insert(dto);
    this.welcomeMail.dispatch(user.id); // never rejects; the response doesn't wait
    return user;
  }
}

// Event handler: await the work, keep what failed for replay
@Injectable()
export class OrderCreatedListener {
  private readonly logger = new Logger(OrderCreatedListener.name);

  constructor(
    private readonly processor: OrderProcessor,
    private readonly deadLetters: DeadLetterStore, // nestjs-resilience dlq-record-final-failure
  ) {}

  @OnEvent('order.created')
  async handleOrderCreated(event: OrderCreatedEvent): Promise<void> {
    try {
      await this.processor.process(event);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const key = `order.created:${event.orderId}`;
      await this.deadLetters.record({ key, attempts: 1, lastError: err.message, failedAt: new Date(), payload: event });
      this.logger.log('Dead letter recorded', { key }, err);
    }
  }
}

// Scheduled tasks: catch to log with the job's context
// (per-item handling: `nestjs-schedule` rule `job-handle-errors`)
@Injectable()
export class CleanupJob {
  private readonly logger = new Logger(CleanupJob.name);

  constructor(private readonly cleanup: CleanupService) {}

  @Cron('0 0 * * *', { name: 'daily-cleanup' })
  async dailyCleanup(): Promise<void> {
    try {
      await this.cleanup.run();
      this.logger.log('Daily cleanup completed');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Daily cleanup failed', { job: 'daily-cleanup' }, err);
    }
  }
}
```

```typescript
// src/main.ts: the handlers, registered before NestFactory.create and logging through the instance create() gets
// (whole file and logger options: nestjs-logging rule setup-json-console-logger)
const logger = new ConsoleLogger({ json: true, redact: ['password', 'token', 'authorization', 'cookie'] });
const toError = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));
process.on('uncaughtException', (thrown) => {
  logger.fatal('Uncaught exception', { source: 'process' }, toError(thrown));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal('Unhandled rejection', { source: 'process' }, toError(reason));
  process.exit(1);
});

const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
```

`@OnEvent` listeners default to `suppressErrors: true` in `@nestjs/event-emitter`: a listener that rejects is caught and logged by the emitter (`error`, context `Event`, the error's message and stack), and the emitting code never sees it. A rethrow therefore doesn't crash the process; it loses the event with one log line. The listener above keeps the event as a dead letter instead. In the probe the failing `process()` left one dead letter and logged `log` `Dead letter recorded` `{"key":"order.created:o1"}` with the error; when the store's `record()` rejected (`dead-letter table locked`), that rejection was the one the emitter logged, and nothing was recorded, so the store needs to be durable (`nestjs-resilience`). Use `{ suppressErrors: false }` only when the emitter awaits `emitAsync()` and owns the failure (`arch-use-events`).

After an unhandled rejection or uncaught exception, the process state is unknown, so both handlers log at `fatal` and exit with code 1, as Node itself would. What they add is visibility: the crash becomes one JSON line instead of a raw stack trace. Register them before `NestFactory.create` so a failure while the app is being created is covered. In the probe, a provider constructor that left a rejected promise behind logged `{"level":"fatal",…,"message":"Unhandled rejection","error":{"name":"Error","message":"cache warmup failed",…},"params":{"source":"process"}}` and exited with code 1. A provider that throws is different: with Nest's default `abortOnError`, Nest logs it under `ExceptionHandler` and exits with code 1 whichever order the handlers are in.

Reference: [Node.js Unhandled Rejections](https://nodejs.org/api/process.html#event-unhandledrejection)
