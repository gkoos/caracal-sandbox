# 20 — Delegated, with the coordinator gone

[18-serval-delegated](../18-serval-delegated/README.md) with the coordinator taken
away: at 4s every replica's client is disconnected, and at 12s it comes back. The
client has no offline queue, so every coordinator call fails while it is down.
Redis keeps its state — this is the outage, not the data-loss case.

```sh
npm run demo 20
npm run compare 20 22
```

## What happened

```
witness peak in-flight: 5
client: 889/6257 ok, refused {bulkhead:capacity: 4978, coordinator-unavailable: 390}
coordination: 0.9 trips/exec (5605 commands)
```

The safety claim survived: the dependency still never saw more than 5 concurrent
calls. A replica can only admit against authority it already holds, so the fleet
is bounded by what was granted before the cut — and the 390
`coordinator-unavailable` refusals are the delegated bulkhead refusing once its
allocation lapsed, because it can no longer verify authority it cannot read.

The admitted share fell from 25.6% to 14.2%: that is the cost of an outage, not a
failure of the bound.

## The control

[22-strict-redis-outage](../22-strict-redis-outage/README.md) runs the same outage
against the strict coordinators. It admitted 13.5% — essentially the same — at
**3.2 Redis commands per execution against 0.9**. Both stayed under the budget,
because the distributed bulkhead fails closed on coordinator loss whatever
`onCoordinatorError` says.

So the delegated path's advantage during an outage is not a different admission
decision. It is that it makes the same decision for a third of the traffic.
