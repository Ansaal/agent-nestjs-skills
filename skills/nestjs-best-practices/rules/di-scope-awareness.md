---
title: Understand Provider Scopes
impact: CRITICAL
impactDescription: Prevents data leaks and performance issues
tags: dependency-injection, scopes, request-context
---

## Understand Provider Scopes

NestJS has three provider scopes: DEFAULT (singleton), REQUEST (per-request instance), and TRANSIENT (new instance for each injection). Most providers should be singletons. Request-scoped providers have performance implications as they bubble up through the dependency tree. Understanding scopes prevents memory leaks and incorrect data sharing.

**Incorrect (wrong scope usage):**

```typescript
// Request-scoped when not needed (performance hit)
@Injectable({ scope: Scope.REQUEST })
export class UsersService {
  // This creates a new instance for EVERY request
  // All dependencies also become request-scoped
  async findAll() {
    return this.userRepo.find();
  }
}

// Singleton with mutable request state
@Injectable() // Default: singleton
export class RequestContextService {
  private userId: string; // DANGER: Shared across all requests!

  setUser(userId: string) {
    this.userId = userId; // Overwrites for all concurrent requests
  }

  getUser() {
    return this.userId; // Returns wrong user!
  }
}
```

**Correct (appropriate scope for each use case):**

```typescript
// Singleton for stateless services (default, most common)
@Injectable()
export class UsersService {
  constructor(private readonly userRepo: UserRepository) {}

  async findById(id: string): Promise<User> {
    return this.userRepo.findOne({ where: { id } });
  }
}

// Request-scoped ONLY when you need request context
@Injectable({ scope: Scope.REQUEST })
export class RequestContextService {
  private userId: string;

  setUser(userId: string) {
    this.userId = userId;
  }

  getUser(): string {
    return this.userId;
  }
}

// Better: Use NestJS built-in request context
import { REQUEST } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js'; // security-use-guards

@Injectable({ scope: Scope.REQUEST })
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(REQUEST) private readonly request: AuthenticatedRequest) {}

  record(action: string) {
    // Opaque identifier only, never names or emails
    this.logger.debug('Action performed', { userId: this.request.user?.id, action });
  }
}

// Best: Use ClsModule for async context (no scope bubble-up)
import { ClsService } from 'nestjs-cls';

@Injectable() // Stays singleton!
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private cls: ClsService) {}

  record(action: string) {
    const userId = this.cls.get('userId');
    this.logger.debug('Action performed', { userId, action });
  }
}
```

Reference: [NestJS Injection Scopes](https://docs.nestjs.com/fundamentals/injection-scopes)
