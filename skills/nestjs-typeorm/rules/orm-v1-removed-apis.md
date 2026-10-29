---
title: Write TypeORM 1.x Query Forms
impact: HIGH
impactDescription: 0.3-era APIs fail typecheck; null or undefined in where throws at runtime
tags: typeorm, migration-guide, repository, find-options
---

## Write TypeORM 1.x Query Forms

Most TypeORM examples in training data are 0.3.x. TypeORM 1.x removed `Connection`/`ConnectionOptions` (use `DataSource`/`DataSourceOptions`), the global helpers (`getRepository`, `getConnection`, `createConnection`), `findByIds`, `findOneById`, `Repository.exist()`, and string arrays for `relations` and `select`. These fail typecheck, e.g. `Module '"typeorm"' has no exported member 'Connection'` and `Type 'string[]' has no properties in common with type 'FindOptionsRelations<Product>'`. Where values changed too: `invalidWhereValuesBehavior` now defaults to `throw`. A literal `null` is already a type error under `strict`, but `undefined` compiles (an optional filter field) and rejects at runtime with `Undefined value encountered in property 'Product.sku' of a where condition.`; a `null` arriving from untyped input rejects with `Null value encountered in property 'Product.deletedReason' of a where condition. To match with SQL NULL, the IsNull() operator must be used.`

**Incorrect (0.3 APIs):**

```typescript
import { Connection } from 'typeorm';

await products.findByIds(ids);
await products.findOneById(id);
await products.find({ relations: ['category'], select: ['id', 'sku'] });
await products.findBy({ deletedReason: null }); // meant: match SQL NULL
await products.findBy({ sku: filter.sku }); // throws when the filter is absent
```

**Correct (1.x forms):**

```typescript
import { In, IsNull, type FindOptionsWhere, type Repository } from 'typeorm';
import type { Product } from './product.entity.js';

export async function productQueries(products: Repository<Product>, ids: string[], id: string, sku?: string) {
  const byIds = await products.findBy({ id: In(ids) });
  const one = await products.findOneBy({ id });
  const withCategory = await products.find({ relations: { category: true }, select: { id: true, sku: true } });
  const active = await products.findBy({ deletedReason: IsNull() });
  const where: FindOptionsWhere<Product> = sku === undefined ? {} : { sku };
  const filtered = await products.findBy(where);
  return { byIds, one, withCategory, active, filtered };
}
```

Inject `DataSource` (not `Connection`) and repositories via `@InjectRepository(Entity)`. For an existing 0.3 codebase the upgrade guide documents `npx @typeorm/codemod v1 src/`, which rewrites most of these and leaves `TODO` comments for the rest.

Reference: [TypeORM 1.0 upgrade guide](https://typeorm.io/docs/releases/1.0/upgrading-from-0.3)
