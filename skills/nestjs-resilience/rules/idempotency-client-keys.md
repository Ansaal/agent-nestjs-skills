---
title: Deduplicate Client Retries With @Idempotent()
impact: HIGH
impactDescription: Double charges and duplicate records when a client retries after a lost response
tags: idempotency, idempotency-key, webhooks, retries
---

## Deduplicate Client Retries With @Idempotent()

A client that loses a response retries, and a check-then-write in the service lets two overlapping requests both pass the check. `@nestjs/idempotency` (0.0.3, ESM-only, peers Nest `^11 || ^12`) runs the handler once per `Idempotency-Key` header: a retry gets the stored first response (status, body, `Idempotent-Replayed: true`) without running the handler, a retry while the first is in flight gets `409 IDEMPOTENCY_KEY_IN_USE` with `Retry-After`, the same key with a different body or URL gets `422 IDEMPOTENCY_KEY_REUSED`, and `required: true` refuses a missing key with `400 IDEMPOTENCY_KEY_REQUIRED`. Completed results replay for `ttl` (default `'24h'`); 5xx outcomes release the key (`storeIf` default `status < 500`). Use it on client-facing mutations, and on webhooks whose duplicates may simply get the first response replayed; when the contract defines its own answer for a duplicate, use `idempotency-processed-events`. Records live in an `InMemoryIdempotencyStore` until you register an `IdempotencyStore`; with `NODE_ENV=production` the app refuses to start without one: `IdempotencyStorage: no IdempotencyStore is registered, and NODE_ENV is "production"`.

**Incorrect (check-then-write race; server retry mistaken for client dedup):**

```typescript
@Post()
@Retry({ idempotent: true }) // re-runs the handler inside one request; does nothing for client retries
async create(@Headers('idempotency-key') key: string, @Body('id') id: string) {
  const existing = await this.orders.findByKey(key); // two concurrent retries both see null
  return existing ?? this.orders.create(id, key);
}
```

**Correct (module registered before `ResilienceModule`, key from the header or the body):**

```bash
pnpm add -E @nestjs/idempotency
```

```typescript
// app.module.ts imports: IdempotencyModule before ResilienceModule (see resilience-module-presets)
IdempotencyModule.forRoot({
  scope: (req: { user?: { id: string } }) => req.user?.id,
}),
```

```typescript
// orders/orders.controller.ts: a client-facing mutation
@Post()
@Idempotent({ required: true })
create(@Body('id') id: string) {
  return this.orders.create(id);
}
```

```typescript
// orders/payment-webhook.controller.ts: a provider webhook keyed by its event id
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Idempotent } from '@nestjs/idempotency';

export interface PaymentEvent {
  id: string;
  type: string;
}

@Controller('webhooks/payments')
export class PaymentWebhookController {
  readonly handled: string[] = [];

  @Post()
  @HttpCode(200)
  @Idempotent({
    required: true,
    scope: false, // the provider's event ids are unique across all callers
    keyFrom: (context) => context.switchToHttp().getRequest<{ body?: Partial<PaymentEvent> }>().body?.id,
  })
  receive(@Body() event: PaymentEvent) {
    this.handled.push(event.id);
    return { received: event.id };
  }
}
```

Import `IdempotencyModule` before `ResilienceModule`: the first global interceptor runs outermost, so a replay or `409` is answered before any retry, breaker or timeout runs, and all retries of one request share one claimed key. `scope` namespaces keys per user so one user's key never replays another's response; `scope: false` is for keys unique across callers, such as a provider's event ids. For production, implement `IdempotencyStore` on your database (the docs' "Store keys in PostgreSQL" section includes a TypeORM store), create its table through migrations, and test it with the contract suite from `@nestjs/idempotency/testing`. Keep the state check in the service too: two taps that send two keys are two attempts.

Reference: [NestJS Idempotency keys](https://docs.nestjs.com/reliability/idempotency#make-the-payment-endpoint-idempotent)
