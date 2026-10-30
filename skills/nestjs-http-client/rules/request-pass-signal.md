---
title: Pass the Caller's AbortSignal Into Every Request
impact: HIGH
impactDescription: Timed-out attempts keep their connections open and keep loading the dependency
tags: http-client, abort-signal, timeout, resilience
---

## Pass the Caller's AbortSignal Into Every Request

A resilience timeout rejects the caller, but only the `signal` stops the HTTP request behind it. Every client method takes `signal?: AbortSignal` and passes it as the request's `signal` option. Callers hand in the attempt's signal: the `{ signal }` a policy's `execute()` gives its function, or `@Signal()` in a handler decorated with `@Resilience()`/`@Timeout()` (`nestjs-resilience`). The client combines it with its own per-attempt `timeout`. Measured against a stub that answers after 1 s, under a preset with `timeout: '100ms'`: with the signal passed, the call rejected with `ResilienceTimeoutError: Timed out after 100ms` after 154 ms and the stub saw the connection closed before it answered. Without it, the caller got the same error but the request stayed open, and the stub served the whole response to nobody. Under a retrying policy those orphans add up: every timed-out attempt keeps its connection while the next one starts.

**Incorrect (the policy's signal is dropped; the wrapper can't be cancelled):**

```typescript
getQuotes(orderId: string): Promise<Quote[]> {
  return this.http.get<Quote[]>('/orders/:orderId/quotes', { params: { orderId } }).then((res) => res.data);
}

cheapestQuote(orderId: string) {
  return this.carrierPolicy.execute(() => this.carrier.getQuotes(orderId)); // timeout rejects, request runs on
}
```

**Correct (client method takes the signal; the policy's signal reaches fetch):**

```typescript
// carrier/carrier.client.ts
async getQuotes(orderId: string, signal?: AbortSignal): Promise<Quote[]> {
  const { data } = await this.http.get<Quote[]>('/orders/:orderId/quotes', { params: { orderId }, signal });
  return data;
}
```

```typescript
// carrier/carrier.gateway.ts
cheapestQuote(orderId: string): Promise<number> {
  return this.carrierPolicy.execute(
    async ({ signal }) => {
      const quotes = await this.carrier.getQuotes(orderId, signal);
      return Math.min(...quotes.map((quote) => quote.price));
    },
    { source: 'CarrierGateway.cheapestQuote' },
  );
}
```

```typescript
// carrier/shipping.controller.ts
@Get('quotes')
@Resilience('carrier')
@Timeout('1.5s')
quotes(@Query('orderId') orderId: string, @Signal() signal: AbortSignal) {
  return this.carrier.getQuotes(orderId, signal);
}
```

An aborted caller signal rejects with the signal's reason unchanged (here the `ResilienceTimeoutError`), not with an `HttpClientError`; the client's own `timeout` rejects with `HttpTimeoutError` (`GET https://carrier.test/slow timed out after 50ms`, `timeoutMs: 50`). Both abort the fetch. The signal also cuts short the client's own interceptors and any backoff wait.

Reference: [NestJS Resilience – Use the same policies inside services](https://docs.nestjs.com/reliability/resilience#use-the-same-policies-inside-services)
