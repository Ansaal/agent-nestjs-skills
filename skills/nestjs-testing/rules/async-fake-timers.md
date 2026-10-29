---
title: Drive Retry Backoff With Fake Timers
impact: MEDIUM-HIGH
impactDescription: Seconds of real waiting per test, and flaky results from random jitter
tags: testing, fake-timers, retry, backoff, resilience, vitest
---

## Drive Retry Backoff With Fake Timers

Retry code waits between attempts. In the probe, the production preset (`attempts: 3`, `backoff: { delay: '1s' }`, full jitter by default) cost 2.7 s of real time per test. On fake timers the same test took 2 ms. In beforeEach, call `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })`. `@nestjs/resilience` 0.0.3 waits through the global `setTimeout`, and its circuit breakers and rate limits read `Date.now()`. Start the call without awaiting it, then `await vi.advanceTimersByTimeAsync(ms)` past the full backoff budget, then await the result. The async variant lets each failed attempt settle before the next timer fires. `vi.waitFor` does not speed up fake time. Under fake timers it moves the clock forward by `interval` (50 ms) once per real `interval`. With its 1 s default timeout it saw 2 of the 3 attempts and failed. Use it only to poll for work that finishes quickly in real time.

**Incorrect (real backoff, or a sleep that guesses it):**

```typescript
it('retries a transient failure', async () => {
  downstream.push.mockRejectedValueOnce(unavailable()).mockResolvedValue('ok:p-1');
  const result = app.get(SyncService).sync('p-1');
  await new Promise((resolve) => setTimeout(resolve, 3_000)); // jitter makes this flaky, and it's slow
  expect(await result).toBe('ok:p-1');
}, 10_000);
```

**Correct (production preset, fake clock advanced past the backoff):**

```typescript
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { DownstreamClient } from '../src/downstream.client.js';
import { SyncService } from '../src/sync.service.js';

const unavailable = () => Object.assign(new Error('unavailable'), { status: 503 });
const downstream = { push: vi.fn<(id: string) => Promise<string>>() };
let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DownstreamClient)
    .useValue(downstream)
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
});
afterAll(() => app.close());

beforeEach(() => {
  downstream.push.mockReset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => vi.useRealTimers());

it('retries transient failures with the production backoff', async () => {
  downstream.push.mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockResolvedValue('ok:p-1');

  const result = app.get(SyncService).sync('p-1');
  await vi.advanceTimersByTimeAsync(60_000);

  await expect(result).resolves.toBe('ok:p-1');
  expect(downstream.push).toHaveBeenCalledTimes(3);
});

it('dead-letters after the last attempt', async () => {
  downstream.push.mockRejectedValue(unavailable());
  const sync = app.get(SyncService);

  const result = sync.sync('p-2');
  await vi.advanceTimersByTimeAsync(60_000);

  await expect(result).resolves.toBeUndefined();
  expect(sync.deadLetters).toContainEqual(expect.objectContaining({ id: 'p-2' }));
});
```

**Correct (alternative when the test is about something other than the retry timing: zero backoff):**

```typescript
import { RESILIENCE_MODULE_OPTIONS, type ResilienceModuleOptions } from '@nestjs/resilience';

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(DownstreamClient)
  .useValue(downstream)
  .overrideProvider(RESILIENCE_MODULE_OPTIONS)
  .useValue({ presets: { downstream: { retry: { attempts: 3, backoff: { delay: 0 } } } } } satisfies ResilienceModuleOptions)
  .compile();
```

This works with `@nestjs/resilience` 0.0.3 and real timers: a call that failed twice and succeeded on the third attempt finished in 4 ms. `useValue` replaces the whole options object, including every preset and `defaults`, so the test no longer checks the production policy. Prefer fake timers whenever the attempt count, backoff or breaker behaviour is what you are testing.

Reference: [Vitest – vi.useFakeTimers](https://vitest.dev/api/vi#vi-usefaketimers), [Vitest – vi.advanceTimersByTimeAsync](https://vitest.dev/api/vi#vi-advancetimersbytimeasync)
