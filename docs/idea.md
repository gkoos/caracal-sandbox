# The idea: where does the constraint live?

Caracal's claim is narrow and testable:

> A resilience limit only means something where the constrained resource is. Caracal's `scope` is how you say where that is.

Every demo in this repository runs **the same workload against the same dependency** and moves exactly one thing: the coordination boundary.

```text
01 local-only        boundary = the process
02 distributed-basic boundary = the whole fleet            (scope: global)
03 multi-region      boundary = the region                 (scope: region:${region})
04 tenant-isolation  boundary = the tenant                 (scope: tenant:${tenantId})
05 postgres-permit-hold  boundary = the query              (abort: "unsupported")
06 observability     what every decision looks like once you can see it
07 chaos             does the boundary survive things dying?
```

## The comparison rule: the downstream is the witness

Caracal reports its own decisions through events. Those reports are useful, but they are not evidence: a library that under-counts admissions would happily report success.

So every demo measures each claim **twice**:

1. **From the client** - caracal events, mapped to metrics by `caracal-observability`.
2. **From the dependency** - `downstream-mock` counts its own in-flight requests, failures and per-scope concurrency, and exposes them as Prometheus metrics.

The **witness** number is the one that decides whether a demo passed. This is the same shape as the soak suite in the library itself ("two independent witnesses"), and it is what makes the headline comparison honest:

```text
4 replicas x bulkhead.local({ limit: 5 })   -> downstream sees 20 concurrent
4 replicas x bulkhead.distributed({ limit: 5, scope: "global" }) -> downstream sees 5
```

## One schema, one dashboard set, one comparator

A demo is not a folder of prose. Each one declares its topology, workload and expected outcome in `study.yaml`, and a run produces `runs/<id>/summary.json` in a single shared schema. From that:

- **Grafana** renders every demo with the same dashboards, so `01` and `02` can be overlaid on one panel instead of compared by memory.
- **`npm run compare 01 02`** prints the KPI table that is the actual point of the demo.
- **invariant checks** decide pass/fail, so a demo that cannot fail is impossible: the checks are named, registered and tested, exactly like the library's own claims.

## Caracal/sandbox limitations

- Caracal exposes **events**, not metrics or OpenTelemetry. The bridge in `packages/caracal-observability` is demo glue, written the way a consumer would write it.
- A distributed bulkhead **sheds, it does not queue**. That is the design, and demos show it.
- The PostgreSQL adapter declares `abort: "unsupported"`, so a timed-out query keeps its distributed permit until it settles. Study `05` explains that instead of working around it.
- Leases are not fencing tokens and this is not exactly-once execution. Study `07` shows where that boundary actually is.
