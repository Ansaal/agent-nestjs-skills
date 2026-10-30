---
title: Test Expiry and Takeover With a ManualLockClock per Instance and a Shared In-Memory Store
impact: MEDIUM
impactDescription: Slow real-time sleeps, or tests that never see a lock expire
tags: locks, testing, ManualLockClock, InMemoryLockStore, expiry, takeover, vitest
---

## Test Expiry and Takeover With a ManualLockClock per Instance and a Shared In-Memory Store

Lock timing runs on a `LockClock`: lease deadlines, renewals every `ttl / 3`, `wait` polling, and the in-memory store's expiry. `ManualLockClock` (exported from `@nestjs/locks`) moves only when a test calls `await clock.advance(duration)`, firing every due timer in order and waiting for each renewal to reach the store. Give it to the module's options (`LocksModule.forRoot({ clock })`, or in a test `overrideProvider(LOCKS_MODULE_OPTIONS)`, which replaces the whole options object); test the code that uses locks against an `InMemoryLockStore`, and the durable store separately with the contract suite (`store-contract-suite`).

The trap is one clock for everything: the holder's renewals fire as the clock advances, so its lock never expires. With one shared clock, `advance('31s')` past a 30 s `ttl` left the lock with instance A and instance B's `acquire()` resolved `null`. A paused process is an instance whose clock does not move while the store's does: give each simulated instance its own `ManualLockClock`, give the shared store another, and register that store in every instance in place of the production store. Then B took the key with a greater token, and when A's clock moved its renewal was refused and `lockA.signal.reason` was a `LockLostError` with `detectedBy: 'renewal'`. Both tests run in milliseconds; the real-time alternative sleeps past `ttl`.

**Incorrect (one clock for both instances and the store):**

```typescript
const clock = new ManualLockClock();
const store = new InMemoryLockStore({ clock });
const [a, b] = [await instance(clock, store), await instance(clock, store)];
await a.get(Locks).acquire('stock:reconcile', { ttl: '30s' });
await clock.advance('31s'); // A renewed at 10 s, 20 s and 30 s
expect(await b.get(Locks).acquire('stock:reconcile')).not.toBeNull(); // fails: null
```

**Correct (`test/lock-expiry.e2e-spec.ts`):**

```typescript
import { InMemoryLockStore, LOCKS_MODULE_OPTIONS, LockLostError, Locks, LocksStorage, ManualLockClock } from '@nestjs/locks';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TypeOrmLockStore } from '../src/distributed-locks/typeorm-lock-store.js';
import { createTestApp } from './support/test-app.js';

/** One simulated app instance: the real AppModule, its locks on `clock`, its store the one all instances share. */
function instance(clock: ManualLockClock, store: InMemoryLockStore): Promise<NestExpressApplication> {
  return createTestApp((builder) =>
    builder
      .overrideProvider(LOCKS_MODULE_OPTIONS)
      .useValue({ ttl: '30s', clock })
      // Registers the shared store instead of the production one (store-register-durable).
      .overrideProvider(TypeOrmLockStore)
      .useFactory({ factory: (storage: LocksStorage) => storage.registerSource(store), inject: [LocksStorage] }),
  );
}

describe('stock:reconcile lock across instances', () => {
  const apps: NestExpressApplication[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  it('keeps a lock its holder renews', async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });
    apps.push(await instance(clock, store));

    const lock = (await apps[0].get(Locks).acquire('stock:reconcile', { ttl: '30s' }))!;
    await clock.advance('5m'); // renewals every 10 s fire on the way

    expect(lock.held).toBe(true);
    expect(store.peek('stock:reconcile')?.fencingToken).toBe(lock.fencingToken);
  });

  it('hands the lock to another instance when the holder pauses past its ttl', async () => {
    const storeClock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock: storeClock });
    const clockA = new ManualLockClock();
    const clockB = new ManualLockClock();
    apps.push(await instance(clockA, store), await instance(clockB, store));

    const lockA = (await apps[0].get(Locks).acquire('stock:reconcile', { ttl: '30s' }))!;
    await storeClock.advance('31s'); // A is paused: its clock stands still, so no renewal reaches the store
    const lockB = (await apps[1].get(Locks).acquire('stock:reconcile', { ttl: '30s' }))!;
    expect(lockB.fencingToken).toBeGreaterThan(lockA.fencingToken);

    await clockA.advance('10s'); // A resumes: its renewal is refused
    expect(lockA.held).toBe(false);
    expect(lockA.signal.reason).toBeInstanceOf(LockLostError);
    expect(lockA.signal.reason).toMatchObject({ key: 'stock:reconcile', detectedBy: 'renewal' });
  });
});
```

`InMemoryLockStore#peek(key)` returns the live lock (`{ owner, fencingToken, expiresAt }`) or `undefined`, for assertions. The same setup drives `@LeaderElection()` takeovers (`leader-election-hooks`). `createTestApp()` is `nestjs-testing`'s helper; the overrides run before `compile()`, so the provider that registers the store in production never runs and the shared store is the only one. `ManualLockClock` replaces only the package's clock; `@nestjs/schedule` timers in the same test need Vitest fake timers (`nestjs-schedule`).

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)
