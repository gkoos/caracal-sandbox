# 24 — Strict coordinators, dependency failing

The control for [23](../23-serval-dependency-fault/README.md): the same four
replicas, the same budget and the same 3s–9s dependency failure, with strict
coordinators.

```sh
npm run demo 24
npm run compare 23 24
```

## What it shows

```
breaker.state-changed: open 1, half-open 1, closed 1
breaker.probe-started: 3            (BREAKER_HALF_OPEN_PROBES is 3)
peak probes in flight: 2
successful requests/s: 47/s  (10.9% admitted)
witness peak in-flight: 5 / 5
```

Every call consults the coordinator, so the fleet learns it opened on the next
call, probes exactly as many times as it is configured to, and closes when a probe
succeeds. That is the behaviour 23's delegated path does not reproduce, and the
reason this study exists as a control rather than as a claim of its own.

Its cost is the coordination: 2.33 Redis commands per execution against 0.29 — the
same trade study [18](../18-serval-delegated/README.md) measures in the healthy
case, and one that is not worth paying while the breaker cannot close.
