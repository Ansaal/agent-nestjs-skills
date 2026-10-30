---
title: Implement Health Checks for Microservices
impact: MEDIUM-HIGH
impactDescription: Health checks enable orchestrators to manage service lifecycle
tags: microservices, health-checks, terminus, kubernetes
---

## Implement Health Checks for Microservices

Expose liveness and readiness with `@nestjs/terminus`. Liveness answers "is the process stuck?" and restarts the container when it fails, so it checks no dependencies: a database outage that fails liveness restarts every pod at once and fixes nothing. Readiness answers "can this instance serve traffic now?" and checks the dependencies every request needs, each with a timeout shorter than the probe's. Check each dependency with its own protocol: Redis speaks RESP, so `HttpHealthIndicator.pingCheck('redis', 'http://redis:6379')` fails against a healthy server; use the Redis client's `PING`. Keep third-party APIs out of readiness: their outage would take every instance out of the load balancer while the endpoints that don't need them could still serve.

**Incorrect (static OK; Redis probed over HTTP; dependencies in liveness):**

```typescript
@Get('health')
check(): string {
  return 'OK'; // 200 while the database is unreachable
}

@Get('live')
@HealthCheck()
liveness() {
  return this.health.check([() => this.db.pingCheck('database')]); // a DB outage restarts every pod
}

@Get('ready')
@HealthCheck()
readiness() {
  return this.health.check([
    () => this.http.pingCheck('redis', 'http://redis:6379'), // not HTTP: always down
    () => this.http.pingCheck('payments', 'https://api.payments.example/health'), // a third party's outage drains you
  ]);
}
```

**Correct (`health/redis.health.ts`):**

```typescript
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { Redis } from 'ioredis';

/** Redis speaks RESP, not HTTP: check it with the client's own PING. */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redis: Redis,
    private readonly health: HealthIndicatorService,
  ) {}

  pingCheck(key: string) {
    return this.health
      .check(key)
      .attempt(async () => {
        await this.redis.ping();
      })
      .withTimeout(1000);
  }
}
```

**Correct (`health/health.controller.ts`):**

```typescript
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /** Liveness: the process answers. No dependencies, or one outage restarts every pod at once. */
  @Get('live')
  @HealthCheck()
  liveness() {
    return this.health.check([]);
  }

  /** Readiness: can this instance serve traffic right now? */
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.db.pingCheck('database').withTimeout(1000),
      () => this.redis.pingCheck('redis'),
    ]);
  }
}
```

**Correct (`health/health.module.ts`):**

```typescript
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import type { Env } from '../config/env.validation.js';
import { HealthController } from './health.controller.js';
import { RedisHealthIndicator } from './redis.health.js';

@Module({
  imports: [
    TerminusModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        // On SIGTERM: every health check answers 503 "shutting_down", then shutdown waits this long
        gracefulShutdownTimeoutMs: config.get('SHUTDOWN_DRAIN_MS', { infer: true }),
      }),
    }),
  ],
  controllers: [HealthController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
```

`Redis` is the shared client from `perf-async-hooks`. Custom indicators use `HealthIndicatorService`: `@nestjs/terminus` 12.1.0 no longer exports the `HealthIndicator` base class or `HealthCheckError` that older examples extend and throw. `check(key).attempt(fn).withTimeout(ms)` marks the key `down` when `fn` throws or runs past the timeout; the built-in indicators return the same attempt, and `pingCheck(key, { timeout })` is deprecated in 12.1.0 in favour of `.withTimeout(ms)`. `SHUTDOWN_DRAIN_MS` is a validated `Env` key (`Joi.number().integer().min(0).default(10_000)`, `devops-use-config-module`): `abc` stopped startup with `Config validation error: SHUTDOWN_DRAIN_MS: "SHUTDOWN_DRAIN_MS" must be a number`, and unset it drained 10000 ms. In the probe (better-sqlite3 database, Redis 8.10.2), `/health/ready` returned 200 with `{"database":{"status":"up"},"redis":{"status":"up"}}` (plus `responseTime`); against a stub that answered `PING` after 3 s it returned 503 after 1022 ms with `{"redis":{"message":"timeout of 1000ms exceeded","responseTime":1003,"status":"down"}}`. `gracefulShutdownTimeoutMs` turns both endpoints into 503 `shutting_down` on `SIGTERM`; the shutdown sequence is `devops-graceful-shutdown`.

### Kubernetes Configuration

```yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30 # > SHUTDOWN_DRAIN_MS + the longest request
      containers:
        - name: api
          image: api-service:1.4.2
          ports:
            - containerPort: 3000
          startupProbe:
            httpGet: { path: /health/live, port: 3000 }
            periodSeconds: 5
            failureThreshold: 30
          livenessProbe:
            httpGet: { path: /health/live, port: 3000 }
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /health/ready, port: 3000 }
            periodSeconds: 5
            timeoutSeconds: 3 # above the 1 s indicator timeouts
            failureThreshold: 2
```

Reference: [NestJS Terminus](https://docs.nestjs.com/recipes/terminus)
