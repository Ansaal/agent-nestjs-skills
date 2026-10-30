---
title: Register One Named Client per External System, Behind One Client Provider
impact: CRITICAL
impactDescription: URLs, credentials and timeouts scattered across services; one system's headers sent to another host
tags: http-client, registration, baseUrl, timeout, configuration
---

## Register One Named Client per External System, Behind One Client Provider

`@nestjs/http-client` is pre-1.0 (0.0.2 on 2026-10-29), ships ESM only (`"type": "module"`), has no runtime dependencies (it calls the platform `fetch`), needs Node `>=20.19.0`, and its peers are `@nestjs/common` and `@nestjs/core` `^11 || ^12`. Pin it exactly; a 0.x release may change the API. Register one client per external system with `HttpClientModule.registerAsync({ name })` in the module whose features call that system, and wrap it in one `<System>Client` provider that the rest of the app injects. The wrapper is the only place that knows the system's paths, verbs and payload shapes; services call typed methods. The client's `baseUrl` also fences it in: an absolute URL to another host is refused with `TypeError: "https://evil.test/x" is not on the client's origin (https://carrier.test). A client with a baseUrl only sends requests there, so its headers and interceptors never reach another host.`, so the carrier's API key can't leak to a second system sharing the client. Options are checked when the client is created: a `baseUrl` without a scheme fails bootstrap with ``TypeError: HttpClient `baseUrl`: "carrier.test" is not an absolute URL. Include the scheme, e.g. "https://api.example.com".``, and a missing setting read with `getOrThrow()` with `TypeError: Configuration key "CARRIER_URL" does not exist`.

**Incorrect (raw fetch in a service, URL and key read per call, no timeout):**

```typescript
@Injectable()
export class ShippingService {
  async cheapestQuote(orderId: string) {
    const res = await fetch(`${process.env.CARRIER_URL}/orders/${orderId}/quotes`, {
      headers: { 'x-api-key': process.env.CARRIER_API_KEY! }, // undefined key sent as "undefined"
    }); // no timeout: a hung carrier holds this request forever
    const quotes = (await res.json()) as { price: number }[]; // a 503 body parsed as quotes
    return Math.min(...quotes.map((quote) => quote.price));
  }
}
```

**Correct (the module registers the named client from config):**

```bash
pnpm add -E @nestjs/http-client
```

```typescript
// carrier/carrier.module.ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientModule } from '@nestjs/http-client';
import { CarrierClient } from './carrier.client.js';
import { CarrierGateway } from './carrier.gateway.js';

@Module({
  imports: [
    HttpClientModule.registerAsync({
      name: 'carrier', // next to useFactory: it decides the injection token
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        baseUrl: config.getOrThrow<string>('CARRIER_URL'),
        headers: { 'x-api-key': config.getOrThrow<string>('CARRIER_API_KEY') },
        timeout: '2s', // per attempt
        retry: false, // @nestjs/resilience owns retries (client-retry-off)
      }),
    }),
  ],
  providers: [CarrierClient, CarrierGateway],
  exports: [CarrierClient, CarrierGateway],
})
export class CarrierModule {}
```

**Correct (one provider owns the carrier's paths and payloads):**

```typescript
// carrier/carrier.client.ts
import { Injectable } from '@nestjs/common';
import { HttpClient, HttpResponseError, InjectHttpClient } from '@nestjs/http-client';

export interface Quote {
  carrier: string;
  price: number;
}

export interface OrderSnapshot {
  id: string;
  status: string;
}

export interface Shipment {
  id: string;
  state: string;
}

/** The only provider that talks to the carrier: typed methods, no URLs outside this file. */
@Injectable()
export class CarrierClient {
  constructor(@InjectHttpClient('carrier') private readonly http: HttpClient) {}

  async getQuotes(orderId: string, signal?: AbortSignal): Promise<Quote[]> {
    const { data } = await this.http.get<Quote[]>('/orders/:orderId/quotes', { params: { orderId }, signal });
    return data;
  }

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

  async pushOrder(order: OrderSnapshot, signal?: AbortSignal): Promise<void> {
    await this.http.put('/orders/:id', { params: { id: order.id }, json: order, signal });
  }

  async createShipment(orderId: string, signal?: AbortSignal): Promise<Shipment> {
    const { data } = await this.http.post<Shipment>('/shipments', { json: { orderId, reference: orderId }, signal });
    return data;
  }

  async buyLabel(orderId: string, signal?: AbortSignal): Promise<{ labelUrl: string }> {
    const { data } = await this.http.post<{ labelUrl: string }>('/labels', { json: { orderId }, signal });
    return data;
  }
}
```

`name`, `isGlobal`, `imports` and interceptor classes go next to `useFactory`; returning `name` from the factory fails bootstrap. Without a `name` the client is the default one, injected by its class `HttpClient`; with one, through `@InjectHttpClient(name)` (token `getHttpClientToken(name)`, the string `HttpClient:carrier`). The client is visible only in the registering module unless `isGlobal: true`; export the wrapper instead. `HttpClientModule.forRoot()` (global) holds defaults for every client (headers, timeout, retry, interceptors); a client's own settings win and headers merge. `timeout` is per attempt and covers reading the body; `0` or unset means none. `T` in `get<T>()` is a type assertion: nothing validates the body at runtime. The `ConfigModule` setup is `nestjs-best-practices` (`devops-use-config-module`); where client providers live in a feature plan is `nestjs-fdd`.

Reference: [NestJS HTTP client](https://docs.nestjs.com/application/http-client)
