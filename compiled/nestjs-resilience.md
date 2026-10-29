# NestJS Resilience

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

Resilience for NestJS calls to downstream dependencies with `@nestjs/resilience` and `@nestjs/idempotency`. Use when adding retries, timeouts, circuit breakers or fallbacks, handling calls that still fail after retries, calling a dependency after a database write, or deduplicating client retries and webhook redeliveries.

---

## Table of Contents

1. [Resilience Policies](#1-resilience-policies) — **CRITICAL**
   - 1.1 [Dispatch Downstream Calls After the Transaction Commits](#11-dispatch-downstream-calls-after-the-transaction-commits)
   - 1.2 [Put Resilience Decorators on Entrypoints Only](#12-put-resilience-decorators-on-entrypoints-only)
   - 1.3 [Register ResilienceModule Once, With One Preset per Dependency](#13-register-resiliencemodule-once-with-one-preset-per-dependency)
   - 1.4 [Call Dependencies From Services Through a Policy Object](#14-call-dependencies-from-services-through-a-policy-object)
2. [Dead Letters](#2-dead-letters) — **HIGH**
   - 2.1 [Record Every Call That Exhausts Its Retries as a Dead Letter](#21-record-every-call-that-exhausts-its-retries-as-a-dead-letter)
3. [Idempotency](#3-idempotency) — **HIGH**
   - 3.1 [Deduplicate Client Retries With @Idempotent()](#31-deduplicate-client-retries-with-idempotent-)
   - 3.2 [Record Processed Event Ids in the State-Change Transaction](#32-record-processed-event-ids-in-the-state-change-transaction)

---

## 1. Resilience Policies

**Section Impact: CRITICAL**

### 1.1 Dispatch Downstream Calls After the Transaction Commits

**Impact: HIGH** — Downstream systems see rolled-back state; slow dependencies hold locks and fail requests

A call to another system made inside a database transaction can't be rolled back: if the transaction fails afterwards, the dependency has seen state that never existed. It also holds the transaction (and on SQLite the single writer lock) open for the whole timeout-and-retry budget. Commit first, then dispatch from the committed values. When the API contract says the response doesn't depend on the downstream call, return without awaiting it and let the dispatch handle its own failures; a dispatched promise that rejects is an unhandled rejection, which ends the Node process. When the response must reflect the downstream result, await the call after the commit.

**Incorrect (remote call inside the transaction, response tied to it):**

```typescript
async cancel(orderId: string): Promise<OrderEntity> {
  return this.transactions.run(async (manager) => {
    await manager.update(OrderEntity, { id: orderId }, { status: 'cancelled' });
    const order = await manager.findOneByOrFail(OrderEntity, { id: orderId });
    await this.orderSync.push(order); // carrier sees 'cancelled' even if the commit fails;
    return order;                     // a carrier outage turns the cancel into a 5xx
  });
}
```

**Correct (commit, then dispatch a call that never rejects):**

```typescript
async cancel(orderId: string): Promise<OrderEntity> {
  const order = await this.transactions.run(async (manager) => {
    await manager.update(OrderEntity, { id: orderId }, { status: 'cancelled' });
    return manager.findOneByOrFail(OrderEntity, { id: orderId });
  });
  // Committed: the carrier only sees state that exists. The response doesn't wait for it.
  void this.orderSync.push({ id: order.id, status: order.status });
  return order;
}
```

`orderSync.push()` runs the call under the `carrier` policy and records a dead letter instead of rejecting (`dlq-record-final-failure`). A crash between commit and dispatch still loses the call; when every committed change must reach the dependency, write an outbox row in the same transaction and dispatch from it. `this.transactions` is the transaction runner from `nestjs-typeorm` (`orm-atomic-writes`); asserting on a dispatch the response doesn't wait for (an awaitable `drain()`, `async-drain-side-effects`) is `nestjs-testing`.

Reference: [NestJS Resilience – Use the same policies inside services](https://docs.nestjs.com/reliability/resilience#use-the-same-policies-inside-services)

---

### 1.2 Put Resilience Decorators on Entrypoints Only

**Impact: CRITICAL** — Decorators on providers silently do nothing; retried POSTs duplicate side effects

`@Retry`, `@Timeout`, `@CircuitBreaker`, `@Bulkhead`, `@Fallback` and `@Resilience` are metadata read by one global interceptor, and interceptors run only around controller routes, GraphQL resolvers, microservice handlers and WebSocket gateways. On a provider method they do nothing, and bootstrap only warns: `Resilience decorators on SyncService.push() have no effect: SyncService is not a controller, resolver or gateway.` Code inside services uses a policy object (`resilience-service-policy`). On HTTP, retries run only for `GET`, `HEAD` and `OPTIONS` (on GraphQL, only queries): a preset's retry is skipped on `POST`, and a bare `@Retry()` there is inactive with `@Retry() on ThingsController.create() is inactive: it only re-runs safe operations (GET, HEAD, OPTIONS, GraphQL queries). If the handler is safe to repeat, use @Retry({ idempotent: true }).` State that a POST is safe to run twice with `@Retry({ idempotent: true })`, and only when the dependency deduplicates the call. Inject `@Signal()` and hand it to every I/O call, so a timed-out attempt cancels its request.

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

---

### 1.3 Register ResilienceModule Once, With One Preset per Dependency

**Impact: CRITICAL** — Unpinned 0.x upgrades, split circuit breakers and retried client errors

`@nestjs/resilience` is pre-1.0 (0.0.3 on 2026-10-29), ESM-only (its export map has only `import`), and its peers are `@nestjs/common` and `@nestjs/core` `^12`; an ESM project setup is `nestjs-setup`. Pin it to an exact version and upgrade deliberately, since any 0.x release may change the API. The module is global: import it once, in the root module, and give each downstream dependency one named preset. A preset's circuit breaker is shared under the preset's name by every route, handler and service that uses the preset, so the whole app learns about one dependency's health from one breaker; options repeated per call site give one dependency several breakers. `retry.attempts` counts the first call: `attempts: 3` is one call plus two retries. By default `retryIf` and `recordIf` skip client errors (a 4xx `HttpException`, or any error with a 4xx `status` or `statusCode`; `408`/`429` from a dependency still count as failures), so a downstream client error must carry its status or it is retried and trips the breaker.

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
// carrier/carrier.client.ts
/** `status` makes a 4xx answer a client error: not retried, not counted by the breaker. */
export class CarrierError extends Error {
  constructor(readonly status: number) {
    super(`The carrier answered with status ${status}`);
  }
}
```

`defaults` only fills in fields of stages a preset or decorator turns on; it never turns a stage on. Bootstrap fails on an unknown preset name, an invalid duration or number (the `NaN` of an unset env var), or one breaker name configured two ways; build options from config with `ResilienceModule.forRootAsync()`. Budget time end to end: `attempts × timeout + backoff` must fit inside the caller's own timeout. Every breaker needs a `timeout`, because a hanging call is never counted. Breaker state is per process.

Reference: [NestJS Resilience – Register the module](https://docs.nestjs.com/reliability/resilience#register-the-module)

---

### 1.4 Call Dependencies From Services Through a Policy Object

**Impact: CRITICAL** — Retried non-repeatable calls, multiplied retries and work that outlives its timeout

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

---

## 2. Dead Letters

**Section Impact: HIGH**

### 2.1 Record Every Call That Exhausts Its Retries as a Dead Letter

**Impact: HIGH** — Work silently lost when a dependency stays down

`@nestjs/resilience` has no dead-letter stage: after the last attempt, `execute()` rejects with the last error (or with `CircuitOpenError` when the breaker rejected the call before it ran), and whatever the call carried is gone unless the caller keeps it. Catch the final rejection right after `execute()` and record `{ key, attempts, lastError, failedAt, payload }` in an injectable dead-letter store, with enough payload to replay the call. Bind the store to an abstract class token: in-memory for demos and tests, a migrated table or a queue in production, since in-memory entries die with the process. Retries before the final failure are visible on `ResilienceEvents.events$`: a `retry` event carries `attempt` (the failed one, 1-based), `delayMs` and `error`, plus `policy` and the `source` passed to `execute()`.

**Incorrect (final failure only logged, or swallowed):**

```typescript
try {
  await this.carrierPolicy.execute(({ signal }) => this.carrier.pushOrder(order, signal));
} catch (error) {
  this.logger.error('push failed', error); // nothing to replay; the order never reaches the carrier
}
```

**Correct (store contract, dead letter after `execute()`, retries logged):**

```typescript
// dead-letter/dead-letter.store.ts
import { Injectable } from '@nestjs/common';

export interface DeadLetter {
  /** What failed, e.g. `order-sync:ord_1`: lets an operator find and replay it. */
  key: string;
  attempts: number;
  lastError: string;
  failedAt: Date;
  /** Everything needed to replay the call. */
  payload: unknown;
}

/** Injection token and contract: swap the in-memory store for a table or queue in production. */
export abstract class DeadLetterStore {
  abstract record(entry: DeadLetter): Promise<void>;
  abstract list(): Promise<DeadLetter[]>;
}

@Injectable()
export class InMemoryDeadLetterStore extends DeadLetterStore {
  private readonly entries: DeadLetter[] = [];

  async record(entry: DeadLetter): Promise<void> {
    this.entries.push(entry);
  }

  async list(): Promise<DeadLetter[]> {
    return [...this.entries];
  }
}
// app.module.ts providers: { provide: DeadLetterStore, useClass: InMemoryDeadLetterStore }
```

```typescript
// carrier/order-sync.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ResilienceService, type ResiliencePolicy } from '@nestjs/resilience';
import { DeadLetterStore } from '../dead-letter/dead-letter.store.js';
import { CarrierClient, type OrderSnapshot } from './carrier.client.js';

@Injectable()
export class OrderSyncService {
  private readonly logger = new Logger(OrderSyncService.name);
  private readonly carrierPolicy: ResiliencePolicy;

  constructor(
    resilience: ResilienceService,
    private readonly carrier: CarrierClient,
    private readonly deadLetters: DeadLetterStore,
  ) {
    this.carrierPolicy = resilience.preset('carrier');
  }

  /** Never rejects: a call that still fails after the preset's retries becomes a dead letter. */
  async push(order: OrderSnapshot): Promise<boolean> {
    let attempts = 0;
    try {
      await this.carrierPolicy.execute(
        ({ signal, attempt }) => {
          attempts = attempt;
          return this.carrier.pushOrder(order, signal);
        },
        { source: 'OrderSyncService.push' },
      );
      return true;
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      await this.deadLetters.record({
        key: `order-sync:${order.id}`,
        attempts, // 0 when an open breaker rejected the call before it ran
        lastError,
        failedAt: new Date(),
        payload: order,
      });
      this.logger.error(`Order ${order.id} dead-lettered after ${attempts} attempt(s): ${lastError}`);
      return false;
    }
  }
}
```

```typescript
// resilience.logger.ts (registered in AppModule providers)
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ResilienceEvents } from '@nestjs/resilience';

@Injectable()
export class ResilienceLogger implements OnModuleInit {
  private readonly logger = new Logger('Resilience');

  constructor(private readonly resilienceEvents: ResilienceEvents) {}

  onModuleInit() {
    this.resilienceEvents.events$.subscribe((event) => {
      switch (event.type) {
        case 'retry':
          this.logger.warn(
            `${event.source} attempt ${event.attempt} failed, retrying in ${event.delayMs} ms: ${String(event.error)}`,
          );
          break;
        case 'circuit-open':
        case 'circuit-half-open':
        case 'circuit-closed':
          this.logger.warn(`Circuit "${event.policy}" went from ${event.from} to ${event.to}`);
          break;
      }
    });
  }
}
```

The error has no attempt count, so the function passed to `execute()` keeps the last `attempt` it saw. Because `push()` never rejects, it is safe to dispatch without awaiting (`resilience-dispatch-after-commit`). A persistent store is a table created by a migration (`nestjs-typeorm`); replay re-runs the same call with the stored `payload`, so it has the same repeat-safety requirement as the retry.

Reference: [NestJS Resilience – Observe breaker transitions](https://docs.nestjs.com/reliability/resilience#observe-breaker-transitions)

---

## 3. Idempotency

**Section Impact: HIGH**

### 3.1 Deduplicate Client Retries With @Idempotent()

**Impact: HIGH** — Double charges and duplicate records when a client retries after a lost response

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

---

### 3.2 Record Processed Event Ids in the State-Change Transaction

**Impact: HIGH** — Redelivered events applied twice, or duplicates answered differently than the contract says

When the contract defines its own response for a duplicate (for example `{ "status": "duplicate" }` instead of the first response), `@Idempotent()` is the wrong tool: it replays the stored first response. Keep a processed-events table whose primary key is the event id, and insert the row in the **same transaction** as the state change. The first delivery commits both; a redelivery fails the insert with a unique violation, which rolls back its state change and maps to the duplicate response. Concurrent redeliveries resolve the same way, because the database, not a prior read, decides. A failed state change rolls back the event row too, so the next delivery is processed again. Transaction serialization (`orm-atomic-writes`) and unique-violation detection (`orm-unique-violation`, `isUniqueViolation()`) are `nestjs-typeorm`.

**Incorrect (read-then-write, marker written separately):**

```typescript
async applyStatusEvent(event: OrderStatusEvent) {
  if (await this.processed.existsBy({ eventId: event.eventId })) return { status: 'duplicate' };
  await this.orders.update({ id: event.orderId }, { status: event.status }); // concurrent deliveries both get here
  await this.processed.insert({ eventId: event.eventId }); // a crash before this line re-applies the event
  return { status: 'processed' };
}
```

**Correct (event row and state change commit together; the unique violation is the duplicate):**

```typescript
// orders/processed-event.entity.ts
import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** One row per handled event: the primary key turns a redelivery into a unique violation. */
@Entity('processed_events')
export class ProcessedEventEntity {
  @PrimaryColumn('varchar') eventId: string;
  @CreateDateColumn() processedAt: Date;
}
```

```typescript
// orders/orders.service.ts
async applyStatusEvent(event: OrderStatusEvent): Promise<{ status: 'processed' | 'duplicate' }> {
  let order: OrderEntity;
  try {
    order = await this.transactions.run(async (manager) => {
      await manager.insert(ProcessedEventEntity, { eventId: event.eventId });
      await manager.update(OrderEntity, { id: event.orderId }, { status: event.status });
      return manager.findOneByOrFail(OrderEntity, { id: event.orderId });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: 'duplicate' };
    throw error;
  }
  // Committed. The contract answers without waiting for the carrier; push() records its own failures.
  void this.orderSync.push({ id: order.id, status: order.status });
  return { status: 'processed' };
}
```

The table comes from a migration like every other table (`nestjs-typeorm`). The downstream call runs after commit and only for the first delivery (`resilience-dispatch-after-commit`).

Reference: [NestJS Idempotency keys – what a retry gets](https://docs.nestjs.com/reliability/idempotency#make-the-payment-endpoint-idempotent)

---

## References

- https://docs.nestjs.com
- https://github.com/nestjs/nest
- https://typeorm.io
- https://github.com/typestack/class-validator
- https://github.com/goldbergyoni/nodebestpractices

---

*Generated by build-agents.ts on 2026-10-29*
