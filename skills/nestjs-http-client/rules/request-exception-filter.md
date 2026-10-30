---
title: Answer Upstream Failures With 502/504 Through toHttpException()
impact: HIGH
impactDescription: Upstream outages answered as 500 Internal server error, with the full error and stack logged per request
tags: http-client, exception-filter, errors, 502, 504
---

## Answer Upstream Failures With 502/504 Through toHttpException()

An `HttpClientError` that reaches Nest's default exception handler is an unknown exception: the client gets `500 {"statusCode":500,"message":"Internal server error"}`, and `ExceptionsHandler` logs the error with its stack. The upstream failed, not this service, so the answer is a gateway status. `toHttpException(error)` maps an `HttpResponseError`, `HttpNetworkError` or `HttpParseError` to `BadGatewayException` (502) and an `HttpTimeoutError` (or an `AbortSignal.timeout()` deadline) to `GatewayTimeoutException` (504) and keeps the original as `cause`; any other error is returned unchanged. Its built-in log interpolates `error.message` into a text line with no error attached, so pass `{ log: false }` and log the failure yourself with the shared shape (`nestjs-logging`): Nest's filter never logs an `HttpException`, so that line is the only record of the 502/504. The upstream body is not forwarded, because it may describe the upstream's internals; `forward: [409]` (or `true`) passes chosen statuses through with their body. Register one global filter for `HttpClientError` only, so every route answers the same way and every other error reaches the filters meant for it.

**Incorrect (each handler builds its own answer, or none):**

```typescript
@Get('quotes')
async quotes(@Query('orderId') orderId: string) {
  try {
    return await this.carrier.getQuotes(orderId);
  } catch (error) {
    throw new InternalServerErrorException((error as Error).message); // 500 with the upstream URL in the body
  }
}
```

**Correct (one global filter):**

```typescript
// http/http-client-exception.filter.ts
import { ArgumentsHost, Catch, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { HttpClientError, toHttpException } from '@nestjs/http-client';

/** An upstream failure that reaches a handler's caller is our 502/504, logged once with the error attached. */
@Catch(HttpClientError)
export class HttpClientExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(HttpClientExceptionFilter.name);

  override catch(error: HttpClientError, host: ArgumentsHost) {
    const exception = toHttpException(error, { log: false });
    this.logger.error('Upstream call failed', { answer: exception.getStatus() }, error);
    super.catch(exception, host);
  }
}
```

```typescript
// app.module.ts providers
{ provide: APP_FILTER, useClass: HttpClientExceptionFilter },
```

With the filter, `GET /shipping/quotes` against a carrier answering `503` (client `retry: false`) answered `502` and logged one line with the error attached: `error` from `HttpClientExceptionFilter`, `Upstream call failed`, params `{"answer":502}`, error `HttpResponseError: GET http://127.0.0.1:64545/orders/x/quotes failed with 503 Service Unavailable`. A caller's deadline is not an `HttpClientError`: the client rejects with the signal's own reason, a `DOMException` named `TimeoutError`. Map it where the signal is created, matching that exact reason, rather than catching `DOMException` globally: Nest picks one filter and never redispatches, so a global `@Catch(DOMException)` also swallowed unrelated `AbortError`s and `DataError`s into its own answer. With the filter above, a handler throwing `new DOMException('aborted elsewhere', 'AbortError')` reached Nest's `ExceptionsHandler`, which logged it with its stack.

```typescript
// carrier/shipping.controller.ts
@Get('quotes')
async quotes(@Query('orderId') orderId: string) {
  // The whole call, not one attempt, must finish within 1 s.
  const deadline = AbortSignal.timeout(1000);
  try {
    return await this.carrier.getQuotes(orderId, deadline);
  } catch (err) {
    // Only this deadline is ours to answer; any other error goes to the filters unchanged.
    if (err !== deadline.reason || (err as Error).name !== 'TimeoutError') throw err;
    this.logger.error('Carrier quotes missed the deadline', { orderId, deadlineMs: 1000 }, err as Error);
    throw toHttpException(err, { log: false }); // GatewayTimeoutException with err as cause
  }
}
```

```typescript
// test/shipping-deadline.e2e-spec.ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { createTestApp } from './support/test-app.js';

describe('Shipping deadline (e2e)', () => {
  // A carrier that answers after the caller's 1 s deadline.
  const carrier = createServer((_req, res) => void setTimeout(() => res.end('[]'), 1500).unref());
  let app: NestExpressApplication;

  beforeAll(async () => {
    await new Promise<void>((resolve) => carrier.listen(0, '127.0.0.1', resolve));
    process.env.CARRIER_URL = `http://127.0.0.1:${(carrier.address() as AddressInfo).port}`;
  });

  afterAll(() => void carrier.close());

  beforeEach(async () => {
    app = await createTestApp();
    return () => app.close();
  });

  it('answers a deadline with 504', async () => {
    await request(app.getHttpServer())
      .get('/shipping/quotes?orderId=ord_1')
      .expect(504)
      .expect({ statusCode: 504, message: 'Gateway Timeout' });
  });
});
```

The test above passed against a carrier answering after 1.5 s: `504 {"statusCode":504,"message":"Gateway Timeout"}`, one `error` line from `ShippingController` with params `{"orderId":"slow","deadlineMs":1000}` and error `TimeoutError: The operation was aborted due to timeout`, and nothing from context `HttpClient`. An `APP_FILTER` provider is in the module graph, so e2e tests over the real `AppModule` get it too (`e2e-global-enhancers-as-providers` in `nestjs-testing`). Resilience's own rejections (`ResilienceTimeoutError`, `CircuitOpenError`) are not `HttpClientError`s; the resilience interceptor answers those on decorated routes (`nestjs-resilience`).

Reference: [NestJS Exception filters](https://docs.nestjs.com/exception-filters#inheritance)
