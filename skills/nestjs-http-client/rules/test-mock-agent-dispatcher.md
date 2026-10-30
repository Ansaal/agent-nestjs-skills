---
title: Test the Client Provider Against an undici MockAgent Matching Node's Bundled undici
impact: HIGH
impactDescription: Untested paths, encoding and status mapping; client specs that hang on a mismatched undici major
tags: testing, http-client, undici, mockagent, dispatcher
---

## Test the Client Provider Against an undici MockAgent Matching Node's Bundled undici

The wrapper's own behaviour (which path and query it sends, how it maps a `404`, what it rethrows) needs the real `HttpClient` with a fake network. The client's `dispatcher` option takes any undici dispatcher, so register the client in the spec with `dispatcher: agent`, an undici `MockAgent`: no port, no server, `disableNetConnect()` turns an unmatched request into `HttpNetworkError: GET https://carrier.test/shipments/nope failed: UND_MOCK_ERR_MOCK_NOT_MATCHED`, and `assertNoPendingInterceptors()` fails a test whose expected request was never sent. Node's global `fetch` is its bundled undici, and the `MockAgent` must come from the same major: on Node 24.22.2 (`node -p process.versions.undici` → `7.30.1`) a `MockAgent` from `undici@8.12.3` never answered matched requests (`Test timed out in 5000ms.`), and one from `undici@7.30.1` worked. Pin the dev dependency to the bundled version, and re-check it when the pinned Node version changes. A stub server (`node:http` on port `0`) works too and is the tool when the test must observe the connection itself, such as an abort closing it; `MockAgent`'s `.delay(ms)` covers timeouts (`HttpTimeoutError: GET https://carrier.test/slow timed out after 50ms`).

**Incorrect (latest undici, default client registration, no net guard):**

```bash
pnpm add -D undici   # 8.x: its MockAgent hangs under Node 24's bundled undici 7 fetch
```

```typescript
const moduleRef = await Test.createTestingModule({
  imports: [HttpClientModule.register({ name: 'carrier', baseUrl: 'https://carrier.test', dispatcher: new MockAgent() })],
  providers: [CarrierClient],
}).compile(); // retries on, an unmatched request goes to the real network
```

**Correct (`src/carrier/carrier.client.spec.ts`):**

```bash
node -p process.versions.undici   # 7.30.1 on Node 24.22.2
pnpm add -D -E undici@7.30.1
```

```typescript
import { HttpClientModule, HttpResponseError } from '@nestjs/http-client';
import { Test } from '@nestjs/testing';
import { MockAgent } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CarrierClient } from './carrier.client.js';

describe('CarrierClient', () => {
  const agent = new MockAgent();
  agent.disableNetConnect(); // an unmatched request fails instead of reaching the network
  const carrierApi = agent.get('https://carrier.test');
  let carrier: CarrierClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        HttpClientModule.register({ name: 'carrier', baseUrl: 'https://carrier.test', retry: false, dispatcher: agent }),
      ],
      providers: [CarrierClient],
    }).compile();
    carrier = moduleRef.get(CarrierClient);
  });

  afterEach(() => agent.assertNoPendingInterceptors());
  afterAll(() => agent.close());

  it('encodes the order id into the path', async () => {
    carrierApi
      .intercept({ path: '/orders/a%2Fb/quotes', method: 'GET' })
      .reply(200, [{ carrier: 'dhl', price: 4.2 }], { headers: { 'content-type': 'application/json' } });

    await expect(carrier.getQuotes('a/b')).resolves.toEqual([{ carrier: 'dhl', price: 4.2 }]);
  });

  it('maps a 404 to null', async () => {
    carrierApi.intercept({ path: '/shipments/shp_1', method: 'GET' }).reply(404, { error: 'not found' });

    await expect(carrier.findShipment('shp_1')).resolves.toBeNull();
  });

  it('rethrows other statuses with their status', async () => {
    carrierApi.intercept({ path: '/shipments/shp_2', method: 'GET' }).reply(500, 'boom');

    const error = await carrier.findShipment('shp_2').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpResponseError);
    expect(error).toMatchObject({ status: 500 });
  });
});
```

**Correct (e2e: real `CarrierClient`, client token overridden):**

```typescript
const agent = new MockAgent();
agent.disableNetConnect();
const app = await createTestApp((builder) =>
  builder
    .overrideProvider(getHttpClientToken('carrier'))
    .useValue(new HttpClient({ baseUrl: 'https://carrier.test', retry: false, dispatcher: agent })),
);
```

The replacement client is built by hand, so it carries none of the registration's other settings and none of the `forRoot()` interceptors. Without `retry: false` in the spec the client would retry `5xx` answers on its own and consume extra interceptors. Interceptor replies need a `content-type: application/json` header for `responseType: 'auto'` to parse the body; without it `data` is the text. Overriding the `CarrierClient` provider itself is the default for e2e suites (`test-override-client-provider`).

Reference: [undici MockAgent](https://undici.nodejs.org/#/docs/api/MockAgent)
