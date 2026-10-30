---
title: Test One Provider With Every Dependency Auto-Mocked
impact: HIGH
impactDescription: Unit tests that break on every constructor change or quietly run real collaborators
tags: testing, unit, useMocker, auto-mock, vitest
---

## Test One Provider With Every Dependency Auto-Mocked

A unit test compiles a testing module that holds only the unit, one provider or controller, and lets `useMocker()` build every constructor dependency. When you list real collaborators, the test runs their code and needs their dependencies too. When you hand-write a `{ provide, useValue }` for each dependency, the test breaks on every constructor change. `@nestjs/testing` 12 has no ready-made mock factory, only the `MockFactory` type. The project keeps one factory in `test/auto-mock.ts` and uses no third-party mock library. `moduleRef.get(Dep)` returns the same mock the unit received, and `vi.mocked()` types it so `.mockResolvedValue` and the matchers type-check. If the factory returns `undefined` for a token, `compile()` fails with the same error you get when a provider is missing: `Nest can't resolve dependencies of the SyncService (?, DownstreamClient). Please make sure that the argument ResilienceService at index [0] is available in the RootTestModule module.`

**Incorrect (real collaborators and hand-listed fakes):**

```typescript
const moduleRef = await Test.createTestingModule({
  providers: [
    SyncDispatcher,
    SyncService, // real: now needs ResilienceService and DownstreamClient too
    { provide: DownstreamClient, useValue: { push: vi.fn() } as any },
  ],
}).compile();
```

**Correct (`test/auto-mock.ts` once, `useMocker(autoMock)` in every unit test):**

```typescript
// test/auto-mock.ts
import type { InjectionToken } from '@nestjs/common';
import { vi } from 'vitest';

/** Mock factory for `useMocker()`: every method on a class token's prototype chain becomes `vi.fn()`. */
export function autoMock(token?: InjectionToken): Record<string, unknown> {
  const mock: Record<string, unknown> = {};
  if (typeof token !== 'function') return mock;
  let proto: unknown = token.prototype;
  while (typeof proto === 'object' && proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== 'constructor' && !(key in mock)) mock[key] = vi.fn();
    }
    proto = Object.getPrototypeOf(proto);
  }
  return mock;
}
```

```typescript
// src/sync/sync.dispatcher.spec.ts
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autoMock } from '../../test/auto-mock.js';
import { SyncService } from './sync.service.js';
import { SyncDispatcher } from './sync.dispatcher.js';

describe('SyncDispatcher', () => {
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({ providers: [SyncDispatcher] })
      .useMocker(autoMock)
      .compile();
  });

  it('runs the sync for a dispatched id', async () => {
    const sync = vi.mocked(moduleRef.get(SyncService));
    sync.sync.mockResolvedValue('ok:p-1');

    const dispatcher = moduleRef.get(SyncDispatcher);
    dispatcher.dispatch('p-1');
    await dispatcher.drain();

    expect(sync.sync).toHaveBeenCalledWith('p-1');
  });

  it('settles drain() when the sync itself rejects', async () => {
    vi.mocked(moduleRef.get(SyncService)).sync.mockRejectedValue(new Error('dead-letter store down'));

    const dispatcher = moduleRef.get(SyncDispatcher);
    dispatcher.dispatch('p-1');

    await expect(dispatcher.drain()).resolves.toBeUndefined();
  });
});
```

`autoMock` mocks the methods of class tokens. String and symbol tokens, and methods whose return value the unit calls further, need a specific double (`unit-specific-doubles`). Unit specs sit next to their source as `*.spec.ts`. `token.prototype` is `any`; walking it as `unknown` with a type guard keeps `autoMock` clean under `recommendedTypeChecked`, where a `let proto = token.prototype` loop failed `pnpm lint` with ``Unsafe assignment of an `any` value  @typescript-eslint/no-unsafe-assignment``. The `expect(sync.sync)` matchers rely on `unbound-method` being off for test files (`nestjs-setup`, `lint-type-aware-flat-config`).

Reference: [NestJS – Testing: Auto mocking](https://docs.nestjs.com/fundamentals/testing#auto-mocking)
