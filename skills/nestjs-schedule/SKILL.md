---
name: nestjs-schedule
description: Scheduled jobs in NestJS with `@nestjs/schedule`. Use when adding `@Cron()`, `@Interval()` or `@Timeout()` jobs, registering jobs at runtime through `SchedulerRegistry`, reading a job's delay from the environment, handling failures or slow runs in a job, shutting down while a job runs, or testing scheduled jobs.
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS Schedule

How a Nest app runs work on a timer: `ScheduleModule.forRoot()` once, a one-line decorated method that delegates to a plain work method, a single-flight guard against overlapping runs, failures caught and logged per item with every read and write through the `TransactionRunner`, `timeZone` on every wall-clock cron, validated env-driven delays, runtime jobs started and guarded by hand, the running job awaited at shutdown, and tests that park the timers and call the work. Verified 2026-10-29 against NestJS 12.3.2, @nestjs/schedule 12.0.2 with cron 4.4.0, TypeORM 1.1.2 with better-sqlite3 12.11.1, TypeScript 6.0.3, Vitest 5.0.5 on Node 24.22.2.

Every instance of the app runs every job: `@WithoutOverlapping()`, `@OnOneInstance()` and leader election are `nestjs-locks`. Retries of downstream calls, circuit breakers, dead letters and idempotency are `nestjs-resilience`; log levels and logger setup are `nestjs-logging`; transactions, the `TransactionRunner` and migrations are `nestjs-typeorm`; test structure, `createTestApp()` and fake timers for backoff are `nestjs-testing`; the Vitest config is `nestjs-setup`.

## Rules
| Prefix | Section | Impact |
|--------|---------|--------|
| `job-` | Job Design | CRITICAL |
| `lifecycle-` | Lifecycle | HIGH |
| `test-` | Testing Jobs | HIGH |

### 1. Job Design (CRITICAL)

- `job-thin-entrypoint` - The decorated method only calls a plain work method that returns a result; `log` per run that did work, `debug` for an empty tick
- `job-no-overlap` - `@Interval` does not wait for the last run: single-flight the work method; `waitForCompletion: true` on `@Cron`; across instances use `nestjs-locks`
- `job-handle-errors` - The scheduler logs a bare error under `Scheduler` and keeps firing; catch per item, `warn` while retried, `error` when given up, record each outcome through the `TransactionRunner`
- `job-cron-time-zone` - Every wall-clock `@Cron` gets a `timeZone` and a `name`; a bad zone fails `app.init()` with `CronError: Invalid timezone.`; catch per tenant inside the run
- `job-delay-from-env` - Delays are read at import; NaN or > 2 147 483 647 ms fires every 1 ms, so validate with `envMs()`
- `job-dynamic-registry` - `SchedulerRegistry` jobs need `start()`, unique names, the replacement `CronJob` built before the live one is deleted, cron's `errorHandler`, a `.catch()` in `setInterval`, and `cron` pinned to the version `@nestjs/schedule` uses

### 2. Lifecycle (HIGH)

- `lifecycle-register-once` - `ScheduleModule.forRoot()` once in `AppModule`; timers start in `onApplicationBootstrap` (`app.init()`), stop in `beforeApplicationShutdown`; jobs only on singleton providers
- `lifecycle-drain-on-shutdown` - `app.close()` does not wait for a running job; await the in-flight promise in `beforeApplicationShutdown()`

### 3. Testing Jobs (HIGH)

- `test-call-the-work` - Add one `<JOB>_POLL_MS: '3600000'` key per env-driven job to Vitest `test.env` (`BATCH_POLL_MS` for the batch job), boot with `createTestApp()` and call the work method directly
- `test-schedule-and-wiring` - Assert fire times with `getCronJob(name).nextDates()`; prove the wiring once with fake timers installed before `app.init()`

Read `rules/<id>.md` for the rule's reasoning and examples.
