---
title: Avoid N+1 Query Problems
impact: HIGH
impactDescription: N+1 queries are one of the most common performance killers
tags: database, n-plus-one, queries, performance
---

## Avoid N+1 Query Problems

N+1 queries happen when you load a list, then issue one more query per row for its related data. Load the relations with the list (`relations`, or a query-builder join), aggregate in SQL when you only need counts, and batch per request (DataLoader over one `In(ids)` query) when resolvers fetch relations field by field. TypeORM 1.x query syntax (object `relations`/`select`, no string arrays) is owned by `nestjs-typeorm` rule `orm-v1-removed-apis`; entities type relations as `Relation<T>` (`orm-relation-wrapper`).

**Incorrect (one query per order):**

```typescript
async getOrdersWithItems(userId: string): Promise<Order[]> {
  const orders = await this.orders.find({ where: { userId } }); // 1 query
  for (const order of orders) {
    order.items = await this.items.find({ where: { order: { id: order.id } } }); // + 1 per order
  }
  return orders;
}
```

**Correct (relations loaded with the list; counts aggregated in SQL):**

```typescript
getOrdersWithItems(userId: string): Promise<Order[]> {
  return this.orders.find({
    where: { userId },
    relations: { items: { product: true } },
  });
}

getUsersWithPostCounts(): Promise<{ id: string; name: string; postCount: number }[]> {
  return this.users
    .createQueryBuilder('user')
    .leftJoin('user.posts', 'post')
    .select('user.id', 'id')
    .addSelect('user.name', 'name')
    .addSelect('COUNT(post.id)', 'postCount')
    .groupBy('user.id')
    .getRawMany();
}

getActiveUsersWithPublishedPosts(): Promise<User[]> {
  return this.users
    .createQueryBuilder('user')
    // the condition belongs to the join: users without published posts stay in the result
    .leftJoinAndSelect('user.posts', 'post', 'post.status = :status', { status: 'published' })
    .where('user.isActive = :active', { active: true })
    .getMany();
}

getOrderSummaries(userId: string): Promise<Order[]> {
  return this.orders.find({
    where: { userId },
    relations: { items: true },
    select: { id: true, total: true, status: true, items: { id: true, quantity: true, price: true } },
  });
}
```

With five orders of one item each, the loop issued 6 `SELECT`s and `relations: { items: { product: true } }` issued 1, with every `items[].product` populated. `getOrderSummaries` returned `{"id":…,"status":"open","total":0,"items":[{"id":…,"quantity":1,"price":2}]}`, nothing else. To spot N+1 in development, turn on `logging: ['query']` in the one `dataSourceOptions` (`nestjs-typeorm` rule `orm-single-data-source`), not in a second `TypeOrmModule.forRoot`.

Reference: [TypeORM Find Options](https://typeorm.io/docs/working-with-entity-manager/find-options/)
