---
title: Implement Graceful Shutdown
impact: MEDIUM-HIGH
impactDescription: Proper shutdown handling ensures zero-downtime deployments
tags: devops, graceful-shutdown, lifecycle, kubernetes
---

## Implement Graceful Shutdown

On `SIGTERM` the instance must stop receiving new traffic, finish what is in flight, then release resources, in that order. One owner handles the signal: `app.enableShutdownHooks()` in `main.ts`. A second `process.on('SIGTERM')` handler that calls `server.close()` / `app.close()` / `process.exit()` races Nest's own sequence and can exit while hooks still run. Nest's sequence on a signal is `onModuleDestroy` → `beforeApplicationShutdown` → close the HTTP server (waits for in-flight requests) → `onApplicationShutdown` → re-raise the signal. The load balancer only stops routing after readiness fails, so readiness has to fail first and the HTTP server must keep serving for a bounded drain period: that is `beforeApplicationShutdown`.

**Incorrect (own signal handler; readiness flipped during teardown; hand-closed connections):**

```typescript
process.on('SIGTERM', () => {
  server.close(async () => {
    await app.close();
    process.exit(0); // a second shutdown path next to enableShutdownHooks()
  });
});

@Injectable()
export class AppShutdownService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    this.shutdownService.startShutdown(); // the HTTP server is already closed: too late to drain
    await sleep(5000);
  }
}

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly connections: Connection[] = []; // TypeORM 1.x has no Connection; @nestjs/typeorm owns the DataSource
}
```

**Correct (`src/main.ts`, the shutdown line; the whole file is `nestjs-logging` rule `setup-json-console-logger`):**

```typescript
const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
configureApp(app);
app.enableShutdownHooks(); // the only SIGTERM/SIGINT listener: runs the shutdown hooks, then re-raises the signal
await app.listen(process.env.PORT ?? 3000);
```

**Correct (readiness fails, then a bounded drain; `health/health.module.ts` from `micro-use-health-checks`):**

```typescript
TerminusModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => ({
    // On SIGTERM: every health check answers 503 "shutting_down", then shutdown waits this long
    gracefulShutdownTimeoutMs: config.get('SHUTDOWN_DRAIN_MS', { infer: true }), // validated integer >= 0, default 10000
  }),
}),
```

`@nestjs/terminus` 12.1.0 does both steps in its own `beforeApplicationShutdown`: it marks every health check `shutting_down` (503) and, on `SIGTERM` only, waits `gracefulShutdownTimeoutMs`. `app.close()` in tests skips the wait. In the probe (built app, `SHUTDOWN_DRAIN_MS=1500`), a 2.5 s request was started, then `SIGTERM` sent: `/health/ready` answered `503 {"status":"shutting_down",…}` 0.3 s later while normal routes still answered, the log showed `Awaiting 1500ms before shutdown`, the slow request completed with `200 {"done":true}` 2.30 s after the signal, and the process then exited with code 143 (the re-raised `SIGTERM`). `SHUTDOWN_DRAIN_MS` comes from the validated `Env` (`devops-use-config-module`), so a non-integer or negative value stops startup instead of reaching Terminus as `NaN`. Set the drain longer than the readiness probe's `periodSeconds × failureThreshold`, and `terminationGracePeriodSeconds` longer than the drain plus the slowest request; Kubernetes sends `SIGKILL` when it runs out.

Nest runs `beforeApplicationShutdown` module by module and awaits each: in the probe, a hook in `AppModule` ran before Terminus's. A hook that awaits long work there delays the readiness flip, so keep those hooks short or bounded.

What each resource does at shutdown, and who owns it:
- **Database:** `@nestjs/typeorm` destroys its `DataSource` in `onApplicationShutdown`; don't close it yourself (`nestjs-typeorm`).
- **Clients you create** (Redis, brokers): close them in `onApplicationShutdown`, after the HTTP server has stopped (`perf-async-hooks`); closing in `onModuleDestroy` breaks requests that are still draining.
- **Scheduled jobs:** await the running job in `beforeApplicationShutdown` (`nestjs-schedule` rule `lifecycle-drain-on-shutdown`).
- **BullMQ workers:** `@nestjs/bullmq` 12.0.0 calls `worker.close()` in `onApplicationShutdown`, which waits for active jobs; a job cut off by `SIGKILL` is picked up again as stalled, so processors must be idempotent (`micro-use-queues`).
- **Process handlers** (`uncaughtException`, `unhandledRejection`) log `fatal` and exit non-zero: `error-handle-async-errors`.

Reference: [NestJS Lifecycle Events](https://docs.nestjs.com/fundamentals/lifecycle-events), [NestJS Terminus](https://docs.nestjs.com/recipes/terminus)
