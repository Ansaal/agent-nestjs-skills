---
title: Give Every Wall-Clock Cron a timeZone
impact: HIGH
impactDescription: Without it a nightly job fires at a different hour on every host whose TZ differs, and silently moves when the container image changes
tags: schedule, cron, timezone, dst, CronExpression
---

## Give Every Wall-Clock Cron a timeZone

`@Cron()` without `timeZone` reads the expression in the process's time zone. In the probe, `@Cron('0 0 2 * * *')` next fired at `02:00:00Z` under `TZ=UTC` and at `06:00:00Z` under `TZ=America/New_York`; the same expression with `timeZone: 'Europe/Berlin'` fired at `01:00:00Z` on both hosts. Containers usually run in UTC, laptops do not, so a job meant for "2 a.m. local" runs at a different hour in development and production. Set `timeZone` (an IANA name) on every cron that names a time of day; `CronExpression.EVERY_*` intervals don't need one.

Daylight-saving switches are handled by cron 4.4.0, the version `@nestjs/schedule` 12.0.2 pins: `nextDates()` in Europe/Berlin showed `02:00` and `02:30` on 2027-03-28 (the hour that does not exist) both firing at 03:00 CEST (`01:00:00Z`), and `02:30` on 2027-10-31 (the hour that occurs twice) listed once, at the first occurrence (`00:30:00Z`). If a job must run exactly every 24 h, use `utcOffset` or a UTC hour instead. A misspelt zone fails `app.init()` with `CronError: Invalid timezone.`, so the typo cannot ship unnoticed if the app is booted once in CI.

Six-field expressions start with seconds (`'0 0 2 * * *'` is 02:00:00); five-field ones start with minutes. Give each cron a `name` so tests and code can reach it through `SchedulerRegistry.getCronJob(name)`.

**Incorrect (runs at 02:00 in whatever zone the host is in):**

```typescript
@Cron('0 0 2 * * *')
async sendNightlyReports(): Promise<void> {
  await this.reports.sendAll();
}
```

**Correct (named, pinned to a zone, no overlapping runs, one tenant's failure does not stop the others):**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReportsService } from './reports.service.js';

export const NIGHTLY_REPORT = 'reports:nightly';

@Injectable()
export class NightlyReportJob {
  private readonly logger = new Logger(NightlyReportJob.name);

  constructor(private readonly reports: ReportsService) {}

  // 02:00 in Berlin on every host, whatever TZ the container runs in; a run still going at the next fire time is not doubled.
  @Cron('0 0 2 * * *', { name: NIGHTLY_REPORT, timeZone: 'Europe/Berlin', waitForCompletion: true })
  async tick(): Promise<void> {
    await this.sendAll();
  }

  /** Sends every tenant's report; a tenant that fails is logged and the rest still get theirs. */
  async sendAll(): Promise<{ sent: number; failed: number }> {
    const tenants = await this.reports.tenants();
    let sent = 0;
    for (const tenantId of tenants) {
      try {
        await this.reports.sendFor(tenantId);
        sent++;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error('Nightly report failed', { tenantId }, err); // not retried before the next night: failed for good
      }
    }
    this.logger.log('Nightly reports sent', { sent, failed: tenants.length - sent });
    return { sent, failed: tenants.length - sent };
  }
}
```

The per-tenant catch follows `job-handle-errors`: with tenants `t-1`, `t-bad`, `t-2` and `t-bad` refused, `sendAll()` resolved `{ sent: 2, failed: 1 }`, `t-1` and `t-2` got their reports, and the error line carried `{ tenantId: 't-bad' }` with the `Error`. Without the catch, the first refusal ends the run and the scheduler logs it without the tenant. Retrying a refused send within the run is `nestjs-resilience`. The test that pins these fire times with `nextDates()` is in `test-schedule-and-wiring`.

Reference: [NestJS – Task scheduling: Declarative cron jobs](https://docs.nestjs.com/techniques/task-scheduling#declarative-cron-jobs), [cron – timeZone](https://github.com/kelektiv/node-cron#cronjob)
