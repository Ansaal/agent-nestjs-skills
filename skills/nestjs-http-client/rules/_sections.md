# Sections

This file defines all sections, their ordering, impact levels, and descriptions.
The section ID (in parentheses) is the filename prefix used to group rules.

---

## 1. Client Registration (client)

**Impact:** CRITICAL
**Description:** Each external system gets one named client with its base URL, a per-attempt timeout and no retries of its own, behind one provider that owns its URLs; otherwise URLs and credentials scatter and retries multiply under a resilience policy.

## 2. Requests and Errors (request)

**Impact:** HIGH
**Description:** How a call is cancelled, how path values reach the URL, how upstream failures become typed outcomes and HTTP answers, and what gets logged per request.

## 3. Testing (test)

**Impact:** HIGH
**Description:** Where tests cut the outbound boundary: the client provider in e2e suites, an undici `MockAgent` behind the real client in client specs.
