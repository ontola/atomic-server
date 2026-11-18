# @tomic/lib: The Atomic Data library for typescript/javascript

[**docs**](https://docs.atomicdata.dev/js)

Resource reads prefer the browser database and a connected WebSocket. If a
WebSocket GET does not answer within 50 ms on loopback, or one second for a
remote node, the Store cancels that request and uses its authenticated HTTP
path. Successful WebSocket reads avoid a duplicate HTTP request, and explicit
server errors are preserved. POST requests use HTTP directly and are not
retried by this read fallback. These budgets cover individual resource and
collection-page GETs; bulk `getResources()` / `GET_MANY` has a separate timeout.
