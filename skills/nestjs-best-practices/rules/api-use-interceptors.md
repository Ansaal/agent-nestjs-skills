---
title: Use Interceptors for Cross-Cutting Concerns
impact: MEDIUM-HIGH
impactDescription: Interceptors provide clean separation for cross-cutting logic
tags: api, interceptors, logging, caching
---

## Use Interceptors for Cross-Cutting Concerns

Interceptors wrap handler execution, so tracing, response envelopes, timeouts, caching and error mapping live in one place instead of every handler. Register global ones as `APP_INTERCEPTOR` providers so e2e apps built from `AppModule` get them too (`nestjs-testing` rule `e2e-global-enhancers-as-providers`). Async work started inside the pipe (a cache write) must be awaited and its failure handled; a rejected promise nobody awaits is an unhandled rejection. Log levels and call shape: `nestjs-logging`.

**Incorrect (repeated per handler; unawaited cache write; message matching):**

```typescript
@Get(':id')
async findOne(@Param('id') id: string): Promise<User> {
  const start = Date.now();
  this.logger.debug('findOne called', { id });
  const user = await this.usersService.findOne(id);
  this.logger.debug('findOne completed', { durationMs: Date.now() - start });
  return user; // repeated in every method
}

const cached = await this.cacheManager.get(cacheKey);
if (cached) return of(cached); // false, 0 and '' are recomputed every time
return next.handle().pipe(
  tap((response) => {
    this.cacheManager.set(cacheKey, response, ttl); // not awaited: a failing store is an unhandled rejection
  }),
);

if (error instanceof QueryFailedError && error.message.includes('duplicate')) {
  throw new ConflictException(); // driver- and locale-specific; better-sqlite3 says "UNIQUE constraint failed"
}
```

**Correct (`common/interceptors.ts`):**

```typescript
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  RequestTimeoutException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Cache } from 'cache-manager';
import type { Request, Response } from 'express';
import { catchError, map, mergeMap, of, tap, throwError, timeout, TimeoutError, type Observable } from 'rxjs';
import { EntityNotFoundError } from 'typeorm';
import { isUniqueViolation } from '../database/is-unique-violation.js';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { method, url } = context.switchToHttp().getRequest<Request>();
    const start = Date.now();
    // Per-request tracing at debug, values as fields. Failures are logged once, by the exception filter.
    return next.handle().pipe(
      tap(() => {
        const { statusCode } = context.switchToHttp().getResponse<Response>();
        this.logger.debug('Request handled', { method, url, statusCode, durationMs: Date.now() - start });
      }),
    );
  }
}

export interface Envelope<T> {
  data: T;
  meta: { timestamp: string; path: string };
}

@Injectable()
export class EnvelopeInterceptor<T> implements NestInterceptor<T, Envelope<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<Envelope<T>> {
    const path = context.switchToHttp().getRequest<Request>().url;
    return next.handle().pipe(
      map((data) => ({ data, meta: { timestamp: new Date().toISOString(), path } })),
    );
  }
}

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(5000),
      catchError((err: unknown) =>
        throwError(() => (err instanceof TimeoutError ? new RequestTimeoutException('Request timed out') : err)),
      ),
    );
  }
}

/** TTL in milliseconds for HttpCacheInterceptor; the route's default applies without it. */
export const CacheTtl = Reflector.createDecorator<number>();

@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  private readonly logger = new Logger(HttpCacheInterceptor.name);

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.method !== 'GET') return next.handle();

    const key = `http:${request.originalUrl}`; // path + query string; never for per-user responses
    const ttl = this.reflector.get(CacheTtl, context.getHandler()) ?? 300_000;

    const cached = await this.cache.get<unknown>(key);
    if (cached !== undefined) return of(cached); // false, 0 and '' are hits too

    return next.handle().pipe(
      mergeMap(async (response: unknown) => {
        try {
          await this.cache.set(key, response, ttl);
        } catch (error) {
          // Best effort: the response is still correct, only the next request is slower
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.warn('Cache write failed', { key }, err);
        }
        return response;
      }),
    );
  }
}

/** Maps persistence errors the handler didn't handle to HTTP errors. */
@Injectable()
export class PersistenceErrorInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof EntityNotFoundError) return throwError(() => new NotFoundException());
        if (isUniqueViolation(error)) return throwError(() => new ConflictException('Resource already exists'));
        return throwError(() => error);
      }),
    );
  }
}
```

```typescript
// app.module.ts — global; per controller or route with @UseInterceptors(...)
@Module({
  providers: [
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
  ],
})
export class AppModule {}

// usage
@Get('flags/:name')
@CacheTtl(60_000)
@UseInterceptors(HttpCacheInterceptor)
isEnabled(@Param('name') name: string): Promise<boolean> {
  return this.flags.isEnabled(name);
}
```

In the probe, a route returning `false` behind `HttpCacheInterceptor` ran once for two requests. With a cache store whose `set()` rejects, the request still returned 200 and the interceptor logged `warn('Cache write failed', { key: 'http:/skus/flag' }, Error('redis down'))`. Inserting a second row with the same `unique` code through `TransactionRunner` returned `409 {"message":"Resource already exists",…}`, and `findOneByOrFail` for a missing id returned `404` without echoing the query criteria that `EntityNotFoundError.message` contains. `isUniqueViolation` is the helper from `nestjs-typeorm` rule `orm-unique-violation`; when a service needs a different answer for a duplicate (return the existing row, `'duplicate'`), it catches there and the interceptor never sees it. The cache key is URL-only, so the interceptor is for responses that are the same for every caller; per-user keys and the stock `CacheInterceptor` are in `perf-use-caching`.

Reference: [NestJS Interceptors](https://docs.nestjs.com/interceptors)
