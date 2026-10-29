# PLAN: <app or feature name>

Source spec: <path or link>. Built with the `nestjs-fdd` steps; each section below is filled by the step named in its heading.

## Overall model (step 1)

### Requirements

| ID | Requirement (verbatim from spec) | Covered by |
|----|----------------------------------|------------|
| R1 | "<sentence>" | <object / I-id / F-ids / Out of scope> |

### Domain objects

| Object | Kind (entity / value / external) | Key attributes | Relationships | Feature set |
|--------|----------------------------------|----------------|---------------|-------------|
| <Object> | entity | <attr>, <attr> | <1..n Other> | <Feature set> |

### External systems

| System | Used for | Failure mode | Client provider (module) |
|--------|----------|--------------|--------------------------|
| <System> | <purpose> | <timeout / 5xx / rate limit> | `<Name>Client` (`<Module>`) |

### Invariants

| ID | Invariant | Source | Owning object | Enforced by |
|----|-----------|--------|---------------|-------------|
| I1 | <rule> | R<n> | <Object> | F<n> |

### Out of scope

- <item>: <reason>

## Feature sets → modules (steps 2–3)

| Feature set | Module | Owns entities | Exports (services only) | Imports | External clients |
|-------------|--------|---------------|-------------------------|---------|------------------|
| <Feature set> | `<Name>Module` | <Entity>, <Entity> | `<Name>Service` | `<Other>Module` | `<Name>Client` |

## Module dependency graph (step 3)

Arrow = "imports". Acyclic; listed modules are built top to bottom in § Features.

```mermaid
graph LR
  <Importer>Module --> <Imported>Module
```

## Features (steps 2–5, in build order)

Feature name grammar: `<action> the <result> <by|for|of|to> a(n) <object>`. Tick `[x]` only after the feature's test is green and the full suite passes.

### <Feature set> — `<Name>Module`

- [ ] **F1 <Action> the <result> <by|for|of|to> a(n) <object>**
  - Interface: `<METHOD> /<route>` body `<Dto>` → `<2xx>` `<ResponseDto>`; errors `<4xx>` (<I-id / reason>); `<Name>Service.<method>(<args>): Promise<<Type>>`
  - Data: reads <entity.columns>; writes <entity.columns>; migration: <yes / no>
  - Calls: `<Other>Service.<method>` (edge `<Name>Module --> <Other>Module`) / none
  - Depends on: <F-ids> / none
  - Test: <e2e / unit> `<path>` — `describe('<feature name verbatim>')`
    - `it('<main outcome>')`
    - `it('<rejects … (I-id)>')`
    - `it('<returns 4xx when …>')`
