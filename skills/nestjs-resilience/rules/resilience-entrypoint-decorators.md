---
title: Put Resilience Decorators on Entrypoints Only
impact: CRITICAL
impactDescription: Decorators on providers silently do nothing; retried POSTs duplicate side effects
tags: resilience, decorators, retry, timeout, controllers
---

## Put Resilience Decorators on Entrypoints Only

`@Retry`, `@Timeout`, `@CircuitBreaker`, `@Bulkhead`, `@Fallback` and `@Resilience` are metadata read by one global interceptor, and interceptors run only around controller routes, GraphQL resolvers, microservice handlers and WebSocket gateways. On a provider method they do nothing, and bootstrap only warns: `Resilience decorators on SyncService.push() have no effect: SyncService is not a controller, resolver or gateway.` Code inside services uses a policy object (`resilience-service-policy`). On HTTP, retries run only for `GET`, `HEAD` and `OPTIONS` (on GraphQL, only queries): a preset's retry is skipped on `POST`, and a bare `@Retry()` there is inactive with `@Retry() on ThingsController.create() is inactive: it only re-runs safe operations (GET, HEAD, OPTIONS, GraphQL queries). If the handler is safe to repeat, use @Retry({ idempotent: true }).` State that a POST is safe to run twice with `@Retry({ idempotent: true })`, and only when the dependency deduplicates the call. Inject `@Signal()` and hand it to every I/O call, so a timed-out attempt cancels its request; with `@nestjs/http-client` that is the request's `signal` option (`request-pass-signal` in `nestjs-http-client`).

**Incorrect (decorators on a provider, bare @Retry on a POST, signal dropped):**

```typescript
@Injectable()
export class SyncService {
  @Retry({ attempts: 3 }) // no effect: SyncService is not an entrypoint
  async push(order: Order) {
    return this.carrier.pushOrder(order);
  }
}

@Post(':id/shipments')
@Retry() // inactive on POST, bootstrap WARN
ship(@Param('id') id: string) {
  return this.carrier.createShipment(id); // a timed-out attempt keeps running
}
```

**Correct (preset per route, signal passed on, POST retry declared safe):**

```typescript
// carrier/shipping.controller.ts
import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '@nestjs/idempotency';
import { Resilience, Retry, Signal, Timeout } from '@nestjs/resilience';
import { CarrierClient } from './carrier.client.js';

@Controller('shipping')
export class ShippingController {
  constructor(private readonly carrier: CarrierClient) {}

  @Get('quotes')
  @Resilience('carrier')
  @Timeout('1.5s')
  quotes(@Query('orderId') orderId: string, @Signal() signal: AbortSignal) {
    return this.carrier.getQuotes(orderId, signal);
  }

  @Post('orders/:id/shipments')
  @Idempotent({ required: true })
  @Resilience('carrier')
  @Retry({ idempotent: true }) // the carrier deduplicates shipments by reference
  ship(@Param('id') id: string, @Signal() signal: AbortSignal) {
    return this.carrier.createShipment(id, signal);
  }
}
```

Settings resolve stage by stage: a handler decorator wins for its own stage (`@Timeout('1.5s')` above) and the preset supplies the rest. Timeouts are per attempt and answer `504`; an open breaker answers `503` with `Retry-After`. `@Fallback('method', { handleIf })` names a method on the same class and must never call the dependency it replaces. On message, event and WebSocket handlers only a `@Retry()` on the handler itself turns retries on. `@Retry({ idempotent: true })` re-runs the handler inside one request; deduplicating the client's own retries is `@Idempotent()` (`idempotency-client-keys`).

Reference: [NestJS Resilience – Retry a POST safely](https://docs.nestjs.com/reliability/resilience#retry-a-post-safely)
