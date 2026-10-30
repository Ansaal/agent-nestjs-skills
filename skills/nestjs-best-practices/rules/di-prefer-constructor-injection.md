---
title: Prefer Constructor Injection
impact: CRITICAL
impactDescription: Required for proper DI and testing
tags: dependency-injection, constructor, testing
---

## Prefer Constructor Injection

Always use constructor injection over property injection. Constructor injection makes dependencies explicit, enables TypeScript type checking, ensures dependencies are available when the class is instantiated, and improves testability. This is required for proper DI, testing, and TypeScript support.

**Incorrect (property injection with hidden dependencies):**

```typescript
// Property injection - avoid unless necessary
@Injectable()
export class UsersService {
  @Inject()
  private userRepo: UserRepository; // Hidden dependency

  @Inject('CONFIG')
  private config: ConfigType; // Also hidden

  async findAll() {
    return this.userRepo.find();
  }
}

// Problems:
// 1. Dependencies not visible in constructor
// 2. Service can be instantiated without dependencies in tests
// 3. TypeScript can't enforce dependency types at instantiation
```

**Correct (constructor injection with explicit dependencies):**

```typescript
// Constructor injection - explicit and testable
@Injectable()
export class UsersService {
  constructor(
    private readonly userRepo: UserRepository,
    @Inject('CONFIG') private readonly config: ConfigType,
  ) {}

  async findAll(): Promise<User[]> {
    return this.userRepo.find();
  }
}

// Only use property injection for optional dependencies
@Injectable()
export class EventRecorder {
  private readonly logger = new Logger(EventRecorder.name);

  @Optional()
  @Inject('ANALYTICS')
  private analytics?: AnalyticsService;

  record(event: string) {
    this.logger.debug('Event recorded', { event });
    this.analytics?.track(event); // Optional enhancement
  }
}
```

Every dependency the constructor lists is one `useMocker()` can supply, so a unit test compiles `Test.createTestingModule({ providers: [UsersService] }).useMocker(autoMock)` and reads typed mocks with `vi.mocked(moduleRef.get(UserRepository))`; the `'CONFIG'` string token gets a specific double. How to write those tests is owned by `nestjs-testing` (`unit-automock-dependencies`, `unit-specific-doubles`).

Reference: [NestJS Providers](https://docs.nestjs.com/providers)
