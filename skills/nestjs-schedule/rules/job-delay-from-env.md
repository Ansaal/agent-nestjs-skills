---
title: Validate Interval Delays Read From the Environment
impact: HIGH
impactDescription: A malformed or too-large delay makes the job run every millisecond; a value set after import is ignored
tags: schedule, interval, timeout, environment, configuration
---

## Validate Interval Delays Read From the Environment

`@Interval(name, ms)` and `@Timeout(name, ms)` store `ms` when the class is decorated, which is when its file is imported; `ScheduleModule` passes it to `setInterval()` at bootstrap. An env-driven delay is therefore read once, at import, before any provider exists, so `ConfigService` cannot supply it and a test that sets `process.env` in `beforeAll` is too late (the probe's 50 ms default still ticked 5 times in 300 ms after `beforeAll` set 3 600 000). Set test values in Vitest's `test.env` (`test-call-the-work`).

Node does not reject a bad delay; it replaces it with 1 ms and prints a warning:

```
(node:90878) TimeoutOverflowWarning: 99999999999 does not fit into a 32-bit signed integer.
Timeout duration was set to 1.
(node:90878) TimeoutNaNWarning: NaN is not a number.
Timeout duration was set to 1.
```

`Number('5s')` is `NaN`, and anything above 2 147 483 647 ms (24.8 days) overflows: both jobs ran 175 times in 200 ms. Validate the value where it is read so a bad setting stops the app at startup. When the delay must come from `ConfigService` or the database, register the timer at runtime instead (`job-dynamic-registry`).

**Incorrect (unvalidated: `BATCH_POLL_MS=5s` polls the database every millisecond):**

```typescript
const POLL_MS = Number(process.env.BATCH_POLL_MS ?? 5_000);

@Interval('batches:process', POLL_MS)
async tick(): Promise<void> {
  await this.processPending();
}
```

**Correct (`src/common/env-ms.ts`, used at the top of the job's file):**

```typescript
/** Largest delay setInterval/setTimeout accept; above it, and for NaN, Node fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** Reads a timer delay from the environment and fails at startup instead of polling every millisecond. */
export function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new Error(`${name} must be a whole number of milliseconds between 1 and ${MAX_TIMER_MS}, got "${raw}"`);
  }
  return value;
}
```

```typescript
import { envMs } from '../common/env-ms.js';

// Read when this file is imported, before any test hook runs: set it in vitest.config.ts `test.env`.
const POLL_MS = envMs('BATCH_POLL_MS', 5_000);
```

With `BATCH_POLL_MS=5s`, `node dist/main.js` stops before Nest starts: `Error: BATCH_POLL_MS must be a whole number of milliseconds between 1 and 2147483647, got "5s"`.

Reference: [Node.js – setInterval](https://nodejs.org/api/timers.html#setintervalcallback-delay-args), [NestJS – Task scheduling: Declarative intervals](https://docs.nestjs.com/techniques/task-scheduling#declarative-intervals)
