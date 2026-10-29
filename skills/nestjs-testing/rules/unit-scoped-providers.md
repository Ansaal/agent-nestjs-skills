---
title: Resolve Scoped Providers and Override REQUEST
impact: MEDIUM-HIGH
impactDescription: get() throws for scoped providers; an auto-mocked REQUEST is silently undefined
tags: testing, unit, request-scope, resolve, overrideProvider
---

## Resolve Scoped Providers and Override REQUEST

`moduleRef.get()` only returns static instances. For a request- or transient-scoped provider it throws: `TenantContext is marked as a scoped provider. Request and transient-scoped providers can't be used in combination with "get()" method. Please, use "resolve()" instead.` The scope moves up the injection chain, so a default-scoped class that injects `TenantContext` throws the same error. Use `await moduleRef.resolve(Unit)`. Each call builds a new DI sub-tree, so two calls return two different instances. To get the same instance twice, pass one `ContextIdFactory.create()` to both calls. `REQUEST` and `INQUIRER` are already defined in the context, so `useMocker()` never receives them. The provider gets `undefined` and fails at first use: `Cannot read properties of undefined (reading 'header')`. Supply them with `overrideProvider()`.

**Incorrect (`get()` on a scoped provider, REQUEST left to the mocker):**

```typescript
const moduleRef = await Test.createTestingModule({ providers: [TenantContext] })
  .useMocker(autoMock)
  .compile();
const context = moduleRef.get(TenantContext); // throws: scoped provider, use resolve()
```

**Correct (REQUEST overridden, unit resolved):**

```typescript
import { REQUEST } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { expect, it } from 'vitest';
import { autoMock } from '../../test/auto-mock.js';
import { TenantContext } from './tenant-context.js';

it('reads the tenant from the request header', async () => {
  const moduleRef = await Test.createTestingModule({ providers: [TenantContext] })
    .overrideProvider(REQUEST)
    .useValue({ header: (name: string) => (name === 'x-tenant-id' ? 'acme' : undefined) })
    .useMocker(autoMock)
    .compile();

  const context = await moduleRef.resolve(TenantContext);

  expect(context.tenantId).toBe('acme');
});
```

`TenantContext` is `@Injectable({ scope: Scope.REQUEST })` with `@Inject(REQUEST) request: Request`. The double implements only the members the unit reads.

Reference: [NestJS – Testing: Testing request-scoped instances](https://docs.nestjs.com/fundamentals/testing#testing-request-scoped-instances)
