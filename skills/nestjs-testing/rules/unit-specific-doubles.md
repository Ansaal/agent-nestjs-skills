---
title: Match the Token for Specific Doubles, Delegate the Rest to autoMock
impact: HIGH
impactDescription: TypeError from empty mocks, or failures swallowed into a passing-looking undefined
tags: testing, unit, useMocker, injection-token, repository
---

## Match the Token for Specific Doubles, Delegate the Rest to autoMock

`autoMock` has two gaps. First, it returns `{}` for string and symbol tokens. `@InjectRepository(Product)` is the string token `'ProductRepository'`, so the controller fails with `TypeError: this.products.create is not a function`. Second, every mocked method returns `undefined`. If the unit chains on a return value, such as `this.resilience.preset('downstream').execute(fn)`, the call throws. When the unit's own `catch` turns that error into a dead letter, the test gets `undefined` back and no error at all. For these tokens, write a factory that compares the token, returns the specific double, and passes every other token to `autoMock(token)`. A new constructor parameter then still gets mocked.

**Incorrect (matches one token and returns `undefined` for the rest):**

```typescript
const moduleRef = await Test.createTestingModule({ controllers: [ProductsController] })
  .useMocker((token) => {
    if (token === getRepositoryToken(Product)) return products;
  }) // Nest can't resolve dependencies of the ProductsController (ProductRepository, ?)
  .compile();
```

**Correct (specific double for the repository token, `autoMock` for everything else):**

```typescript
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autoMock } from '../../test/auto-mock.js';
import { Product } from '../product.entity.js';
import { SyncDispatcher } from './sync.dispatcher.js';
import { ProductsController } from './products.controller.js';

describe('ProductsController', () => {
  const products = {
    create: vi.fn((data: Partial<Product>) => data),
    save: vi.fn(async (data: Partial<Product>) => ({ id: 'id-1', ...data })),
  };
  let moduleRef: TestingModule;

  beforeEach(async () => {
    vi.clearAllMocks();
    moduleRef = await Test.createTestingModule({ controllers: [ProductsController] })
      .useMocker((token) => (token === getRepositoryToken(Product) ? products : autoMock(token)))
      .compile();
  });

  it('saves a new product at version 1', async () => {
    const created = await moduleRef.get(ProductsController).create({ sku: 'p-1' });

    expect(created).toEqual({ id: 'id-1', sku: 'p-1', version: 1 });
    expect(products.save).toHaveBeenCalledOnce();
  });

  it('hands the sync to the dispatcher', () => {
    moduleRef.get(ProductsController).sync('p-1');

    expect(vi.mocked(moduleRef.get(SyncDispatcher)).dispatch).toHaveBeenCalledWith('p-1');
  });
});
```

Keep the double in a local `const` so the test uses it with its real type, with no `moduleRef.get<…>(stringToken)` cast. Use the same pattern for a pass-through policy, so a service unit test runs the wrapped call directly:

```typescript
.useMocker((token) =>
  token === ResilienceService ? { preset: () => ({ execute: (fn: () => unknown) => fn() }) } : autoMock(token),
)
```

Reference: [NestJS – Testing: Auto mocking](https://docs.nestjs.com/fundamentals/testing#auto-mocking)
