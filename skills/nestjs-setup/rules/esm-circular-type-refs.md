---
title: Wrap Circular Type References in Relation or WrapperType
impact: HIGH
impactDescription: Prevents "Cannot access 'X' before initialization" crashes at boot that tests do not reproduce
tags: esm, swc, circular-imports, forwardRef, typeorm, decorator-metadata
---

## Wrap Circular Type References in Relation or WrapperType

With ESM and SWC, decorator metadata (`design:type`, `design:paramtypes`) reads the imported class while the module is still being evaluated. When two files import each other, one of the classes is not initialized yet and the built app crashes at boot: `ReferenceError: Cannot access 'ProfileService' before initialization`, and after fixing the services, `ReferenceError: Cannot access 'Profile' before initialization` for the entities. `forwardRef()` fixes Nest's provider ordering, not this metadata read. Vitest's module runner hides the bug: the same circular providers and entities passed a Vitest spec while the `nest build` output crashed under `node`, so prove a cycle fix with `nest build` and a boot. Wrapping the type in an alias makes SWC emit `Object` instead of the class: TypeORM's `Relation<T>` for entity relation properties, a local `WrapperType<T>` for `forwardRef` constructor parameters.

**Incorrect (plain class types across a circular import):**

```typescript
// users.service.ts ↔ profile.service.ts import each other
@Injectable()
export class UsersService {
  constructor(
    @Inject(forwardRef(() => ProfileService))
    private readonly profiles: ProfileService,
  ) {}
}

// user.entity.ts ↔ profile.entity.ts import each other
@Entity()
export class User {
  @PrimaryGeneratedColumn() id: number;

  @OneToOne(() => Profile, (profile) => profile.user)
  @JoinColumn()
  profile: Profile;
}
```

**Correct (alias-wrapped types on both sides of each cycle):**

```typescript
// wrapper-type.ts
/** Type alias that SWC emits as `Object` in decorator metadata, so the class reference is not read at load time. */
export type WrapperType<T> = T;
```

```typescript
// users.service.ts (profile.service.ts mirrors it with WrapperType<UsersService>)
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ProfileService } from './profile.service.js';
import type { WrapperType } from './wrapper-type.js';

@Injectable()
export class UsersService {
  constructor(
    @Inject(forwardRef(() => ProfileService))
    private readonly profiles: WrapperType<ProfileService>,
  ) {}

  name(): string {
    return 'user';
  }

  describe(): string {
    return `${this.name()} with ${this.profiles.name()}`;
  }
}
```

```typescript
// user.entity.ts (profile.entity.ts mirrors it with `user: Relation<User>`)
import { Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { Profile } from './profile.entity.js';

@Entity()
export class User {
  @PrimaryGeneratedColumn() id: number;

  @OneToOne(() => Profile, (profile) => profile.user)
  @JoinColumn()
  profile: Relation<Profile>;
}
```

Removing the cycle is the better fix where the design allows it (`nestjs-best-practices`, `arch-avoid-circular-deps`); entity modelling lives in `nestjs-typeorm`.

Reference: [NestJS SWC recipe – Common pitfalls](https://docs.nestjs.com/recipes/swc)
