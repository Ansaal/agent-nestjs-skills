---
title: Use Async Lifecycle Hooks Correctly
impact: HIGH
impactDescription: Improper async handling blocks application startup
tags: performance, lifecycle, async, hooks
---

## Use Async Lifecycle Hooks Correctly

Nest awaits the promise returned from `onModuleInit`, `onApplicationBootstrap` and the shutdown hooks, so async setup belongs there, returned or awaited. A hook that starts work without awaiting it lets the app accept requests before the resource is ready and turns a setup failure into an unhandled rejection. Constructors stay synchronous and cheap: they run during dependency resolution, and blocking I/O there stalls every module. Open connections in `onModuleInit` and close them in `onApplicationShutdown`, which runs after the HTTP server has stopped; closing in `onModuleDestroy` pulls the resource from under requests that are still draining. Shutdown hooks only run on a signal when `main.ts` calls `enableShutdownHooks()` (`devops-graceful-shutdown`).

**Incorrect (fire-and-forget init; blocking constructor):**

```typescript
@Injectable()
export class RedisConnection implements OnModuleInit {
  onModuleInit() {
    this.redis.connect(); // not awaited: the app starts before Redis is ready; a failure is an unhandled rejection
  }
}

@Injectable()
export class DomainBlocklist {
  private readonly domains: Set<string>;

  constructor() {
    this.domains = new Set(readFileSync('blocklist.txt', 'utf8').split('\n')); // blocks module instantiation
  }
}
```

**Correct (`redis/redis.module.ts`):**

```typescript
import { Global, Injectable, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/** Opens the shared client before the app starts and closes it after the HTTP server has stopped. */
@Injectable()
export class RedisConnection implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisConnection.name);

  constructor(private readonly redis: Redis) {
    // Without a listener ioredis prints "[ioredis] Unhandled error event" on every failed reconnect
    redis.on('error', (error: Error) => this.logger.warn('Redis connection error', {}, error));
  }

  async onModuleInit(): Promise<void> {
    await this.redis.connect(); // bootstrap waits; an unreachable Redis fails startup instead of the first request
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit(); // runs after in-flight requests have finished (devops-graceful-shutdown)
  }
}

@Global()
@Module({
  providers: [
    {
      provide: Redis,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Redis(config.getOrThrow<string>('REDIS_URL'), { lazyConnect: true }),
    },
    RedisConnection,
  ],
  exports: [Redis],
})
export class RedisModule {}
```

**Correct (`signup/domain-blocklist.ts`):**

```typescript
import { readFile } from 'node:fs/promises';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Blocked email domains, loaded once before the app accepts requests. */
@Injectable()
export class DomainBlocklist implements OnModuleInit {
  private domains = new Set<string>();

  constructor(private readonly config: ConfigService) {} // keep the constructor synchronous and cheap

  async onModuleInit(): Promise<void> {
    // Awaited by app.init(): a missing file fails startup instead of the first signup
    const text = await readFile(this.config.getOrThrow<string>('BLOCKLIST_PATH'), 'utf8');
    this.domains = new Set(text.split('\n').map((line) => line.trim().toLowerCase()).filter(Boolean));
  }

  isBlocked(email: string): boolean {
    return this.domains.has(email.slice(email.lastIndexOf('@') + 1).toLowerCase());
  }
}
```

```typescript
// Runs after every module's onModuleInit: safe to use other modules' providers
@Injectable()
export class PopularProductsWarmer implements OnApplicationBootstrap {
  constructor(private readonly products: ProductsService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.products.getPopular(); // fills the cache (perf-use-caching)
  }
}
```

In the probe (`ioredis` 6.0.0 against a local RESP stub), `app.init()` resolved with the blocklist loaded and the client connected, and `app.close()` sent `QUIT`. A missing `BLOCKLIST_PATH` file rejected `init()` with `ENOENT: no such file or directory`; an unreachable Redis rejected it with `Connection is closed.` after logging `warn('Redis connection error', {}, Error('connect ECONNREFUSED 127.0.0.1:1'))`. Configuration comes from the validated `ConfigService` (`devops-use-config-module`). Providers of lazily loaded modules get no lifecycle hooks (`perf-lazy-loading`).

Reference: [NestJS Lifecycle Events](https://docs.nestjs.com/fundamentals/lifecycle-events)
