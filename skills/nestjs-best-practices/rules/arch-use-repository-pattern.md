---
title: Use Repository Pattern for Data Access
impact: HIGH
impactDescription: Decouples business logic from database
tags: architecture, repository, data-access
---

## Use Repository Pattern for Data Access

Create custom repositories to encapsulate complex queries and database logic. This keeps services focused on business logic, makes testing easier with mock repositories, and allows changing database implementations without affecting business code.

**Incorrect (complex queries in services):**

```typescript
// Complex queries in services
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private repo: Repository<User>,
  ) {}

  async findActiveWithOrders(minOrders: number): Promise<User[]> {
    // Complex query logic mixed with business logic
    return this.repo
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.orders', 'order')
      .where('user.isActive = :active', { active: true })
      .andWhere('user.deletedAt IS NULL')
      .groupBy('user.id')
      .having('COUNT(order.id) >= :min', { min: minOrders })
      .orderBy('user.createdAt', 'DESC')
      .getMany();
  }

  // Service becomes bloated with query logic
}
```

**Correct (custom repository with encapsulated queries and writes):**

```typescript
// users/users.repository.ts
@Injectable()
export class UsersRepository {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly transactions: TransactionRunner,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.users.findOneBy({ id });
  }

  findActiveWithMinOrders(minOrders: number): Promise<User[]> {
    return this.users
      .createQueryBuilder('user')
      .leftJoin('user.orders', 'order') // joined to count, not selected
      .where('user.isActive = :active', { active: true })
      .groupBy('user.id')
      .having('COUNT(order.id) >= :min', { min: minOrders })
      .orderBy('user.createdAt', 'DESC')
      .getMany();
  }

  /** A duplicate email rejects with the unique-constraint violation; the caller maps it. */
  insert(data: Pick<User, 'email' | 'name'>): Promise<User> {
    return this.transactions.run((manager) => manager.save(User, { ...data, roles: ['member'] }));
  }
}

// users/users.service.ts: business rules only
@Injectable()
export class UsersService {
  constructor(private readonly usersRepo: UsersRepository) {}

  getActiveUsersWithOrders(): Promise<User[]> {
    return this.usersRepo.findActiveWithMinOrders(1);
  }

  async create(dto: CreateUserDto): Promise<User> {
    try {
      return await this.usersRepo.insert({ email: dto.email, name: dto.name });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Email already registered');
      throw error;
    }
  }
}
```

No `findByEmail` pre-check: two concurrent requests both see "absent", so the unique index on `email` decides and the service maps its violation to 409 (in the probe a second `POST /users` with the same email answered `409 {"message":"Email already registered",…}`). Persistence rules are owned by `nestjs-typeorm`: every write through `TransactionRunner` (`orm-atomic-writes`), `isUniqueViolation()` and the driver codes (`orm-unique-violation`), `Relation<T>` and the 1.x find forms (`orm-relation-wrapper`, `orm-v1-removed-apis`).

Reference: [Repository Pattern](https://martinfowler.com/eaaCatalog/repository.html)
