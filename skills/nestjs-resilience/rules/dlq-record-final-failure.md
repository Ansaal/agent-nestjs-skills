---
title: Record Every Call That Exhausts Its Retries as a Dead Letter
impact: HIGH
impactDescription: Work silently lost when a dependency stays down
tags: dlq, dead-letter, retry, observability, events
---

## Record Every Call That Exhausts Its Retries as a Dead Letter

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
import { type BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ResilienceService, type ResiliencePolicy } from '@nestjs/resilience';
import { DeadLetterStore } from '../dead-letter/dead-letter.store.js';
import { CarrierClient, type OrderSnapshot } from './carrier.client.js';

@Injectable()
export class OrderSyncService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(OrderSyncService.name);
  private readonly carrierPolicy: ResiliencePolicy;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    resilience: ResilienceService,
    private readonly carrier: CarrierClient,
    private readonly deadLetters: DeadLetterStore,
  ) {
    this.carrierPolicy = resilience.preset('carrier');
  }

  /** Fire-and-forget entry point: never rejects, so an unawaited call cannot end the process. */
  dispatch(order: OrderSnapshot): void {
    const job = this.push(order)
      .catch((error: unknown) => {
        // Only reached when the dead-letter store itself failed: the call is lost, say so once.
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error('Order sync lost, dead letter not recorded', { orderId: order.id }, err);
      })
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  /** Resolves once every dispatched call has settled, including calls dispatched while draining (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** `app.close()` waits here, before any dependency shuts down. */
  beforeApplicationShutdown(): Promise<void> {
    return this.drain();
  }

  /**
   * `false` once a call that still fails after the preset's retries is recorded as a dead letter.
   * Rejects only when the dead-letter store fails; callers that don't await use `dispatch()`.
   */
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
      const err = error instanceof Error ? error : new Error(String(error));
      const key = `order-sync:${order.id}`;
      await this.deadLetters.record({
        key,
        attempts, // 0 when an open breaker rejected the call before it ran
        lastError: err.message,
        failedAt: new Date(),
        payload: order,
      });
      this.logger.log('Dead letter recorded', { key, attempts }, err);
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
        case 'retry': {
          const err = event.error instanceof Error ? event.error : new Error(String(event.error));
          this.logger.warn('Retrying call', { source: event.source, attempt: event.attempt, delayMs: event.delayMs }, err);
          break;
        }
        case 'circuit-open':
        case 'circuit-half-open':
        case 'circuit-closed':
          this.logger.warn('Circuit state changed', { policy: event.policy, from: event.from, to: event.to });
          break;
      }
    });
  }
}
```

The error has no attempt count, so the function passed to `execute()` keeps the last `attempt` it saw. Against a carrier answering `503`, with its `@nestjs/http-client` client registered `retry: false` (`nestjs-http-client`), `dispatch()` sent 3 `PUT`s, logged two `Retrying call` warnings and then `{"level":"log",…,"message":"Dead letter recorded","context":"OrderSyncService","error":{"name":"HttpResponseError","message":"PUT http://127.0.0.1:59914/orders/ord_1 failed with 503 Service Unavailable","stack":"…","method":"PUT","status":503,"statusText":"Service Unavailable"},"params":{"key":"order-sync:ord_1","attempts":3}}`. The error goes in as the third argument, never as a field (`content-errors-as-objects` in `nestjs-logging`). The client's error messages mask query values and leave out the response body, so `lastError` is safe to store. A retry is `warn` (degraded, handled), the dead letter `log` (an event an operator acts on, small), the lost call `error` (nobody will retry it); levels are `nestjs-logging`.

The dead-letter store is one more dependency and can fail too: then `record()` rejects inside the `catch`, and `push()` rejects with the store's error. Awaiting callers see it; an unawaited `void this.orderSync.push(order)` turns it into an unhandled rejection, which ends the process. `dispatch()` is the one fire-and-forget entry point: the terminal `.catch` comes before `.finally`, so the job always settles and leaves `pending`. With a store whose `record()` threw `dead-letter table locked`, `dispatch()` then `drain()` resolved after 3 attempts, an `unhandledRejection` listener recorded nothing, and the log had `error` `Order sync lost, dead letter not recorded` with `params: { orderId: 'ord_2' }` and the store's error attached. With a 300 ms carrier call in flight, `app.close()` took 302 ms and the call completed; without `beforeApplicationShutdown` it returned after 1 ms with the call unfinished. Tests await the same `drain()` after a `202` (`async-drain-side-effects` in `nestjs-testing`). A persistent store is a table created by a migration and written through `TransactionRunner.run()` (`nestjs-typeorm`); when losing the call is not acceptable, write an outbox row in the business transaction instead (`resilience-dispatch-after-commit`). Replay re-runs the same call with the stored `payload`, so it has the same repeat-safety requirement as the retry.

Reference: [NestJS Resilience – Observe breaker transitions](https://docs.nestjs.com/reliability/resilience#observe-breaker-transitions)
