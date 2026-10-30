---
title: Use Events for Decoupling, Not for Required Work
impact: MEDIUM-HIGH
impactDescription: Decouples modules; a best-effort emit used for required work loses it silently
tags: architecture, events, decoupling, event-emitter
---

## Use Events for Decoupling, Not for Required Work

`@nestjs/event-emitter` lets modules react to a change without the emitter knowing them. Decide per reaction whether it is best effort or required, because the defaults are built for best effort: `emit()` returns before async listeners finish, and `@OnEvent` listeners default to `suppressErrors: true`, so a listener that rejects is caught and logged by the emitter (`error`, context `Event`) and neither `emit()` nor `emitAsync()` sees the failure. In the probe, `emitAsync()` on a rejecting default listener resolved; with `{ suppressErrors: false }` it rejected with the listener's error.

- **Best effort** (analytics, cache warm-up): `emit()` after the commit; each listener catches and logs its own failure.
- **Required, in-process** (reserve stock in the same database): `await emitAsync()` inside the transaction, with **exactly one** required listener per event, `@OnEvent(…, { suppressErrors: false })`. A rejecting listener rejects `emitAsync()` and rolls the whole transaction back. The listener's writes go through `TransactionRunner.run()`, which joins the open transaction (re-entrant, `nestjs-typeorm` rule `orm-atomic-writes`). `emitAsync()` runs listeners concurrently (`Promise.all`), so with two, one can reject and roll back while the other is still running; that one's write then lands outside the transaction. When several required steps must succeed together, don't use an event: the service calls them one after another inside its `run()`.
- **Required, another system** (email provider, payment, broker): not an in-process event. Write an outbox row in the same transaction and dispatch it after the commit with retries and dead letters, per `nestjs-resilience` (`resilience-dispatch-after-commit`, `dlq-record-final-failure`).

**Incorrect (direct coupling; or required work behind a fire-and-forget emit):**

```typescript
async createOrder(dto: CreateOrderDto): Promise<Order> {
  const order = await this.repo.save(dto);
  await this.inventoryService.reserve(order.items); // OrdersService knows every consumer
  await this.emailService.sendConfirmation(order);
  await this.analyticsService.track('order_created', order);
  return order;
}

// …or "decoupled": a failed reservation is logged by the emitter and the order still returns 201
this.eventEmitter.emit('order.created', new OrderCreatedEvent(order.id, order.items));
```

**Correct (required listener inside the transaction, best-effort listeners after the commit):**

```typescript
// orders/orders.service.ts
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TransactionRunner } from '../database/transaction-runner.js';
import { OrderPlacedEvent } from './order-placed.event.js';
import { Order } from './order.entity.js';
import type { PlaceOrderDto } from './orders.dto.js';

@Injectable()
export class OrdersService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly events: EventEmitter2,
  ) {}

  async place(userId: string, dto: PlaceOrderDto): Promise<Order> {
    const order = await this.transactions.run(async (manager) => {
      const order = await manager.save(Order, { userId, ...dto });
      // Required: its one listener runs inside this transaction; a rejection rolls the order back
      await this.events.emitAsync('order.placing', toEvent(order));
      return order;
    });
    // Best effort, after the commit: emit() returns at once, each listener owns its failures
    this.events.emit('order.placed', toEvent(order));
    return order;
  }
}

const toEvent = (order: Order) => new OrderPlacedEvent(order.id, order.userId, order.sku, order.quantity, order.total);
```

```typescript
// inventory/inventory.listener.ts (required)
@Injectable()
export class InventoryListener {
  constructor(private readonly inventory: InventoryService) {}

  @OnEvent('order.placing', { suppressErrors: false })
  async reserve(event: OrderPlacedEvent): Promise<void> {
    await this.inventory.reserve(event.sku, event.quantity); // throws ConflictException when out of stock
  }
}

// analytics/analytics.listener.ts (best effort)
@Injectable()
export class AnalyticsListener {
  private readonly logger = new Logger(AnalyticsListener.name);

  constructor(private readonly analytics: AnalyticsService) {}

  @OnEvent('order.placed')
  async track(event: OrderPlacedEvent): Promise<void> {
    try {
      await this.analytics.track('order_placed', { orderId: event.orderId, total: event.total });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn('Order analytics dropped', { orderId: event.orderId }, err);
    }
  }
}
```

`EventEmitterModule.forRoot()` is imported once in `AppModule`. In the probe, with stock 3, a first order for 2 returned 201 and left 1 in stock; a second order for 2 returned `409 {"message":"Out of stock",…}` and the order count stayed at 1 (rolled back); with analytics rejecting, the order still returned 201 and logged `warn` `Order analytics dropped` with the error. With a second required listener on `order.placing` that rejected (`Credit limit reached`) while the inventory listener was still awaiting, `place()` rejected with 0 orders and stock 3, and 100 ms later stock was 1: the reservation had run after the rollback as its own transaction and committed. Keep required listeners to local database work: a remote call inside the transaction holds SQLite's single writer lock for its whole timeout and cannot be rolled back.

Reference: [NestJS Events](https://docs.nestjs.com/techniques/events)
