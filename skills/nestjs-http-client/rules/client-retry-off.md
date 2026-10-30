---
title: Register Every Client With retry false; Resilience Policies Own Retries
impact: CRITICAL
impactDescription: Attempts multiply under a resilience policy (3 × 3 = 9 requests per call) against a dependency that is already failing
tags: http-client, retry, resilience, configuration
---

## Register Every Client With retry false; Resilience Policies Own Retries

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
