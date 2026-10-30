---
title: Log a Retry at warn and Only the Final Failure at error
impact: HIGH
impactDescription: Alerts fire on failures that recovered; the failure that needs a human hides among them
tags: logging, log-levels, retry, error, warn, dead-letter, resilience
---

## Log a Retry at warn and Only the Final Failure at error

A failed attempt that will be retried is degraded but handled: `warn`. Only the outcome that nobody will retry is `error`, logged once, by the code that gives up, with the `Error` object attached (`content-errors-as-objects`). Logging every attempt at `error` makes a recovered call indistinguishable from a lost one: a batch processor that logged `` `Punch batch ${batch.id} failed on attempt ${batch.attempts}/${MAX_ATTEMPTS} (${status}): ${message}` `` at `error` for every attempt, including those it re-polls and may still recover, filled a test run with `ERROR [PunchBatchProcessor] …` lines. Retries themselves belong to `@nestjs/resilience` (`nestjs-resilience`); its `ResilienceEvents.events$` stream emits a `retry` event per failed attempt and a state event per breaker transition, so one subscriber logs all of them at `warn`. When the final failure is recorded as a dead letter (`nestjs-resilience`, `dlq-record-final-failure`), the dead-letter record is what someone acts on and the line saying it was written is `log`; without a dead letter, the final failure is `error`.

**Incorrect (every attempt an error, final failure logged as text without the error):**

```typescript
this.resilienceEvents.events$.subscribe((event) => {
  if (event.type === 'retry') this.logger.error(`attempt ${event.attempt} failed: ${String(event.error)}`);
});
// ...
} catch (error) {
  this.logger.error(`Order ${order.id} push failed: ${String(error)}`); // no stack, no code, id inside the text
}
```

**Correct (`src/carrier/resilience.logger.ts`, registered in the providers of `AppModule`):**

```typescript
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ResilienceEvents } from '@nestjs/resilience';

@Injectable()
export class ResilienceLogger implements OnModuleInit {
  private readonly logger = new Logger('Resilience');

  constructor(private readonly resilienceEvents: ResilienceEvents) {}

  onModuleInit() {
    this.resilienceEvents.events$.subscribe((event) => {
      switch (event.type) {
        case 'retry': {
          // Normalise once: the event's error is whatever the call threw.
          const err = event.error instanceof Error ? event.error : new Error(String(event.error));
          this.logger.warn('Retrying call', { source: event.source, attempt: event.attempt, delayMs: event.delayMs }, err);
          break;
        }
        case 'circuit-open':
        case 'circuit-half-open':
        case 'circuit-closed':
          this.logger.warn('Circuit state changed', { policy: event.policy, from: event.from, to: event.to });
          break;
      }
    });
  }
}
```

**Correct (`src/carrier/order-sync.service.ts`, the final failure once, at `error`):**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ResilienceService, type ResiliencePolicy } from '@nestjs/resilience';
import { CarrierClient, type OrderSnapshot } from './carrier.client.js';

@Injectable()
export class OrderSyncService {
  private readonly logger = new Logger(OrderSyncService.name);
  private readonly carrierPolicy: ResiliencePolicy;

  constructor(
    resilience: ResilienceService,
    private readonly carrier: CarrierClient,
  ) {
    this.carrierPolicy = resilience.preset('carrier');
  }

  async push(order: OrderSnapshot): Promise<boolean> {
    this.logger.debug('Pushing order to carrier', { orderId: order.id, lines: order.lines.length });
    try {
      const { trackingId } = await this.carrierPolicy.execute(
        ({ signal }) => this.carrier.pushOrder(order, signal),
        { source: 'OrderSyncService.push' },
      );
      this.logger.debug('Order pushed', { orderId: order.id, trackingId });
      return true;
    } catch (error) {
      // Retries are exhausted: the order did not reach the carrier.
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Order push failed', { orderId: order.id }, err);
      return false;
    }
  }
}
```

With the `carrier` preset at `retry: { attempts: 3 }` and a carrier down for three calls, one push wrote two `warn` lines and one `error` line, each with the structured `error` (stacks shortened):

```text
{"level":"warn","pid":50728,"timestamp":1793334286422,"message":"Retrying call","context":"Resilience","error":{"name":"CarrierError","message":"The carrier answered with status 503","stack":"…","status":503,"code":"CARRIER_UNAVAILABLE"},"params":{"source":"OrderSyncService.push","attempt":1,"delayMs":2}}
{"level":"warn","pid":50728,"timestamp":1793334286425,"message":"Retrying call","context":"Resilience","error":{"name":"CarrierError","message":"The carrier answered with status 503","stack":"…","status":503,"code":"CARRIER_UNAVAILABLE"},"params":{"source":"OrderSyncService.push","attempt":2,"delayMs":9}}
{"level":"error","pid":50728,"timestamp":1793334286437,"message":"Order push failed","context":"OrderSyncService","error":{"name":"CarrierError","message":"The carrier answered with status 503","stack":"…","status":503,"code":"CARRIER_UNAVAILABLE"},"params":{"orderId":"ord_1"}}
```

The retry line carries `status` and `code` because the error is the third argument; copied into params as `error.message`, they and the stack were gone. The same subscriber is `nestjs-resilience`'s `dlq-record-final-failure`, where the final failure is recorded as a dead letter and logged at `log`.

A job runner that retries on its own (a batch re-polled from a table) follows the same split: `warn` while `attempts < maxAttempts`, `error` (or `log` plus a dead letter) on the last one.

Reference: [NestJS Resilience – Observe breaker transitions](https://docs.nestjs.com/reliability/resilience#observe-breaker-transitions)
