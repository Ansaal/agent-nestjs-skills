# Sections

This file defines all sections, their ordering, impact levels, and descriptions.
The section ID (in parentheses) is the filename prefix used to group rules.

---

## 1. Resilience Policies (resilience)

**Impact:** CRITICAL
**Description:** Where retries, timeouts and circuit breakers apply decides whether a failing dependency costs a bounded delay or a retry storm, duplicated side effects and hung requests.

## 2. Dead Letters (dlq)

**Impact:** HIGH
**Description:** A call that still fails after its retries must leave a replayable record, or the work it carried is silently lost.

## 3. Idempotency (idempotency)

**Impact:** HIGH
**Description:** Client retries and webhook redeliveries must change state once and answer the way the API contract says duplicates are answered.
