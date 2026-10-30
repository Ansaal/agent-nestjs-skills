---
title: Use Lazy Loading for Large Modules
impact: MEDIUM
impactDescription: Improves startup time for large applications
tags: performance, lazy-loading, modules, optimization
---

## Use Lazy Loading for Large Modules

`LazyModuleLoader` defers a module's import and instantiation until first use. It pays off for rarely used features with heavy dependencies and for serverless cold starts; in a long-running server the work only moves from startup to the first request. Three things go wrong in practice: the dynamic import needs the `.js` suffix like every relative ESM import (`nestjs-setup` rule `esm-imports-and-paths`), concurrent first calls each load the module unless the *promise* is cached, and lifecycle hooks (`onModuleInit`, `onApplicationBootstrap`, shutdown hooks) are not called for providers of a lazily loaded module, so a provider that needs async setup or teardown does not belong there.

**Incorrect (extensionless import; result cached after the await):**

```typescript
private adminModule: ModuleRef | null = null;

private async getAdminModule(): Promise<ModuleRef> {
  if (!this.adminModule) {
    const { AdminModule } = await import('./admin/admin.module'); // TS2307: Cannot find module './admin/admin.module'
    this.adminModule = await this.lazyModuleLoader.load(() => AdminModule); // concurrent callers all get here
  }
  return this.adminModule;
}
```

**Correct (`reports/reports.facade.ts`):**

```typescript
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { LazyModuleLoader, type ModuleRef } from '@nestjs/core';

/** Loads ReportsModule on first use; every caller shares one load. */
@Injectable()
export class ReportsFacade implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReportsFacade.name);
  private reportsModule?: Promise<ModuleRef>;

  constructor(private readonly lazyModuleLoader: LazyModuleLoader) {}

  async generate(type: string): Promise<string> {
    const moduleRef = await this.module();
    const { ReportGenerator } = await import('./reports/reports.module.js');
    return moduleRef.get(ReportGenerator).generate(type);
  }

  /** Optional warm-up after startup; a failure leaves the module to load on first use. */
  onApplicationBootstrap(): void {
    this.module().catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn('Reports module preload failed', {}, err);
    });
  }

  private module(): Promise<ModuleRef> {
    // Cache the promise, not the result: concurrent first calls share one load
    this.reportsModule ??= this.load().catch((error: unknown) => {
      this.reportsModule = undefined; // a failed load is retried on the next call
      throw error;
    });
    return this.reportsModule;
  }

  private async load(): Promise<ModuleRef> {
    const { ReportsModule } = await import('./reports/reports.module.js');
    return this.lazyModuleLoader.load(() => ReportsModule);
  }
}
```

`ReportsModule` is not in any `imports` array; only the facade is registered eagerly. In the probe, three concurrent first calls through the incorrect getter constructed `ReportGenerator` three times (they then received one `ModuleRef`); through the facade, three concurrent `generate()` calls constructed it once. The class is taken from the same typed `import()`, so no `Object.values(module)[0]` or `Promise<any>` is needed.

Reference: [NestJS Lazy Loading Modules](https://docs.nestjs.com/fundamentals/lazy-loading-modules)
