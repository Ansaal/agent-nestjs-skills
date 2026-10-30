---
title: Test the Schedule With nextDates() and the Wiring With Fake Timers
impact: MEDIUM-HIGH
impactDescription: Wrong cron expressions and time zones ship untested, or tests wait hours of real time to see a job fire
tags: schedule, testing, cron, fake-timers, vitest, SchedulerRegistry
---

## Test the Schedule With nextDates() and the Wiring With Fake Timers

Three different things can be wrong, and each has its own cheap test:

1. **The work**: call the work method (`test-call-the-work`). Most tests are this.
2. **The schedule** (expression, `timeZone`, DST): ask cron. `SchedulerRegistry.getCronJob(name).nextDates(n)` returns the next `n` fire times as Luxon `DateTime`s, computed from `Date.now()`. Fake only `Date` and set the clock; no timer runs.
3. **The wiring** (the decorator calls the work method at that time): one test with fake timers. Install them before `app.init()`, because that is where `@nestjs/schedule` calls `setInterval()` and cron calls `setTimeout()`. With fake timers installed after `init()`, `advanceTimersByTimeAsync(3_600_000)` produced 0 calls: the real timer was already armed. Fake only what the job uses: `setInterval`/`clearInterval` for `@Interval`; `setTimeout`/`clearTimeout`/`Date` for `@Cron` (cron 4.4.0 computes the delay from the clock and arms a `setTimeout`).

Spy on the work method with a resolved value, so the wiring test does not also exercise the work. Fake timers for retry backoff are `nestjs-testing`.

**Incorrect (fake timers after init; asserting the hour by waiting):**

```typescript
it('fires the job', async () => {
  await app.init();
  vi.useFakeTimers(); // too late: the real interval is already armed
  const processPending = vi.spyOn(app.get(BatchProcessor), 'processPending');
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(processPending).toHaveBeenCalled(); // 0 calls
});
```

**Correct (`test/nightly-report.e2e-spec.ts`: schedule, work and wiring of a `@Cron`):**

```typescript
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SchedulerRegistry } from '@nestjs/schedule';
import { NIGHTLY_REPORT, NightlyReportJob } from '../src/reports/nightly-report.job.js';
import { ReportsService } from '../src/reports/reports.service.js';
import { createTestApp } from './support/test-app.js';

describe('Nightly report', () => {
  let app: NestExpressApplication;

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it('runs at 02:00 Berlin time, across the DST switch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-26T12:00:00Z'));
    app = await createTestApp();

    const next = app.get(SchedulerRegistry).getCronJob(NIGHTLY_REPORT).nextDates(3);

    expect(next.map((date) => date.toUTC().toISO())).toEqual([
      '2027-03-27T01:00:00.000Z', // 02:00 CET
      '2027-03-28T01:00:00.000Z', // 02:00 does not exist on the switch day: 03:00 CEST
      '2027-03-29T00:00:00.000Z', // 02:00 CEST
    ]);
  });

  it('sends a report for every tenant', async () => {
    app = await createTestApp();

    await expect(app.get(NightlyReportJob).sendAll()).resolves.toEqual({ sent: 2, failed: 0 });

    expect(app.get(ReportsService).sent).toEqual(['t-1', 't-2']);
  });

  it('fires the job at the scheduled time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); // before init(): cron arms its timer there
    vi.setSystemTime(new Date('2027-03-27T00:59:00Z'));
    app = await createTestApp();
    const sendAll = vi.spyOn(app.get(NightlyReportJob), 'sendAll').mockResolvedValue({ sent: 0, failed: 0 });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(sendAll).toHaveBeenCalledTimes(1);
  });
});
```

**Correct (`@Interval` wiring, with `BATCH_POLL_MS=3600000` from `test.env`):**

```typescript
describe('Interval wiring', () => {
  afterEach(() => vi.useRealTimers());

  it('calls processPending every BATCH_POLL_MS', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // before init(): the interval is created there
    const app = await createTestApp();
    const processPending = vi.spyOn(app.get(BatchProcessor), 'processPending').mockResolvedValue(0);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(processPending).toHaveBeenCalledTimes(1);

    await app.close();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(processPending).toHaveBeenCalledTimes(1);
  });
});
```

Exactly one call after one fake hour also proves `test.env` reached the decorator: with the 5 s default it would have been 720. Both suites ran with TypeORM on better-sqlite3 booting under the faked timers. `createTestApp()` is `nestjs-testing`'s helper; `tick()` calls `this.processPending()`, so a spy on the instance catches the scheduled call.

Reference: [Vitest – vi.useFakeTimers](https://vitest.dev/api/vi#vi-usefaketimers), [cron – CronJob.nextDates](https://github.com/kelektiv/node-cron#cronjob)
