---
title: Register ResilienceModule Once, With One Preset per Dependency
impact: CRITICAL
impactDescription: Unpinned 0.x upgrades, split circuit breakers and retried client errors
tags: resilience, retry, circuit-breaker, configuration
---

## Register ResilienceModule Once, With One Preset per Dependency

`@nestjs/resilience` is pre-1.0 (0.0.3 on 2026-10-29), ESM-only (its export map has only `import`), and its peers are `@nestjs/common` and `@nestjs/core` `^12`; an ESM project setup is `nestjs-setup`. Pin it to an exact version and upgrade deliberately, since any 0.x release may change the API. The module is global: import it once, in the root module, and give each downstream dependency one named preset. A preset's circuit breaker is shared under the preset's name by every route, handler and service that uses the preset, so the whole app learns about one dependency's health from one breaker; options repeated per call site give one dependency several breakers. `retry.attempts` counts the first call: `attempts: 3` is one call plus two retries. By default `retryIf` and `recordIf` skip client errors (a 4xx `HttpException`, or any error with a 4xx `status` or `statusCode`; `408`/`429` from a dependency still count as failures), so a downstream client error must carry its status or it is retried and trips the breaker. `@nestjs/http-client` throws `HttpResponseError` with `status` for every non-2xx answer: a `422` from the carrier made 1 request under the 3-attempt preset below, where a `503` made 3. The transport itself is `nestjs-http-client`.

**Incorrect (unpinned, options per call site, status lost):**

```typescript
// package.json: "@nestjs/resilience": "latest"

// orders.service.ts and billing.service.ts each build their own policy for the same carrier:
this.policy = resilience.create({ retry: { attempts: 3 }, circuitBreaker: { minimumCalls: 5 } }); // "3 retries"

// carrier.client.ts: a 422 for a malformed request is retried 2x and counted by the breaker
if (!response.ok) throw new Error(`Carrier failed with ${response.status}`);
```

**Correct (exact pin, one preset per dependency, errors carry `status`):**

```bash
pnpm add -E @nestjs/resilience
```

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { IdempotencyModule } from '@nestjs/idempotency';
import { ResilienceModule } from '@nestjs/resilience';
// …

@Module({
  imports: [
    // …
    // Before ResilienceModule: the first global interceptor runs outermost, so all retries share one key.
    IdempotencyModule.forRoot({
      scope: (req: { user?: { id: string } }) => req.user?.id,
    }),
    ResilienceModule.forRoot({
      defaults: {
        timeout: '5s',
        retry: { attempts: 3, backoff: { delay: '200ms', maxDelay: '2s' } },
      },
      presets: {
        // One preset per downstream dependency: its breaker is shared by every caller of the preset.
        carrier: {
          timeout: '2s',
          retry: { attempts: 3 }, // 3 calls in total: the first one plus 2 retries
          circuitBreaker: { failureRateThreshold: 50, minimumCalls: 10, openDuration: '30s' },
        },
      },
    }),
  ],
  // …
})
export class AppModule {}
```

```typescript
// carrier/carrier.module.ts imports: the carrier's client (nestjs-http-client)
HttpClientModule.registerAsync({
  name: 'carrier',
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    baseUrl: config.getOrThrow<string>('CARRIER_URL'),
    headers: { 'x-api-key': config.getOrThrow<string>('CARRIER_API_KEY') },
    timeout: '2s', // per attempt
    retry: false, // the preset retries; the client's own retry would multiply it
  }),
}),
// A non-2xx answer rejects with HttpResponseError: its `status` keeps a 4xx out of retries and the breaker.
```

`defaults` only fills in fields of stages a preset or decorator turns on; it never turns a stage on. Bootstrap fails on an unknown preset name, an invalid duration or number (the `NaN` of an unset env var), or one breaker name configured two ways; build options from config with `ResilienceModule.forRootAsync()`. Budget time end to end: `attempts × timeout + backoff` must fit inside the caller's own timeout. Every breaker needs a `timeout`, because a hanging call is never counted. Breaker state is per process.

Reference: [NestJS Resilience – Register the module](https://docs.nestjs.com/reliability/resilience#register-the-module)
