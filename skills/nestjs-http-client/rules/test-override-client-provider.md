---
title: In E2E Suites, Override the Client Provider, Not fetch or Internals
impact: HIGH
impactDescription: E2E suites that call real third-party APIs, or that stub so deep they test nothing of the app
tags: testing, e2e, overrideProvider, http-client
---

## In E2E Suites, Override the Client Provider, Not fetch or Internals

The `<System>Client` provider is the outbound boundary, so an e2e suite over the real `AppModule` replaces exactly that provider and keeps everything in the process real: routes, resilience decorators and policies, filters, the database (`e2e-real-app-module` in `nestjs-testing`). Don't patch `globalThis.fetch` (every client and every library in the process share it) and don't replace the services that call the client. The client's registration still runs during `compile()`, so the settings it reads must exist: without `CARRIER_URL` bootstrap fails with `TypeError: Configuration key "CARRIER_URL" does not exist`. Set dummy values in the Vitest `env` (`nestjs-setup`) or before `compile()`; an overridden wrapper never sends a request, so no address has to be reachable.

**Incorrect (global fetch patched; every outbound call in the process is faked):**

```typescript
vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ carrier: 'dhl', price: 4.2 }])));
const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
```

**Correct (`test/shipping.e2e-spec.ts`):**

```typescript
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CarrierClient } from '../src/carrier/carrier.client.js';
import { createTestApp } from './support/test-app.js';

describe('Shipping (e2e)', () => {
  const carrier = { getQuotes: vi.fn(async () => [{ carrier: 'dhl', price: 4.2 }]) };
  let app: NestExpressApplication;

  beforeEach(async () => {
    process.env.CARRIER_URL = 'https://carrier.invalid';
    process.env.CARRIER_API_KEY = 'test-key';
    app = await createTestApp((builder) => builder.overrideProvider(CarrierClient).useValue(carrier));
    return () => app.close();
  });

  it('GET /shipping/quotes returns the carrier quotes', async () => {
    const res = await request(app.getHttpServer()).get('/shipping/quotes?orderId=ord_1').expect(200);

    expect(res.body).toEqual([{ carrier: 'dhl', price: 4.2 }]);
    expect(carrier.getQuotes).toHaveBeenCalledWith('ord_1', expect.any(AbortSignal));
  });
});
```

The suite boots through `createTestApp()` from `nestjs-testing` (`e2e-real-app-module`), which applies `configureApp()` like `main.ts`; the override is the only thing the suite adds. The `AbortSignal` assertion shows the route passes `@Signal()` on (`request-pass-signal`). To run the real `CarrierClient` inside an e2e suite (its paths, its status mapping, the exception filter's `502`), override the HTTP client token instead, with a client on an undici `MockAgent` (`test-mock-agent-dispatcher`). Testing the wrapper's requests and error mapping themselves is that rule's job, not the e2e suite's.

Reference: [NestJS – Testing: End-to-end testing](https://docs.nestjs.com/fundamentals/testing#end-to-end-testing)
