---
title: Call Dependencies From Services Through a Policy Object
impact: CRITICAL
impactDescription: Retried non-repeatable calls, multiplied retries and work that outlives its timeout
tags: resilience, policy, retry, abort-signal, services
---

## Call Dependencies From Services Through a Policy Object

Services, jobs and event consumers get resilience from a policy object: `resilience.preset('<dependency>')` returns the preset as one policy whose breaker is the same instance the `@Resilience('<dependency>')` routes use. Create it once, in the constructor. `execute()` hands the function `{ signal, attempt }`; pass `signal` into the I/O call so a timeout aborts the request, and pass `{ source: 'Class.method' }` so events name the caller. A policy object has no HTTP method to inspect, so the preset's retry **always** applies: run only repeat-safe calls (reads, PUTs keyed by id, creates the dependency deduplicates) under a retrying policy, and give other calls a policy without retry. Retry at one layer: either the entrypoint or the service policy, with retries in SDKs and HTTP clients underneath turned off; 3 attempts at each of 3 layers send up to 27 requests to a struggling dependency.

**Incorrect (policy per call, signal ignored, retried non-repeatable call, stacked retries):**

```typescript
@Injectable()
export class CarrierGateway {
  constructor(private readonly resilience: ResilienceService, private readonly carrier: CarrierClient) {}

  buyLabel(orderId: string) {
    // retries a call that bills a new label each time; the SDK below also retries 3x
    return this.resilience.preset('carrier').execute(() => this.carrier.buyLabel(orderId));
  }
}
```

**Correct (created once, signal and source passed, retry only for repeat-safe calls):**

```typescript
import { Injectable } from '@nestjs/common';
import { ResilienceService, type ResiliencePolicy } from '@nestjs/resilience';
import { CarrierClient } from './carrier.client.js';

@Injectable()
export class CarrierGateway {
  private readonly carrierPolicy: ResiliencePolicy;
  private readonly carrierOnce: ResiliencePolicy;

  constructor(
    resilience: ResilienceService,
    private readonly carrier: CarrierClient,
  ) {
    // Created once: both share the preset's breaker with every @Resilience('carrier') route.
    this.carrierPolicy = resilience.preset('carrier');
    this.carrierOnce = resilience.create({ timeout: '2s', circuitBreaker: 'carrier' }, 'carrier-once');
  }

  /** A read: safe to repeat, so it runs under the preset's retry. */
  cheapestQuote(orderId: string): Promise<number> {
    return this.carrierPolicy.execute(
      async ({ signal }) => {
        const quotes = await this.carrier.getQuotes(orderId, signal);
        return Math.min(...quotes.map((quote) => quote.price));
      },
      { source: 'CarrierGateway.cheapestQuote' },
    );
  }

  /** Every call bills a label: timeout and breaker, but a single attempt. */
  buyLabel(orderId: string): Promise<{ labelUrl: string }> {
    return this.carrierOnce.execute(({ signal }) => this.carrier.buyLabel(orderId, signal), {
      source: 'CarrierGateway.buyLabel',
    });
  }
}
```

`create(options, name)` without a `retry` stage makes one attempt (`defaults` never turn a stage on); `circuitBreaker: 'carrier'` reuses the preset's breaker, so an open breaker rejects this call too with `CircuitOpenError` before the carrier is called. A policy used inside an entrypoint's attempt inherits that attempt's signal. What to do when `execute()` finally rejects is `dlq-record-final-failure`.

Reference: [NestJS Resilience – Use the same policies inside services](https://docs.nestjs.com/reliability/resilience#use-the-same-policies-inside-services)
