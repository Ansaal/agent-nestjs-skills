---
title: Put Path Values in params and Query Values in query
impact: MEDIUM-HIGH
impactDescription: Interpolated ids that contain "/" or ".." call a different endpoint; secrets in query strings reach logs
tags: http-client, url, params, query, security
---

## Put Path Values in params and Query Values in query

An id interpolated into a path is not encoded: `` `/shipments/${id}` `` with `id = '../admin/users'` was sent as `GET https://carrier.test/admin/users`, and an id containing `/` or `?` changes the path or starts a query string. Write the path as a template with `:name` segments and pass the values in `params`: each one is URI-encoded (`getQuotes('a/b')` requested `/orders/a%2Fb/quotes`), every key must match a segment, and a value can't be empty, `.` or `..` (`TypeError: Path parameter "id" can't be "..": it would change which endpoint the request goes to`). Pass query values in `query` (`{ orderId: 'ord 1', state: ['open', 'lost'], since: undefined }` was sent as `?orderId=ord%201&state=open&state=lost`), never as a string on the path. The client's error messages mask every query value (`?token=***`), and a `baseUrl` with a query string is refused at startup, so per-system query values belong in `query` or an interceptor.

**Incorrect (interpolated id and query string):**

```typescript
findShipment(id: string, include: string) {
  return this.http.get<Shipment>(`/shipments/${id}?include=${include}`);
}
```

**Correct (template path, `params` and `query`):**

```typescript
async findShipment(id: string, signal?: AbortSignal): Promise<Shipment | null> {
  try {
    const { data } = await this.http.get<Shipment>('/shipments/:id', { params: { id }, signal });
    return data;
  } catch (error) {
    if (error instanceof HttpResponseError && error.status === 404) return null;
    throw error;
  }
}

async listShipments(orderId: string, states: string[], signal?: AbortSignal): Promise<Shipment[]> {
  const { data } = await this.http.get<Shipment[]>('/shipments', { query: { orderId, state: states }, signal });
  return data;
}
```

A `GET` or `HEAD` with a body throws ``TypeError: A GET request can't have a body. Send the values in `query`.`` before anything is sent. Send JSON bodies with `json` (serialized, `content-type: application/json` set) and raw bodies with `body`; passing both throws ``TypeError: Pass either `json` or `body`, not both``.

Reference: [NestJS HTTP client](https://docs.nestjs.com/application/http-client)
