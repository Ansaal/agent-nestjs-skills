---
title: Type Relation Properties as Relation<T>
impact: HIGH
impactDescription: Circular entity imports crash the built app and the TypeORM CLI with a TDZ ReferenceError
tags: typeorm, entities, relations, esm, swc, decorators
---

## Type Relation Properties as Relation<T>

Two entities that reference each other import each other. With `emitDecoratorMetadata`, SWC emits `_ts_metadata("design:type", typeof Category === "undefined" ? Object : Category)` for a property typed `Category`; in ESM the imported class is still in its temporal dead zone while the cycle loads, and even `typeof` throws. The built app (`node dist/src/main.js`) and the TypeORM CLI then fail with `ReferenceError: Cannot access 'Category' before initialization`. Vitest can pass at the same time because its import order differs, so a green test run does not prove the entities are safe. `Relation<T>` (`type Relation<T> = T`) is type-only, so the emitted metadata falls back to `Object` and the cycle disappears; the arrow functions in the decorators already tell TypeORM the target entity.

**Incorrect (bare entity types on relation properties):**

```typescript
@Entity('products')
export class Product {
  @ManyToOne(() => Category, (category) => category.products) category: Category;
}

@Entity('categories')
export class Category {
  @OneToMany(() => Product, (product) => product.category) products: Product[];
}
```

**Correct (`Relation<T>` on both sides, imported as a type):**

```typescript
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Category } from './category.entity.js';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) sku: string;
  @Column('integer') version: number;
  @Column({ type: 'varchar', default: '' }) title: string;
  @Column({ type: 'varchar', nullable: true }) deletedReason: string | null;
  @ManyToOne(() => Category, (category) => category.products, { nullable: true }) category: Relation<Category> | null;
}
```

```typescript
import { Column, Entity, OneToMany, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Product } from './product.entity.js';

@Entity('categories')
export class Category {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) name: string;
  @OneToMany(() => Product, (product) => product.category) products: Relation<Product[]>;
}
```

SWC also emits `Object` for union-typed columns such as `deletedReason: string | null`, so give those columns an explicit `type`; otherwise boot fails with `DataTypeNotSupportedError: Data type "Object" in "Product.deletedReason" is not supported by "better-sqlite3" database.`

Reference: [TypeORM: Relations in ESM projects](https://typeorm.io/docs/getting-started#relations-in-esm-projects)
