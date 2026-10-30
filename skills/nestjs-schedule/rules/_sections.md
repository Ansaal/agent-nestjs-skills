# Sections

This file defines all sections, their ordering, impact levels, and descriptions.
The section ID (in parentheses) is the filename prefix used to group rules.

---

## 1. Job Design (job)

**Impact:** CRITICAL
**Description:** How a scheduled method is written decides whether a slow run overlaps the next tick, a failure is logged with enough detail to act on, a nightly job fires at the intended hour, and a bad delay setting polls every millisecond.

## 2. Lifecycle (lifecycle)

**Impact:** HIGH
**Description:** Where `ScheduleModule` is registered and how the app shuts down decide whether jobs start at all and whether a run in progress finishes before the database closes.

## 3. Testing Jobs (test)

**Impact:** HIGH
**Description:** `app.init()` starts every job, so tests must keep timers from firing on their own and drive the work, the schedule and the timer wiring deterministically.
