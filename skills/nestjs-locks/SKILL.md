---
name: nestjs-locks
description: Distributed locks for NestJS with `@nestjs/locks`. Use when a scheduled job must not overlap itself or must run on one instance, when code needs a lock with a fencing token, when registering or testing a durable `LockStore`, or when one instance at a time must lead continuous work.
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS Locks

How a Nest app excludes concurrent work across instances with `@nestjs/locks`: one durable, atomic `LockStore` proven by the package's contract suite, `@WithoutOverlapping()` and `@OnOneInstance()` on scheduled jobs with explicit keys, `acquire()`/`withLock()` in code with fencing tokens on every write the lock guards, `@LeaderElection()` for continuous work, and `ManualLockClock` for deterministic tests of expiry and takeover. Verified 2026-10-29 against NestJS 12.3.2, @nestjs/locks 0.0.5, @nestjs/schedule 12.0.2, TypeORM 1.1.2 with better-sqlite3 12.11.1 (SQLite 3.53.2), TypeScript 6.0.3, Vitest 5.0.5 on Node 24.22.2.

`@Cron()`, `@Interval()`, `@Timeout()`, `SchedulerRegistry` and timers in tests are `nestjs-schedule`; `TransactionRunner`, migrations and guarded writes are `nestjs-typeorm` (`orm-atomic-writes`); retries, circuit breakers and dead letters are `nestjs-resilience`; log levels and logger setup are `nestjs-logging`; test structure and `createTestApp()` are `nestjs-testing`; the Vitest config is `nestjs-setup`.

## Rules
| Prefix | Section | Impact |
|--------|---------|--------|
| `store-` | Lock Store | CRITICAL |
| `job-` | Scheduled Jobs | HIGH |
| `lock-` | Ad-hoc Locks | HIGH |
| `leader-` | Leader Election | MEDIUM |
| `test-` | Testing Locks | MEDIUM |

### 1. Lock Store (CRITICAL)

- `store-register-durable` - Register one durable `LockStore` provider through `LocksStorage.registerSource(this)` on a store every instance shares; the in-memory default excludes one process only; SQLite only for processes on one host sharing a local file, PostgreSQL or Redis across hosts
- `store-atomic-statements` - `acquire`/`renew`/`release` are single compare-and-set statements on the store's clock; tokens never reset; on SQLite use `RETURNING` and the `TransactionRunner`, keep queued transactions well below `2·ttl/3` and `storeTimeout`, and take locks outside `run()`
- `store-contract-suite` - Prove the store with `lockStoreContract(() => store, { concurrent: true })`; expiry cases on a database clock wait in real time

### 2. Scheduled Jobs (HIGH)

- `job-without-overlapping` - `@WithoutOverlapping()` stops overlapping runs on every instance; `@OnOneInstance()` only pins the job to one instance
- `job-explicit-keys` - Set a stable `key` on every job; a key `k` also claims `k:owner`, and collisions fail at startup
- `job-direct-calls` - A decorated method is a lock wrapper: direct calls skip (resolve `undefined`) while the key is held; test the work through an undecorated method that reports a fenced write instead of logging success

### 3. Ad-hoc Locks (HIGH)

- `lock-acquire-release` - `acquire()` resolves `Lock | null`, `withLock()` rejects with `LockNotAcquiredError`; release in `finally` or with `await using`
- `lock-fencing-tokens` - Pass `lock.fencingToken` to every write the lock guards and reject lower tokens; write one logical update as one all-or-nothing snapshot; pass `lock.signal` to the calls

### 4. Leader Election (MEDIUM)

- `leader-election-hooks` - `@LeaderElection(key)` for continuous work: return its promise from `onLeadershipAcquired(lock)` so a failure steps down, stop it on `lock.signal`

### 5. Testing Locks (MEDIUM)

- `test-manual-lock-clock` - Simulate instances with `createTestApp()`, one `ManualLockClock` each and a shared `InMemoryLockStore` on its own clock to test expiry, takeover and loss

Read `rules/<id>.md` for the rule's reasoning and examples.
