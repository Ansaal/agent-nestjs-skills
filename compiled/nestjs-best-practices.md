# NestJS Best Practices

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

General NestJS architecture, dependency injection, error handling, security (authentication, authorization, input validation, rate limiting), API design (serialization, versioning, pipes, interceptors), performance and microservice patterns. Use when designing modules and providers, securing endpoints, shaping API contracts, or reviewing NestJS code for those concerns. For persistence, tests, toolchain, outbound HTTP, retries and idempotency, scheduled jobs, locks or logging, load the owning skill listed under Related Skills instead.

---

## Table of Contents

1. [Architecture](#1-architecture) — **CRITICAL**
   - 1.1 [Avoid Circular Dependencies](#11-avoid-circular-dependencies)
   - 1.2 [Organize by Feature Modules](#12-organize-by-feature-modules)
   - 1.3 [Use Proper Module Sharing Patterns](#13-use-proper-module-sharing-patterns)
   - 1.4 [Single Responsibility for Services](#14-single-responsibility-for-services)
   - 1.5 [Use Events for Decoupling, Not for Required Work](#15-use-events-for-decoupling-not-for-required-work)
   - 1.6 [Use Repository Pattern for Data Access](#16-use-repository-pattern-for-data-access)
2. [Dependency Injection](#2-dependency-injection) — **CRITICAL**
   - 2.1 [Avoid Service Locator Anti-Pattern](#21-avoid-service-locator-anti-pattern)
   - 2.2 [Apply Interface Segregation Principle](#22-apply-interface-segregation-principle)
   - 2.3 [Honor Liskov Substitution Principle](#23-honor-liskov-substitution-principle)
   - 2.4 [Prefer Constructor Injection](#24-prefer-constructor-injection)
   - 2.5 [Understand Provider Scopes](#25-understand-provider-scopes)
   - 2.6 [Use Injection Tokens for Interfaces](#26-use-injection-tokens-for-interfaces)
3. [Error Handling](#3-error-handling) — **HIGH**
   - 3.1 [Handle Async Errors Properly](#31-handle-async-errors-properly)
   - 3.2 [Throw HTTP Exceptions from Services](#32-throw-http-exceptions-from-services)
   - 3.3 [Use Exception Filters for Error Handling](#33-use-exception-filters-for-error-handling)
4. [Security](#4-security) — **HIGH**
   - 4.1 [Issue and Verify Short-Lived JWT Access Tokens](#41-issue-and-verify-short-lived-jwt-access-tokens)
   - 4.2 [Implement Rate Limiting](#42-implement-rate-limiting)
   - 4.3 [Sanitize Output to Prevent XSS](#43-sanitize-output-to-prevent-xss)
   - 4.4 [Use Guards for Authentication and Authorization](#44-use-guards-for-authentication-and-authorization)
   - 4.5 [Validate All Input with DTOs and Pipes](#45-validate-all-input-with-dtos-and-pipes)
5. [Performance](#5-performance) — **HIGH**
   - 5.1 [Use Async Lifecycle Hooks Correctly](#51-use-async-lifecycle-hooks-correctly)
   - 5.2 [Use Lazy Loading for Large Modules](#52-use-lazy-loading-for-large-modules)
   - 5.3 [Optimize Database Queries](#53-optimize-database-queries)
   - 5.4 [Use Caching Strategically](#54-use-caching-strategically)
6. [Database & ORM](#6-database-orm) — **MEDIUM-HIGH**
   - 6.1 [Avoid N+1 Query Problems](#61-avoid-n-1-query-problems)
7. [API Design](#7-api-design) — **MEDIUM**
   - 7.1 [Use DTOs and Serialization for API Responses](#71-use-dtos-and-serialization-for-api-responses)
   - 7.2 [Use Interceptors for Cross-Cutting Concerns](#72-use-interceptors-for-cross-cutting-concerns)
   - 7.3 [Use Pipes for Input Transformation](#73-use-pipes-for-input-transformation)
   - 7.4 [Use API Versioning for Breaking Changes](#74-use-api-versioning-for-breaking-changes)
8. [Microservices](#8-microservices) — **MEDIUM**
   - 8.1 [Implement Health Checks for Microservices](#81-implement-health-checks-for-microservices)
   - 8.2 [Use Message and Event Patterns Correctly](#82-use-message-and-event-patterns-correctly)
   - 8.3 [Use Message Queues for Background Jobs](#83-use-message-queues-for-background-jobs)
9. [DevOps & Deployment](#9-devops-deployment) — **LOW-MEDIUM**
   - 9.1 [Implement Graceful Shutdown](#91-implement-graceful-shutdown)
   - 9.2 [Use ConfigModule for Environment Configuration](#92-use-configmodule-for-environment-configuration)

---

## 1. Architecture

**Section Impact: CRITICAL**

### 1.1 Avoid Circular Dependencies

**Impact: CRITICAL** — "#1 cause of runtime crashes"

Circular dependencies occur when Module A imports Module B, and Module B imports Module A (directly or transitively). NestJS can sometimes resolve these through forward references, but they indicate architectural problems and should be avoided. This is the #1 cause of runtime crashes in NestJS applications.

**Incorrect (circular module imports):**

```typescript
// users.module.ts
@Module({
  imports: [OrdersModule], // Orders needs Users, Users needs Orders = circular
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

// orders.module.ts
@Module({
  imports: [UsersModule], // Circular dependency!
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
```

**Correct (extract shared logic or use events):**

```typescript
// Option 1: Extract shared logic to a third module
// shared.module.ts
@Module({
  providers: [SharedService],
  exports: [SharedService],
})
export class SharedModule {}

// users.module.ts
@Module({
  imports: [SharedModule],
  providers: [UsersService],
})
export class UsersModule {}

// orders.module.ts
@Module({
  imports: [SharedModule],
  providers: [OrdersService],
})
export class OrdersModule {}

// Option 2: Use events for decoupled communication (best-effort reactions only; see arch-use-events)
// users.service.ts
@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepo: UsersRepository, // writes through TransactionRunner (nestjs-typeorm)
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createUser(dto: CreateUserDto): Promise<User> {
    const user = await this.usersRepo.insert(dto);
    this.eventEmitter.emit('user.created', new UserCreatedEvent(user.id));
    return user;
  }
}

// orders.service.ts
@Injectable()
export class OrdersService {
  @OnEvent('user.created')
  async handleUserCreated(event: UserCreatedEvent): Promise<void> {
    // React to user creation without importing UsersModule
  }
}
```

Reference: [NestJS Circular Dependency](https://docs.nestjs.com/fundamentals/circular-dependency)

---

### 1.2 Organize by Feature Modules

**Impact: CRITICAL** — "3-5x faster onboarding and development"

Organize your application into feature modules that encapsulate related functionality. Each feature module should be self-contained with its own controllers, services, entities, and DTOs. Avoid organizing by technical layer (all controllers together, all services together). This enables 3-5x faster onboarding and feature development.

**Incorrect (technical layer organization):**

```typescript
// Technical layer organization (anti-pattern)
src/
├── controllers/
│   ├── users.controller.ts
│   ├── orders.controller.ts
│   └── products.controller.ts
├── services/
│   ├── users.service.ts
│   ├── orders.service.ts
│   └── products.service.ts
├── entities/
│   ├── user.entity.ts
│   ├── order.entity.ts
│   └── product.entity.ts
└── app.module.ts  // Imports everything directly
```

**Correct (feature module organization):**

```typescript
// Feature module organization
src/
├── users/
│   ├── dto/
│   │   ├── create-user.dto.ts
│   │   └── update-user.dto.ts
│   ├── entities/
│   │   └── user.entity.ts
│   ├── users.controller.ts
│   ├── users.service.ts
│   ├── users.repository.ts
│   └── users.module.ts
├── orders/
│   ├── dto/
│   ├── entities/
│   ├── orders.controller.ts
│   ├── orders.service.ts
│   └── orders.module.ts
├── shared/
│   ├── guards/
│   ├── interceptors/
│   ├── filters/
│   └── shared.module.ts
└── app.module.ts

// users.module.ts
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService], // Only export what others need
})
export class UsersModule {}

// app.module.ts
@Module({
  imports: [
    ConfigModule.forRoot(),
    TypeOrmModule.forRoot(),
    UsersModule,
    OrdersModule,
    SharedModule,
  ],
})
export class AppModule {}
```

Reference: [NestJS Modules](https://docs.nestjs.com/modules)

---

### 1.3 Use Proper Module Sharing Patterns

**Impact: CRITICAL** — Prevents duplicate instances, memory leaks, and state inconsistency

NestJS modules are singletons by default. When a service is properly exported from a module and that module is imported elsewhere, the same instance is shared. However, providing a service in multiple modules creates separate instances, leading to memory waste, state inconsistency, and confusing behavior. Always encapsulate services in dedicated modules, export them explicitly, and import the module where needed.

**Incorrect (service provided in multiple modules):**

```typescript
// StorageService provided directly in multiple modules - WRONG
// storage.service.ts
@Injectable()
export class StorageService {
  private cache = new Map(); // Each instance has separate state!

  store(key: string, value: any) {
    this.cache.set(key, value);
  }
}

// app.module.ts
@Module({
  providers: [StorageService], // Instance #1
  controllers: [AppController],
})
export class AppModule {}

// videos.module.ts
@Module({
  providers: [StorageService], // Instance #2 - different from AppModule!
  controllers: [VideosController],
})
export class VideosModule {}

// Problems:
// 1. Two separate StorageService instances exist
// 2. cache.set() in VideosModule doesn't affect AppModule's cache
// 3. Memory wasted on duplicate instances
// 4. Debugging nightmares when state doesn't sync
```

**Correct (dedicated module with exports):**

```typescript
// storage/storage.module.ts
@Module({
  providers: [StorageService],
  exports: [StorageService], // Make available to importers
})
export class StorageModule {}

// videos/videos.module.ts
@Module({
  imports: [StorageModule], // Import the module, not the service
  controllers: [VideosController],
  providers: [VideosService],
})
export class VideosModule {}

// channels/channels.module.ts
@Module({
  imports: [StorageModule], // Same instance shared
  controllers: [ChannelsController],
  providers: [ChannelsService],
})
export class ChannelsModule {}

// app.module.ts
@Module({
  imports: [
    StorageModule, // Only if AppModule itself needs StorageService
    VideosModule,
    ChannelsModule,
  ],
})
export class AppModule {}

// Now all modules share the SAME StorageService instance
```

**When to use @Global() (sparingly):**

```typescript
// ONLY for truly cross-cutting infrastructure, e.g. the app-wide transaction runner (nestjs-typeorm)
@Global()
@Module({
  providers: [TransactionRunner],
  exports: [TransactionRunner],
})
export class DatabaseModule {}

// Import once in AppModule
@Module({
  imports: [DatabaseModule], // Registered globally, available everywhere
})
export class AppModule {}

// Other modules don't need to import DatabaseModule
@Module({
  controllers: [UsersController],
  providers: [UsersService], // Can inject TransactionRunner without importing
})
export class UsersModule {}

// WARNING: Don't make everything global!
// - Hides dependencies (can't see what a module needs from imports)
// - Makes testing harder
// - Config: ConfigModule.forRoot({ isGlobal: true }), never re-provide ConfigService yourself
```

**Module re-exporting pattern:**

```typescript
// common.module.ts - shared utilities
@Module({
  providers: [DateService, ValidationService],
  exports: [DateService, ValidationService],
})
export class CommonModule {}

// core.module.ts - re-exports common for convenience
@Module({
  imports: [CommonModule, DatabaseModule],
  exports: [CommonModule, DatabaseModule], // Re-export for consumers
})
export class CoreModule {}

// feature.module.ts - imports CoreModule, gets both
@Module({
  imports: [CoreModule], // Gets CommonModule + DatabaseModule
  controllers: [FeatureController],
})
export class FeatureModule {}
```

Reference: [NestJS Modules](https://docs.nestjs.com/modules#shared-modules)

---

### 1.4 Single Responsibility for Services

**Impact: CRITICAL** — "40%+ improvement in testability"

Each service should have a single, well-defined responsibility. Avoid "god services" that handle multiple unrelated concerns. If a service name includes "And" or handles more than one domain concept, it likely violates single responsibility. This reduces complexity and improves testability by 40%+.

**Incorrect (god service anti-pattern):**

```typescript
// God service anti-pattern
@Injectable()
export class UserAndOrderService {
  constructor(
    private userRepo: UserRepository,
    private orderRepo: OrderRepository,
    private mailer: MailService,
    private payment: PaymentService,
  ) {}

  async createUser(dto: CreateUserDto) {
    const user = await this.userRepo.save(dto);
    await this.mailer.sendWelcome(user);
    return user;
  }

  async createOrder(userId: string, dto: CreateOrderDto) {
    const order = await this.orderRepo.save({ userId, ...dto });
    await this.payment.charge(order);
    await this.mailer.sendOrderConfirmation(order);
    return order;
  }

  async calculateOrderStats(userId: string) {
    // Stats logic mixed in
  }

  async validatePayment(orderId: string) {
    // Payment logic mixed in
  }
}
```

**Correct (focused services; one application service owns the workflow; thin controller):**

```typescript
// orders/order.entity.ts (excerpt) and orders/orders.dto.ts
@Entity('orders')
@Index(['userId', 'checkoutId'], { unique: true }) // one order per client checkout attempt
export class Order {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() userId: string;
  @Column() checkoutId: string;
  @Column('integer') total: number;
  @Column() currency: string;
  @Column({ type: 'varchar', default: 'pending' }) status: 'pending' | 'paid';
  @Column({ type: 'varchar', nullable: true }) chargeId: string | null;
}

export class PlaceOrderDto {
  /** Generated by the client once per checkout and resent on every retry of it. */
  @IsUUID() checkoutId: string;
  @IsInt() @IsPositive() total: number;
  @IsIn(['usd', 'eur', 'gbp']) currency: string;
}
```

```typescript
// orders/orders.service.ts: order state only
@Injectable()
export class OrdersService {
  constructor(
    private readonly transactions: TransactionRunner,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  /** One order per (user, checkoutId): the insert is skipped when it exists, then both callers read the same row. */
  findOrCreatePending(userId: string, dto: PlaceOrderDto): Promise<Order> {
    return this.transactions.run(async (manager) => {
      await manager.createQueryBuilder().insert().into(Order).values({ userId, ...dto, status: 'pending' }).orIgnore().execute();
      return manager.findOneByOrFail(Order, { userId, checkoutId: dto.checkoutId });
    });
  }

  /** `won` is true only for the call that moved the order from pending to paid. */
  markPaid(orderId: string, chargeId: string): Promise<{ order: Order; won: boolean }> {
    return this.transactions.run(async (manager) => {
      const { affected } = await manager.update(Order, { id: orderId, status: 'pending' }, { status: 'paid', chargeId });
      return { order: await manager.findOneByOrFail(Order, { id: orderId }), won: affected === 1 };
    });
  }

  findByUser(userId: string): Promise<Order[]> {
    return this.orders.findBy({ userId });
  }
}

@Injectable()
export class OrderStatsService {
  constructor(@InjectRepository(Order) private readonly orders: Repository<Order>) {}

  async calculateForUser(userId: string): Promise<{ count: number; total: number }> {
    const [count, total] = await Promise.all([this.orders.countBy({ userId }), this.orders.sum('total', { userId })]);
    return { count, total: total ?? 0 };
  }
}

// orders/checkout.service.ts: the workflow and its failure handling
@Injectable()
export class CheckoutService {
  constructor(
    private readonly orders: OrdersService,
    @Inject(PAYMENT_GATEWAY) private readonly payments: PaymentGateway,
    private readonly notifications: NotificationService,
  ) {}

  async checkout(userId: string, dto: PlaceOrderDto): Promise<Order> {
    const order = await this.orders.findOrCreatePending(userId, dto); // committed before any remote call
    if (order.status === 'paid') return order; // an earlier attempt finished
    // Same order, same charge: the gateway returns the first charge for a repeated orderId
    const { chargeId } = await this.payments.charge({ orderId: order.id, amount: order.total, currency: order.currency });
    const { order: paid, won } = await this.orders.markPaid(order.id, chargeId);
    if (won) this.notifications.dispatchOrderConfirmed(paid.id); // a concurrent attempt that lost returns the paid order only
    return paid;
  }
}

// orders/orders.controller.ts: HTTP only
@Controller('orders')
export class OrdersController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post()
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() dto: PlaceOrderDto): Promise<Order> {
    return this.checkoutService.checkout(user.id, dto);
  }
}
```

The controller maps HTTP to one call; `CheckoutService` is the only class that knows the order of steps and what a failure in each leaves behind. The remote charge runs after the order commits, never inside its transaction (`nestjs-resilience` rule `resilience-dispatch-after-commit`). The client sends one `checkoutId` per checkout and resends it on every retry. The insert is `INSERT … ON CONFLICT DO NOTHING` on the unique index, followed by a read of the row, so concurrent attempts share one order without a check-then-insert. `PaymentGateway` and its implementations are in `di-liskov-substitution`: `charge()` uses the order id as its idempotency key and returns the first charge for a repeated one. `markPaid()` updates only `WHERE status = 'pending'`, so exactly one attempt wins and dispatches the confirmation. `@Idempotent()` (`nestjs-resilience` rule `idempotency-client-keys`) is not enough on its own, because a 5xx releases its key and the retry runs the handler again. In the probe:

- A charge followed by a failing `markPaid()` answered 500 with the order `pending`; the retry with the same body answered `201 paid mock_ch_1`, with 1 order and 1 confirmation. A rejected charge likewise answered 500 and its retry 201 `paid`.
- Two concurrent requests with the same body both answered 201 with one order, 2 gateway calls, 1 distinct charge and 1 confirmation; the previous unguarded `markPaid()` sent 2 confirmations.
- Two processes sharing the database file ran the previous find-then-save concurrently and one failed with `SqliteError: database is locked`; with insert-or-ignore both got the same order id, 5 runs out of 5.

Gateway keys expire (Stripe: after 24 h at the earliest), so a scheduled job reconciles orders still `pending` past that window by looking the charge up at the gateway and calling `markPaid()`, never `charge()`. `dispatchOrderConfirmed()` is a `dispatch()` in the shape of `nestjs-resilience` rule `dlq-record-final-failure`: it returns `void`, ends its promise in a terminal `.catch` and tracks it for `drain()`. Writes, and the reads that follow them, go through `TransactionRunner` (`nestjs-typeorm` rule `orm-atomic-writes`); `CurrentUser` is in `security-use-guards`.

Reference: [NestJS Providers](https://docs.nestjs.com/providers)

---

### 1.5 Use Events for Decoupling, Not for Required Work

**Impact: MEDIUM-HIGH** — Decouples modules; a best-effort emit used for required work loses it silently

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

---

### 1.6 Use Repository Pattern for Data Access

**Impact: HIGH** — Decouples business logic from database

Create custom repositories to encapsulate complex queries and database logic. This keeps services focused on business logic, makes testing easier with mock repositories, and allows changing database implementations without affecting business code.

**Incorrect (complex queries in services):**

```typescript
// Complex queries in services
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private repo: Repository<User>,
  ) {}

  async findActiveWithOrders(minOrders: number): Promise<User[]> {
    // Complex query logic mixed with business logic
    return this.repo
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.orders', 'order')
      .where('user.isActive = :active', { active: true })
      .andWhere('user.deletedAt IS NULL')
      .groupBy('user.id')
      .having('COUNT(order.id) >= :min', { min: minOrders })
      .orderBy('user.createdAt', 'DESC')
      .getMany();
  }

  // Service becomes bloated with query logic
}
```

**Correct (custom repository with encapsulated queries and writes):**

```typescript
// users/users.repository.ts
@Injectable()
export class UsersRepository {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly transactions: TransactionRunner,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.users.findOneBy({ id });
  }

  findActiveWithMinOrders(minOrders: number): Promise<User[]> {
    return this.users
      .createQueryBuilder('user')
      .leftJoin('user.orders', 'order') // joined to count, not selected
      .where('user.isActive = :active', { active: true })
      .groupBy('user.id')
      .having('COUNT(order.id) >= :min', { min: minOrders })
      .orderBy('user.createdAt', 'DESC')
      .getMany();
  }

  /** A duplicate email rejects with the unique-constraint violation; the caller maps it. */
  insert(data: Pick<User, 'email' | 'name'>): Promise<User> {
    return this.transactions.run((manager) => manager.save(User, { ...data, roles: ['member'] }));
  }
}

// users/users.service.ts: business rules only
@Injectable()
export class UsersService {
  constructor(private readonly usersRepo: UsersRepository) {}

  getActiveUsersWithOrders(): Promise<User[]> {
    return this.usersRepo.findActiveWithMinOrders(1);
  }

  async create(dto: CreateUserDto): Promise<User> {
    try {
      return await this.usersRepo.insert({ email: dto.email, name: dto.name });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Email already registered');
      throw error;
    }
  }
}
```

No `findByEmail` pre-check: two concurrent requests both see "absent", so the unique index on `email` decides and the service maps its violation to 409 (in the probe a second `POST /users` with the same email answered `409 {"message":"Email already registered",…}`). Persistence rules are owned by `nestjs-typeorm`: every write through `TransactionRunner` (`orm-atomic-writes`), `isUniqueViolation()` and the driver codes (`orm-unique-violation`), `Relation<T>` and the 1.x find forms (`orm-relation-wrapper`, `orm-v1-removed-apis`).

Reference: [Repository Pattern](https://martinfowler.com/eaaCatalog/repository.html)

---

## 2. Dependency Injection

**Section Impact: CRITICAL**

### 2.1 Avoid Service Locator Anti-Pattern

**Impact: HIGH** — Hides dependencies and breaks testability

Avoid using `ModuleRef.get()` or global containers to resolve dependencies at runtime. This hides dependencies, makes code harder to test, and breaks the benefits of dependency injection. Use constructor injection instead.

**Incorrect (service locator anti-pattern):**

```typescript
// Use ModuleRef to get dependencies dynamically
@Injectable()
export class OrdersService {
  constructor(private moduleRef: ModuleRef) {}

  async createOrder(dto: CreateOrderDto): Promise<Order> {
    // Dependencies are hidden - not visible in constructor
    const usersService = this.moduleRef.get(UsersService);
    const inventoryService = this.moduleRef.get(InventoryService);
    const paymentService = this.moduleRef.get(PaymentService);

    const user = await usersService.findOne(dto.userId);
    // ... rest of logic
  }
}

// Global singleton container
class ServiceContainer {
  private static instance: ServiceContainer;
  private services = new Map<string, any>();

  static getInstance(): ServiceContainer {
    if (!this.instance) {
      this.instance = new ServiceContainer();
    }
    return this.instance;
  }

  get<T>(key: string): T {
    return this.services.get(key);
  }
}
```

**Correct (constructor injection with explicit dependencies):**

```typescript
// Use constructor injection - dependencies are explicit
@Injectable()
export class OrdersService {
  constructor(
    private usersService: UsersService,
    private inventoryService: InventoryService,
    private paymentService: PaymentService,
  ) {}

  async createOrder(dto: CreateOrderDto): Promise<Order> {
    const user = await this.usersService.findOne(dto.userId);
    const inventory = await this.inventoryService.check(dto.items);
    // Dependencies are clear and testable
  }
}

// VALID: Factory pattern for dynamic instantiation
@Injectable()
export class HandlerFactory {
  constructor(private moduleRef: ModuleRef) {}

  getHandler(type: string): Handler {
    switch (type) {
      case 'email':
        return this.moduleRef.get(EmailHandler);
      case 'sms':
        return this.moduleRef.get(SmsHandler);
      default:
        return this.moduleRef.get(DefaultHandler);
    }
  }
}
```

Constructor dependencies are what lets a unit test compile `OrdersService` alone and have `useMocker(autoMock)` supply the rest; `ModuleRef.get()` lookups are invisible to it. Test structure is owned by `nestjs-testing` (`unit-automock-dependencies`).

Reference: [NestJS Module Reference](https://docs.nestjs.com/fundamentals/module-ref)

---

### 2.2 Apply Interface Segregation Principle

**Impact: HIGH** — Reduces coupling and improves testability by 30-50%

Clients should not be forced to depend on interfaces they don't use. In NestJS, this means keeping interfaces small and focused on specific capabilities rather than creating "fat" interfaces that bundle unrelated methods. When a service only needs to send emails, it shouldn't depend on an interface that also includes SMS, push notifications, and logging. Split large interfaces into role-based ones.

**Incorrect (fat interface forcing unused dependencies):**

```typescript
// Fat interface - forces all consumers to depend on everything
interface NotificationService {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
  sendSms(phone: string, message: string): Promise<void>;
  sendPush(userId: string, notification: PushPayload): Promise<void>;
  sendSlack(channel: string, message: string): Promise<void>;
  logNotification(type: string, payload: any): Promise<void>;
  getDeliveryStatus(id: string): Promise<DeliveryStatus>;
  retryFailed(id: string): Promise<void>;
  scheduleNotification(dto: ScheduleDto): Promise<string>;
}

// Consumer only needs email, but must mock everything for tests
@Injectable()
export class OrdersService {
  constructor(
    private notifications: NotificationService, // Depends on 8 methods, uses 1
  ) {}

  async confirmOrder(order: Order): Promise<void> {
    await this.notifications.sendEmail(
      order.customer.email,
      'Order Confirmed',
      `Your order ${order.id} has been confirmed.`,
    );
  }
}

// Testing is painful - must mock unused methods
const mockNotificationService = {
  sendEmail: vi.fn(),
  sendSms: vi.fn(),           // Never used, but required
  sendPush: vi.fn(),          // Never used, but required
  sendSlack: vi.fn(),         // Never used, but required
  logNotification: vi.fn(),   // Never used, but required
  getDeliveryStatus: vi.fn(), // Never used, but required
  retryFailed: vi.fn(),       // Never used, but required
  scheduleNotification: vi.fn(), // Never used, but required
};
```

**Correct (segregated interfaces by capability):**

```typescript
// Segregated interfaces - each focused on one capability
interface EmailSender {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

interface SmsSender {
  sendSms(phone: string, message: string): Promise<void>;
}

interface PushSender {
  sendPush(userId: string, notification: PushPayload): Promise<void>;
}

interface NotificationLogger {
  logNotification(type: string, payload: any): Promise<void>;
}

interface NotificationScheduler {
  scheduleNotification(dto: ScheduleDto): Promise<string>;
}

// Implementation can implement multiple interfaces
@Injectable()
export class NotificationService implements EmailSender, SmsSender, PushSender {
  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    // Email implementation
  }

  async sendSms(phone: string, message: string): Promise<void> {
    // SMS implementation
  }

  async sendPush(userId: string, notification: PushPayload): Promise<void> {
    // Push implementation
  }
}

// Or separate implementations
@Injectable()
export class SendGridEmailService implements EmailSender {
  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    // SendGrid-specific implementation
  }
}

// Consumer depends only on what it needs
@Injectable()
export class OrdersService {
  constructor(
    @Inject(EMAIL_SENDER) private emailSender: EmailSender, // Minimal dependency
  ) {}

  async confirmOrder(order: Order): Promise<void> {
    await this.emailSender.sendEmail(
      order.customer.email,
      'Order Confirmed',
      `Your order ${order.id} has been confirmed.`,
    );
  }
}

// Testing is simple - only mock what's used
const mockEmailSender: EmailSender = {
  sendEmail: vi.fn(),
};

// Module registration with tokens
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
export const SMS_SENDER = Symbol('SMS_SENDER');

@Module({
  providers: [
    { provide: EMAIL_SENDER, useClass: SendGridEmailService },
    { provide: SMS_SENDER, useClass: TwilioSmsService },
  ],
  exports: [EMAIL_SENDER, SMS_SENDER],
})
export class NotificationModule {}
```

**Combining interfaces when needed:**

```typescript
// Sometimes a consumer legitimately needs multiple capabilities
interface EmailAndSmsSender extends EmailSender, SmsSender {}

// Or use intersection types
type MultiChannelSender = EmailSender & SmsSender & PushSender;

// Consumer that genuinely needs multiple channels
@Injectable()
export class AlertService {
  constructor(
    @Inject(MULTI_CHANNEL_SENDER)
    private sender: EmailSender & SmsSender,
  ) {}

  async sendCriticalAlert(user: User, message: string): Promise<void> {
    await Promise.all([
      this.sender.sendEmail(user.email, 'Critical Alert', message),
      this.sender.sendSms(user.phone, message),
    ]);
  }
}
```

Reference: [Interface Segregation Principle](https://en.wikipedia.org/wiki/Interface_segregation_principle)

---

### 2.3 Honor Liskov Substitution Principle

**Impact: HIGH** — Ensures implementations are truly interchangeable without breaking callers

Subtypes must be substitutable for their base types without altering program correctness. In NestJS with dependency injection, this means any implementation of an interface or abstract class must honor the contract completely. A mock payment service used in tests must behave like a real payment service (return similar shapes, handle errors the same way). Violating LSP causes subtle bugs when swapping implementations.

**Incorrect (implementations break the contract):**

```typescript
// Production implementation: no idempotency key, so a retried charge for the same order charges twice
@Injectable()
export class StripeService implements PaymentGateway {
  async charge({ amount, currency }: ChargeInput): Promise<Charge> {
    const response = await this.stripe.charges.create({ amount, currency });
    return { chargeId: response.id, amount };
  }
}

// Mock that violates LSP - different behavior!
@Injectable()
export class MockPaymentService implements PaymentGateway {
  async charge({ amount, currency }: ChargeInput): Promise<Charge> {
    // VIOLATION 1: Throws for valid input
    if (amount > 1000) {
      throw new Error('Mock does not support large amounts');
    }

    // VIOLATION 2: Returns null instead of a Charge
    if (currency !== 'usd') {
      return null as any; // Real service would convert or reject properly
    }

    // VIOLATION 3: Missing required field, and a new charge on every call for the same order
    return { amount } as Charge;
  }
}
```

**Correct (one documented contract; every implementation honors it):**

```typescript
// payments/payment-gateway.ts
export interface ChargeInput {
  orderId: string;
  /** Smallest currency unit (cents). */
  amount: number;
  /** ISO 4217, lower case as Stripe uses it. */
  currency: string;
}

export interface Charge {
  chargeId: string;
  amount: number;
}

export interface Refund {
  refundId: string;
  amount: number;
}

export interface PaymentGateway {
  /**
   * Charges at most once per orderId: a repeated orderId returns the first charge.
   * @throws PaymentFailedException if the charge is declined
   * @throws InvalidCurrencyException if the currency is not supported
   */
  charge(input: ChargeInput): Promise<Charge>;

  /** @throws TransactionNotFoundException if chargeId is unknown */
  refund(chargeId: string, amount?: number): Promise<Refund>;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
```

```typescript
// payments/stripe.service.ts
import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';

// Production implementation: the provider errors the contract names become its domain exceptions
@Injectable()
export class StripeService implements PaymentGateway {
  constructor(private readonly stripe: Stripe) {}

  async charge({ orderId, amount, currency }: ChargeInput): Promise<Charge> {
    try {
      // orderId is the idempotency key: Stripe answers a repeated key with the first request's result
      const charge = await this.stripe.charges.create({ amount, currency, metadata: { orderId } }, { idempotencyKey: orderId });
      return { chargeId: charge.id, amount: charge.amount };
    } catch (error) {
      // `error` is unknown: narrow with the SDK's classes before reading any property
      if (error instanceof Stripe.errors.StripeCardError) {
        throw new PaymentFailedException(error.message);
      }
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.param === 'currency') {
        throw new InvalidCurrencyException(`Unsupported currency: ${currency}`);
      }
      throw error; // network, auth and rate-limit errors are not part of the contract
    }
  }

  async refund(chargeId: string, amount?: number): Promise<Refund> {
    try {
      const refund = await this.stripe.refunds.create({ charge: chargeId, amount });
      return { refundId: refund.id, amount: refund.amount };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') {
        throw new TransactionNotFoundException(chargeId);
      }
      throw error;
    }
  }
}
```

```typescript
// payments/mock-payment.service.ts
// Mock that honors LSP: same contract, same failure modes, same idempotency
@Injectable()
export class MockPaymentService implements PaymentGateway {
  private readonly charges = new Map<string, Charge>(); // by orderId, like the idempotency key

  async charge({ orderId, amount, currency }: ChargeInput): Promise<Charge> {
    if (!['usd', 'eur', 'gbp'].includes(currency)) {
      throw new InvalidCurrencyException(`Unsupported currency: ${currency}`);
    }
    if (amount === 99999) {
      throw new PaymentFailedException('Card declined (test scenario)');
    }
    const existing = this.charges.get(orderId);
    if (existing) return existing;

    const charge: Charge = { chargeId: `mock_ch_${this.charges.size + 1}`, amount };
    this.charges.set(orderId, charge);
    return charge;
  }

  async refund(chargeId: string, amount?: number): Promise<Refund> {
    const charge = [...this.charges.values()].find((c) => c.chargeId === chargeId);
    if (!charge) {
      throw new TransactionNotFoundException(chargeId);
    }
    return { refundId: `refund_${chargeId}`, amount: amount ?? charge.amount };
  }
}
```

**Testing LSP compliance:**

```typescript
// test/payment-gateway.contract.ts: the suite every implementation must pass
import { randomUUID } from 'node:crypto';

export function testPaymentGatewayContract(createGateway: () => PaymentGateway) {
  describe('PaymentGateway contract', () => {
    let gateway: PaymentGateway;

    beforeEach(() => {
      gateway = createGateway();
    });

    it('returns a charge with an id and the amount', async () => {
      const charge = await gateway.charge({ orderId: randomUUID(), amount: 1000, currency: 'usd' });
      expect(charge).toEqual({ chargeId: expect.any(String), amount: 1000 });
    });

    it('returns the first charge for a repeated orderId', async () => {
      const input = { orderId: randomUUID(), amount: 1000, currency: 'usd' };
      const first = await gateway.charge(input);
      await expect(gateway.charge(input)).resolves.toEqual(first);
    });

    it('throws InvalidCurrencyException for an unsupported currency', async () => {
      await expect(gateway.charge({ orderId: randomUUID(), amount: 1000, currency: 'xxx' })).rejects.toThrow(InvalidCurrencyException);
    });

    it('throws TransactionNotFoundException for an unknown refund', async () => {
      await expect(gateway.refund('ch_nonexistent')).rejects.toThrow(TransactionNotFoundException);
    });
  });
}

// test/payments.e2e-spec.ts
describe('MockPaymentService', () => {
  testPaymentGatewayContract(() => new MockPaymentService());
});

// Stripe test mode: needs network and a test key
describe.skipIf(!process.env.STRIPE_TEST_KEY)('StripeService', () => {
  testPaymentGatewayContract(() => new StripeService(new Stripe(process.env.STRIPE_TEST_KEY ?? '')));
});
```

`CheckoutService` in `arch-single-responsibility` is the consumer: it charges with the order's id and works unchanged with either implementation. Stripe keeps an idempotency key for at least 24 hours and answers a repeat with the first result. Under `strict`, a `catch` variable is `unknown`, so `error.type === 'card_error'` fails with `TS18046: 'error' is of type 'unknown'`. In the probe (`stripe` 23.0.1, a fake `fetch` behind `Stripe.createFetchHttpClient()`), two charges for `ord_1` both sent `Idempotency-Key: ord_1`, where the old `charges.create({ amount, currency })` sent a fresh `stripe-node-retry-<uuid>` per call. A card decline became `PaymentFailedException: Your card was declined.`, `param: 'currency'` became `InvalidCurrencyException`, `resource_missing` on refund became `TransactionNotFoundException`, and a `StripeConnectionError` or a thrown string came out unchanged. `MockPaymentService` passed the contract suite; the Stripe suite is skipped without `STRIPE_TEST_KEY`.

Reference: [Liskov Substitution Principle](https://en.wikipedia.org/wiki/Liskov_substitution_principle), [Stripe Idempotent requests](https://docs.stripe.com/api/idempotent_requests)

---

### 2.4 Prefer Constructor Injection

**Impact: CRITICAL** — Required for proper DI and testing

Always use constructor injection over property injection. Constructor injection makes dependencies explicit, enables TypeScript type checking, ensures dependencies are available when the class is instantiated, and improves testability. This is required for proper DI, testing, and TypeScript support.

**Incorrect (property injection with hidden dependencies):**

```typescript
// Property injection - avoid unless necessary
@Injectable()
export class UsersService {
  @Inject()
  private userRepo: UserRepository; // Hidden dependency

  @Inject('CONFIG')
  private config: ConfigType; // Also hidden

  async findAll() {
    return this.userRepo.find();
  }
}

// Problems:
// 1. Dependencies not visible in constructor
// 2. Service can be instantiated without dependencies in tests
// 3. TypeScript can't enforce dependency types at instantiation
```

**Correct (constructor injection with explicit dependencies):**

```typescript
// Constructor injection - explicit and testable
@Injectable()
export class UsersService {
  constructor(
    private readonly userRepo: UserRepository,
    @Inject('CONFIG') private readonly config: ConfigType,
  ) {}

  async findAll(): Promise<User[]> {
    return this.userRepo.find();
  }
}

// Only use property injection for optional dependencies
@Injectable()
export class EventRecorder {
  private readonly logger = new Logger(EventRecorder.name);

  @Optional()
  @Inject('ANALYTICS')
  private analytics?: AnalyticsService;

  record(event: string) {
    this.logger.debug('Event recorded', { event });
    this.analytics?.track(event); // Optional enhancement
  }
}
```

Every dependency the constructor lists is one `useMocker()` can supply, so a unit test compiles `Test.createTestingModule({ providers: [UsersService] }).useMocker(autoMock)` and reads typed mocks with `vi.mocked(moduleRef.get(UserRepository))`; the `'CONFIG'` string token gets a specific double. How to write those tests is owned by `nestjs-testing` (`unit-automock-dependencies`, `unit-specific-doubles`).

Reference: [NestJS Providers](https://docs.nestjs.com/providers)

---

### 2.5 Understand Provider Scopes

**Impact: CRITICAL** — Prevents data leaks and performance issues

NestJS has three provider scopes: DEFAULT (singleton), REQUEST (per-request instance), and TRANSIENT (new instance for each injection). Most providers should be singletons. Request-scoped providers have performance implications as they bubble up through the dependency tree. Understanding scopes prevents memory leaks and incorrect data sharing.

**Incorrect (wrong scope usage):**

```typescript
// Request-scoped when not needed (performance hit)
@Injectable({ scope: Scope.REQUEST })
export class UsersService {
  // This creates a new instance for EVERY request
  // All dependencies also become request-scoped
  async findAll() {
    return this.userRepo.find();
  }
}

// Singleton with mutable request state
@Injectable() // Default: singleton
export class RequestContextService {
  private userId: string; // DANGER: Shared across all requests!

  setUser(userId: string) {
    this.userId = userId; // Overwrites for all concurrent requests
  }

  getUser() {
    return this.userId; // Returns wrong user!
  }
}
```

**Correct (appropriate scope for each use case):**

```typescript
// Singleton for stateless services (default, most common)
@Injectable()
export class UsersService {
  constructor(private readonly userRepo: UserRepository) {}

  async findById(id: string): Promise<User> {
    return this.userRepo.findOne({ where: { id } });
  }
}

// Request-scoped ONLY when you need request context
@Injectable({ scope: Scope.REQUEST })
export class RequestContextService {
  private userId: string;

  setUser(userId: string) {
    this.userId = userId;
  }

  getUser(): string {
    return this.userId;
  }
}

// Better: Use NestJS built-in request context
import { REQUEST } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js'; // security-use-guards

@Injectable({ scope: Scope.REQUEST })
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(REQUEST) private readonly request: AuthenticatedRequest) {}

  record(action: string) {
    // Opaque identifier only, never names or emails
    this.logger.debug('Action performed', { userId: this.request.user?.id, action });
  }
}

// Best: Use ClsModule for async context (no scope bubble-up)
import { ClsService } from 'nestjs-cls';

@Injectable() // Stays singleton!
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private cls: ClsService) {}

  record(action: string) {
    const userId = this.cls.get('userId');
    this.logger.debug('Action performed', { userId, action });
  }
}
```

Reference: [NestJS Injection Scopes](https://docs.nestjs.com/fundamentals/injection-scopes)

---

### 2.6 Use Injection Tokens for Interfaces

**Impact: HIGH** — Enables interface-based DI at runtime

TypeScript interfaces are erased at compile time and can't be used as injection tokens. Use string tokens, symbols, or abstract classes when you want to inject implementations of interfaces. The token is also the seam tests replace: the module always registers the production implementation, and a test overrides the token.

**Incorrect (interface can't be used as token):**

```typescript
// Interface can't be used as injection token
interface PaymentGateway {
  charge(input: ChargeInput): Promise<Charge>;
}

@Injectable()
export class StripeService implements PaymentGateway { /* ... */ }

@Injectable()
export class OrdersService {
  // This WON'T work - PaymentGateway doesn't exist at runtime
  constructor(private payment: PaymentGateway) {}
}
```

**Correct (symbol tokens or abstract classes):**

```typescript
// Option 1: String/Symbol tokens (most flexible)
// payments/payment-gateway.ts: the contract and StripeService are in di-liskov-substitution
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface PaymentGateway {
  charge(input: ChargeInput): Promise<Charge>;
  refund(chargeId: string, amount?: number): Promise<Refund>;
}

// Module registration: always the production implementation
@Module({
  providers: [{ provide: PAYMENT_GATEWAY, useClass: StripeService }],
  exports: [PAYMENT_GATEWAY],
})
export class PaymentModule {}

// Injection
@Injectable()
export class CheckoutService {
  constructor(@Inject(PAYMENT_GATEWAY) private readonly payments: PaymentGateway) {}
}

// test/checkout.e2e-spec.ts: the test replaces the token, the module graph stays production
const gateway = { charge: vi.fn(async ({ orderId, amount }: ChargeInput) => ({ chargeId: `ch_${orderId}`, amount })) };
app = await createTestApp((builder) => builder.overrideProvider(PAYMENT_GATEWAY).useValue(gateway));

// Option 2: Abstract class (carries runtime type info)
export abstract class PaymentGateway {
  abstract charge(input: ChargeInput): Promise<Charge>;
  abstract refund(chargeId: string, amount?: number): Promise<Refund>;
}

// StripeService then `extends PaymentGateway` instead of `implements` it
// providers: [{ provide: PaymentGateway, useClass: StripeService }]
// No @Inject needed with abstract class
@Injectable()
export class CheckoutService {
  constructor(private readonly payments: PaymentGateway) {}
}
```

A `process.env.NODE_ENV === 'test' ? Mock : Real` switch puts test code in the production graph, reads the environment behind `ConfigService`'s back, and leaves the e2e suite testing a module graph production never runs. Replace the token per suite instead; with the override above, the probe's checkout suite charged through `gateway` while every other provider stayed real. When a deployment genuinely selects an implementation (two payment providers), pick it in a `useFactory` that reads a validated setting with `config.getOrThrow()`, never a test double. Test structure: `nestjs-testing` (`e2e-real-app-module`).

Reference: [NestJS Custom Providers](https://docs.nestjs.com/fundamentals/custom-providers)

---

## 3. Error Handling

**Section Impact: HIGH**

### 3.1 Handle Async Errors Properly

**Impact: HIGH** — Lost work and silent process deaths from unhandled rejections

NestJS catches errors from async route handlers, but a promise nobody awaits (fire-and-forget calls, un-awaited work inside event handlers) rejects with no one listening, and Node ends the process on an unhandled rejection. Every promise is awaited, or handed to a `dispatch()` that ends it in its own `catch` and tracks it so tests and shutdown can `drain()` it. The process-level handlers are a last resort that make the crash visible as one structured log line; they never keep the process running. Log levels and call shape: `nestjs-logging`.

**Incorrect (fire-and-forget without error handling):**

```typescript
// Fire-and-forget without error handling
@Injectable()
export class UsersService {
  async createUser(dto: CreateUserDto): Promise<User> {
    const user = await this.usersRepo.insert(dto);

    // Fire and forget - if this fails, the rejection is unhandled and ends the process
    this.emailService.sendWelcome(user.email);

    return user;
  }
}

// Unhandled promise in event handler
@Injectable()
export class OrdersService {
  @OnEvent('order.created')
  handleOrderCreated(event: OrderCreatedEvent) {
    // Not awaited: the emitter can't see the rejection either, so it is unhandled
    this.processOrder(event);
  }
}

// Scheduled task that leaves failures to the scheduler
@Cron('0 0 * * *')
async dailyCleanup(): Promise<void> {
  await this.cleanup.run();
  // @nestjs/schedule catches the rejection and keeps the schedule, but logs
  // only the error message under context 'Scheduler': no job name, no item ids
}

// main.ts: log-and-continue keeps serving after an unknown failure
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason);
});
```

**Correct (explicit async error handling):**

```typescript
// Fire-and-forget through a dispatcher: dispatch() returns void, tracks the promise for drain()
// and ends it in a terminal .catch (nestjs-resilience rule dlq-record-final-failure)
@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly welcomeMail: WelcomeMailDispatcher,
  ) {}

  async createUser(dto: CreateUserDto): Promise<User> {
    const user = await this.usersRepo.insert(dto);
    this.welcomeMail.dispatch(user.id); // never rejects; the response doesn't wait
    return user;
  }
}

// Event handler: await the work, keep what failed for replay
@Injectable()
export class OrderCreatedListener {
  private readonly logger = new Logger(OrderCreatedListener.name);

  constructor(
    private readonly processor: OrderProcessor,
    private readonly deadLetters: DeadLetterStore, // nestjs-resilience dlq-record-final-failure
  ) {}

  @OnEvent('order.created')
  async handleOrderCreated(event: OrderCreatedEvent): Promise<void> {
    try {
      await this.processor.process(event);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const key = `order.created:${event.orderId}`;
      await this.deadLetters.record({ key, attempts: 1, lastError: err.message, failedAt: new Date(), payload: event });
      this.logger.log('Dead letter recorded', { key }, err);
    }
  }
}

// Scheduled tasks: catch to log with the job's context
// (per-item handling: `nestjs-schedule` rule `job-handle-errors`)
@Injectable()
export class CleanupJob {
  private readonly logger = new Logger(CleanupJob.name);

  constructor(private readonly cleanup: CleanupService) {}

  @Cron('0 0 * * *', { name: 'daily-cleanup' })
  async dailyCleanup(): Promise<void> {
    try {
      await this.cleanup.run();
      this.logger.log('Daily cleanup completed');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Daily cleanup failed', { job: 'daily-cleanup' }, err);
    }
  }
}
```

```typescript
// src/main.ts: the handlers, registered before NestFactory.create and logging through the instance create() gets
// (whole file and logger options: nestjs-logging rule setup-json-console-logger)
const logger = new ConsoleLogger({ json: true, redact: ['password', 'token', 'authorization', 'cookie'] });
const toError = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));
process.on('uncaughtException', (thrown) => {
  logger.fatal('Uncaught exception', { source: 'process' }, toError(thrown));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal('Unhandled rejection', { source: 'process' }, toError(reason));
  process.exit(1);
});

const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
```

`@OnEvent` listeners default to `suppressErrors: true` in `@nestjs/event-emitter`: a listener that rejects is caught and logged by the emitter (`error`, context `Event`, the error's message and stack), and the emitting code never sees it. A rethrow therefore doesn't crash the process; it loses the event with one log line. The listener above keeps the event as a dead letter instead. In the probe the failing `process()` left one dead letter and logged `log` `Dead letter recorded` `{"key":"order.created:o1"}` with the error; when the store's `record()` rejected (`dead-letter table locked`), that rejection was the one the emitter logged, and nothing was recorded, so the store needs to be durable (`nestjs-resilience`). Use `{ suppressErrors: false }` only when the emitter awaits `emitAsync()` and owns the failure (`arch-use-events`).

After an unhandled rejection or uncaught exception, the process state is unknown, so both handlers log at `fatal` and exit with code 1, as Node itself would. What they add is visibility: the crash becomes one JSON line instead of a raw stack trace. Register them before `NestFactory.create` so a failure while the app is being created is covered. In the probe, a provider constructor that left a rejected promise behind logged `{"level":"fatal",…,"message":"Unhandled rejection","error":{"name":"Error","message":"cache warmup failed",…},"params":{"source":"process"}}` and exited with code 1. A provider that throws is different: with Nest's default `abortOnError`, Nest logs it under `ExceptionHandler` and exits with code 1 whichever order the handlers are in.

Reference: [Node.js Unhandled Rejections](https://nodejs.org/api/process.html#event-unhandledrejection)

---

### 3.2 Throw HTTP Exceptions from Services

**Impact: HIGH** — Keeps controllers thin and simplifies error handling

It's acceptable (and often preferable) to throw `HttpException` subclasses from services in HTTP applications. This keeps controllers thin and allows services to communicate appropriate error states. For truly layer-agnostic services, use domain exceptions that map to HTTP status codes.

**Incorrect (return error objects instead of throwing):**

```typescript
// Return error objects instead of throwing
@Injectable()
export class UsersService {
  async findById(id: string): Promise<{ user?: User; error?: string }> {
    const user = await this.repo.findOne({ where: { id } });
    if (!user) {
      return { error: 'User not found' }; // Controller must check this
    }
    return { user };
  }
}

@Controller('users')
export class UsersController {
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const result = await this.usersService.findById(id);
    if (result.error) {
      throw new NotFoundException(result.error);
    }
    return result.user;
  }
}
```

**Correct (throw exceptions directly from service):**

```typescript
// Throw exceptions directly from service
@Injectable()
export class UsersService {
  constructor(private readonly usersRepo: UsersRepository) {}

  async findById(id: string): Promise<User> {
    const user = await this.usersRepo.findById(id);
    if (!user) throw new NotFoundException('User not found'); // no client input echoed (security-sanitize-output)
    return user;
  }

  async create(dto: CreateUserDto): Promise<User> {
    try {
      return await this.usersRepo.insert({ email: dto.email, name: dto.name });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Email already registered');
      throw error;
    }
  }

  async update(id: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.usersRepo.update(id, dto); // null when no row matched
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}

// Controller stays thin
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get(':id')
  findOne(@Param() params: UserIdParamDto): Promise<User> {
    return this.usersService.findById(params.id);
  }

  @Post()
  create(@Body() dto: CreateUserDto): Promise<User> {
    return this.usersService.create(dto);
  }
}

// For layer-agnostic services, use domain exceptions
export class EntityNotFoundException extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} not found`);
  }
}

// Map to HTTP in an exception filter (error-use-exception-filters)
@Catch(EntityNotFoundException)
export class EntityNotFoundFilter extends BaseExceptionFilter {
  override catch(exception: EntityNotFoundException, host: ArgumentsHost): void {
    super.catch(new NotFoundException(exception.message, { cause: exception }), host);
  }
}
```

`UsersRepository` writes through `TransactionRunner` (`arch-use-repository-pattern`); the duplicate check is the unique index, not a pre-read (`nestjs-typeorm` rule `orm-unique-violation`). In the probe a duplicate email answered `409 {"message":"Email already registered","error":"Conflict","statusCode":409}` and `PATCH` on an unknown id answered 404.

Reference: [NestJS Exception Filters](https://docs.nestjs.com/exception-filters)

---

### 3.3 Use Exception Filters for Error Handling

**Impact: HIGH** — Consistent, centralized error handling

Never catch exceptions and manually format error responses in controllers. Throw exceptions and let filters turn them into responses. Custom filters map specific error types; one catch-all logs every failed request. Filters extend `BaseExceptionFilter` and hand it an `HttpException`, so the body is Nest's `getResponse()` (validation messages included) and every filter answers in the same shape. Log levels and call shape: `nestjs-logging`.

**Incorrect (manual error handling in controllers):**

```typescript
// Manual error handling in controllers
@Controller('users')
export class UsersController {
  @Get(':id')
  async findOne(@Param('id') id: string, @Res() res: Response) {
    try {
      const user = await this.usersService.findById(id);
      if (!user) {
        return res.status(404).json({
          statusCode: 404,
          message: 'User not found',
        });
      }
      return res.json(user);
    } catch (error) {
      return res.status(500).json({
        statusCode: 500,
        message: 'Internal server error',
      });
    }
  }
}
```

**Incorrect (catch-all that rebuilds the body from `exception.message`):**

```typescript
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const message = exception instanceof HttpException ? exception.message : 'Internal server error';
    host.switchToHttp().getResponse<Response>().status(status).json({ statusCode: status, message });
    // A ValidationPipe 400 answers "Bad Request Exception": the violations live in getResponse()
  }
}
```

**Correct (exceptions in code, filters that delegate the response to `BaseExceptionFilter`):**

```typescript
// Throw built-in or custom HTTP exceptions; no response handling in controllers
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get(':id')
  findOne(@Param() params: UserIdParamDto): Promise<User> {
    return this.usersService.findById(params.id); // throws NotFoundException
  }
}
```

```typescript
// errors/filters.ts
import { type ArgumentsHost, Catch, HttpException, HttpStatus, InternalServerErrorException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';

export class DomainException extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY,
  ) {
    super(message);
  }
}

/** Domain errors are expected outcomes: mapped to their status, not logged. */
@Catch(DomainException)
export class DomainExceptionFilter extends BaseExceptionFilter {
  override catch(exception: DomainException, host: ArgumentsHost): void {
    const body = { statusCode: exception.status, code: exception.code, message: exception.message };
    super.catch(new HttpException(body, exception.status, { cause: exception }), host);
  }
}

/** Logs every failed request once; Nest's BaseExceptionFilter writes the response. */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    // Unknown errors answer a generic 500; the original stays in `cause` and in the log
    const httpException =
      exception instanceof HttpException ? exception : new InternalServerErrorException(undefined, { cause: exception });
    const statusCode = httpException.getStatus();
    const fields = { method: request.method, path: request.path, statusCode };

    if (statusCode >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error('Request failed', fields, err);
    } else {
      this.logger.debug('Request rejected', fields);
    }
    super.catch(httpException, host); // body = getResponse(): validation messages survive
  }
}
```

```typescript
// app.module.ts providers: APP_FILTER, so e2e apps get them too (nestjs-testing e2e-global-enhancers-as-providers).
// Nest tries the last-listed filter first and runs only the first whose @Catch matches: the catch-all goes first.
{ provide: APP_FILTER, useClass: AllExceptionsFilter },
{ provide: APP_FILTER, useClass: DomainExceptionFilter },
{ provide: APP_FILTER, useClass: HttpClientExceptionFilter }, // nestjs-http-client request-exception-filter
```

Measured through the real `AppModule` with the `ValidationPipe` as `APP_PIPE`: `{ name: 42 }` answered `400 {"message":["name must be a string"],"error":"Bad Request","statusCode":400}`; `NotFoundException('User not found')` kept its body; a plain `Error` answered `500 {"message":"Internal Server Error","statusCode":500}` and logged one `error` `Request failed` with the fields and the error; a `DomainException` answered `422 {"statusCode":422,"code":"ORDER_SHIPPED",…}`. An `HttpNetworkError` answered `502` and an `HttpTimeoutError` `504` through `HttpClientExceptionFilter`, which logs those itself. With the catch-all listed last, the same `HttpNetworkError` answered `500`: the catch-all matched first and the gateway mapping never ran. Wrapping unknown errors in `InternalServerErrorException` keeps `BaseExceptionFilter` from logging them a second time under `ExceptionsHandler`. `HttpClientExceptionFilter` and `toHttpException()` are owned by `nestjs-http-client`.

Reference: [NestJS Exception Filters](https://docs.nestjs.com/exception-filters)

---

## 4. Security

**Section Impact: HIGH**

### 4.1 Issue and Verify Short-Lived JWT Access Tokens

**Impact: CRITICAL** — Forged, stale or over-privileged tokens accepted

Use `@nestjs/jwt` to sign access tokens and `@nestjs/passport` with `passport-jwt` to verify them. Read every required setting with `ConfigService.getOrThrow()`, so a missing secret stops the app at startup instead of failing at the first `sign()`; `get()` returns `undefined`, and an `undefined` issuer or audience silently turns that check off. Keep tokens short-lived and the payload to identifiers. `JwtStrategy.validate()` loads the user on every request, so deactivation, demotion and "sign out everywhere" take effect immediately. This rule covers access tokens only. Refresh tokens need their own atomic rotation contract (hashed one-time secrets, expiry and revocation checks, single-use replacement, family revocation on reuse); a `save()` of a hashed random string is not one, so don't issue refresh tokens until you implement that contract in full.

**Incorrect (hardcoded secret, sensitive payload, no user check):**

```typescript
@Module({
  imports: [
    JwtModule.register({
      secret: 'my-secret-key', // Exposed in code
      signOptions: { expiresIn: '7d' }, // Too long
    }),
  ],
})
export class AuthModule {}

async login(user: User): Promise<{ accessToken: string }> {
  const payload = {
    sub: user.id,
    email: user.email, // personal data, readable by anyone holding the token
    roles: user.roles, // stays valid after the user is demoted
  };
  return { accessToken: this.jwtService.sign(payload) };
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_SECRET'), // undefined when unset; issuer/audience never checked
    });
  }

  async validate(payload: any): Promise<any> {
    return payload; // No validation of user existence
  }
}
```

**Correct (validated settings, identifier-only payload, user loaded per request):**

```typescript
// auth/auth.module.ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './jwt.strategy.js';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService], // ConfigModule.forRoot({ isGlobal: true }) in AppModule
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: '15m', // Short-lived access tokens
          issuer: config.getOrThrow<string>('JWT_ISSUER'),
          audience: config.getOrThrow<string>('JWT_AUDIENCE'),
        },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
```

```typescript
// auth/auth.service.ts
/** Identifiers only: no roles, no personal data. Roles are read from the database per request. */
export interface AccessTokenPayload {
  sub: string;
  ver: number;
}

@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  /** Call only after the credentials have been verified. */
  async issueAccessToken(user: User): Promise<{ accessToken: string; expiresIn: number }> {
    const payload: AccessTokenPayload = { sub: user.id, ver: user.tokenVersion };
    return { accessToken: await this.jwt.signAsync(payload), expiresIn: 900 };
  }
}
```

```typescript
// users/users.repository.ts (arch-use-repository-pattern): the read that authorizes
/** Committed state only: waits behind an open transaction instead of reading its uncommitted rows. */
findCommittedById(id: string): Promise<User | null> {
  return this.transactions.run((manager) => manager.findOneBy(User, { id }));
}
```

```typescript
// auth/jwt.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersRepository } from '../users/users.repository.js';
import type { AccessTokenPayload } from './auth.service.js';
import type { AuthenticatedUser } from './authenticated-request.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly users: UsersRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      issuer: config.getOrThrow<string>('JWT_ISSUER'),
      audience: config.getOrThrow<string>('JWT_AUDIENCE'),
      algorithms: ['HS256'],
    });
  }

  /** Runs after the signature and expiry check; its return value becomes request.user. */
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    // Committed read: a role change inside another request's open transaction is not visible until it commits
    const user = await this.users.findCommittedById(payload.sub);
    // Deleted, deactivated, or signed out everywhere (tokenVersion bumped) since the token was issued
    if (!user?.isActive || user.tokenVersion !== payload.ver) throw new UnauthorizedException();
    return { id: user.id, roles: user.roles, plan: user.plan };
  }
}
```

Without `JWT_SECRET`, `main.ts` stopped during `NestFactory.create` with `{"level":"error",…,"message":"Configuration key \"JWT_SECRET\" does not exist","context":"ExceptionHandler",…}` and exit code 1. `validate()` decides authorization, so it reads through `TransactionRunner.run()` (`nestjs-typeorm` rule `orm-atomic-writes`): a plain repository read on better-sqlite3 runs inside whatever transaction is open on the shared connection. In the probe, a member's token called an `@Roles(['admin'])` route while another transaction had set the user's roles to `['admin']` and then rolled back: with `findById` the request answered 200, with `findCommittedById` it waited for the rollback and answered 403. `tokenVersion` is an integer column incremented on password change, "sign out everywhere" and account recovery; comparing it is exact, where comparing `iat` (whole seconds) with a password-change timestamp misjudges tokens issued in the same second. `AuthenticatedUser` and the global `JwtAuthGuard` that runs this strategy are in `security-use-guards`. Secrets come from the environment or a secret manager, never from source; for HS256 use at least 32 random bytes.

Reference: [NestJS Authentication: Passport JWT](https://docs.nestjs.com/recipes/passport#implementing-passport-jwt), [OWASP JSON Web Token Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)

---

### 4.2 Implement Rate Limiting

**Impact: HIGH** — Protects against abuse and ensures fair resource usage

Use `@nestjs/throttler` to limit request rates per client, stricter on credential and email-sending endpoints than on reads. In `@nestjs/throttler` 6, per-user limits are configuration, not guard overrides: `limit` and `ttl` accept a function of the `ExecutionContext`, and `getTracker` decides who is counted. `ThrottlerGuard` has no `getLimit()` hook: in the probe, a subclass `getLimit()` returning 1000 was called 0 times, and the fourth request against the configured limit of 3 answered 429. Counting per user needs `request.user`, so the throttler guard runs after the authentication guard. The default storage is in-process memory: with several instances, every instance counts separately; use a shared storage (Redis) there.

**Incorrect (no limits on sensitive endpoints; a limit hook that doesn't exist):**

```typescript
@Controller('auth')
export class AuthController {
  @Post('login')
  login(@Body() dto: LoginDto): Promise<TokenResponse> {
    return this.authService.login(dto); // Attackers can brute-force credentials
  }
}

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected async getLimit(context: ExecutionContext): Promise<number> {
    return context.switchToHttp().getRequest().user?.isPremium ? 1000 : 200; // never called
  }
}
```

**Correct (resolvable limit and tracker, guard after authentication):**

```typescript
// auth/throttling.ts
import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from './authenticated-request.js';

const requestOf = (context: ExecutionContext) => context.switchToHttp().getRequest<AuthenticatedRequest>();

/** Requests per minute: premium accounts 1000, other accounts 200, anonymous callers 50. */
export function limitFor(context: ExecutionContext): number {
  const { user } = requestOf(context);
  if (!user) return 50;
  return user.plan === 'premium' ? 1000 : 200;
}

/** Signed-in callers are counted per account, anonymous callers per IP. */
export function trackerFor(_req: Record<string, unknown>, context: ExecutionContext): string {
  const request = requestOf(context);
  return request.user ? `user:${request.user.id}` : `ip:${request.ip}`;
}
```

```typescript
// app.module.ts
@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: limitFor }],
      getTracker: trackerFor,
    }),
  ],
  providers: [
    // Global guards run in this order: authenticate, authorize, then throttle per account
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}

// Stricter limits per endpoint
@Controller('auth')
export class AuthController {
  @Public()
  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 5 attempts per minute
  login(@Body() dto: LoginDto): Promise<TokenResponse> {
    return this.authService.login(dto);
  }

  @Public()
  @Post('forgot-password')
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } }) // 3 per hour
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    return this.authService.sendResetEmail(dto.email);
  }
}

// No throttling for probes
@Controller('health')
export class HealthController {
  @Public()
  @SkipThrottle()
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
```

With `@nestjs/throttler` 6.7.1, the sixth `POST /auth/login` within a minute answered 429; an anonymous `GET` route answered 200 for the 50th request and 429 for the 51st, while a signed-in member made 60 requests to an authenticated route with no 429 and got `X-RateLimit-Limit: 200`. `@SkipThrottle()` `GET /health` never answered 429. Counters are per route and tracker. Behind a reverse proxy, `request.ip` is the proxy's address unless Express's `trust proxy` is set to the proxy hop count in `configureApp()`; without it every anonymous caller shares one counter. A per-IP login limit slows credential stuffing only partly; also count failed attempts per account in the login service. `AuthenticatedRequest`, `JwtAuthGuard` and `@Public()` are in `security-use-guards`.

Reference: [NestJS Throttler](https://docs.nestjs.com/security/rate-limiting)

---

### 4.3 Sanitize Output to Prevent XSS

**Impact: HIGH** — XSS vulnerabilities can compromise user sessions and data

While NestJS APIs typically return JSON (which browsers don't execute), XSS risks exist when rendering HTML, storing user content, or when frontend frameworks improperly handle API responses. Sanitize user-generated HTML before storage, keep client input out of messages, and send a Content-Security-Policy. Under the project's NodeNext ESM setup, `sanitize-html` is a default import: `import * as sanitizeHtml` fails to type-check with `TS2349: This expression is not callable` (`sanitize-html` 2.18.1, `@types/sanitize-html` 2.16.2).

**Incorrect (storing raw HTML without sanitization):**

```typescript
// Store raw HTML from users
@Injectable()
export class CommentsService {
  async create(dto: CreateCommentDto): Promise<Comment> {
    // User can inject: <script>steal(document.cookie)</script>
    return this.repo.save({
      content: dto.content, // Raw, unsanitized
      authorId: dto.authorId, // and the author is whatever the client claims
    });
  }
}

// Return HTML without sanitization
@Controller('pages')
export class PagesController {
  @Get(':slug')
  @Header('Content-Type', 'text/html')
  async getPage(@Param('slug') slug: string): Promise<string> {
    const page = await this.pagesService.findBySlug(slug);
    // If page.content contains user input, XSS is possible
    return `<html><body>${page.content}</body></html>`;
  }
}

// Reflect user input in errors
@Get(':id')
async findOne(@Param('id') id: string): Promise<User> {
  const user = await this.repo.findOne({ where: { id } });
  if (!user) {
    // XSS if id contains malicious content and error is rendered
    throw new NotFoundException(`User ${id} not found`);
  }
  return user;
}

// Sanitizer in a transform without a type guard: an array body field throws a TypeError -> 500
@Transform(({ value }) => sanitizeHtml(value, { allowedTags: [] }))
title: string;
```

**Correct (sanitize content, guard transforms, send a CSP):**

```typescript
// comments/comments.service.ts: sanitize HTML before storage
import { Injectable } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';
import { TransactionRunner } from '../database/transaction-runner.js';
import { Comment } from './comment.entity.js';

export const COMMENT_HTML: sanitizeHtml.IOptions = {
  allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'br'],
  allowedAttributes: { a: ['href', 'title'] },
  allowedSchemes: ['http', 'https', 'mailto'],
};

@Injectable()
export class CommentsService {
  constructor(private readonly transactions: TransactionRunner) {}

  create(authorId: string, dto: CreateCommentDto): Promise<Comment> {
    const content = sanitizeHtml(dto.content, COMMENT_HTML);
    return this.transactions.run((manager) => manager.save(Comment, { authorId, content }));
  }
}

// comments/comments.controller.ts: the author is the authenticated user, not a body field
@Post()
create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCommentDto): Promise<Comment> {
  return this.comments.create(user.id, dto);
}
```

```typescript
// posts/create-post.dto.ts: sanitize in the DTO; non-strings pass through to @IsString()
import { Transform } from 'class-transformer';
import { IsString, MaxLength } from 'class-validator';
import sanitizeHtml from 'sanitize-html';
import { COMMENT_HTML } from '../comments/comments.service.js';

const stripAllHtml = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }) : value;

export class CreatePostDto {
  @IsString()
  @MaxLength(1000)
  @Transform(stripAllHtml)
  title: string;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? sanitizeHtml(value, COMMENT_HTML) : value))
  content: string;
}
```

```typescript
// Fixed error messages; the param is validated before use
@Get(':id')
findOne(@Param() params: UserIdParamDto): Promise<User> {
  return this.usersService.findById(params.id); // throws NotFoundException('User not found')
}
```

```typescript
// src/configure-app.ts (nestjs-testing): middleware has no provider form, so main.ts and e2e apps share it here
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

export function configureApp(app: NestExpressApplication): NestExpressApplication {
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
        },
      },
    }),
  );
  return app.setGlobalPrefix('api');
}
```

In the probe, a comment `hi <script>steal()</script><b>there</b>` was stored as `hi <b>there</b>` with the token's user as author. `CreatePostDto` turned `<b>Hi</b><script>x()</script>` into `Hi` and `<p onclick="x()">ok <a href="javascript:x()">l</a></p>` into `<p>ok <a>l</a></p>`; an array `title` answered 400 (`title must be a string`) where the unguarded transform answered 500. Every response carried `content-security-policy: default-src 'self';…;script-src 'self';…`. Transforms run before validation, so each one returns non-strings unchanged (`security-validate-all-input`). Nest serializes returned objects as `application/json`; set `Content-Type: text/html` only on routes that render escaped HTML.

Reference: [OWASP XSS Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)

---

### 4.4 Use Guards for Authentication and Authorization

**Impact: HIGH** — Enforces access control before handlers execute

Guards decide whether a request reaches its handler. They run after middleware and before interceptors and pipes, which makes them the place for access control. Authenticate with Passport's `AuthGuard('jwt')`, so `JwtStrategy.validate()` (`security-auth-jwt`) loads the current user from the database on every request, and authorize from that server-side user. Roles copied into a token stay valid for the token's lifetime after the user is demoted or deactivated.

**Incorrect (manual checks; or a guard that trusts the token's claims):**

```typescript
// Manual auth checks in every handler
@Controller('admin')
export class AdminController {
  @Get('users')
  async getUsers(@Request() req) {
    if (!req.user) throw new UnauthorizedException();
    if (!req.user.roles.includes('admin')) throw new ForbiddenException();
    return this.adminService.getUsers();
  }
}

// Verified payload used as the user: roles come from the token, the user is never looked up
@Injectable()
export class JwtAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    request.user = await this.jwtService.verifyAsync(extractBearer(request)); // { sub, roles: ['admin'] }
    return true;
  }
}
```

**Correct (Passport guard, roles from the database user, declarative decorators):**

```typescript
// auth/authenticated-request.ts
import type { Request } from 'express';
import type { Role } from '../users/user.entity.js';

/** What JwtStrategy.validate() puts on request.user: loaded from the database on every request. */
export interface AuthenticatedUser {
  id: string;
  roles: Role[];
  plan: 'free' | 'premium';
}

export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };
```

```typescript
// auth/public.decorator.ts, auth/roles.decorator.ts, auth/current-user.decorator.ts
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const Roles = Reflector.createDecorator<Role[]>();

/** The user JwtStrategy.validate() loaded for this request. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedUser => {
  const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!user) throw new UnauthorizedException(); // only reachable on a @Public() route
  return user;
});
```

```typescript
// auth/jwt-auth.guard.ts
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC } from './public.decorator.js';

/** Authenticates through JwtStrategy, so request.user is the current database user. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    return isPublic || super.canActivate(context);
  }
}

// auth/roles.guard.ts
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride(Roles, [context.getHandler(), context.getClass()]);
    if (!required?.length) return true;
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return !!user && required.some((role) => user.roles.includes(role));
  }
}
```

```typescript
// app.module.ts providers: global guards run in the order listed
{ provide: APP_GUARD, useClass: JwtAuthGuard },
{ provide: APP_GUARD, useClass: RolesGuard },

// admin/admin.controller.ts
@Controller('admin')
@Roles(['admin']) // Applied to all routes
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  getUsers(): Promise<User[]> {
    return this.adminService.getUsers();
  }

  @Delete('users/:id')
  deleteUser(@CurrentUser() admin: AuthenticatedUser, @Param() params: UserIdParamDto): Promise<void> {
    return this.adminService.deleteUser(params.id, admin.id);
  }
}

@Controller('health')
export class HealthController {
  @Public() // no authentication
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
```

Every route is authenticated unless marked `@Public()`. In the probe, a token issued while the user was `admin` read `GET /admin/users` with 200; after the database row was changed to `['member']`, the same unexpired token answered `403 {"message":"Forbidden resource",…}`, and after `isActive = false` or a `tokenVersion` bump it answered 401. Without a token the route answered 401 and `@Public()` `GET /health` 200. `RolesGuard` covers coarse roles; access to a specific resource (is this the order's owner?) is checked in the service against the stored row. `PassportModule`, `JwtStrategy` and the token payload are in `security-auth-jwt`; the throttler guard goes after these two (`security-rate-limiting`). To replace a global guard in a test, register it with `useExisting` (`nestjs-testing` rule `e2e-global-enhancers-as-providers`).

Reference: [NestJS Authentication: Enable authentication globally](https://docs.nestjs.com/recipes/passport#enable-authentication-globally), [NestJS Guards](https://docs.nestjs.com/guards)

---

### 4.5 Validate All Input with DTOs and Pipes

**Impact: HIGH** — First line of defense against attacks

Validate every request body, query and route parameter with class-validator DTOs and one global `ValidationPipe`, registered as an `APP_PIPE` provider so e2e apps run it too (`nestjs-testing` rule `e2e-global-enhancers-as-providers`). Leave `enableImplicitConversion` off: it converts by the declared TypeScript type before validation, so `{ "name": 42 }` became `"42"` and passed `@IsString()` (201 in the probe). Convert query strings explicitly with `@Type(() => Number)`. `@Transform` also runs before validation, so a transform that assumes a string turns an array into a 500 (`value?.trim()` on `["a"]` did); guard each one with `typeof value === 'string'` and let the validators reject the rest.

**Incorrect (raw input; implicit conversion; unguarded transforms; composition rules):**

```typescript
@Controller('users')
export class UsersController {
  @Post()
  create(@Body() body: any) {
    return this.usersService.create(body); // body could contain anything
  }
}

// main.ts: missing from every e2e app, and converts 42 to "42" before @IsString() runs
app.useGlobalPipes(new ValidationPipe({ transform: true, transformOptions: { enableImplicitConversion: true } }));

export class CreateUserDto {
  @IsString()
  @Transform(({ value }) => value?.trim()) // ["a"] -> TypeError -> 500
  name: string;

  @MinLength(8)
  @MaxLength(100) // rejects long passphrases
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/) // "Passw0rd1" passes
  password: string;
}
```

**Correct (global `APP_PIPE`, explicit conversion, guarded transforms):**

```typescript
// app.module.ts providers
{ provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }) },
```

```typescript
// users/users.dto.ts
import { Transform, Type } from 'class-transformer';
import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const normalizeEmail = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name: string;

  @IsEmail()
  @Transform(normalizeEmail)
  email: string;

  @IsInt()
  @Min(0)
  @Max(150)
  age: number;

  // Length only: no composition rules, passphrases welcome (NIST SP 800-63B-4)
  @IsString()
  @MinLength(15)
  @MaxLength(256)
  password: string;
}

export class FindUsersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

export class UserIdParamDto {
  @IsUUID('4')
  id: string;
}
```

```typescript
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  create(@Body() dto: CreateUserDto): Promise<User> {
    return this.usersService.create(dto);
  }

  @Get()
  findAll(@Query() query: FindUsersQueryDto): Promise<User[]> {
    return this.usersService.findAll(query); // query.limit is a number
  }

  @Get(':id')
  findOne(@Param() params: UserIdParamDto): Promise<User> {
    return this.usersService.findById(params.id); // params.id is a valid UUID
  }
}
```

In the probe, `name: ["a","b"]`, `name: 42`, an unknown property, `email: ["x"]` and `password: "Passw0rd1"` each answered 400 with the violations; `"  Ann  "` and `" Ann@X.test "` were stored as `Ann` and `ann@x.test`; a 200-character passphrase was accepted; `?limit=5` arrived as the number `5` and `?limit=abc` answered 400.

Passwords follow NIST SP 800-63B-4: at least 15 characters when the password is the only factor (8 with a second factor), no composition rules, long passphrases accepted. The upper bound only caps hashing work; hash with Argon2id (bcrypt ignores input past 72 bytes). The DTO can't know whether a password has leaked: in the service, reject passwords found in a breached-password list, such as the Have I Been Pwned range API, which takes only the first five hex characters of the SHA-1 hash. That outbound call is an HTTP client (`nestjs-http-client`).

Reference: [NestJS Validation](https://docs.nestjs.com/techniques/validation), [NIST SP 800-63B-4: Passwords](https://pages.nist.gov/800-63-4/sp800-63b.html#password)

---

## 5. Performance

**Section Impact: HIGH**

### 5.1 Use Async Lifecycle Hooks Correctly

**Impact: HIGH** — Improper async handling blocks application startup

Nest awaits the promise returned from `onModuleInit`, `onApplicationBootstrap` and the shutdown hooks, so async setup belongs there, returned or awaited. A hook that starts work without awaiting it lets the app accept requests before the resource is ready and turns a setup failure into an unhandled rejection. Constructors stay synchronous and cheap: they run during dependency resolution, and blocking I/O there stalls every module. Open connections in `onModuleInit` and close them in `onApplicationShutdown`, which runs after the HTTP server has stopped; closing in `onModuleDestroy` pulls the resource from under requests that are still draining. Shutdown hooks only run on a signal when `main.ts` calls `enableShutdownHooks()` (`devops-graceful-shutdown`).

**Incorrect (fire-and-forget init; blocking constructor):**

```typescript
@Injectable()
export class RedisConnection implements OnModuleInit {
  onModuleInit() {
    this.redis.connect(); // not awaited: the app starts before Redis is ready; a failure is an unhandled rejection
  }
}

@Injectable()
export class DomainBlocklist {
  private readonly domains: Set<string>;

  constructor() {
    this.domains = new Set(readFileSync('blocklist.txt', 'utf8').split('\n')); // blocks module instantiation
  }
}
```

**Correct (`redis/redis.module.ts`):**

```typescript
import { Global, Injectable, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/** Opens the shared client before the app starts and closes it after the HTTP server has stopped. */
@Injectable()
export class RedisConnection implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisConnection.name);

  constructor(private readonly redis: Redis) {
    // Without a listener ioredis prints "[ioredis] Unhandled error event" on every failed reconnect
    redis.on('error', (error: Error) => this.logger.warn('Redis connection error', {}, error));
  }

  async onModuleInit(): Promise<void> {
    await this.redis.connect(); // bootstrap waits; an unreachable Redis fails startup instead of the first request
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit(); // runs after in-flight requests have finished (devops-graceful-shutdown)
  }
}

@Global()
@Module({
  providers: [
    {
      provide: Redis,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new Redis(config.getOrThrow<string>('REDIS_URL'), { lazyConnect: true }),
    },
    RedisConnection,
  ],
  exports: [Redis],
})
export class RedisModule {}
```

**Correct (`signup/domain-blocklist.ts`):**

```typescript
import { readFile } from 'node:fs/promises';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Blocked email domains, loaded once before the app accepts requests. */
@Injectable()
export class DomainBlocklist implements OnModuleInit {
  private domains = new Set<string>();

  constructor(private readonly config: ConfigService) {} // keep the constructor synchronous and cheap

  async onModuleInit(): Promise<void> {
    // Awaited by app.init(): a missing file fails startup instead of the first signup
    const text = await readFile(this.config.getOrThrow<string>('BLOCKLIST_PATH'), 'utf8');
    this.domains = new Set(text.split('\n').map((line) => line.trim().toLowerCase()).filter(Boolean));
  }

  isBlocked(email: string): boolean {
    return this.domains.has(email.slice(email.lastIndexOf('@') + 1).toLowerCase());
  }
}
```

```typescript
// Runs after every module's onModuleInit: safe to use other modules' providers
@Injectable()
export class PopularProductsWarmer implements OnApplicationBootstrap {
  constructor(private readonly products: ProductsService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.products.getPopular(); // fills the cache (perf-use-caching)
  }
}
```

In the probe (`ioredis` 6.0.0 against a local RESP stub), `app.init()` resolved with the blocklist loaded and the client connected, and `app.close()` sent `QUIT`. A missing `BLOCKLIST_PATH` file rejected `init()` with `ENOENT: no such file or directory`; an unreachable Redis rejected it with `Connection is closed.` after logging `warn('Redis connection error', {}, Error('connect ECONNREFUSED 127.0.0.1:1'))`. Configuration comes from the validated `ConfigService` (`devops-use-config-module`). Providers of lazily loaded modules get no lifecycle hooks (`perf-lazy-loading`).

Reference: [NestJS Lifecycle Events](https://docs.nestjs.com/fundamentals/lifecycle-events)

---

### 5.2 Use Lazy Loading for Large Modules

**Impact: MEDIUM** — Improves startup time for large applications

`LazyModuleLoader` defers a module's import and instantiation until first use. It pays off for rarely used features with heavy dependencies and for serverless cold starts; in a long-running server the work only moves from startup to the first request. Three things go wrong in practice: the dynamic import needs the `.js` suffix like every relative ESM import (`nestjs-setup` rule `esm-imports-and-paths`), concurrent first calls each load the module unless the *promise* is cached, and lifecycle hooks (`onModuleInit`, `onApplicationBootstrap`, shutdown hooks) are not called for providers of a lazily loaded module, so a provider that needs async setup or teardown does not belong there.

**Incorrect (extensionless import; result cached after the await):**

```typescript
private adminModule: ModuleRef | null = null;

private async getAdminModule(): Promise<ModuleRef> {
  if (!this.adminModule) {
    const { AdminModule } = await import('./admin/admin.module'); // TS2307: Cannot find module './admin/admin.module'
    this.adminModule = await this.lazyModuleLoader.load(() => AdminModule); // concurrent callers all get here
  }
  return this.adminModule;
}
```

**Correct (`reports/reports.facade.ts`):**

```typescript
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { LazyModuleLoader, type ModuleRef } from '@nestjs/core';

/** Loads ReportsModule on first use; every caller shares one load. */
@Injectable()
export class ReportsFacade implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReportsFacade.name);
  private reportsModule?: Promise<ModuleRef>;

  constructor(private readonly lazyModuleLoader: LazyModuleLoader) {}

  async generate(type: string): Promise<string> {
    const moduleRef = await this.module();
    const { ReportGenerator } = await import('./reports/reports.module.js');
    return moduleRef.get(ReportGenerator).generate(type);
  }

  /** Optional warm-up after startup; a failure leaves the module to load on first use. */
  onApplicationBootstrap(): void {
    this.module().catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn('Reports module preload failed', {}, err);
    });
  }

  private module(): Promise<ModuleRef> {
    // Cache the promise, not the result: concurrent first calls share one load
    this.reportsModule ??= this.load().catch((error: unknown) => {
      this.reportsModule = undefined; // a failed load is retried on the next call
      throw error;
    });
    return this.reportsModule;
  }

  private async load(): Promise<ModuleRef> {
    const { ReportsModule } = await import('./reports/reports.module.js');
    return this.lazyModuleLoader.load(() => ReportsModule);
  }
}
```

`ReportsModule` is not in any `imports` array; only the facade is registered eagerly. In the probe, three concurrent first calls through the incorrect getter constructed `ReportGenerator` three times (they then received one `ModuleRef`); through the facade, three concurrent `generate()` calls constructed it once. The class is taken from the same typed `import()`, so no `Object.values(module)[0]` or `Promise<any>` is needed.

Reference: [NestJS Lazy Loading Modules](https://docs.nestjs.com/fundamentals/lazy-loading-modules)

---

### 5.3 Optimize Database Queries

**Impact: HIGH** — Database queries are typically the largest source of latency

Fetch only the columns and relations a response needs, bound every list with a page size and a deterministic order, and add indexes for the queries you actually run, confirmed with the database's query plan. Each index costs a write on every insert and update, so an index nobody's query uses is pure cost. Loading relations without N+1 is `db-avoid-n-plus-one`; TypeORM 1.x query syntax is `nestjs-typeorm` (`orm-v1-removed-apis`), and indexes ship in migrations (`nestjs-typeorm` `migration-list-classes`).

**Incorrect (over-fetching; speculative indexes; unbounded, unordered lists):**

```typescript
async findAllEmails(): Promise<string[]> {
  const users = await this.users.find(); // every column of every user
  return users.map((u) => u.email);
}

@Entity('orders')
@Index(['userId'])
@Index(['status'])
@Index(['createdAt'])
@Index(['userId', 'status']) // the single-column userId index duplicates this one's prefix
export class Order { /* ... */ }

findAll(): Promise<Order[]> {
  return this.orders.find(); // no limit; row order undefined
}
```

**Correct (narrow selects, one index per real query, stable pages):**

```typescript
async findAllEmails(): Promise<string[]> {
  const users = await this.users.find({ select: { email: true } });
  return users.map((u) => u.email);
}

getProfile(id: string): Promise<User | null> {
  return this.users.findOne({
    where: { id },
    relations: { posts: true },
    select: { id: true, name: true, email: true, posts: { id: true, title: true } },
  });
}
```

```typescript
// Serves "a user's orders in one status, newest first": equality columns first, then the sort columns
@Entity('orders')
@Index('IDX_orders_user_status_created', ['userId', 'status', 'createdAt', 'id'])
export class Order {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() userId: string;
  @Column() status: string;
  @Column('integer') total: number;
  @CreateDateColumn() createdAt: Date;
  @OneToMany(() => OrderItem, (item) => item.order) items: Relation<OrderItem[]>;
}
```

```typescript
findPage(userId: string, status: string, page: number, limit: number): Promise<[Order[], number]> {
  return this.orders.findAndCount({
    where: { userId, status },
    order: { createdAt: 'DESC', id: 'DESC' }, // id breaks ties: a deterministic order, so equal timestamps don't swap between pages
    skip: (page - 1) * limit,
    take: limit, // validate limit with an upper bound (@Max(100)) in the query DTO
  });
}
```

Check the plan for the query the index is for. On better-sqlite3, `EXPLAIN QUERY PLAN SELECT * FROM orders WHERE userId = ? AND status = ? ORDER BY createdAt DESC, id DESC LIMIT 2` returned `SEARCH orders USING INDEX IDX_orders_user_status_created (userId=? AND status=?)`. With the index on `(userId, status, createdAt)` only, it added `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`: the tie-break column has to be in the index too, or every page sorts in memory. The same index serves `WHERE userId = ?` alone (`SEARCH … (userId=?)`, a prefix), so a separate `userId` index adds write cost and nothing else; `WHERE status = ?` alone is `SCAN orders`. Add an index for that access path only when that query exists. Offset pages get slower as `skip` grows, and a row inserted or deleted between requests shifts every later page, so the next page repeats or skips a row. For deep or live lists, page by cursor (`WHERE userId = ? AND status = ? AND (createdAt, id) < (?, ?)`, planned as `SEARCH … (userId=? AND status=? AND (createdAt,id)<(?,?))`) on the same index: each page starts after the last row the client saw, so pages neither overlap nor skip existing rows.

Reference: [SQLite EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html)

---

### 5.4 Use Caching Strategically

**Impact: HIGH** — Dramatically reduces database load and response times

Cache expensive reads that many requests share, with a TTL that matches how stale the data may be, and make sure no entry read before a write commits is served after it. The cache key must contain everything the response depends on. `CacheInterceptor` keys on the request URL (`httpAdapter.getRequestUrl`), path parameters and query string included, and caches `GET` only. A static `@CacheKey('category')` replaces that key for every request to the route: in the probe, `GET /categories/1` then `GET /categories/2` both returned `{"id":"1"}`. A response that depends on the caller (`/me`, anything behind a guard that filters by user or tenant) must not use a URL-only key, or the first caller's data is served to everyone.

**Incorrect (static key on a parameterized route; personalized response under a shared key):**

```typescript
@Controller('categories')
@UseInterceptors(CacheInterceptor)
export class CategoriesController {
  @Get(':id')
  @CacheKey('category') // every id shares one entry
  findOne(@Param('id') id: string): Promise<Category> {
    return this.categories.findOne(id);
  }
}

@Get('me/feed')
@UseInterceptors(CacheInterceptor) // key is "/me/feed": user B gets user A's feed
feed(@CurrentUser() user: User): Promise<FeedItem[]> {
  return this.feeds.forUser(user.id);
}

async getPopular(): Promise<Product[]> {
  const cached = await this.cache.get<Product[]>('products:popular');
  if (cached) return cached; // a cached 0, '' or false is treated as a miss
  // ...
}

async update(id: string, dto: UpdateProductDto): Promise<void> {
  await this.transactions.run((manager) => manager.update(Product, { id }, dto));
  await this.cache.del('products:popular'); // a reader that queried before the commit sets the old list again
}
```

**Correct (store, URL keys, per-principal keys, generation keys):**

```typescript
// cache/redis-cache.module.ts — shared store; omit `stores` for the in-memory default
import KeyvRedis from '@keyv/redis';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        stores: [new KeyvRedis(config.getOrThrow<string>('REDIS_URL'))],
        ttl: 60_000, // default 60 s, in milliseconds
      }),
    }),
  ],
})
export class RedisCacheModule {}
```

```typescript
// The URL is the key: /categories/1 and /categories/2 are separate entries
@Controller('categories')
@UseInterceptors(CacheInterceptor)
export class CategoriesController {
  @Get(':id')
  @CacheTTL(60_000)
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<CategoryDto> {
    return this.categories.findOne(id);
  }
}
```

```typescript
// cache/user-cache.interceptor.ts
import { CacheInterceptor } from '@nestjs/cache-manager';
import { Injectable, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: string };
}

/** Per-principal cache key for responses that depend on who asks; uncached without a key or a user. */
@Injectable()
export class UserCacheInterceptor extends CacheInterceptor {
  protected override async trackBy(context: ExecutionContext): Promise<string | undefined> {
    const key = await super.trackBy(context); // a @CacheKey() factory may return a promise
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    return key && user ? `user:${user.id}:${key}` : undefined;
  }
}

// usage: @Get('me/feed') @UseInterceptors(UserCacheInterceptor) @CacheTTL(30_000)
```

```typescript
// cache/cache-generation.ts: one row per cached data set, created by a migration (nestjs-typeorm)
@Entity('cache_generations')
export class CacheGeneration {
  @PrimaryColumn() name: string;
  @Column('integer') value: number;
}

export async function readGeneration(manager: EntityManager, name: string): Promise<number> {
  return (await manager.findOneBy(CacheGeneration, { name }))?.value ?? 0;
}

export async function bumpGeneration(manager: EntityManager, name: string): Promise<void> {
  await manager.createQueryBuilder().insert().into(CacheGeneration).values({ name, value: 0 }).orIgnore().execute();
  await manager.increment(CacheGeneration, { name }, 'value', 1);
}
```

```typescript
// products/products.service.ts
const POPULAR = 'products:popular';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly transactions: TransactionRunner,
  ) {}

  async getPopular(): Promise<Product[]> {
    const generation = await this.transactions.run((manager) => readGeneration(manager, POPULAR));
    const cached = await this.cache.get<Product[]>(`${POPULAR}:${generation}`);
    if (cached !== undefined) return cached; // an empty list is a valid cached value

    // The list and the generation it belongs to, read in one transaction
    const fresh = await this.transactions.run(async (manager) => ({
      generation: await readGeneration(manager, POPULAR),
      products: await manager.find(Product, { order: { orderCount: 'DESC' }, take: 20 }),
    }));
    await this.cache.set(`${POPULAR}:${fresh.generation}`, fresh.products, 5 * 60_000);
    return fresh.products;
  }

  update(id: string, dto: UpdateProductDto): Promise<void> {
    return this.transactions.run(async (manager) => {
      await manager.update(Product, { id }, dto);
      await bumpGeneration(manager, POPULAR); // commits with the change, or not at all
    });
  }
}
```

Probe results (in-memory store, `@nestjs/cache-manager` 12.0.2, `cache-manager` 7.2.9): `/categories/1`, `/categories/2`, `/categories/1` returned `n` 1, 2, 1, so the second id ran the handler and the third request was a hit. `/me/feed` for `u1`, `u2`, `u1` returned 1, 2, 1, and two anonymous requests returned 3 and 4 (not cached). On a route with an async `@CacheKey()` factory keyed on `?tab=`, a synchronous `trackBy` override (`${super.trackBy(context)}` in a template string, so the key holds `[object Promise]`) answered `tab=b` with the cached `tab=a` body; the awaiting override cached them separately. A reader held between its query and its `cache.set()` while `update()` committed: with delete-after-commit the next two reads returned the old name, with the database generation the new one. When the cache rejected writes right after the commit, a generation kept in the cache left `update()` rejected (`ECONNRESET`) after the row had changed, and the next reads returned `old`; the database generation made no cache call in `update()`, and the next reads returned `new`. On an empty table, three `getPopular()` calls returned `[]` with one list query. Through `RedisCacheModule` (`@keyv/redis` 6.1.0, Redis 8.10.2) a cached `[]` came back as `[]` and a miss as `undefined`; `CacheInterceptor` itself treats a cached `null` as a miss.

Writes go through `TransactionRunner` (`nestjs-typeorm` rule `orm-atomic-writes`). Deleting a key after the commit is not enough: a reader that queried before the commit can `set()` the old value after the `del()`. Changing a generation kept in the cache is a second write after the commit that can fail on its own. The generation therefore lives in the database and changes in the same transaction as the data; a reader caches a list only under the generation it read in that same transaction, so a late `set()` lands on a key nobody reads. That costs one primary-key read through `run()` per request, queued behind open transactions like every committed read. Entries under old generations expire with their TTL. Don't cache what changes on most requests, and don't cache errors.

Reference: [NestJS Caching](https://docs.nestjs.com/techniques/caching)

---

## 6. Database & ORM

**Section Impact: MEDIUM-HIGH**

### 6.1 Avoid N+1 Query Problems

**Impact: HIGH** — N+1 queries are one of the most common performance killers

N+1 queries happen when you load a list, then issue one more query per row for its related data. Load the relations with the list (`relations`, or a query-builder join), aggregate in SQL when you only need counts, and batch per request (DataLoader over one `In(ids)` query) when resolvers fetch relations field by field. TypeORM 1.x query syntax (object `relations`/`select`, no string arrays) is owned by `nestjs-typeorm` rule `orm-v1-removed-apis`; entities type relations as `Relation<T>` (`orm-relation-wrapper`).

**Incorrect (one query per order):**

```typescript
async getOrdersWithItems(userId: string): Promise<Order[]> {
  const orders = await this.orders.find({ where: { userId } }); // 1 query
  for (const order of orders) {
    order.items = await this.items.find({ where: { order: { id: order.id } } }); // + 1 per order
  }
  return orders;
}
```

**Correct (relations loaded with the list; counts aggregated in SQL):**

```typescript
getOrdersWithItems(userId: string): Promise<Order[]> {
  return this.orders.find({
    where: { userId },
    relations: { items: { product: true } },
  });
}

getUsersWithPostCounts(): Promise<{ id: string; name: string; postCount: number }[]> {
  return this.users
    .createQueryBuilder('user')
    .leftJoin('user.posts', 'post')
    .select('user.id', 'id')
    .addSelect('user.name', 'name')
    .addSelect('COUNT(post.id)', 'postCount')
    .groupBy('user.id')
    .getRawMany();
}

getActiveUsersWithPublishedPosts(): Promise<User[]> {
  return this.users
    .createQueryBuilder('user')
    // the condition belongs to the join: users without published posts stay in the result
    .leftJoinAndSelect('user.posts', 'post', 'post.status = :status', { status: 'published' })
    .where('user.isActive = :active', { active: true })
    .getMany();
}

getOrderSummaries(userId: string): Promise<Order[]> {
  return this.orders.find({
    where: { userId },
    relations: { items: true },
    select: { id: true, total: true, status: true, items: { id: true, quantity: true, price: true } },
  });
}
```

With five orders of one item each, the loop issued 6 `SELECT`s and `relations: { items: { product: true } }` issued 1, with every `items[].product` populated. `getOrderSummaries` returned `{"id":…,"status":"open","total":0,"items":[{"id":…,"quantity":1,"price":2}]}`, nothing else. To spot N+1 in development, turn on `logging: ['query']` in the one `dataSourceOptions` (`nestjs-typeorm` rule `orm-single-data-source`), not in a second `TypeOrmModule.forRoot`.

Reference: [TypeORM Find Options](https://typeorm.io/docs/working-with-entity-manager/find-options/)

---

## 7. API Design

**Section Impact: MEDIUM**

### 7.1 Use DTOs and Serialization for API Responses

**Impact: MEDIUM** — Response DTOs prevent accidental data exposure and ensure consistency

Never return entities as the response contract. Declare a response DTO per shape and let one global `ClassSerializerInterceptor` turn whatever the handler returns into that DTO. The DTO must be deny-by-default: `@Expose()` alone does not hide anything. `plainToInstance(Dto, user)` copies every property of `user`, and `instanceToPlain` then emits all of them, so a DTO without a class-level `@Exclude()` leaks `passwordHash` the day someone adds it to the entity.

**Incorrect (entity returned directly; DTO with `@Expose()` only):**

```typescript
@Get(':id')
findOne(@Param('id', ParseUUIDPipe) id: string): Promise<User> {
  return this.usersService.findById(id); // { id, email, passwordHash, ... }
}

export class UserResponseDto {
  @Expose() id: string;
  @Expose() email: string;
}

@Get(':id')
async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
  return plainToInstance(UserResponseDto, await this.usersService.findById(id));
  // {"id":"u1","email":"a@x.io","name":"Ann","passwordHash":"h","createdAt":"1970-01-01T00:00:00.000Z"}
}
```

**Correct (deny-by-default DTOs, one global serializer):**

```typescript
// users/user-response.dto.ts
import { Exclude, Expose } from 'class-transformer';

/** Class-level @Exclude(): only the properties declared with @Expose() reach the client. */
@Exclude()
export class UserResponseDto {
  @Expose() id: string;
  @Expose() email: string;
  @Expose() name: string;
}

@Exclude()
export class UserAdminDto extends UserResponseDto {
  @Expose({ groups: ['admin'] }) createdAt: Date;
}
```

```typescript
// app.module.ts
import { ClassSerializerInterceptor, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';

@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      inject: [Reflector],
      // Default for every route: a class instance without a response DTO serializes to {} instead of every column.
      useFactory: (reflector: Reflector) => new ClassSerializerInterceptor(reflector, { excludeExtraneousValues: true }),
    },
  ],
})
export class AppModule {}
```

```typescript
// users/users.controller.ts
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  @SerializeOptions({ type: UserResponseDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    return this.users.findById(id); // the interceptor converts the entity to UserResponseDto
  }

  @Get(':id/admin')
  @UseGuards(AdminGuard)
  @SerializeOptions({ type: UserAdminDto, groups: ['admin'] })
  findOneForAdmin(@Param('id', ParseUUIDPipe) id: string): Promise<UserAdminDto> {
    return this.users.findById(id);
  }
}
```

Conversion lives in one place, the interceptor, so list and detail routes cannot diverge; handlers never call `plainToInstance` themselves. In the probe, a source object carrying `passwordHash` serialized to `{"id":"u1","email":"a@x.io","name":"Ann"}` through `UserResponseDto`, the admin route added `createdAt`, and the same DTO without the `admin` group omitted it. A class instance returned from a route with no `@SerializeOptions` serialized to `{}`. The interceptor only converts class instances: a plain object literal returned without `@SerializeOptions({ type })` passes through unchanged, so declare the type on every route.

The interceptor is an `APP_INTERCEPTOR` provider, not `app.useGlobalInterceptors()` in `main.ts`, so e2e apps built from `AppModule` serialize the same way (`nestjs-testing` rule `e2e-global-enhancers-as-providers`); input validation goes the same way as an `APP_PIPE` (`api-use-pipes`).

Reference: [NestJS Serialization](https://docs.nestjs.com/techniques/serialization)

---

### 7.2 Use Interceptors for Cross-Cutting Concerns

**Impact: MEDIUM-HIGH** — Interceptors provide clean separation for cross-cutting logic

Interceptors wrap handler execution, so tracing, response envelopes, timeouts, caching and error mapping live in one place instead of every handler. Register global ones as `APP_INTERCEPTOR` providers so e2e apps built from `AppModule` get them too (`nestjs-testing` rule `e2e-global-enhancers-as-providers`). Async work started inside the pipe (a cache write) must be awaited and its failure handled; a rejected promise nobody awaits is an unhandled rejection. Log levels and call shape: `nestjs-logging`.

**Incorrect (repeated per handler; unawaited cache write; message matching):**

```typescript
@Get(':id')
async findOne(@Param('id') id: string): Promise<User> {
  const start = Date.now();
  this.logger.debug('findOne called', { id });
  const user = await this.usersService.findOne(id);
  this.logger.debug('findOne completed', { durationMs: Date.now() - start });
  return user; // repeated in every method
}

const cached = await this.cacheManager.get(cacheKey);
if (cached) return of(cached); // false, 0 and '' are recomputed every time
return next.handle().pipe(
  tap((response) => {
    this.cacheManager.set(cacheKey, response, ttl); // not awaited: a failing store is an unhandled rejection
  }),
);

if (error instanceof QueryFailedError && error.message.includes('duplicate')) {
  throw new ConflictException(); // driver- and locale-specific; better-sqlite3 says "UNIQUE constraint failed"
}
```

**Correct (`common/interceptors.ts`):**

```typescript
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  RequestTimeoutException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Cache } from 'cache-manager';
import type { Request, Response } from 'express';
import { catchError, map, mergeMap, of, tap, throwError, timeout, TimeoutError, type Observable } from 'rxjs';
import { EntityNotFoundError } from 'typeorm';
import { isUniqueViolation } from '../database/is-unique-violation.js';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { method, url } = context.switchToHttp().getRequest<Request>();
    const start = Date.now();
    // Per-request tracing at debug, values as fields. Failures are logged once, by the exception filter.
    return next.handle().pipe(
      tap(() => {
        const { statusCode } = context.switchToHttp().getResponse<Response>();
        this.logger.debug('Request handled', { method, url, statusCode, durationMs: Date.now() - start });
      }),
    );
  }
}

export interface Envelope<T> {
  data: T;
  meta: { timestamp: string; path: string };
}

@Injectable()
export class EnvelopeInterceptor<T> implements NestInterceptor<T, Envelope<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<Envelope<T>> {
    const path = context.switchToHttp().getRequest<Request>().url;
    return next.handle().pipe(
      map((data) => ({ data, meta: { timestamp: new Date().toISOString(), path } })),
    );
  }
}

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(5000),
      catchError((err: unknown) =>
        throwError(() => (err instanceof TimeoutError ? new RequestTimeoutException('Request timed out') : err)),
      ),
    );
  }
}

/** TTL in milliseconds for HttpCacheInterceptor; the route's default applies without it. */
export const CacheTtl = Reflector.createDecorator<number>();

@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  private readonly logger = new Logger(HttpCacheInterceptor.name);

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.method !== 'GET') return next.handle();

    const key = `http:${request.originalUrl}`; // path + query string; never for per-user responses
    const ttl = this.reflector.get(CacheTtl, context.getHandler()) ?? 300_000;

    const cached = await this.cache.get<unknown>(key);
    if (cached !== undefined) return of(cached); // false, 0 and '' are hits too

    return next.handle().pipe(
      mergeMap(async (response: unknown) => {
        try {
          await this.cache.set(key, response, ttl);
        } catch (error) {
          // Best effort: the response is still correct, only the next request is slower
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.warn('Cache write failed', { key }, err);
        }
        return response;
      }),
    );
  }
}

/** Maps persistence errors the handler didn't handle to HTTP errors. */
@Injectable()
export class PersistenceErrorInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof EntityNotFoundError) return throwError(() => new NotFoundException());
        if (isUniqueViolation(error)) return throwError(() => new ConflictException('Resource already exists'));
        return throwError(() => error);
      }),
    );
  }
}
```

```typescript
// app.module.ts — global; per controller or route with @UseInterceptors(...)
@Module({
  providers: [
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
  ],
})
export class AppModule {}

// usage
@Get('flags/:name')
@CacheTtl(60_000)
@UseInterceptors(HttpCacheInterceptor)
isEnabled(@Param('name') name: string): Promise<boolean> {
  return this.flags.isEnabled(name);
}
```

In the probe, a route returning `false` behind `HttpCacheInterceptor` ran once for two requests. With a cache store whose `set()` rejects, the request still returned 200 and the interceptor logged `warn('Cache write failed', { key: 'http:/skus/flag' }, Error('redis down'))`. Inserting a second row with the same `unique` code through `TransactionRunner` returned `409 {"message":"Resource already exists",…}`, and `findOneByOrFail` for a missing id returned `404` without echoing the query criteria that `EntityNotFoundError.message` contains. `isUniqueViolation` is the helper from `nestjs-typeorm` rule `orm-unique-violation`; when a service needs a different answer for a duplicate (return the existing row, `'duplicate'`), it catches there and the interceptor never sees it. The cache key is URL-only, so the interceptor is for responses that are the same for every caller; per-user keys and the stock `CacheInterceptor` are in `perf-use-caching`.

Reference: [NestJS Interceptors](https://docs.nestjs.com/interceptors)

---

### 7.3 Use Pipes for Input Transformation

**Impact: MEDIUM** — Pipes ensure clean, validated data reaches your handlers

Use the built-in pipes (`ParseUUIDPipe`, `ParseIntPipe`, `ParseEnumPipe`, `ParseArrayPipe`, `DefaultValuePipe`) for parameters, a custom pipe for a parsing rule the built-ins lack, and one global `ValidationPipe` for DTOs. A pipe or `@Transform` receives whatever the client sent: a repeated query key (`?search=a&search=b`) arrives as an array, and a JSON body field can be any type. Transforms run before class-validator, so a transform that calls string methods unguarded turns that input into a 500: `@Transform(({ value }) => value?.toLowerCase())` answered `?search=a&search=b` with `500 Internal server error` and logged `TypeError: value?.toLowerCase is not a function`. Check the type, and either throw `BadRequestException` (pipes) or return the value unchanged for the validators to reject (DTOs).

**Incorrect (manual parsing; unguarded transforms; validation only in `main.ts`):**

```typescript
@Get()
findAll(@Query('page') page: string, @Query('limit') limit: string): Promise<User[]> {
  return this.usersService.findAll(parseInt(page) || 1, parseInt(limit) || 10); // ?page=abc silently becomes 1
}

export class FindProductsDto {
  @IsOptional()
  @Transform(({ value }) => value?.toLowerCase()) // array input: TypeError, 500
  @IsString()
  search?: string;
}

// main.ts — e2e apps built from AppModule run without it
app.useGlobalPipes(new ValidationPipe({ transform: true, transformOptions: { enableImplicitConversion: true } }));
```

**Correct (built-in and custom pipes):**

```typescript
@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    return this.users.findOne(id);
  }

  @Get()
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ): Promise<UserResponseDto[]> {
    return this.users.findAll(page, limit);
  }
}
```

```typescript
// common/pipes.ts
import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

/** Query/param values are strings, string arrays (repeated keys) or undefined; reject everything but one string. */
@Injectable()
export class ParseDatePipe implements PipeTransform<unknown, Date> {
  transform(value: unknown): Date {
    const date = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Expected an ISO 8601 date');
    return date;
  }
}

@Injectable()
export class NormalizeEmailPipe implements PipeTransform<unknown, string | undefined> {
  transform(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new BadRequestException('Expected a single email');
    return value.trim().toLowerCase();
  }
}
```

```typescript
@Get('reports')
findReports(@Query('from', ParseDatePipe) from: Date, @Query('to', ParseDatePipe) to: Date): Promise<ReportDto[]> {
  return this.reports.findBetween(from, to);
}

@Get('products')
findByIds(
  @Query('ids', new ParseArrayPipe({ items: String, separator: ',' })) ids: string[],
  @Query('email', NormalizeEmailPipe) email: string | undefined,
): Promise<ProductDto[]> {
  return this.products.findByIds(ids, email);
}

@Get('items/:id')
findItem(
  @Param('id', new ParseIntPipe({ exceptionFactory: () => new BadRequestException('id must be an integer') })) id: number,
): Promise<ItemDto> {
  return this.items.findOne(id);
}
```

**Correct (DTO with guarded transforms, global `ValidationPipe` as `APP_PIPE`):**

```typescript
import { Transform, Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class FindProductsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;

  // Transforms run before validation: touch strings only, leave anything else for @IsString to reject
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  search?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',') : value))
  @IsArray()
  @IsString({ each: true })
  categories?: string[];
}
```

```typescript
// app.module.ts
@Module({
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class AppModule {}
```

Probe results: `?from=2026-01-01&from=2026-01-02` → `400 Expected an ISO 8601 date`; `?email=a@x.io&email=b@x.io` → `400 Expected a single email`; `?search=a&search=b` → `400 ["search must be a string"]`; `?search=ABC&categories=a,b&page=2` → `{"page":2,"limit":10,"search":"abc","categories":["a","b"]}`; `?page=x` → 400; `/items/abc` → `400 id must be an integer`. Conversion is explicit (`@Type(() => Number)`), not `enableImplicitConversion`, which also converts a number sent for a string field into a string that passes `@IsString()` (`security-validate-all-input`). `ParseArrayPipe` is Nest's; don't shadow it with a custom class of the same name. HTML sanitization is `security-sanitize-output`. `APP_PIPE` puts validation in the module graph, so e2e apps validate like production (`nestjs-testing` rule `e2e-global-enhancers-as-providers`).

Reference: [NestJS Pipes](https://docs.nestjs.com/pipes)

---

### 7.4 Use API Versioning for Breaking Changes

**Impact: MEDIUM** — Versioning allows you to evolve APIs without breaking existing clients

Use Nest's built-in versioning when a response or request contract changes incompatibly. Pick one strategy (URI, header or media type) for the whole API and enable it once in `configureApp()`, so production and every e2e app route the same way. Let the router select the handler with `version` / `@Version()`; each version's controller returns its own typed DTO, and the service underneath stays version-neutral. Version branching inside a service (`findOne(id, version): Promise<any>`) bypasses the router, accepts versions nobody supports, and hides each version's contract.

**Incorrect (breaking change in place; version selected by hand):**

```typescript
@Get(':id')
findOne(@Param('id') id: string): Promise<User> {
  // v1 clients expected { id, name, email }; now { id, firstName, lastName, emailAddress }
  return this.usersService.findOne(id);
}

@Get(':id')
findOne(@Param('id') id: string, @Headers('X-API-Version') version = '1'): Promise<any> {
  return this.usersService.findOne(id, version); // any version string reaches the service
}
```

**Correct (`src/configure-app.ts`):**

```typescript
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** Settings production and tests share; main.ts and createTestApp call this. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  return app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' }); // /v1/users, /v2/users
}
```

Header (`{ type: VersioningType.HEADER, header: 'X-API-Version' }`) and media-type (`{ type: VersioningType.MEDIA_TYPE, key: 'v=' }`) versioning are alternatives to URI versioning, not additions: `enableVersioning` is called once.

**Correct (version-specific controllers over a version-neutral service):**

```typescript
import {
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  createdAt: Date;
}

/** Version-neutral domain logic; knows nothing about response shapes. */
@Injectable()
export class UsersService {
  private readonly users = new Map<string, User>([
    ['u1', { id: 'u1', firstName: 'Ann', lastName: 'Lee', email: 'ann@x.io', createdAt: new Date(0) }],
  ]);

  async findOne(id: string): Promise<User> {
    const user = this.users.get(id);
    if (!user) throw new NotFoundException();
    return user;
  }
}

export interface UserV1Dto {
  id: string;
  name: string;
  email: string;
}

export interface UserV2Dto {
  id: string;
  firstName: string;
  lastName: string;
  emailAddress: string;
  createdAt: string;
}

/** Illustrative: announce the real date with the v2 release and keep it in one place. */
const V1_DEPRECATED_AT = new Date('2026-11-01T00:00:00Z');
const V1_SUNSET_AT = new Date('2027-11-01T00:00:00Z');

/** RFC 9745 Deprecation + RFC 8594 Sunset headers on every v1 response. */
@Injectable()
export class V1DeprecationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Deprecation', `@${V1_DEPRECATED_AT.getTime() / 1000}`);
    response.setHeader('Sunset', V1_SUNSET_AT.toUTCString());
    response.setHeader('Link', '</v2/users>; rel="successor-version"');
    return next.handle();
  }
}

@Controller({ path: 'users', version: '1' })
@UseInterceptors(V1DeprecationInterceptor)
export class UsersV1Controller {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<UserV1Dto> {
    const user = await this.users.findOne(id);
    return { id: user.id, name: `${user.firstName} ${user.lastName}`, email: user.email };
  }
}

@Controller({ path: 'users', version: '2' })
export class UsersV2Controller {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<UserV2Dto> {
    const user = await this.users.findOne(id);
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      emailAddress: user.email,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
```

```typescript
// Routes that don't change between versions
@Controller({ path: 'status', version: VERSION_NEUTRAL })
export class StatusController {
  @Get()
  status(): { ok: true } {
    return { ok: true };
  }
}
```

Probe results: `GET /v1/users/u1` → `{"id":"u1","name":"Ann Lee","email":"ann@x.io"}` with `Deprecation: @1793491200` and `Sunset: Mon, 01 Nov 2027 00:00:00 GMT`; `GET /v2/users/u1` → the v2 shape without those headers; `/v3/users/u1` → 404; `/status` → 200 while `/v2/status` → 404. With URI versioning a versioned route exists only under its prefix, so unversioned `/users/u1` is 404; `defaultVersion` only assigns a version to controllers that declare none. The dates are illustrative: set them when v2 ships, give clients a migration window, and remove v1 only after its traffic is gone. Response DTOs and serialization: `api-use-dto-serialization`.

Reference: [NestJS Versioning](https://docs.nestjs.com/techniques/versioning)

---

## 8. Microservices

**Section Impact: MEDIUM**

### 8.1 Implement Health Checks for Microservices

**Impact: MEDIUM-HIGH** — Health checks enable orchestrators to manage service lifecycle

Expose liveness and readiness with `@nestjs/terminus`. Liveness answers "is the process stuck?" and restarts the container when it fails, so it checks no dependencies: a database outage that fails liveness restarts every pod at once and fixes nothing. Readiness answers "can this instance serve traffic now?" and checks the dependencies every request needs, each with a timeout shorter than the probe's. Check each dependency with its own protocol: Redis speaks RESP, so `HttpHealthIndicator.pingCheck('redis', 'http://redis:6379')` fails against a healthy server; use the Redis client's `PING`. Keep third-party APIs out of readiness: their outage would take every instance out of the load balancer while the endpoints that don't need them could still serve.

**Incorrect (static OK; Redis probed over HTTP; dependencies in liveness):**

```typescript
@Get('health')
check(): string {
  return 'OK'; // 200 while the database is unreachable
}

@Get('live')
@HealthCheck()
liveness() {
  return this.health.check([() => this.db.pingCheck('database')]); // a DB outage restarts every pod
}

@Get('ready')
@HealthCheck()
readiness() {
  return this.health.check([
    () => this.http.pingCheck('redis', 'http://redis:6379'), // not HTTP: always down
    () => this.http.pingCheck('payments', 'https://api.payments.example/health'), // a third party's outage drains you
  ]);
}
```

**Correct (`health/redis.health.ts`):**

```typescript
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { Redis } from 'ioredis';

/** Redis speaks RESP, not HTTP: check it with the client's own PING. */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redis: Redis,
    private readonly health: HealthIndicatorService,
  ) {}

  pingCheck(key: string) {
    return this.health
      .check(key)
      .attempt(async () => {
        await this.redis.ping();
      })
      .withTimeout(1000);
  }
}
```

**Correct (`health/health.controller.ts`):**

```typescript
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /** Liveness: the process answers. No dependencies, or one outage restarts every pod at once. */
  @Get('live')
  @HealthCheck()
  liveness() {
    return this.health.check([]);
  }

  /** Readiness: can this instance serve traffic right now? */
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.db.pingCheck('database').withTimeout(1000),
      () => this.redis.pingCheck('redis'),
    ]);
  }
}
```

**Correct (`health/health.module.ts`):**

```typescript
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import type { Env } from '../config/env.validation.js';
import { HealthController } from './health.controller.js';
import { RedisHealthIndicator } from './redis.health.js';

@Module({
  imports: [
    TerminusModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        // On SIGTERM: every health check answers 503 "shutting_down", then shutdown waits this long
        gracefulShutdownTimeoutMs: config.get('SHUTDOWN_DRAIN_MS', { infer: true }),
      }),
    }),
  ],
  controllers: [HealthController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
```

`Redis` is the shared client from `perf-async-hooks`. Custom indicators use `HealthIndicatorService`: `@nestjs/terminus` 12.1.0 no longer exports the `HealthIndicator` base class or `HealthCheckError` that older examples extend and throw. `check(key).attempt(fn).withTimeout(ms)` marks the key `down` when `fn` throws or runs past the timeout; the built-in indicators return the same attempt, and `pingCheck(key, { timeout })` is deprecated in 12.1.0 in favour of `.withTimeout(ms)`. `SHUTDOWN_DRAIN_MS` is a validated `Env` key (`Joi.number().integer().min(0).default(10_000)`, `devops-use-config-module`): `abc` stopped startup with `Config validation error: SHUTDOWN_DRAIN_MS: "SHUTDOWN_DRAIN_MS" must be a number`, and unset it drained 10000 ms. In the probe (better-sqlite3 database, Redis 8.10.2), `/health/ready` returned 200 with `{"database":{"status":"up"},"redis":{"status":"up"}}` (plus `responseTime`); against a stub that answered `PING` after 3 s it returned 503 after 1022 ms with `{"redis":{"message":"timeout of 1000ms exceeded","responseTime":1003,"status":"down"}}`. `gracefulShutdownTimeoutMs` turns both endpoints into 503 `shutting_down` on `SIGTERM`; the shutdown sequence is `devops-graceful-shutdown`.

### Kubernetes Configuration

```yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30 # > SHUTDOWN_DRAIN_MS + the longest request
      containers:
        - name: api
          image: api-service:1.4.2
          ports:
            - containerPort: 3000
          startupProbe:
            httpGet: { path: /health/live, port: 3000 }
            periodSeconds: 5
            failureThreshold: 30
          livenessProbe:
            httpGet: { path: /health/live, port: 3000 }
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /health/ready, port: 3000 }
            periodSeconds: 5
            timeoutSeconds: 3 # above the 1 s indicator timeouts
            failureThreshold: 2
```

Reference: [NestJS Terminus](https://docs.nestjs.com/recipes/terminus)

---

### 8.2 Use Message and Event Patterns Correctly

**Impact: MEDIUM** — Proper patterns ensure reliable microservice communication

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

---

### 8.3 Use Message Queues for Background Jobs

**Impact: MEDIUM-HIGH** — Queues enable reliable background processing

Move slow or failure-prone work (reports, mail, imports) out of the request into `@nestjs/bullmq`: the request enqueues and returns, a worker processes, and BullMQ re-runs failed attempts. This rule covers the BullMQ mechanics. What to retry, how often, and what happens to work that never succeeds is `nestjs-resilience`: queued work gets one retry layer (BullMQ's `attempts`/`backoff`, not a retrying policy inside `process()` as well), and the final failure becomes a durable dead letter (`dlq-record-final-failure`). BullMQ delivers at least once: a worker that dies mid-job leaves it stalled and another worker runs it again, so processors must be idempotent (`idempotency-processed-events`).

**Incorrect (work in the request; colon in a job id; final failure only logged; error text in fields; open board):**

```typescript
@Post()
async generate(@Body() dto: GenerateReportDto): Promise<Report> {
  return this.reports.build(dto); // minutes inside the request; the client times out
}

await this.queue.add('send', { userId }, { jobId: `welcome:${userId}` }); // rejects: "Custom Id cannot contain :"

@OnWorkerEvent('failed')
onFailed(job: Job, error: Error) {
  this.logger.warn('Job attempt failed', { jobId: job.id, error: error.message }); // message in fields, stack lost
  // after the last attempt nothing is kept but the failed job, and removeOnFail: 5000 deletes it eventually
}

BullBoardModule.forRoot({ route: '/admin/queues', adapter: ExpressAdapter }); // anyone can read payloads, retry and delete jobs
```

**Correct (`queues/queue.module.ts`):**

```typescript
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReportsProcessor, ReportsService, WelcomeMailProcessor, WelcomeMailService } from './queues.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('REDIS_URL') },
        defaultJobOptions: {
          // Attempts and backoff are the retry policy for queued work (nestjs-resilience); no second retry layer inside process()
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 1000,
          removeOnFail: false, // a failed job is removed only once its dead letter is stored (ReportsProcessor.onFailed)
        },
      }),
    }),
    BullModule.registerQueue({ name: 'reports' }, { name: 'welcome-mail' }),
  ],
  providers: [ReportsService, ReportsProcessor, WelcomeMailService, WelcomeMailProcessor],
})
export class QueueModule {}
```

**Correct (`queues/queues.ts`):**

```typescript
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { DeadLetterStore } from '../dead-letter/dead-letter.store.js';
import { ReportBuilder } from './report-builder.js';
import { WelcomeMailer } from './welcome-mailer.js';

export interface GenerateReport {
  reportId: string;
  ownerId: string;
  urgent: boolean;
}

export interface ReportStatus {
  state: string;
  progress: Job['progress'];
}

const toError = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));

@Injectable()
export class ReportsService {
  constructor(@InjectQueue('reports') private readonly reports: Queue<GenerateReport>) {}

  /** The report row exists already; its id is the job id, so a repeated request adds no second job. */
  async requestReport(request: GenerateReport): Promise<{ jobId: string }> {
    await this.reports.add('generate', request, { jobId: request.reportId, priority: request.urgent ? 1 : 10 });
    return { jobId: request.reportId };
  }

  async status(jobId: string): Promise<ReportStatus> {
    const job = await this.reports.getJob(jobId);
    if (!job) throw new NotFoundException();
    return { state: await job.getState(), progress: job.progress };
  }
}

@Processor('reports')
export class ReportsProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportsProcessor.name);
  /** Final failures whose dead letter is stored: only these failed jobs may be removed. */
  private readonly deadLettered = new Set<string>();

  constructor(
    private readonly builder: ReportBuilder,
    private readonly deadLetters: DeadLetterStore,
  ) {
    super();
  }

  async process(job: Job<GenerateReport>): Promise<void> {
    try {
      await this.builder.build(job.data.reportId, (percent) => job.updateProgress(percent));
    } catch (error) {
      const err = toError(error);
      // attemptsMade counts earlier failed attempts: this is the last one when it reaches attempts - 1
      const final = err instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (final && job.id) {
        // A rejecting store fails the job with the store's error; the failed job stays as the only copy
        await this.deadLetters.record({
          key: `reports:${job.data.reportId}`,
          attempts: job.attemptsMade + 1,
          lastError: err.message,
          failedAt: new Date(),
          payload: job.data,
        });
        this.deadLettered.add(job.id);
      }
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<GenerateReport> | undefined, error: Error): Promise<void> {
    const fields = { jobId: job?.id, attempt: job?.attemptsMade };
    if (job && job.finishedOn === undefined) {
      this.logger.warn('Report job attempt failed, will retry', fields, error);
      return;
    }
    this.logger.error('Report job failed', fields, error);
    if (!job?.id || !this.deadLettered.delete(job.id)) return; // no dead letter: keep the failed job
    try {
      await job.remove();
    } catch (removeError) {
      this.logger.warn('Dead-lettered job not removed', fields, toError(removeError));
    }
  }
}

/** Payload holds ids, not personal data: job data is visible in Redis and in Bull Board. */
export interface SendWelcome {
  userId: string;
}

@Injectable()
export class WelcomeMailService {
  constructor(@InjectQueue('welcome-mail') private readonly queue: Queue<SendWelcome>) {}

  /** Custom job ids must not contain ':' (BullMQ rejects them); a repeated enqueue for the same user adds no second job. */
  async enqueue(userId: string): Promise<void> {
    await this.queue.add('send', { userId }, { jobId: `welcome-${userId}`, attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
  }
}

@Processor('welcome-mail')
export class WelcomeMailProcessor extends WorkerHost {
  constructor(private readonly mailer: WelcomeMailer) {
    super();
  }

  /** At-least-once: a stalled job runs again, so send() must skip users it already mailed. */
  async process(job: Job<SendWelcome>): Promise<void> {
    await this.mailer.send(job.data.userId);
  }
}
```

**Correct (`queues/queue-board.module.ts`, never public):**

```typescript
import { createHash, timingSafeEqual } from 'node:crypto';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { BullBoardModule } from '@bull-board/nestjs';
import { Injectable, Module, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';

/** Fixed-length digests: the comparison takes the same time whatever the header's length. */
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Basic auth for the board; behind SSO or a reverse-proxy policy, check that identity here instead. */
@Injectable()
export class QueueBoardAuth implements NestMiddleware {
  private readonly expected: Buffer;

  constructor(config: ConfigService) {
    const credentials = `${config.getOrThrow<string>('QUEUE_BOARD_USER')}:${config.getOrThrow<string>('QUEUE_BOARD_PASSWORD')}`;
    this.expected = digest(`Basic ${Buffer.from(credentials).toString('base64')}`);
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (timingSafeEqual(digest(req.headers.authorization ?? ''), this.expected)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="queues"').status(401).end();
  }
}

@Module({
  imports: [
    BullBoardModule.forRoot({ route: '/admin/queues', adapter: ExpressAdapter, middleware: QueueBoardAuth }),
    BullBoardModule.forFeature({ name: 'reports', adapter: BullMQAdapter }, { name: 'welcome-mail', adapter: BullMQAdapter }),
  ],
})
export class QueueBoardModule {}
```

Probe results (Redis 8.10.2, `bullmq` 6.5.1, `@nestjs/bullmq` 12.0.0, `@bull-board/*` 9.10.5): `jobId: 'welcome:u1'` rejected with `Custom Id cannot contain :`; `welcome-u1` was accepted and processed. Requesting a report twice left one job. A builder that always threw ran 3 times and logged `warn` `Report job attempt failed, will retry` for attempts 1 and 2, then `error` `Report job failed` `{ jobId, attempt: 3 }` with `Error('boom 3')`; the store held one dead letter `{"key":"reports:r2","attempts":3,"lastError":"boom 3"}` and the failed job was gone. With a store whose `record()` threw `dead-letter table locked`, the job stayed in state `failed` with that `failedReason` and no dead letter existed. An `UnrecoverableError` failed after one attempt with one dead letter and one `error` log. The board answered 401 without credentials, with a wrong password and with a longer header, and 200 with the right ones (UI and `/admin/queues/api/queues`). `DeadLetterStore` is the injectable store from `nestjs-resilience`; back it with a migrated table so dead letters survive Redis eviction. If the process dies between `record()` and `job.remove()`, both copies remain, never neither.

Bull Board shows every job's payload and can retry, promote and delete jobs: put it behind your admin authentication (or a reverse-proxy policy) and never route it publicly. Keep personal data out of payloads (ids, not email addresses); Redis and the board keep job data until removal.

`@nestjs/bullmq` consumers extend `WorkerHost` and implement one `process(job)` per queue, dispatching on `job.name` when a queue carries several job types; `@Process()` belongs to the older `@nestjs/bull`. Repeating jobs are job schedulers upserted by id (`queue.upsertJobScheduler('daily-cleanup', { pattern: '0 0 * * *' }, { name: 'cleanup' })`), which stays one scheduler per id across restarts and instances; `RepeatOptions` has `pattern`, not `cron`. Every queue a producer or consumer uses must be registered with `BullModule.registerQueue`. A producer that must not delay the response doesn't leave `enqueue()` unawaited: it calls a `dispatch(): void` that tracks the promise for `drain()` and ends it in a terminal `.catch` (`nestjs-resilience` rule `dlq-record-final-failure`). Workers close at shutdown: `devops-graceful-shutdown`. Log levels and call shape: `nestjs-logging`.

Reference: [NestJS Queues](https://docs.nestjs.com/techniques/queues), [BullMQ Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs)

---

## 9. DevOps & Deployment

**Section Impact: LOW-MEDIUM**

### 9.1 Implement Graceful Shutdown

**Impact: MEDIUM-HIGH** — Proper shutdown handling ensures zero-downtime deployments

On `SIGTERM` the instance must stop receiving new traffic, finish what is in flight, then release resources, in that order. One owner handles the signal: `app.enableShutdownHooks()` in `main.ts`. A second `process.on('SIGTERM')` handler that calls `server.close()` / `app.close()` / `process.exit()` races Nest's own sequence and can exit while hooks still run. Nest's sequence on a signal is `onModuleDestroy` → `beforeApplicationShutdown` → close the HTTP server (waits for in-flight requests) → `onApplicationShutdown` → re-raise the signal. The load balancer only stops routing after readiness fails, so readiness has to fail first and the HTTP server must keep serving for a bounded drain period: that is `beforeApplicationShutdown`.

**Incorrect (own signal handler; readiness flipped during teardown; hand-closed connections):**

```typescript
process.on('SIGTERM', () => {
  server.close(async () => {
    await app.close();
    process.exit(0); // a second shutdown path next to enableShutdownHooks()
  });
});

@Injectable()
export class AppShutdownService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    this.shutdownService.startShutdown(); // the HTTP server is already closed: too late to drain
    await sleep(5000);
  }
}

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly connections: Connection[] = []; // TypeORM 1.x has no Connection; @nestjs/typeorm owns the DataSource
}
```

**Correct (`src/main.ts`, the shutdown line; the whole file is `nestjs-logging` rule `setup-json-console-logger`):**

```typescript
const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger });
configureApp(app);
app.enableShutdownHooks(); // the only SIGTERM/SIGINT listener: runs the shutdown hooks, then re-raises the signal
await app.listen(process.env.PORT ?? 3000);
```

**Correct (readiness fails, then a bounded drain; `health/health.module.ts` from `micro-use-health-checks`):**

```typescript
TerminusModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => ({
    // On SIGTERM: every health check answers 503 "shutting_down", then shutdown waits this long
    gracefulShutdownTimeoutMs: config.get('SHUTDOWN_DRAIN_MS', { infer: true }), // validated integer >= 0, default 10000
  }),
}),
```

`@nestjs/terminus` 12.1.0 does both steps in its own `beforeApplicationShutdown`: it marks every health check `shutting_down` (503) and, on `SIGTERM` only, waits `gracefulShutdownTimeoutMs`. `app.close()` in tests skips the wait. In the probe (built app, `SHUTDOWN_DRAIN_MS=1500`), a 2.5 s request was started, then `SIGTERM` sent: `/health/ready` answered `503 {"status":"shutting_down",…}` 0.3 s later while normal routes still answered, the log showed `Awaiting 1500ms before shutdown`, the slow request completed with `200 {"done":true}` 2.30 s after the signal, and the process then exited with code 143 (the re-raised `SIGTERM`). `SHUTDOWN_DRAIN_MS` comes from the validated `Env` (`devops-use-config-module`), so a non-integer or negative value stops startup instead of reaching Terminus as `NaN`. Set the drain longer than the readiness probe's `periodSeconds × failureThreshold`, and `terminationGracePeriodSeconds` longer than the drain plus the slowest request; Kubernetes sends `SIGKILL` when it runs out.

Nest runs `beforeApplicationShutdown` module by module and awaits each: in the probe, a hook in `AppModule` ran before Terminus's. A hook that awaits long work there delays the readiness flip, so keep those hooks short or bounded.

What each resource does at shutdown, and who owns it:
- **Database:** `@nestjs/typeorm` destroys its `DataSource` in `onApplicationShutdown`; don't close it yourself (`nestjs-typeorm`).
- **Clients you create** (Redis, brokers): close them in `onApplicationShutdown`, after the HTTP server has stopped (`perf-async-hooks`); closing in `onModuleDestroy` breaks requests that are still draining.
- **Scheduled jobs:** await the running job in `beforeApplicationShutdown` (`nestjs-schedule` rule `lifecycle-drain-on-shutdown`).
- **BullMQ workers:** `@nestjs/bullmq` 12.0.0 calls `worker.close()` in `onApplicationShutdown`, which waits for active jobs; a job cut off by `SIGKILL` is picked up again as stalled, so processors must be idempotent (`micro-use-queues`).
- **Process handlers** (`uncaughtException`, `unhandledRejection`) log `fatal` and exit non-zero: `error-handle-async-errors`.

Reference: [NestJS Lifecycle Events](https://docs.nestjs.com/fundamentals/lifecycle-events), [NestJS Terminus](https://docs.nestjs.com/recipes/terminus)

---

### 9.2 Use ConfigModule for Environment Configuration

**Impact: LOW-MEDIUM** — Proper configuration prevents deployment failures

Read configuration through `@nestjs/config`, validate every variable once at startup, and give consumers typed access that cannot return `undefined`. Scattered `process.env` reads fail late (`parseInt(undefined)` is `NaN`, a typo is `undefined`) and differ between services. An untyped `ConfigService.get<number>('app.port')` is `number | undefined` under `strict`, so returning it as `number` does not compile, and casting it away moves the failure to runtime. Database settings are not part of this rule: TypeORM reads them in the one `src/data-source.ts` shared by the CLI and `forRootAsync` (`nestjs-typeorm` rule `orm-single-data-source`); a second inline `TypeOrmModule.forRootAsync({ type: 'postgres', … })` here would drift from what migrations run against.

**Incorrect (direct env access; untyped getters):**

```typescript
@Injectable()
export class MailService {
  private readonly apiKey = process.env.MAIL_API_KEY || 'default'; // a typo or a missing variable goes unnoticed
}

@Injectable()
export class AppService {
  constructor(private readonly config: ConfigService) {}

  getPort(): number {
    return this.config.get<number>('app.port'); // TS2322: Type 'number | undefined' is not assignable to type 'number'
  }
}
```

**Correct (`config/env.validation.ts`):**

```typescript
import Joi from 'joi';

/** Every variable the app reads, as the validated (converted, defaulted) values. */
export interface Env {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  REDIS_URL: string;
  JWT_SECRET: string;
  MAIL_API_KEY: string;
  MAIL_FROM: string;
  SHUTDOWN_DRAIN_MS: number;
}

export const envSchema = Joi.object<Env, true>({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3000),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
  JWT_SECRET: Joi.string().min(32).required(),
  MAIL_API_KEY: Joi.string().required(),
  MAIL_FROM: Joi.string().email().required(),
  SHUTDOWN_DRAIN_MS: Joi.number().integer().min(0).default(10_000), // micro-use-health-checks
});
```

**Correct (`config/mail.config.ts`):**

```typescript
import { registerAs } from '@nestjs/config';

/** Namespaced settings for one feature; runs after validation, so the variables are present. */
export const mailConfig = registerAs('mail', () => ({
  apiKey: process.env.MAIL_API_KEY ?? '',
  from: process.env.MAIL_FROM ?? '',
}));
```

**Correct (`app.module.ts`):**

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema } from './config/env.validation.js';
import { mailConfig } from './config/mail.config.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [mailConfig],
      validationSchema: envSchema,
    }),
  ],
})
export class AppModule {}
```

**Correct (typed access):**

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService, type ConfigType } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import { mailConfig } from '../config/mail.config.js';

@Injectable()
export class TokenService {
  // `true`: the schema guarantees every key, so get() returns Env[K], never undefined
  constructor(private readonly config: ConfigService<Env, true>) {}

  secret(): string {
    return this.config.get('JWT_SECRET', { infer: true });
  }

  port(): number {
    return this.config.get('PORT', { infer: true });
  }
}

@Injectable()
export class MailService {
  constructor(@Inject(mailConfig.KEY) private readonly mail: ConfigType<typeof mailConfig>) {}

  sender(): string {
    return this.mail.from;
  }
}
```

`@nestjs/config` 12.0.1 validates `validationSchema` through Standard Schema and defaults Joi to `abortEarly: false, allowUnknown: true`, so one start reports every problem; Joi 18.3.1 implements the interface. `ConfigModule.forRoot()` is async and runs when `AppModule` is imported, so `main.ts` fails before `NestFactory.create` resolves. With four bad variables the probe failed with `Config validation error: REDIS_URL: "REDIS_URL" must be a valid uri with a scheme matching the redis|rediss pattern` followed by one line each for `JWT_SECRET` (too short), `MAIL_API_KEY` and `MAIL_FROM` (required). With valid values and no `PORT`, `config.get('PORT', { infer: true })` returned the number `3000` (the validated, converted value; `process.env.PORT` stays a string), and the injected `mailConfig` returned `noreply@example.com`. The `?? ''` in `mailConfig` only satisfies the compiler; validation has already guaranteed both variables. Secrets come from the environment or a secret store, never from committed `.env` files.

Reference: [NestJS Configuration](https://docs.nestjs.com/techniques/configuration)

---

## References

- https://docs.nestjs.com
- https://github.com/nestjs/nest
- https://typeorm.io
- https://github.com/typestack/class-validator
- https://github.com/goldbergyoni/nodebestpractices

---

*Generated by build-agents.ts on 2026-10-30*
