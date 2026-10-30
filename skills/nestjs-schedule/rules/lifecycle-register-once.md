---
title: Import ScheduleModule.forRoot() Once and Keep Jobs on Singleton Providers
impact: HIGH
impactDescription: Without forRoot() no job ever fires; jobs on request-scoped providers are skipped with only a warning
tags: schedule, ScheduleModule, lifecycle, scope, onApplicationBootstrap
---

## Import ScheduleModule.forRoot() Once and Keep Jobs on Singleton Providers

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
