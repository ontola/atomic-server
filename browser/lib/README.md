# @tomic/lib: The Atomic Data library for typescript/javascript

[**docs**](https://docs.atomicdata.dev/js)

To observe automatic server storage receipts, subscribe before connecting or
saving:

```ts
import { StoreEvents } from '@tomic/lib';

const unsubscribe = store.on(StoreEvents.ServerReplicaReceipt, evidence => {
  const barrier = evidence.observation.barrier!;
  console.info(evidence.serverOrigin, barrier.subject, barrier.version);
});
```

Compatible servers supply evidence after saves, background outbox delivery, and
stored-state reconciliation. Followed WebSocket drives refresh their stored
versions automatically. No application receipt probes are needed. Evidence is
best effort and historical; it does not change save completion or establish a
complete backup. Apply your own trust and independence policy with
`evaluateReplicaEvidence`. See the
[persistence guide](https://docs.atomicdata.dev/local-first-guide/4-persist.html)
for the contract and lifecycle limits. Call `unsubscribe()` to remove the listener.
