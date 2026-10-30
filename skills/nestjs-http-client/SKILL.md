---
name: nestjs-http-client
description: Outbound HTTP for NestJS with `@nestjs/http-client` (native fetch). Use when calling another service or third-party API, registering HTTP clients, choosing timeouts and retry settings for a client, mapping upstream errors to results or 502/504 answers, logging outbound requests, or testing code that makes HTTP calls.
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS HTTP Client

How a Nest app talks HTTP to another system: one named `@nestjs/http-client` client per system, registered with its base URL, a per-attempt timeout and `retry: false`, behind one client provider that owns the system's paths; the caller's abort signal on every request; expected statuses mapped in the client, everything else propagated as typed errors and answered as `502`/`504`; one `debug` line per request; tests that cut at the client provider or at an undici `MockAgent`. Verified 2026-10-29 against NestJS 12.3.2, @nestjs/http-client 0.0.2, @nestjs/resilience 0.0.3, @nestjs/config 12.0.1, undici 7.30.1 (MockAgent), Vitest 5.0.5, supertest 7.3.1 on Node 24.22.2.

Retries, timeouts around a whole call, circuit breakers, fallbacks and dead letters are `nestjs-resilience`; logger setup and the level policy are `nestjs-logging`; e2e suite structure is `nestjs-testing`; the Vitest config is `nestjs-setup`; where client providers sit in a feature plan is `nestjs-fdd`.

## Rules
| Prefix | Section | Impact |
|--------|---------|--------|
| `client-` | Client Registration | CRITICAL |
| `request-` | Requests and Errors | HIGH |
| `test-` | Testing | HIGH |

### 1. Client Registration (CRITICAL)

- `client-register-per-system` - Pin the package; `registerAsync({ name })` per external system with `baseUrl`, headers and per-attempt `timeout` from config; one `<System>Client` provider owns the paths
- `client-retry-off` - Retries are on when `retry` is omitted (3 attempts); register every client with `retry: false` so a resilience policy's 3 attempts don't become 9 requests

### 2. Requests and Errors (HIGH)

- `request-pass-signal` - Client methods take `signal?: AbortSignal` and pass it on; callers hand in the policy's or `@Signal()`'s signal so a timeout closes the request
- `request-path-params` - `:name` path templates with `params`, values in `query`; never interpolate ids into URLs
- `request-typed-errors` - Map expected statuses (`404` → `null`) in the client; let `HttpResponseError` and friends propagate with `status`; a handled degrade logs one `warn`
- `request-exception-filter` - One global `@Catch(HttpClientError)` filter: `toHttpException(error, { log: false })` answers `502`/`504` instead of `500`, then one structured `error` log with the error attached; map an `AbortSignal.timeout()` deadline at the call site that created it
- `request-log-interceptor` - One `forRoot()` interceptor logs every request at `debug` with method, host, path, status and duration; never headers, query or body

### 3. Testing (HIGH)

- `test-override-client-provider` - E2E suites over the real `AppModule` override the `<System>Client` provider; never patch `globalThis.fetch`
- `test-mock-agent-dispatcher` - Client specs register the real client with `retry: false` and an undici `MockAgent` as `dispatcher`, from the undici version Node bundles

Read `rules/<id>.md` for the rule's reasoning and examples.
