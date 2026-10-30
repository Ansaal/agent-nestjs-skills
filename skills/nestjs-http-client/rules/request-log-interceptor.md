---
title: Log Each Outbound Request at debug From One forRoot() Interceptor
impact: MEDIUM
impactDescription: Unlogged outbound calls, or per-request warn/error noise with headers, tokens and bodies in it
tags: http-client, logging, interceptors, observability
---

## Log Each Outbound Request at debug From One forRoot() Interceptor

A request to a dependency is a per-request step, so it is a `debug` line: method, host, path, status and duration as structured fields. Headers carry API keys and tokens, query strings and bodies carry personal data: none of them go into the line. Register the interceptor once in `HttpClientModule.forRoot()`: `forRoot()` interceptors run before each client's own, for every client, once per attempt. A failed request is also only `debug` here; the code that handles the rejection logs it once at the level its outcome deserves: `warn` from the resilience event logger for a retry and from a fallback (`request-typed-errors`), `error` from the global filter or the deadline's call site when the request fails for good (`request-exception-filter`), `log` for a dead letter (`nestjs-resilience`).

**Incorrect (per-service logging at the wrong level, with secrets and payloads):**

```typescript
const res = await this.http.post('/labels', { json: { orderId } });
this.logger.log(`POST /labels ${res.status} headers=${JSON.stringify([...res.request.headers])} body=${JSON.stringify(res.data)}`);
```

**Correct (one interceptor for every client):**

```typescript
// http/request-log.interceptor.ts
import { Injectable, Logger } from '@nestjs/common';
import type { HttpClientInterceptor, HttpHandler, HttpRequest } from '@nestjs/http-client';

/** One debug line per outbound request: method, host, path, outcome. Never headers, query or body. */
@Injectable()
export class RequestLogInterceptor implements HttpClientInterceptor {
  private readonly logger = new Logger('HttpClient');

  async intercept(request: HttpRequest, next: HttpHandler): Promise<Response> {
    const startedAt = performance.now();
    const fields = { method: request.method, host: request.url.host, path: request.url.pathname };
    try {
      const response = await next(request);
      this.logger.debug('Outbound request', {
        ...fields,
        status: response.status,
        ms: Math.round(performance.now() - startedAt),
      });
      return response;
    } catch (error) {
      // Not a warn: whoever handles the rejection logs it once, at the level its outcome deserves.
      this.logger.debug('Outbound request failed', {
        ...fields,
        error: error instanceof Error ? error.name : 'unknown',
        ms: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
  }
}
```

```typescript
// app.module.ts imports
HttpClientModule.forRoot({ interceptors: [RequestLogInterceptor] }),
```

With `ConsoleLogger({ json: true })` one call logged `{"level":"debug",…,"message":"Outbound request","context":"HttpClient","params":{"method":"PUT","host":"127.0.0.1:53563","path":"/orders/ord_1","status":503,"ms":12}}`. A non-2xx answer reaches the interceptor as a `Response` (the client throws `HttpResponseError` after the interceptors), so the status is in the success branch; timeouts and network failures arrive as `HttpTimeoutError`/`HttpNetworkError` in the catch branch. Interceptor classes are created with DI on `onModuleInit`, so an unresolvable dependency fails bootstrap, and they may inject other providers. Logger setup and the level policy are `nestjs-logging`.

Reference: [NestJS HTTP client](https://docs.nestjs.com/application/http-client)
