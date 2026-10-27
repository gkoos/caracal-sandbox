# 22 — Strict coordinators, same outage

The control for the delegated pair: the same four replicas, the same budget and the
same 4s–12s coordinator cut, with the strict coordinators that have no local
authority to fall back on.

```sh
npm run demo 22
npm run compare 22 20
```

## What happened

```
witness peak in-flight: 5
client: 766/5654 ok, refused {bulkhead:capacity: 2278, coordinator-unavailable: 2610}
coordination: 3.2 trips/exec (18080 commands)
```

Two things are worth reading carefully.

**`onCoordinatorError: fail-open` did not admit everything.** It governs the
breaker, and the breaker does admit — but the distributed bulkhead fails closed on
coordinator loss whatever that setting says, and it sits innermost, so it decides.
The 2610 `coordinator-unavailable` refusals are that. The documented behaviour of
the strict path under an outage is refusal, not a stampede.

**The cost is what differs.** 13.5% admitted at 3.2 Redis commands per execution,
against the delegated path's 14.2% at 0.9 — the same decision, three and a half
times the traffic, because every attempt has to reach a coordinator that is not
answering.

This study asserts the documented behaviour rather than a good outcome: it is the
witness peak next to [20](../20-serval-redis-outage/README.md)'s that carries the
claim.
