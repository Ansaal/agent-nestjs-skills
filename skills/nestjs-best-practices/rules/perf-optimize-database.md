---
title: Optimize Database Queries
impact: HIGH
impactDescription: Database queries are typically the largest source of latency
tags: performance, database, queries, optimization, indexes
---

## Optimize Database Queries

Fetch only the columns and relations a response needs, bound every list with a page size and a deterministic order, and add indexes for the queries you actually run, confirmed with the database's query plan. Each index costs a write on every insert and update, so an index nobody's query uses is pure cost. Loading relations without N+1 is `db-avoid-n-plus-one`; TypeORM 1.x query syntax is `nestjs-typeorm` (`orm-v1-removed-apis`), and indexes ship in migrations (`nestjs-typeorm` `migration-list-classes`).

**Incorrect (over-fetching; speculative indexes; unbounded, unordered lists):**

```typescript
async findAllEmails(): Promise<string[]> {
  const users = await this.users.find(); // every column of every user
  return users.map((u) => u.email);
}

@Entity('orders')
@Index(['userId'])
@Index(['status'])
@Index(['createdAt'])
@Index(['userId', 'status']) // the single-column userId index duplicates this one's prefix
export class Order { /* ... */ }

findAll(): Promise<Order[]> {
  return this.orders.find(); // no limit; row order undefined
}
```

**Correct (narrow selects, one index per real query, stable pages):**

```typescript
async findAllEmails(): Promise<string[]> {
  const users = await this.users.find({ select: { email: true } });
  return users.map((u) => u.email);
}

getProfile(id: string): Promise<User | null> {
  return this.users.findOne({
    where: { id },
    relations: { posts: true },
    select: { id: true, name: true, email: true, posts: { id: true, title: true } },
  });
}
```

```typescript
// Serves "a user's orders in one status, newest first": equality columns first, then the sort columns
@Entity('orders')
@Index('IDX_orders_user_status_created', ['userId', 'status', 'createdAt', 'id'])
export class Order {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() userId: string;
  @Column() status: string;
  @Column('integer') total: number;
  @CreateDateColumn() createdAt: Date;
  @OneToMany(() => OrderItem, (item) => item.order) items: Relation<OrderItem[]>;
}
```

```typescript
findPage(userId: string, status: string, page: number, limit: number): Promise<[Order[], number]> {
  return this.orders.findAndCount({
    where: { userId, status },
    order: { createdAt: 'DESC', id: 'DESC' }, // id breaks ties: a deterministic order, so equal timestamps don't swap between pages
    skip: (page - 1) * limit,
    take: limit, // validate limit with an upper bound (@Max(100)) in the query DTO
  });
}
```

Check the plan for the query the index is for. On better-sqlite3, `EXPLAIN QUERY PLAN SELECT * FROM orders WHERE userId = ? AND status = ? ORDER BY createdAt DESC, id DESC LIMIT 2` returned `SEARCH orders USING INDEX IDX_orders_user_status_created (userId=? AND status=?)`. With the index on `(userId, status, createdAt)` only, it added `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`: the tie-break column has to be in the index too, or every page sorts in memory. The same index serves `WHERE userId = ?` alone (`SEARCH … (userId=?)`, a prefix), so a separate `userId` index adds write cost and nothing else; `WHERE status = ?` alone is `SCAN orders`. Add an index for that access path only when that query exists. Offset pages get slower as `skip` grows, and a row inserted or deleted between requests shifts every later page, so the next page repeats or skips a row. For deep or live lists, page by cursor (`WHERE userId = ? AND status = ? AND (createdAt, id) < (?, ?)`, planned as `SEARCH … (userId=? AND status=? AND (createdAt,id)<(?,?))`) on the same index: each page starts after the last row the client saw, so pages neither overlap nor skip existing rows.

Reference: [SQLite EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html)
