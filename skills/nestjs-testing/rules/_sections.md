# Sections

## 1. Unit Tests (unit)

**Impact:** HIGH
**Description:** One provider per testing module, every dependency auto-mocked through `useMocker()`, specific doubles only where the token or the call chain needs them.

## 2. E2E Tests (e2e)

**Impact:** CRITICAL
**Description:** The real `AppModule` over HTTP with Supertest, external boundaries overridden, and every global enhancer registered where the test app sees it.

## 3. Time and Async Work (async)

**Impact:** MEDIUM-HIGH
**Description:** Retries, backoff and work that finishes after the response, tested with fake timers and awaitables instead of real waiting.
