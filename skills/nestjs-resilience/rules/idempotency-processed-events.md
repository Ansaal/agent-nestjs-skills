---
title: Record Processed Event Ids in the State-Change Transaction
impact: HIGH
impactDescription: Redelivered events applied twice, or duplicates answered differently than the contract says
tags: idempotency, webhooks, events, transactions, unique-constraint
---

## Record Processed Event Ids in the State-Change Transaction

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
