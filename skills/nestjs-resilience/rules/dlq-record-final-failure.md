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
