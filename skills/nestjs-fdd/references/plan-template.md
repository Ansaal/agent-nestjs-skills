# PLAN: <app or feature name>

Source spec: <path or link>. Built with the `nestjs-fdd` steps. Ids are for this file only; code and test titles use plain words.

## Decisions

- D1 <decision> — <why>[; instead of <obvious alternative>]

## Risks

- <limit the design accepts> — <accepted | mitigated by …>

## Model (step 1)

### Requirements

- R1 "<clause, verbatim>" → F<n>, … | out of scope

### Domain objects

- <Object> (entity | value | external): <key attributes>; <relationships with cardinality> → <Feature set>

### External systems

- <System>: <used for>; fails by <timeout / 5xx / rate limit>; client <Name>Client in <Module>

### Invariants

- I1 <rule> (R<n>) — owner <Object>

### Out of scope

- <item> — <reason>

## Modules (step 3)

Arrow = "imports". Acyclic; feature sets below are in build order.

```mermaid
graph LR
  <Importer>Module --> <Imported>Module
```

## Enablers (steps 2–5, in build order)

- [ ] **E1 <purpose>** — check: `<command>` → <result> (D<n>)

## Features (steps 2–5, in build order)

Name grammar: `<action> the <result> <by|for|of|to> a(n) <object>`. Tick `[x]` only after every case was red against the scaffold, the feature's test is green, and the full suite passes. Leave out a line that would say `none`.

### <Feature set> — <Name>Module (owns <Entity>, …; exports <Name>Service)

- [ ] **F1 <Action> the <result> <by|for|of|to> a(n) <object>**
  - Interface: `<METHOD> /<route>` `<Dto>` → `<2xx>` `<ResponseDto>`; `<4xx>` <reason>; `<Name>Service.<method>(<args>): Promise<<Type>>`
  - Data: reads <table>; writes <table>[; migration]
  - Calls: `<Other>Service.<method>`
  - Operations: <trigger>; <overlap / instances>; <lock>; <retry / idempotency>; logs <message: level>
  - Needs: E<n>
  - Test: <e2e | unit> `<path>` — `describe('<feature name verbatim>')`
    - `it('<main outcome>')`
    - `it('<rule it enforces>')` — I<n>
    - `it('<answers 4xx with <the feature's error message> when …>')`
