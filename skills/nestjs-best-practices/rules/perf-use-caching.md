---
title: Use Caching Strategically
impact: HIGH
impactDescription: Dramatically reduces database load and response times
tags: performance, caching, redis, optimization
---

## Use Caching Strategically

Cache expensive reads that many requests share, with a TTL that matches how stale the data may be, and make sure no entry read before a write commits is served after it. The cache key must contain everything the response depends on. `CacheInterceptor` keys on the request URL (`httpAdapter.getRequestUrl`), path parameters and query string included, and caches `GET` only. A static `@CacheKey('category')` replaces that key for every request to the route: in the probe, `GET /categories/1` then `GET /categories/2` both returned `{"id":"1"}`. A response that depends on the caller (`/me`, anything behind a guard that filters by user or tenant) must not use a URL-only key, or the first caller's data is served to everyone.

**Incorrect (static key on a parameterized route; personalized response under a shared key):**

```typescript
@Controller('categories')
@UseInterceptors(CacheInterceptor)
export class CategoriesController {
  @Get(':id')
  @CacheKey('category') // every id shares one entry
  findOne(@Param('id') id: string): Promise<Category> {
    return this.categories.findOne(id);
  }
}

@Get('me/feed')
@UseInterceptors(CacheInterceptor) // key is "/me/feed": user B gets user A's feed
feed(@CurrentUser() user: User): Promise<FeedItem[]> {
  return this.feeds.forUser(user.id);
}

async getPopular(): Promise<Product[]> {
  const cached = await this.cache.get<Product[]>('products:popular');
  if (cached) return cached; // a cached 0, '' or false is treated as a miss
  // ...
}

async update(id: string, dto: UpdateProductDto): Promise<void> {
  await this.transactions.run((manager) => manager.update(Product, { id }, dto));
  await this.cache.del('products:popular'); // a reader that queried before the commit sets the old list again
}
```

**Correct (store, URL keys, per-principal keys, generation keys):**

```typescript
// cache/redis-cache.module.ts — shared store; omit `stores` for the in-memory default
import KeyvRedis from '@keyv/redis';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        stores: [new KeyvRedis(config.getOrThrow<string>('REDIS_URL'))],
        ttl: 60_000, // default 60 s, in milliseconds
      }),
    }),
  ],
})
export class RedisCacheModule {}
```

```typescript
// The URL is the key: /categories/1 and /categories/2 are separate entries
@Controller('categories')
@UseInterceptors(CacheInterceptor)
export class CategoriesController {
  @Get(':id')
  @CacheTTL(60_000)
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<CategoryDto> {
    return this.categories.findOne(id);
  }
}
```

```typescript
// cache/user-cache.interceptor.ts
import { CacheInterceptor } from '@nestjs/cache-manager';
import { Injectable, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: string };
}

/** Per-principal cache key for responses that depend on who asks; uncached without a key or a user. */
@Injectable()
export class UserCacheInterceptor extends CacheInterceptor {
  protected override async trackBy(context: ExecutionContext): Promise<string | undefined> {
    const key = await super.trackBy(context); // a @CacheKey() factory may return a promise
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    return key && user ? `user:${user.id}:${key}` : undefined;
  }
}

// usage: @Get('me/feed') @UseInterceptors(UserCacheInterceptor) @CacheTTL(30_000)
```

```typescript
// cache/cache-generation.ts: one row per cached data set, created by a migration (nestjs-typeorm)
@Entity('cache_generations')
export class CacheGeneration {
  @PrimaryColumn() name: string;
  @Column('integer') value: number;
}

export async function readGeneration(manager: EntityManager, name: string): Promise<number> {
  return (await manager.findOneBy(CacheGeneration, { name }))?.value ?? 0;
}

export async function bumpGeneration(manager: EntityManager, name: string): Promise<void> {
  await manager.createQueryBuilder().insert().into(CacheGeneration).values({ name, value: 0 }).orIgnore().execute();
  await manager.increment(CacheGeneration, { name }, 'value', 1);
}
```

```typescript
// products/products.service.ts
const POPULAR = 'products:popular';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly transactions: TransactionRunner,
  ) {}

  async getPopular(): Promise<Product[]> {
    const generation = await this.transactions.run((manager) => readGeneration(manager, POPULAR));
    const cached = await this.cache.get<Product[]>(`${POPULAR}:${generation}`);
    if (cached !== undefined) return cached; // an empty list is a valid cached value

    // The list and the generation it belongs to, read in one transaction
    const fresh = await this.transactions.run(async (manager) => ({
      generation: await readGeneration(manager, POPULAR),
      products: await manager.find(Product, { order: { orderCount: 'DESC' }, take: 20 }),
    }));
    await this.cache.set(`${POPULAR}:${fresh.generation}`, fresh.products, 5 * 60_000);
    return fresh.products;
  }

  update(id: string, dto: UpdateProductDto): Promise<void> {
    return this.transactions.run(async (manager) => {
      await manager.update(Product, { id }, dto);
      await bumpGeneration(manager, POPULAR); // commits with the change, or not at all
    });
  }
}
```

Probe results (in-memory store, `@nestjs/cache-manager` 12.0.2, `cache-manager` 7.2.9): `/categories/1`, `/categories/2`, `/categories/1` returned `n` 1, 2, 1, so the second id ran the handler and the third request was a hit. `/me/feed` for `u1`, `u2`, `u1` returned 1, 2, 1, and two anonymous requests returned 3 and 4 (not cached). On a route with an async `@CacheKey()` factory keyed on `?tab=`, a synchronous `trackBy` override (`${super.trackBy(context)}` in a template string, so the key holds `[object Promise]`) answered `tab=b` with the cached `tab=a` body; the awaiting override cached them separately. A reader held between its query and its `cache.set()` while `update()` committed: with delete-after-commit the next two reads returned the old name, with the database generation the new one. When the cache rejected writes right after the commit, a generation kept in the cache left `update()` rejected (`ECONNRESET`) after the row had changed, and the next reads returned `old`; the database generation made no cache call in `update()`, and the next reads returned `new`. On an empty table, three `getPopular()` calls returned `[]` with one list query. Through `RedisCacheModule` (`@keyv/redis` 6.1.0, Redis 8.10.2) a cached `[]` came back as `[]` and a miss as `undefined`; `CacheInterceptor` itself treats a cached `null` as a miss.

Writes go through `TransactionRunner` (`nestjs-typeorm` rule `orm-atomic-writes`). Deleting a key after the commit is not enough: a reader that queried before the commit can `set()` the old value after the `del()`. Changing a generation kept in the cache is a second write after the commit that can fail on its own. The generation therefore lives in the database and changes in the same transaction as the data; a reader caches a list only under the generation it read in that same transaction, so a late `set()` lands on a key nobody reads. That costs one primary-key read through `run()` per request, queued behind open transactions like every committed read. Entries under old generations expire with their TTL. Don't cache what changes on most requests, and don't cache errors.

Reference: [NestJS Caching](https://docs.nestjs.com/techniques/caching)
