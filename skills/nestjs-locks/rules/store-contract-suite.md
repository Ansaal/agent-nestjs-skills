---
title: Prove a Lock Store With the Package's Contract Suite
impact: HIGH
impactDescription: Races, token resets and clock bugs ship unnoticed in a hand-written store
tags: locks, lock-store, testing, contract, vitest, concurrency
---

## Prove a Lock Store With the Package's Contract Suite

`@nestjs/locks/testing` exports `lockStoreContract(createStore, options)`, which returns runner-agnostic cases (`{ name, run }`); register each as a test. With `concurrent: true` there are 16: 10 behaviour cases (exclusive acquire, owner-only release and renew, expiry measured from the call in milliseconds, takeover with a greater token, tokens growing across release and expiry, exact key separation, 30-day durations) and 6 races with 16 callers each. Hand-written tests rarely cover the races: a read-then-write store passes a sequential acquire/release test and fails `concurrency: of 16 callers acquiring a free key at once, exactly one wins` with `16 of 16 concurrent callers acquired the key`; a store that deletes on release fails `fencing tokens must grow: 1 after 1` (`store-atomic-statements`).

The expiry cases need the store's clock to move. A store on a database or Redis clock can't be faked with `vi.useFakeTimers()`, so the cases wait in real time with a 2.5 s `ttl`: against SQLite the 8 timed cases took 2.9 to 4.2 s each and the file 25 s, above Vitest's 5 s default per test. Give each case a 30 s timeout. The in-memory store takes `advanceTime` and finishes the 16 cases in milliseconds.

**Incorrect (two hand-written cases, no races, no expiry):**

```typescript
it('acquires and releases', async () => {
  const store = app.get(TypeOrmLockStore);
  expect(await store.acquire('k', 'a', 1_000)).toMatchObject({ acquired: true });
  expect(await store.acquire('k', 'b', 1_000)).toEqual({ acquired: false });
  expect(await store.release('k', 'a')).toBe(true);
});
```

**Correct (`test/typeorm-lock-store.e2e-spec.ts`, the store from the real app):**

```typescript
import { lockStoreContract } from '@nestjs/locks/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TypeOrmLockStore } from '../src/distributed-locks/typeorm-lock-store.js';
import { createTestApp } from './support/test-app.js';

describe('TypeOrmLockStore', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    app = await createTestApp();
    return () => app.close();
  });

  // The store measures expiry on SQLite's clock, which fake timers can't move: the expiry cases wait in real time.
  for (const contractCase of lockStoreContract(() => app.get(TypeOrmLockStore), { concurrent: true })) {
    it(contractCase.name, () => contractCase.run(), 30_000);
  }
});
```

**Correct (in-memory store on a manual clock, for comparison or a store double):**

```typescript
import { InMemoryLockStore, ManualLockClock } from '@nestjs/locks';
import { lockStoreContract } from '@nestjs/locks/testing';

describe('InMemoryLockStore on a ManualLockClock', () => {
  const clock = new ManualLockClock();
  const store = new InMemoryLockStore({ clock });
  for (const contractCase of lockStoreContract(() => store, { advanceTime: (ms) => clock.advance(ms), concurrent: true })) {
    it(contractCase.name, () => contractCase.run());
  }
});
```

`createStore` runs once per case, after `beforeEach` booted that case's app, so each case gets the store of a fresh app and database. `createTestApp()` boots the real `AppModule` (`nestjs-testing`), so the migration and the `TransactionRunner` are the production ones. On one better-sqlite3 connection the races are serialized by the runner, which the suite accepts as a valid run; run them against a pooled server database too when the store targets one. Raise `ttl` (default 2500 ms) for a remote store whose round trips are slow, or the expiry cases turn flaky. The `.e2e-spec.ts` file is picked up by the single Vitest config from `nestjs-setup`.

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)
