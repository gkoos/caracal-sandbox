# 19 — Delegated, bounded from inside the process

[18-serval-delegated](../18-serval-delegated/README.md) with one line added: a
`bulkhead.local({ limit: 2 })` composed **innermost**, under the delegated layers.
The delegated layers are approximate by design — they admit from authority a
replica already holds, and that authority can be stale. A local policy is the only
bound that still holds when the coordinator does not answer.

```sh
npm run demo 19
npm run compare 18 19
```

## What the ceiling is, and is not

Two per process across four processes is **8**: that is the worst case the fleet
can now reach, against a fleet target of 5. It is a bound on the worst case, not a
second budget — and here it is deliberately tighter than the target, so it *does*
bind when the load concentrates on one replica.

That sensitivity is visible in two runs of the identical configuration:

| run | witness peak in-flight | admitted share |
|---|---|---|
| 1 | 5 | 25.4% |
| 2 | 3 | 15.3% |
| 3 | 5 | 25.4% |

Ten points of admitted share, from nothing but how the offered load landed. The
study asserts the bound (at most 8 in flight) and that the run did real work; the
cost of the bound is what `compare 18 19` reports rather than something a single
threshold can pin.

## What to take from it

The pairing is the point: the fleet target belongs to the coordinator, the
per-process ceiling belongs to the process, and the two are set independently. A
delegated fleet without the second one has no worst case it can state — which is
what the outage study makes visible.
