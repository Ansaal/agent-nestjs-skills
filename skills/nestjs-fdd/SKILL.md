---
name: nestjs-fdd
description: Feature-Driven Development (FDD) planning for NestJS, turning a spec into a domain model, a feature list, feature modules with an acyclic import graph, and a PLAN.md built one test-proven feature at a time. Use when planning, designing, or structuring a NestJS app or a new feature from a spec, or when continuing a build from an existing PLAN.md.
license: MIT
metadata:
  author: Ansaal
  version: "1.0.0"
---

# NestJS Feature-Driven Development

Coad/De Luca FDD applied to NestJS: five ordered steps from spec to working code, recorded in `PLAN.md` at the repository root. A *feature* is a client-valued function small enough for one test block to prove; a *feature set* is one Nest feature module. Verified 2026-10-29 against NestJS 12.3.2 and Vitest 5.0.5 (test-name filtering in step 5).

Copy [`references/plan-template.md`](references/plan-template.md) to `PLAN.md` before step 1 and fill one section per step. When `PLAN.md` already exists, run steps 1–4 for the delta only (new requirements, objects, features), append to the existing sections, then continue step 5 at the first unticked feature.

Running example (a library lending API): members borrow copies of books; a member holds at most 5 active loans; a loan lasts 21 days; overdue members get an email.

## 1. Develop an overall model

Read the whole spec, then fill `PLAN.md` § Overall model:

- **Requirements**: number every spec sentence that states behaviour (`R1`…), quoted verbatim.
- **Domain objects**: every noun the system stores or computes (`Member`, `Book`, `Copy`, `Loan`), its kind (entity, value, external), key attributes, and relationships with cardinality.
- **External systems**: every system the app calls or is called by (mail gateway), with what it is used for and how it fails.
- **Invariants**: every "must", "never", "at most", "unique", "only if" in the spec (`I1` a copy is on at most one active loan; `I2` a member holds at most 5 active loans), each citing its `R`-id and naming the **owning object**: the entity whose state the invariant constrains.
- **Out of scope**: spec items deliberately excluded, each with a reason.

**Done when** every `R`-id is referenced by a domain object, an invariant, or an Out-of-scope entry, and every invariant names exactly one owning object.

## 2. Build a feature list

Group the work into feature sets (one per business activity: Membership, Catalog, Lending, Reminders) and list features under each. Name every feature `<action> the <result> <by|for|of|to> a(n) <object>`:

- `Lend a copy to a member`
- `Calculate the due date for a loan`
- `List the overdue loans of a member`
- `Send the overdue reminder to a member`

A feature is client-valued: a spec reader recognises it as something the system does for them. Persistence, entities, DTOs, and wiring are design detail inside features (step 4), never features of their own. A candidate whose proof needs writes in two feature sets is two features.

Each feature set becomes one Nest feature module (`Lending` → `LendingModule`) that owns the entities of the domain objects assigned to it (fill the Feature set column in § Domain objects); layout per `nestjs-best-practices` rule `arch-feature-modules`. Each invariant belongs to the feature set owning its owning object (`I2` constrains `Loan` state, so Lending enforces it and Membership stays unaware of loans).

**Done when** every `R`-id maps to at least one feature or Out of scope (the Covered by column), every domain object has a feature set, every feature name matches the grammar, every invariant is listed under a feature of its owning feature set, and every feature set has a module name in § Feature sets → modules.

## 3. Plan by feature

Draw the module import graph in § Module dependency graph (mermaid, arrow = "imports"), one edge per cross-module call a feature needs. The graph is a DAG: modules wire with plain `imports`, and a needed `forwardRef` signals a modelling error. Resolve a cycle in the model: move the feature to the module owning the data it reads, extract the shared concept into a new module both import, or decouple with events (`nestjs-best-practices` rule `arch-avoid-circular-deps`). Then return to step 2 for the moved features.

Fill § Feature sets → modules per module:

- **Exports**: its service(s) only. Repositories and `TypeOrmModule.forFeature` stay inside the owning module; other modules read and write that data through the exported service.
- **External clients**: one client provider per external system, inside the module whose features call it (its own module when several feature sets call it). Resilience wrapping per `nestjs-resilience`.

Record each feature's **Depends on** (the features whose behaviour it calls or whose data it needs), then order § Features for building: modules in topological order (imported before importer), and within a module, every feature after the features it depends on.

**Done when** the graph is acyclic, every module's exports list holds services only, and every feature's position comes after every feature it depends on.

## 4. Design by feature

Fill the four design fields of every feature in § Features:

- **Interface**: the route, method, DTO, and success/error status codes when the feature is reachable over HTTP; the service method signature in every case.
- **Data**: entities and columns it reads and writes; `migration: yes` when it adds or changes a column or table (migration mechanics per `nestjs-typeorm`).
- **Calls**: exported service methods of other modules it calls; each matches an edge in the graph. A call without an edge means updating the graph and re-running the step 3 acyclicity check.
- **Test**: the test that proves the feature: e2e when the feature is reachable over HTTP, unit when it is domain logic without a route (`Calculate the due date for a loan`). The `describe` title is the feature name verbatim; list one `it` case for the main outcome, one per invariant the feature enforces, and one per error status in Interface.

This test is the feature's completion criterion: the feature is done exactly when every listed case passes.

**Done when** every feature has all four fields filled, every invariant appears in at least one `it` case, and every Calls entry matches a graph edge.

## 5. Build by feature

Build one feature at a time, in § Features order. For each:

1. Write the test file entries exactly as listed in PLAN.md (file locations, `Test.createTestingModule`, `useMocker`, supertest per `nestjs-testing`).
2. Run `npx vitest run -t '<Feature name>'` and see it **red**: listed cases fail for missing behaviour. A run reporting only skipped tests exits 0 and means the `describe` title differs from PLAN.md; fix the title.
3. Implement in the owning module (plus its migration when Data says `migration: yes`).
4. Re-run until **green**: `Tests  N passed`, where N is the number of `it` cases listed for the feature.
5. Run the full suite; on green, tick the feature `[x]` in PLAN.md.

Work the build reveals (a missing feature, invariant, or call) goes into PLAN.md through steps 2–4 before any code for it is written.

**Done when** every feature in PLAN.md is ticked, the full test suite is green, and `nest build` succeeds.
