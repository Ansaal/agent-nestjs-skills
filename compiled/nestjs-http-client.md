# NestJS HTTP Client

**Version 2.0.0-ansaal**
Ansaal/agent-nestjs-skills
October 2026

> **Note:**
> This document is mainly for agents and LLMs to follow when maintaining,
> generating, or refactoring NestJS codebases. Humans may also find it
> useful, but guidance here is optimized for automation and consistency
> by AI-assisted workflows.

---

## Abstract

Outbound HTTP for NestJS with `@nestjs/http-client` (native fetch). Use when calling another service or third-party API, registering HTTP clients, choosing timeouts and retry settings for a client, mapping upstream errors to results or 502/504 answers, logging outbound requests, or testing code that makes HTTP calls.

---

## Table of Contents

1. [Client Registration](#1-client-registration) — **CRITICAL**
   - 1.1 [Register One Named Client per External System, Behind One Client Provider](#11-register-one-named-client-per-external-system-behind-one-client-provider)
   - 1.2 [Register Every Client With retry false; Resilience Policies Own Retries](#12-register-every-client-with-retry-false-resilience-policies-own-retries)
2. [Requests and Errors](#2-requests-and-errors) — **HIGH**
   - 2.1 [Answer Upstream Failures With 502/504 Through toHttpException()](#21-answer-upstream-failures-with-502-504-through-tohttpexception-)
   - 2.2 [Log Each Outbound Request at debug From One forRoot() Interceptor](#22-log-each-outbound-request-at-debug-from-one-forroot-interceptor)
   - 2.3 [Pass the Caller's AbortSignal Into Every Request](#23-pass-the-caller-s-abortsignal-into-every-request)
   - 2.4 [Put Path Values in params and Query Values in query](#24-put-path-values-in-params-and-query-values-in-query)
   - 2.5 [Map Expected Statuses in the Client; Let Typed Errors Propagate](#25-map-expected-statuses-in-the-client-let-typed-errors-propagate)
3. [Testing](#3-testing) — **HIGH**
   - 3.1 [Test the Client Provider Against an undici MockAgent Matching Node's Bundled undici](#31-test-the-client-provider-against-an-undici-mockagent-matching-node-s-bundled-undici)
   - 3.2 [In E2E Suites, Override the Client Provider, Not fetch or Internals](#32-in-e2e-suites-override-the-client-provider-not-fetch-or-internals)

---

## 1. Client Registration

**Section Impact: CRITICAL**

### 1.1 Register One Named Client per External System, Behind One Client Provider

**Impact: CRITICAL** — URLs, credentials and timeouts scattered across services; one system's headers sent to another host

`@nestjs/http-client` is pre-1.0 (0.0.2 on 2026-10-29), ships ESM only (`"type": "module"`), has no runtime dependencies (it calls the platform `fetch`), needs Node `>=20.19.0`, and its peers are `@nestjs/common` and `@nestjs/core` `^11 || ^12`. Pin it exactly; a 0.x release may change the API. Register one client per external system with `HttpClientModule.registerAsync({ name })` in the module whose features call that system, and wrap it in one `<System>Client` provider that the rest of the app injects. The wrapper is the only place that knows the system's paths, verbs and payload shapes; services call typed methods. The client's `baseUrl` also fences it in: an absolute URL to another host is refused with `TypeError: "https://evil.test/x" is not on the client's origin (https://carrier.test). A client with a baseUrl only sends requests there, so its headers and interceptors never reach another host.`, so the carrier's API key can't leak to a second system sharing the client. Options are checked when the client is created: a `baseUrl` without a scheme fails bootstrap with ``TypeError: HttpClient `baseUrl`: "carrier.test" is not an absolute URL. Include the scheme, e.g. "https://api.example.com".``, and a missing setting read with `getOrThrow()` with `TypeError: Configuration key "CARRIER_URL" does not exist`.

**Incorrect (raw fetch in a service, URL and key read per call, no timeout):**

```typescript
@Injectable()
export class ShippingService {
  async cheapestQuote(orderId: string) {
    const res = await fetch(`${process.env.CARRIER_URL}/orders/${orderId}/quotes`, {
      headers: { 'x-api-key': process.env.CARRIER_API_KEY! }, // undefined key sent as "undefined"
    }); // no timeout: a hung carrier holds this request forever
    const quotes = (await res.json()) as { price: number }[]; // a 503 body parsed as quotes
    return Math.min(...quotes.map((quote) => quote.price));
  }
}
```

**Correct (the module registers the named client from config):**

```bash
pnpm add -E @nestjs/http-client
```

```typescript
// carrier/carrier.module.ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientModule } from '@nestjs/http-client';
import { CarrierClient } from './carrier.client.js';
import { CarrierGateway } from './carrier.gateway.js';

@Module({
  imports: [
    HttpClientModule.registerAsync({
      name: 'carrier', // next to useFactory: it decides the injection token
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        baseUrl: config.getOrThrow<string>('CARRIER_URL'),
        headers: { 'x-api-key': config.getOrThrow<string>('CARRIER_API_KEY') },
        timeout: '2s', // per attempt
        retry: false, // @nestjs/resilience owns retries (client-retry-off)
      }),
    }),
  ],
  providers: [CarrierClient, CarrierGateway],
  exports: [CarrierClient, CarrierGateway],
})
export class CarrierModule {}
```

**Correct (one provider owns the carrier's paths and payloads):**

```typescript
// carrier/carrier.client.ts
import { Injectable } from '@nestjs/common';
import { HttpClient, HttpResponseError, InjectHttpClient } from '@nestjs/http-client';

export interface Quote {
  carrier: string;
  price: number;
}

export interface OrderSnapshot {
  id: string;
  status: string;
}

export interface Shipment {
  id: string;
  state: string;
}

/** The only provider that talks to the carrier: typed methods, no URLs outside this file. */
@Injectable()
export class CarrierClient {
  constructor(@InjectHttpClient('carrier') private readonly http: HttpClient) {}

  async getQuotes(orderId: string, signal?: AbortSignal): Promise<Quote[]> {
    const { data } = await this.http.get<Quote[]>('/orders/:orderId/quotes', { params: { orderId }, signal });
    return data;
  }

  /** `null` when the carrier has no such shipment; every other failure propagates. */
  async findShipment(id: string, signal?: AbortSignal): Promise<Shipment | null> {
    try {
      const { data } = await this.http.get<Shipment>('/shipments/:id', { params: { id }, signal });
      return data;
    } catch (error) {
      if (error instanceof HttpResponseError && error.status === 404) return null;
      throw error;
    }
  }

  async pushOrder(order: OrderSnapshot, signal?: AbortSignal): Promise<void> {
    await this.http.put('/orders/:id', { params: { id: order.id }, json: order, signal });
  }

  async createShipment(orderId: string, signal?: AbortSignal): Promise<Shipment> {
    const { data } = await this.http.post<Shipment>('/shipments', { json: { orderId, reference: orderId }, signal });
    return data;
  }

  async buyLabel(orderId: string, signal?: AbortSignal): Promise<{ labelUrl: string }> {
    const { data } = await this.http.post<{ labelUrl: string }>('/labels', { json: { orderId }, signal });
    return data;
  }
}
```

`name`, `isGlobal`, `imports` and interceptor classes go next to `useFactory`; returning `name` from the factory fails bootstrap. Without a `name` the client is the default one, injected by its class `HttpClient`; with one, through `@InjectHttpClient(name)` (token `getHttpClientToken(name)`, the string `HttpClient:carrier`). The client is visible only in the registering module unless `isGlobal: true`; export the wrapper instead. `HttpClientModule.forRoot()` (global) holds defaults for every client (headers, timeout, retry, interceptors); a client's own settings win and headers merge. `timeout` is per attempt and covers reading the body; `0` or unset means none. `T` in `get<T>()` is a type assertion: nothing validates the body at runtime. The `ConfigModule` setup is `nestjs-best-practices` (`devops-use-config-module`); where client providers live in a feature plan is `nestjs-fdd`.

Reference: [NestJS HTTP client](https://docs.nestjs.com/application/http-client)

---

### 1.2 Register Every Client With retry false; Resilience Policies Own Retries

**Impact: CRITICAL** — Attempts multiply under a resilience policy (3 × 3 = 9 requests per call) against a dependency that is already failing

Retries are on when `retry` is omitted. `resolveRetry(undefined)` applies `DEFAULT_RETRY`: 3 attempts in total for `GET`, `HEAD`, `OPTIONS`, `PUT` and `DELETE`, after connection errors, per-attempt timeouts and `408`/`429`/`500`/`502`/`503`/`504`, waiting a full-jitter backoff of 200 ms × 2 per retry capped at 30 s, or the `Retry-After` the upstream sends. A bare `new HttpClient({ baseUrl })` sent 3 requests for one `get()` to a stub answering `503`. Under a `@nestjs/resilience` preset with `retry: { attempts: 3 }`, each policy attempt runs the client's own 3: one `CarrierGateway.cheapestQuote()` sent **9** requests and still rejected with `HttpResponseError: GET http://127.0.0.1:53304/orders/ord_1/quotes failed with 503 Service Unavailable`. With the client registered `retry: false`, the same call sent 3. The policy is the layer that sees the whole call: its retry events, its circuit breaker, its dead letters and its per-route method rules (`nestjs-resilience`). So the client makes one attempt and the policy decides whether there is another. Calls that run outside any policy make one attempt as well; if one of them needs a retry, run it under a policy.

**Incorrect (`retry` omitted; the default 3 attempts run inside every policy attempt):**

```typescript
HttpClientModule.register({ name: 'carrier', baseUrl: 'https://api.carrier.example', timeout: '2s' });
```

**Correct (one attempt per call; set on the client, not per request):**

```typescript
// carrier/carrier.module.ts imports
HttpClientModule.registerAsync({
  name: 'carrier',
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    baseUrl: config.getOrThrow<string>('CARRIER_URL'),
    headers: { 'x-api-key': config.getOrThrow<string>('CARRIER_API_KEY') },
    timeout: '2s', // per attempt
    retry: false, // @nestjs/resilience owns retries (nestjs-resilience)
  }),
}),
```

Set it on every registration, not only in `forRoot()`: a client module imported by a test module without the app's `forRoot()` would fall back to the default 3 attempts. Settings layer `forRoot()` → client → request, and a later `retry` (a number or an object) turns retries back on from the defaults; don't pass `retry` per request. Keep the client's `timeout` too: it bounds a call that runs without a policy or without a signal, and a client timeout rejects with `HttpTimeoutError`, which the policy retries like any other transient failure. Which calls may be retried, and where, is `resilience-service-policy` and `resilience-entrypoint-decorators` in `nestjs-resilience`.

Reference: [NestJS HTTP client](https://docs.nestjs.com/application/http-client)

---

## 2. Requests and Errors

**Section Impact: HIGH**

### 2.1 Answer Upstream Failures With 502/504 Through toHttpException()

**Impact: HIGH** — Upstream outages answered as 500 Internal server error, with the full error and stack logged per request

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

---

### 2.2 Log Each Outbound Request at debug From One forRoot() Interceptor

**Impact: MEDIUM** — Unlogged outbound calls, or per-request warn/error noise with headers, tokens and bodies in it

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

---

### 2.3 Pass the Caller's AbortSignal Into Every Request

**Impact: HIGH** — Timed-out attempts keep their connections open and keep loading the dependency

A resilience timeout rejects the caller, but only the `signal` stops the HTTP request behind it. Every client method takes `signal?: AbortSignal` and passes it as the request's `signal` option. Callers hand in the attempt's signal: the `{ signal }` a policy's `execute()` gives its function, or `@Signal()` in a handler decorated with `@Resilience()`/`@Timeout()` (`nestjs-resilience`). The client combines it with its own per-attempt `timeout`. Measured against a stub that answers after 1 s, under a preset with `timeout: '100ms'`: with the signal passed, the call rejected with `ResilienceTimeoutError: Timed out after 100ms` after 154 ms and the stub saw the connection closed before it answered. Without it, the caller got the same error but the request stayed open, and the stub served the whole response to nobody. Under a retrying policy those orphans add up: every timed-out attempt keeps its connection while the next one starts.

**Incorrect (the policy's signal is dropped; the wrapper can't be cancelled):**

```typescript
getQuotes(orderId: string): Promise<Quote[]> {
  return this.http.get<Quote[]>('/orders/:orderId/quotes', { params: { orderId } }).then((res) => res.data);
}

cheapestQuote(orderId: string) {
  return this.carrierPolicy.execute(() => this.carrier.getQuotes(orderId)); // timeout rejects, request runs on
}
```

**Correct (client method takes the signal; the policy's signal reaches fetch):**

```typescript
// carrier/carrier.client.ts
async getQuotes(orderId: string, signal?: AbortSignal): Promise<Quote[]> {
  const { data } = await this.http.get<Quote[]>('/orders/:orderId/quotes', { params: { orderId }, signal });
  return data;
}
```

```typescript
// carrier/carrier.gateway.ts
cheapestQuote(orderId: string): Promise<number> {
  return this.carrierPolicy.execute(
    async ({ signal }) => {
      const quotes = await this.carrier.getQuotes(orderId, signal);
      return Math.min(...quotes.map((quote) => quote.price));
    },
    { source: 'CarrierGateway.cheapestQuote' },
  );
}
```

```typescript
// carrier/shipping.controller.ts
@Get('quotes')
@Resilience('carrier')
@Timeout('1.5s')
quotes(@Query('orderId') orderId: string, @Signal() signal: AbortSignal) {
  return this.carrier.getQuotes(orderId, signal);
}
```

An aborted caller signal rejects with the signal's reason unchanged (here the `ResilienceTimeoutError`), not with an `HttpClientError`; the client's own `timeout` rejects with `HttpTimeoutError` (`GET https://carrier.test/slow timed out after 50ms`, `timeoutMs: 50`). Both abort the fetch. The signal also cuts short the client's own interceptors and any backoff wait.

Reference: [NestJS Resilience – Use the same policies inside services](https://docs.nestjs.com/reliability/resilience#use-the-same-policies-inside-services)

---

### 2.4 Put Path Values in params and Query Values in query

**Impact: MEDIUM-HIGH** — Interpolated ids that contain "/" or ".." call a different endpoint; secrets in query strings reach logs

An id interpolated into a path is not encoded: `` `/shipments/${id}` `` with `id = '../admin/users'` was sent as `GET https://carrier.test/admin/users`, and an id containing `/` or `?` changes the path or starts a query string. Write the path as a template with `:name` segments and pass the values in `params`: each one is URI-encoded (`getQuotes('a/b')` requested `/orders/a%2Fb/quotes`), every key must match a segment, and a value can't be empty, `.` or `..` (`TypeError: Path parameter "id" can't be "..": it would change which endpoint the request goes to`). Pass query values in `query` (`{ orderId: 'ord 1', state: ['open', 'lost'], since: undefined }` was sent as `?orderId=ord%201&state=open&state=lost`), never as a string on the path. The client's error messages mask every query value (`?token=***`), and a `baseUrl` with a query string is refused at startup, so per-system query values belong in `query` or an interceptor.

**Incorrect (interpolated id and query string):**

```typescript
findShipment(id: string, include: string) {
  return this.http.get<Shipment>(`/shipments/${id}?include=${include}`);
}
```

**Correct (template path, `params` and `query`):**

```typescript
async findShipment(id: string, signal?: AbortSignal): Promise<Shipment | null> {
  try {
    const { data } = await this.http.get<Shipment>('/shipments/:id', { params: { id }, signal });
    return data;
  } catch (error) {
    if (error instanceof HttpResponseError && error.status === 404) return null;
    throw error;
  }
}

async listShipments(orderId: string, states: string[], signal?: AbortSignal): Promise<Shipment[]> {
  const { data } = await this.http.get<Shipment[]>('/shipments', { query: { orderId, state: states }, signal });
  return data;
}
```

A `GET` or `HEAD` with a body throws ``TypeError: A GET request can't have a body. Send the values in `query`.`` before anything is sent. Send JSON bodies with `json` (serialized, `content-type: application/json` set) and raw bodies with `body`; passing both throws ``TypeError: Pass either `json` or `body`, not both``.

Reference: [NestJS HTTP client](https://docs.nestjs.com/application/http-client)

---

### 2.5 Map Expected Statuses in the Client; Let Typed Errors Propagate

**Impact: HIGH** — Client errors retried and counted by the breaker; expected answers treated as outages; upstream bodies in logs

Every failure the client produces is an `HttpClientError` with `method` and a `message` that names the URL with its query values masked: `HttpResponseError` for a non-2xx answer (`status`, `statusText`, `headers`, `body`; thrown while `throwOnHttpError` keeps its default `true`), `HttpTimeoutError` for the per-attempt `timeout` (`timeoutMs`), `HttpNetworkError` before a complete response (DNS, refused or reset connection, TLS, a refused redirect; details in `cause.code`, e.g. `ECONNREFUSED`), and `HttpParseError` for a body that claims JSON but isn't. Errors thrown by interceptors and a caller's abort propagate unchanged. An answer the caller expects, such as a `404` for an unknown shipment, is a result: the client provider maps it (`null`, a domain value) with `instanceof HttpResponseError` and `status`. Everything else propagates as it is, because `status` is what `@nestjs/resilience` reads: `isClientError()` treats a `4xx` (except `408`/`429`) as the caller's fault, so the policy neither retries it nor counts it toward the breaker. A `422` from the carrier made 1 request under a 3-attempt preset. The fields that can carry secrets or personal data (`url`, `headers`, `body`) are non-enumerable: `JSON.stringify(error)` gave `{"name":"HttpResponseError","method":"GET","status":422,"statusText":"Unprocessable Entity"}`.

**Incorrect (status discarded, 404 treated as an outage, body logged):**

```typescript
async findShipment(id: string) {
  const res = await this.http.get<Shipment>('/shipments/:id', { params: { id }, throwOnHttpError: false });
  if (!res.ok) {
    this.logger.error(`carrier failed: ${JSON.stringify(res.data)}`); // upstream body (PII) in the log
    throw new Error(`Carrier failed with ${res.status}`); // no status: a 4xx is retried and trips the breaker
  }
  return res.data;
}
```

**Correct (expected status mapped in the client):**

```typescript
// carrier/carrier.client.ts
/** `null` when the carrier has no such shipment; every other failure propagates. */
async findShipment(id: string, signal?: AbortSignal): Promise<Shipment | null> {
  try {
    const { data } = await this.http.get<Shipment>('/shipments/:id', { params: { id }, signal });
    return data;
  } catch (error) {
    if (error instanceof HttpResponseError && error.status === 404) return null;
    throw error;
  }
}
```

**Correct (a handled failure degrades and logs one `warn`):**

```typescript
// carrier/shipping-estimate.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { isClientError } from '@nestjs/resilience';
import { CarrierGateway } from './carrier.gateway.js';

const FLAT_RATE = 9.9;

@Injectable()
export class ShippingEstimateService {
  private readonly logger = new Logger(ShippingEstimateService.name);

  constructor(private readonly gateway: CarrierGateway) {}

  /** Degrades to a flat rate when the carrier is unavailable; our own bad request still fails. */
  async estimate(orderId: string): Promise<number> {
    try {
      return await this.gateway.cheapestQuote(orderId);
    } catch (error) {
      if (isClientError(error)) throw error; // a 4xx HttpResponseError: a fallback would hide our bug
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn('Carrier quote unavailable, using flat rate', { orderId }, err);
      return FLAT_RATE;
    }
  }
}
```

With `ConsoleLogger({ json: true })` the fallback logged `{"level":"warn",…,"message":"Carrier quote unavailable, using flat rate","context":"ShippingEstimateService","error":{"name":"HttpResponseError","message":"GET http://127.0.0.1:59844/orders/ord_1/quotes failed with 503 Service Unavailable","stack":"…","method":"GET","status":503,"statusText":"Service Unavailable"},"params":{"orderId":"ord_1"}}` after the policy's two retry warnings: the error goes in as the third argument (`content-errors-as-objects` in `nestjs-logging`), and its record carries `status` but not the upstream body. Read `error.body` to branch on an upstream error code, not to log it: payloads belong at `verbose` at most, and only without secrets or personal data. Failures that reach an HTTP handler become `502`/`504` in `request-exception-filter`; `@Fallback()` on routes and dead letters for calls that still fail are `nestjs-resilience`; log levels are `nestjs-logging`.

Reference: [NestJS HTTP client](https://docs.nestjs.com/application/http-client)

---

## 3. Testing

**Section Impact: HIGH**

### 3.1 Test the Client Provider Against an undici MockAgent Matching Node's Bundled undici

**Impact: HIGH** — Untested paths, encoding and status mapping; client specs that hang on a mismatched undici major

The wrapper's own behaviour (which path and query it sends, how it maps a `404`, what it rethrows) needs the real `HttpClient` with a fake network. The client's `dispatcher` option takes any undici dispatcher, so register the client in the spec with `dispatcher: agent`, an undici `MockAgent`: no port, no server, `disableNetConnect()` turns an unmatched request into `HttpNetworkError: GET https://carrier.test/shipments/nope failed: UND_MOCK_ERR_MOCK_NOT_MATCHED`, and `assertNoPendingInterceptors()` fails a test whose expected request was never sent. Node's global `fetch` is its bundled undici, and the `MockAgent` must come from the same major: on Node 24.22.2 (`node -p process.versions.undici` → `7.30.1`) a `MockAgent` from `undici@8.12.3` never answered matched requests (`Test timed out in 5000ms.`), and one from `undici@7.30.1` worked. Pin the dev dependency to the bundled version, and re-check it when the pinned Node version changes. A stub server (`node:http` on port `0`) works too and is the tool when the test must observe the connection itself, such as an abort closing it; `MockAgent`'s `.delay(ms)` covers timeouts (`HttpTimeoutError: GET https://carrier.test/slow timed out after 50ms`).

**Incorrect (latest undici, default client registration, no net guard):**

```bash
pnpm add -D undici   # 8.x: its MockAgent hangs under Node 24's bundled undici 7 fetch
```

```typescript
const moduleRef = await Test.createTestingModule({
  imports: [HttpClientModule.register({ name: 'carrier', baseUrl: 'https://carrier.test', dispatcher: new MockAgent() })],
  providers: [CarrierClient],
}).compile(); // retries on, an unmatched request goes to the real network
```

**Correct (`src/carrier/carrier.client.spec.ts`):**

```bash
node -p process.versions.undici   # 7.30.1 on Node 24.22.2
pnpm add -D -E undici@7.30.1
```

```typescript
import { HttpClientModule, HttpResponseError } from '@nestjs/http-client';
import { Test } from '@nestjs/testing';
import { MockAgent } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CarrierClient } from './carrier.client.js';

describe('CarrierClient', () => {
  const agent = new MockAgent();
  agent.disableNetConnect(); // an unmatched request fails instead of reaching the network
  const carrierApi = agent.get('https://carrier.test');
  let carrier: CarrierClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.register({ name: 'carrier', baseUrl: 'https://carrier.test', retry: false, dispatcher: agent }),
      ],
      providers: [CarrierClient],
    }).compile();
    carrier = moduleRef.get(CarrierClient);
  });

  afterEach(() => agent.assertNoPendingInterceptors());
  afterAll(() => agent.close());

  it('encodes the order id into the path', async () => {
    carrierApi
      .intercept({ path: '/orders/a%2Fb/quotes', method: 'GET' })
      .reply(200, [{ carrier: 'dhl', price: 4.2 }], { headers: { 'content-type': 'application/json' } });

    await expect(carrier.getQuotes('a/b')).resolves.toEqual([{ carrier: 'dhl', price: 4.2 }]);
  });

  it('maps a 404 to null', async () => {
    carrierApi.intercept({ path: '/shipments/shp_1', method: 'GET' }).reply(404, { error: 'not found' });

    await expect(carrier.findShipment('shp_1')).resolves.toBeNull();
  });

  it('rethrows other statuses with their status', async () => {
    carrierApi.intercept({ path: '/shipments/shp_2', method: 'GET' }).reply(500, 'boom');

    const error = await carrier.findShipment('shp_2').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpResponseError);
    expect(error).toMatchObject({ status: 500 });
  });
});
```

**Correct (e2e: real `CarrierClient`, client token overridden):**

```typescript
const agent = new MockAgent();
agent.disableNetConnect();
const app = await createTestApp((builder) =>
  builder
    .overrideProvider(getHttpClientToken('carrier'))
    .useValue(new HttpClient({ baseUrl: 'https://carrier.test', retry: false, dispatcher: agent })),
);
```

The replacement client is built by hand, so it carries none of the registration's other settings and none of the `forRoot()` interceptors. Without `retry: false` in the spec the client would retry `5xx` answers on its own and consume extra interceptors. Interceptor replies need a `content-type: application/json` header for `responseType: 'auto'` to parse the body; without it `data` is the text. Overriding the `CarrierClient` provider itself is the default for e2e suites (`test-override-client-provider`).

Reference: [undici MockAgent](https://undici.nodejs.org/#/docs/api/MockAgent)

---

### 3.2 In E2E Suites, Override the Client Provider, Not fetch or Internals

**Impact: HIGH** — E2E suites that call real third-party APIs, or that stub so deep they test nothing of the app

The `<System>Client` provider is the outbound boundary, so an e2e suite over the real `AppModule` replaces exactly that provider and keeps everything in the process real: routes, resilience decorators and policies, filters, the database (`e2e-real-app-module` in `nestjs-testing`). Don't patch `globalThis.fetch` (every client and every library in the process share it) and don't replace the services that call the client. The client's registration still runs during `compile()`, so the settings it reads must exist: without `CARRIER_URL` bootstrap fails with `TypeError: Configuration key "CARRIER_URL" does not exist`. Set dummy values in the Vitest `env` (`nestjs-setup`) or before `compile()`; an overridden wrapper never sends a request, so no address has to be reachable.

**Incorrect (global fetch patched; every outbound call in the process is faked):**

```typescript
vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ carrier: 'dhl', price: 4.2 }])));
const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
```

**Correct (`test/shipping.e2e-spec.ts`):**

```typescript
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CarrierClient } from '../src/carrier/carrier.client.js';
import { createTestApp } from './support/test-app.js';

describe('Shipping (e2e)', () => {
  const carrier = { getQuotes: vi.fn(async () => [{ carrier: 'dhl', price: 4.2 }]) };
  let app: NestExpressApplication;

  beforeEach(async () => {
    process.env.CARRIER_URL = 'https://carrier.invalid';
    process.env.CARRIER_API_KEY = 'test-key';
    app = await createTestApp((builder) => builder.overrideProvider(CarrierClient).useValue(carrier));
    return () => app.close();
  });

  it('GET /shipping/quotes returns the carrier quotes', async () => {
    const res = await request(app.getHttpServer()).get('/shipping/quotes?orderId=ord_1').expect(200);

    expect(res.body).toEqual([{ carrier: 'dhl', price: 4.2 }]);
    expect(carrier.getQuotes).toHaveBeenCalledWith('ord_1', expect.any(AbortSignal));
  });
});
```

The suite boots through `createTestApp()` from `nestjs-testing` (`e2e-real-app-module`), which applies `configureApp()` like `main.ts`; the override is the only thing the suite adds. The `AbortSignal` assertion shows the route passes `@Signal()` on (`request-pass-signal`). To run the real `CarrierClient` inside an e2e suite (its paths, its status mapping, the exception filter's `502`), override the HTTP client token instead, with a client on an undici `MockAgent` (`test-mock-agent-dispatcher`). Testing the wrapper's requests and error mapping themselves is that rule's job, not the e2e suite's.

Reference: [NestJS – Testing: End-to-end testing](https://docs.nestjs.com/fundamentals/testing#end-to-end-testing)

---

## References

- https://docs.nestjs.com
- https://github.com/nestjs/nest
- https://typeorm.io
- https://github.com/typestack/class-validator
- https://github.com/goldbergyoni/nodebestpractices

---

*Generated by build-agents.ts on 2026-10-30*
