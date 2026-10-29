---
title: Dispatch Downstream Calls After the Transaction Commits
impact: HIGH
impactDescription: Downstream systems see rolled-back state; slow dependencies hold locks and fail requests
tags: resilience, transactions, side-effects, async
---

## Dispatch Downstream Calls After the Transaction Commits

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
