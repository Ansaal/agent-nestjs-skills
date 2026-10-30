# Sections

This file defines all sections, their ordering, impact levels, and descriptions.
The section ID (in parentheses) is the filename prefix used to group rules.

---

## 1. Logger Setup (setup)

**Impact:** HIGH
**Description:** One JSON logger, configured once in `main.ts` and reached through `Logger` instances, decides the format, levels and masking of every line the app and the framework write.

## 2. Log Levels (level)

**Impact:** HIGH
**Description:** The level says who must act on a line; a shared policy keeps production output small enough to read and alerts meaningful.

## 3. Log Content (content)

**Impact:** HIGH
**Description:** Fields go into structured params and errors are passed as objects, so lines can be queried, while secrets and personal data never reach the log at any level.

## 4. Logs in Tests (test)

**Impact:** MEDIUM
**Description:** Test runs print nothing from the app logger, and tests that care about a log line assert it from a capturing logger instead of reading console output.
