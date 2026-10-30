# Sections

This file defines all sections, their ordering, impact levels, and descriptions.
The section ID (in parentheses) is the filename prefix used to group rules.

---

## 1. Lock Store (store)

**Impact:** CRITICAL
**Description:** A lock excludes only the callers that share its store: without a durable, atomic store every instance takes "the" lock and runs the same job.

## 2. Scheduled Jobs (job)

**Impact:** HIGH
**Description:** `@WithoutOverlapping()` and `@OnOneInstance()` replace the method they decorate; the wrong decorator or an unstable key lets runs overlap or run on every instance.

## 3. Ad-hoc Locks (lock)

**Impact:** HIGH
**Description:** A lock taken in code can be refused, and can be lost while held; the caller must handle both, and fence its writes with the lock's token.

## 4. Leader Election (leader)

**Impact:** MEDIUM
**Description:** Continuous work that one instance at a time must do starts and stops with the leader's lease.

## 5. Testing Locks (test)

**Impact:** MEDIUM
**Description:** Lock expiry, takeover and loss are time-dependent; the package's manual clock makes them deterministic tests.
