# 21 — Outage, with a ceiling that needs no authority

[20-serval-redis-outage](../20-serval-redis-outage/README.md) with a
`bulkhead.local({ limit: 2 })` composed innermost, so the fleet can state a worst
case without asking the authority anything.

```sh
npm run demo 21
npm run compare 20 21
```

## What it changes

| | 20 no ceiling | 21 ceiling 2/process |
|---|---|---|
| witness peak in-flight | 5 | 5 |
| stated worst case | what was granted | **8, decided locally** |
| admitted share | 14.2% | 14.1% |
| coordinator-unavailable refusals | 390 | 387 |
| trips/exec | 0.9 | 0.89 |

In this outage the ceiling changes nothing measurable, and that is the honest
result: the authority's grants already held the fleet at 5, so a bound of 8 never
bound. What it adds is the *statement* — 8 is the worst case whether or not the
authority answers, which is not something the delegated layers can say on their
own.

To make the ceiling the binding constraint, set it at or below the fair share
(5 / 4 ≈ 1.25, so 1 per process) — study
[19](../19-serval-with-local-ceiling/README.md) shows what a binding ceiling costs.
