---
title: Map Expected Statuses in the Client; Let Typed Errors Propagate
impact: HIGH
impactDescription: Client errors retried and counted by the breaker; expected answers treated as outages; upstream bodies in logs
tags: http-client, errors, status, resilience, logging
---

## Map Expected Statuses in the Client; Let Typed Errors Propagate

Every failure the client produces is an `HttpClientError` with `method` and a `message` that names the URL with its query values masked: `HttpResponseError` for a non-2xx answer (`status`, `statusText`, `headers`, `body`; thrown while `throwOnHttpError` keeps its default `true`), `HttpTimeoutError` for the per-attempt `timeout` (`timeoutMs`), `HttpNetworkError` before a complete response (DNS, refused or reset connection, TLS, a refused redirect; details in `cause.code`, e.g. `ECONNREFUSED`), and `HttpParseError` for a body that claims JSON but isn't. Errors thrown by interceptors and a caller's abort propagate unchanged. An answer the caller expects, such as a `404` for an unknown shipment, is a result: the client provider maps it (`null`, a domain value) with `instanceof HttpResponseError` and `status`. Everything else propagates as it is, because `status` is what `@nestjs/resilience` reads: `isClientError()` treats a `4xx` (except `408`/`429`) as the caller's fault, so the policy neither retries it nor counts it toward the breaker. A `422` from the carrier made 1 request under a 3-attempt preset. The fields that can carry secrets or personal data (`url`, `headers`, `body`) are non-enumerable: `JSON.stringify(error)` gave `{"name":"HttpResponseError","method":"GET","status":422,"statusText":"Unprocessable Entity"}`.

**Incorrect (status discarded, 404 treated as an outage, body logged):**

```typescript
async findShipment(id: string) {
  const res = await this.http.get<Shipment>('/shipments/:id', { params: { id }, throwOnHttpError: false });
  if (!res.ok) {
    this.logger.error(`carrier failed: ${JSON.stringify(res.data)}`); // upstream body (PII) in the log
    throw new Error(`Carrier failed with ${res.status}`); // no status: a 4xx is retried and trips the breaker
  }
  return res.data;
}
```

**Correct (expected status mapped in the client):**

```typescript
// carrier/carrier.client.ts
/** `null` when the carrier has no such shipment; every other failure propagates. */
async findShipment(id: string, signal?: AbortSignal): Promise<Shipment | null> {
  try {
    const { data } = await this.http.get<Shipment>('/shipments/:id', { params: { id }, signal });
    return data;
  } catch (error) {
    if (error instanceof HttpResponseError && error.status === 404) return null;
    throw error;
  }
}
```

**Correct (a handled failure degrades and logs one `warn`):**

```typescript
// carrier/shipping-estimate.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { isClientError } from '@nestjs/resilience';
import { CarrierGateway } from './carrier.gateway.js';

const FLAT_RATE = 9.9;

@Injectable()
export class ShippingEstimateService {
  private readonly logger = new Logger(ShippingEstimateService.name);

  constructor(private readonly gateway: CarrierGateway) {}

  /** Degrades to a flat rate when the carrier is unavailable; our own bad request still fails. */
  async estimate(orderId: string): Promise<number> {
    try {
      return await this.gateway.cheapestQuote(orderId);
    } catch (error) {
      if (isClientError(error)) throw error; // a 4xx HttpResponseError: a fallback would hide our bug
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn('Carrier quote unavailable, using flat rate', { orderId }, err);
      return FLAT_RATE;
    }
  }
}
```

With `ConsoleLogger({ json: true })` the fallback logged `{"level":"warn",…,"message":"Carrier quote unavailable, using flat rate","context":"ShippingEstimateService","error":{"name":"HttpResponseError","message":"GET http://127.0.0.1:59844/orders/ord_1/quotes failed with 503 Service Unavailable","stack":"…","method":"GET","status":503,"statusText":"Service Unavailable"},"params":{"orderId":"ord_1"}}` after the policy's two retry warnings: the error goes in as the third argument (`content-errors-as-objects` in `nestjs-logging`), and its record carries `status` but not the upstream body. Read `error.body` to branch on an upstream error code, not to log it: payloads belong at `verbose` at most, and only without secrets or personal data. Failures that reach an HTTP handler become `502`/`504` in `request-exception-filter`; `@Fallback()` on routes and dead letters for calls that still fail are `nestjs-resilience`; log levels are `nestjs-logging`.

Reference: [NestJS HTTP client](https://docs.nestjs.com/application/http-client)
