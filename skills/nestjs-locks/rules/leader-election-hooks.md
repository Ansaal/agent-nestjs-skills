---
title: Run Continuous Single-Instance Work From @LeaderElection Hooks, Stopped by the Lease Signal
impact: MEDIUM
impactDescription: Two instances consume the same stream after a leader pauses or loses its lease
tags: locks, leader-election, LeaderElection, OnLeadershipAcquired, signal, fencing-token
---

## Run Continuous Single-Instance Work From @LeaderElection Hooks, Stopped by the Lease Signal

`@LeaderElection(key, { ttl })` on a singleton provider makes every instance campaign for the lease `key` from `onApplicationBootstrap`. The winner's `onLeadershipAcquired(lock)` runs (logged `Leading "warehouse-feed" (fencing token 1)`); the leader renews every `ttl / 3`, the others retry as often. It fits work that runs continuously on one instance (a feed consumer, a socket to a partner); a periodic job belongs on `@OnOneInstance()` and `@WithoutOverlapping()` (`job-without-overlapping`).

Leadership ends three ways, each observed in the probe with two app instances sharing an `InMemoryLockStore` (`test-manual-lock-clock`):

- Shutdown: `app.close()` stepped down (`Stepped down from "warehouse-feed"`, then `Warehouse feed stopped` from the hook), `lock.signal` aborted with an `AbortError` `DOMException`, and the other instance led after its next campaign, one `ttl / 3` later, with fencing token 2.
- Lease lost: a leader whose renewals stopped for longer than `ttl` was replaced (token 2) while its own work still ran; when it resumed, its renewal was refused, `lock.signal` aborted with `LockLostError`, and `LocksEvents.events$` emitted `lock-lost` (`detectedBy: 'renewal'`) then `leadership-lost` (`reason: 'lost'`).
- A hook that throws, or returns a promise that rejects: `WarehouseFeed.onLeadershipAcquired() failed for "warehouse-feed": stepping down` at error with the stack, `Stepped down from "warehouse-feed"`, a `leadership-lost` event with `reason: 'released'`, and a new campaign every `ttl / 3` (2 attempts after 10 s with `ttl` 30 s).

The election only sees a failure the hook reports: it attaches its handler to the thenable `onLeadershipAcquired()` returns (`services/leader-elections.service.js`). Return the work's promise. With `void this.consume(…)`, the same rejection (`Error: feed connection reset`) reached `process.on('unhandledRejection')` instead, which ends a Node 24 process, and the election never stepped down (`events$` emitted only `leadership-acquired`). A returned promise that rejects because leadership ended is also reported: without the `signal.aborted` check below, every shutdown logged `onLeadershipAcquired() failed … stepping down` with an `AbortError`. Resolve when the signal aborts; reject only on a real failure.

Because of the overlap window, start the work with `lock.signal` so it stops on loss, and fence its writes with `lock.fencingToken` (`lock-fencing-tokens`). `onLeadershipLost(lock)` runs on every end; it is for cleanup and logging, not the only stop.

**Incorrect (work ignores the lease; a detached loop's rejection escapes the election):**

```typescript
@Injectable()
@LeaderElection('warehouse-feed')
export class WarehouseFeed implements OnLeadershipAcquired {
  onLeadershipAcquired(lock: Lock): void {
    setInterval(() => void this.pullUpdates(), 1_000); // still pulling on the old leader after a takeover
    void this.consume(lock.signal, lock.fencingToken); // a rejection is an unhandled rejection; no step-down
  }
}
```

**Correct (`src/stock/warehouse-feed.ts`):**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { LeaderElection, type Lock, type OnLeadershipAcquired, type OnLeadershipLost } from '@nestjs/locks';
import { WarehouseUpdates } from './warehouse-updates.js';

@Injectable()
@LeaderElection('warehouse-feed', { ttl: '30s' })
export class WarehouseFeed implements OnLeadershipAcquired, OnLeadershipLost {
  private readonly logger = new Logger(WarehouseFeed.name);

  constructor(private readonly updates: WarehouseUpdates) {}

  /** Returned, not `void`ed: when the loop rejects, the election logs it and steps down so another instance leads. */
  onLeadershipAcquired(lock: Lock): Promise<void> {
    return this.consume(lock.signal, lock.fencingToken);
  }

  onLeadershipLost(lock: Lock): void {
    this.logger.log('Warehouse feed stopped', { fencingToken: lock.fencingToken });
  }

  /** Runs until leadership ends (resolves) or an update fails (rejects); every write carries `fencingToken`. */
  private async consume(signal: AbortSignal, fencingToken: number): Promise<void> {
    this.logger.log('Warehouse feed started', { fencingToken });
    try {
      while (!signal.aborted) await this.updates.applyNext(signal, fencingToken);
    } catch (error) {
      if (signal.aborted) return; // leadership ended: the abort is the stop, not a failure
      throw error;
    }
  }
}
```

`WarehouseUpdates.applyNext()` is one step of the consumer: it passes `signal` to every call it makes, so it rejects with the abort reason once leadership ends. In the probe, a failing step logged `Warehouse feed started`, the error above, `Stepped down from "warehouse-feed"` and `Warehouse feed stopped`, with no unhandled rejection; `app.close()` logged the same without the error.

The provider must be a singleton and implement at least one hook, or startup fails with `@LeaderElection("no-hooks") on NoHooks: implement OnLeadershipAcquired (onLeadershipAcquired(lock)) and OnLeadershipLost (onLeadershipLost(lock)), or the election has nothing to call`. An election key is checked against job keys and their leases at startup: `@LeaderElection("stock:reconcile:owner")` next to a job keyed `stock:reconcile` failed with `… both use the lock key "stock:reconcile:owner", so they would exclude each other.` (`job-explicit-keys`). Log levels follow `nestjs-logging`: start and stop of the feed are `log` events.

Reference: [NestJS Locks](https://docs.nestjs.com/reliability/locks)
