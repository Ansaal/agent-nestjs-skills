---
title: Use Message and Event Patterns Correctly
impact: MEDIUM
impactDescription: Proper patterns ensure reliable microservice communication
tags: microservices, message-pattern, event-pattern, communication
---

## Use Message and Event Patterns Correctly

`@nestjs/microservices` has two patterns. `send()` + `@MessagePattern` is request-response: use it when the caller needs the answer to continue, and bound the wait with `timeout()`. `emit()` + `@EventPattern` is fire-and-forget: the handler's return value is discarded and the sender never learns whether it ran. An `emit()` after a commit is best-effort: a crash between the commit and the emit, or a broker that is down, loses the event. That is acceptable for analytics or cache warming; for anything that must happen (a welcome mail, a stock reservation, a downstream sync) write an outbox row in the same transaction and dispatch from it with the retry and dead-letter policy of `nestjs-resilience` (`resilience-dispatch-after-commit`, `dlq-record-final-failure`). Consumers of either kind must tolerate duplicates (`idempotency-processed-events`).

**Incorrect (wrong pattern; unbounded wait; compensating delete after a remote call):**

```typescript
@MessagePattern('user.created') // the sender waits for a mail to be sent
async handleUserCreated(data: UserCreatedEvent) {
  await this.emailService.sendWelcome(data.email);
}

@EventPattern('inventory.check')
async checkInventory(data: CheckInventoryDto) {
  return this.inventory.check(data); // discarded: events have no reply
}

async createOrder(dto: CreateOrderDto): Promise<Order> {
  const order = await this.repo.save(dto);
  const reserved = await firstValueFrom(this.inventory.send({ cmd: 'reserve' }, { orderId: order.id })); // no timeout
  if (!reserved.success) await this.repo.delete(order.id);
  // a lost reply after a successful reservation leaves stock reserved for a deleted order;
  // a crash between the steps leaves an order nobody reserved stock for
  return order;
}
```

**Correct (request-response: `inventory/inventory.controller.ts` and the caller):**

```typescript
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import type { CheckStock, StockLevel } from './contracts.js';

/** Inventory service side: answers a query; the reply goes back to the caller. */
@Controller()
export class InventoryController {
  private readonly stock = new Map([['p1', 5]]);

  @MessagePattern({ cmd: 'check_stock' })
  checkStock(@Payload() query: CheckStock): StockLevel {
    const onHand = this.stock.get(query.productId);
    if (onHand === undefined) throw new RpcException({ status: 404, message: 'Unknown product' });
    return { productId: query.productId, available: onHand >= query.quantity };
  }
}
```

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { INVENTORY_CLIENT, type CheckStock, type StockLevel } from './contracts.js';

/** Caller side of a request-response pattern: always bound the wait. */
@Injectable()
export class StockClient {
  constructor(@Inject(INVENTORY_CLIENT) private readonly inventory: ClientProxy) {}

  check(query: CheckStock): Promise<StockLevel> {
    return firstValueFrom(
      this.inventory.send<StockLevel, CheckStock>({ cmd: 'check_stock' }, query).pipe(timeout(2000)),
    );
  }
}
```

**Correct (best-effort event after commit, failure observed):**

```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { TransactionRunner } from '../database/transaction-runner.js';
import { EVENTS_CLIENT, type UserCreated } from './contracts.js';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) email: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly transactions: TransactionRunner,
    @Inject(EVENTS_CLIENT) private readonly events: ClientProxy,
  ) {}

  async create(email: string): Promise<User> {
    const user = await this.transactions.run((manager) => manager.save(User, { email }));
    // Best effort, after commit: lost on a crash before this line or when the broker is down
    const event: UserCreated = { userId: user.id, occurredAt: new Date().toISOString() };
    this.events.emit<void, UserCreated>('user.created', event).subscribe({
      error: (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn('Event not published', { pattern: 'user.created', userId: user.id }, err);
      },
    });
    return user;
  }
}
```

```typescript
import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import type { UserCreated } from './contracts.js';
import { WelcomeMailer } from './welcome-mailer.js';

/** Consumer side of an event: no reply; the sender never learns about failures here. */
@Controller()
export class NotificationsController {
  constructor(private readonly mailer: WelcomeMailer) {}

  @EventPattern('user.created')
  async onUserCreated(@Payload() event: UserCreated): Promise<void> {
    await this.mailer.send(event.userId); // idempotent per userId: events can arrive twice
  }
}
```

Probe results (TCP transport, `@nestjs/microservices` 12.3.2): `check({ productId: 'p1', quantity: 3 })` resolved `{"productId":"p1","available":true}`; an unknown product rejected the caller with `{"status":404,"message":"Unknown product"}` from the `RpcException`; `create()` committed the user and the `user.created` handler received its id. With the events client pointed at a closed port, `create()` still returned the committed user and logged `warn('Event not published', { pattern: 'user.created', userId }, AggregateError('connect ECONNREFUSED ::1:31499'))`. The `subscribe({ error })` is what makes that failure visible; it does not retry or keep the event.

An order that needs a remote reservation is a workflow, not one request: commit the order as `pending` with an outbox row, dispatch `reserve` after commit with the order id as the idempotency key, and move the order to `confirmed` or `rejected` when the reply or event arrives. Retries, dead letters and the processed-events table are `nestjs-resilience`; writes go through `TransactionRunner` (`nestjs-typeorm` rule `orm-atomic-writes`).

Reference: [NestJS Microservices](https://docs.nestjs.com/microservices/basics)
