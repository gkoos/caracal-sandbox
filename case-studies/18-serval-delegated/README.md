# 18 — Same budget, held locally

The same workload, the same four replicas and the same shared budget as
[02-distributed-basic](../02-distributed-basic/README.md), with the coordination
boundary moved once more: each replica holds a bounded piece of the fleet's
authority and enforces it locally, so most admissions never reach Redis.

```sh
npm run demo 18
npm run compare 02 18
```

## What the comparison shows

| KPI | 02 strict | 18 delegated |
|---|---|---|
| witness peak in-flight | 5 | 5 |
| witness peak / bulkhead limit | 5 / 5 | 5 / 5 |
| coordinator trips per execution | 2.5 | **0.35** |
| successful requests/s | 105 | 107 |
| p99 latency | 59ms | 52ms |
| breaker opens | 0 | 0 |
| lease lost | 0 | 0 |

The safety claim is unchanged: the dependency never saw more than the shared
budget, no breaker opened and no lease was lost. What moved is the price of
coordination — **2.5 Redis commands per execution became 0.35**, a factor of seven.

Both numbers come from the same instrument: every authority read, grant and
allocation the delegated path makes goes through the demo's `recording()` client,
so the row is not flattered by counting only the strict commands.

## What this study does not show

Three things decide whether the delegation is safe to rely on, and none of them
are exercised here: what a replica admits while its authority is stale (the
freshness window), what the fleet does when the coordinator stops answering, and
what the dependency sees when a verdict the fleet has already opened on is still
cached locally. Those are the studies where this topology can lose, and they are
the reason the number above is not the whole story.
