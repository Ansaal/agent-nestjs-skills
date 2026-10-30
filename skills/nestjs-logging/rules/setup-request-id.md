---
title: Stamp Every Record with the Request Id from AsyncLocalStorage
impact: MEDIUM
impactDescription: Lines of concurrent requests cannot be told apart
tags: logging, request-id, correlation, asynclocalstorage, middleware
---

## Stamp Every Record with the Request Id from AsyncLocalStorage

Concurrent requests interleave their lines; a `requestId` field on every record lets one request's flow be filtered out, including lines written deep inside services and by framework subscribers. No extra package is needed: Node's `AsyncLocalStorage` carries the id through every `await`, a middleware opens the store per request, and a `ConsoleLogger` subclass adds the field in `getJsonLogObject()`, the protected hook that builds each JSON record. Services keep calling `new Logger(ClassName.name)` and pass no id. The id is taken from an incoming `x-request-id` header when it looks like an id, so a caller's trace continues, otherwise generated, and echoed in the response. Lines written outside a request (startup, timers, queue consumers) have no store and no field.

**Incorrect (id threaded through every call, or a request-scoped logger):**

```typescript
async create(input: CreateUserInput, requestId: string) {
  this.logger.debug(`[${requestId}] Creating user`); // every signature changes; lines in other classes lack the id
}
// or: @Injectable({ scope: Scope.REQUEST }) on the logger, which makes every consumer request-scoped
```

**Correct (`src/logging/request-context.ts`):**

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

/** Holds the id of the request being handled; empty outside a request (startup, timers). */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();
```

**Correct (`src/logging/request-id.middleware.ts`):**

```typescript
import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from './request-context.js';

const SAFE_ID = /^[\w-]{1,64}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.get('x-request-id');
    const requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', requestId);
    // Everything the request does from here, async continuations included, sees this store.
    requestContext.run({ requestId }, next);
  }
}
```

**Correct (`src/logging/app-logger.ts`, used in `main.ts` instead of `ConsoleLogger`):**

```typescript
import { ConsoleLogger } from '@nestjs/common';
import { requestContext } from './request-context.js';

/** ConsoleLogger whose JSON records carry the id of the request that wrote them. */
export class AppLogger extends ConsoleLogger {
  protected override getJsonLogObject(...args: Parameters<ConsoleLogger['getJsonLogObject']>) {
    const record = super.getJsonLogObject(...args);
    const requestId = requestContext.getStore()?.requestId;
    return requestId ? { ...record, requestId } : record;
  }
}
```

```typescript
// app.module.ts
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}'); // '*path' skips GET /
  }
}
// main.ts: logger: new AppLogger({ json: true, redact: ['password', 'token', 'authorization', 'cookie'] })
```

`'{*path}'` makes the wildcard optional, so the middleware also runs for `/`: `GET /` answered with a generated `x-request-id: a47da69a-39aa-4187-9c3a-b743ed75db90` and its `debug` line carried the same id, while with `forRoutes('*path')` the `GET /` response had no `x-request-id` header. A request sent with `x-request-id: req-43` produced, among others, a retry event from the `@nestjs/resilience` subscriber and the final failure, both carrying the id: `{"level":"warn",...,"message":"Retrying call","context":"Resilience","error":{"name":"CarrierError","message":"The carrier answered with status 503",...},"params":{"source":"OrderSyncService.push","attempt":1,"delayMs":2},"requestId":"req-43"}`. The unhandled-exception line Nest writes itself carried the generated id too: `{"level":"error",...,"message":"Unexpected state","context":"ExceptionsHandler","error":{...},"requestId":"fe7581f9-4040-43dc-b8f4-16e393fe8534"}`. Work picked up later from a queue or a table runs outside the request's store; save the id with the job if the trace must follow it.

Reference: [Node.js – AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage)
