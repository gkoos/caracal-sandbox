# 23 — Delegated, with the dependency failing

This study was built to put a number on the cached verdict's deviation — how much
traffic reaches a failing dependency before a replica learns the fleet opened. It
found something worse instead.

```sh
npm run demo 23
npm run compare 23 24
```

## The blocker

**The delegated breaker never closes.** It opens, goes half-open, and stops there,
so the fleet stays degraded after the dependency has recovered.

| | 23 delegated | 24 strict |
|---|---|---|
| state changes | `open 1, half-open 1` | `open 1, half-open 1, closed 1` |
| `breaker.probe-started` events | **512** | **3** |
| peak probes believed in flight | **346** | 2 |
| successful requests/s | 21/s | 47/s |
| admitted share | 5.0% | 10.9% |
| witness peak in-flight | 5 / 5 | 5 / 5 |
| coordinator trips/exec | 0.29 | 2.33 |

`BREAKER_HALF_OPEN_PROBES` is 3. The strict path starts exactly 3 probes and closes.
The delegated path starts 512 and believes up to 346 are in flight — so its local
probe budget is permanently exhausted and nothing is left to close the breaker.
Half of the strict path's throughput is the price of that, for the rest of the run.

The study pins it: `eventCountAtLeast: breaker.state-changed >= 3` fails here with
2, and passes in the control.

## What it is not

The budget holds throughout (peak 5 of 5), no lease is lost, and there are no
coordinator errors — this is specifically the probe and recovery path, not the
admission accounting. The deviation I expected to measure (extra traffic during the
failure) does not appear at the witness: both topologies hold the dependency at 5.

## Where the window does show

`SERVAL_FRESHNESS_MS` is 5s here rather than the 1s default, so the half-open verdict
a replica caches stays usable across the whole failure. That is the knob the
deviation scales with, and a sweep over it is the follow-up this study sets up.
