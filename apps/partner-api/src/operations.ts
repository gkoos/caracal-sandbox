import {
  type EventSinks,
  type Operation,
  BulkheadRejectedError,
  operation,
} from "@gkoos/caracal"
import { fetchAdapter } from "@gkoos/caracal/fetch"
import { postgresAdapter } from "@gkoos/caracal/postgres"
import type { QueryResult } from "pg"
import type { PolicySet } from "./policies.js"

/**
 * The operations the workload calls.
 *
 * The fetch-backed ones (`orders.get`, `orders.create`, `partner.call`) share one
 * `fetchAdapter()`; `report.run` is PostgreSQL-backed and exists to demonstrate
 * `abort: "unsupported"` - a timed-out query keeps its distributed permit until it
 * actually settles, unlike fetch, which aborts.
 *
 * Each operation differs only in its name, which is the piece caracal's
 * coordination identity includes, so they get separate breaker windows and
 * bulkhead budgets.
 */
export type DownstreamCall = { url: string; options?: RequestInit }

export type PostgresCall = {
  sql: string
  values?: readonly unknown[]
  replay?: "safe" | "unsafe" | "unknown"
}

export type PartnerOperations = {
  ordersGet: Operation<DownstreamCall, Response>
  ordersCreate: Operation<DownstreamCall, Response>
  partnerCall: Operation<DownstreamCall, Response>
  /** Present only when a PostgreSQL pool was configured. */
  reportRun: Operation<PostgresCall, QueryResult> | undefined
  /** Maps a request line to the operation that should serve it. */
  forPath(
    method: string,
    path: string,
  ): Operation<DownstreamCall, Response> | undefined
}

/** The bare query contract the postgres adapter needs; a `pg.Pool` satisfies it. */
export type PostgresQueryable = {
  query(query: {
    text: string
    values?: readonly unknown[]
  }): Promise<QueryResult>
}

export function buildOperations(
  policies: PolicySet,
  events?: EventSinks,
  pool?: PostgresQueryable,
): PartnerOperations {
  const adapter = fetchAdapter({
    // A bulkhead rejection is the policy shedding, not the dependency failing.
    // The fetch adapter's default `classifyError` returns "retryable" for *any*
    // thrown error, so without this a shed call is retried and - worse - the
    // outer breaker counts the shedding against the dependency's health and opens
    // under overload (docs/findings.md, finding 3). "ignored" means neither.
    classifyError: (error) =>
      error instanceof BulkheadRejectedError ? "ignored" : "retryable",
  })
  const ordersGet = operation({
    name: "orders.get",
    adapter,
    policies: policies.policies,
    events,
  })
  const ordersCreate = operation({
    name: "orders.create",
    adapter,
    policies: policies.policies,
    events,
  })
  const partnerCall = operation({
    name: "partner.call",
    adapter,
    policies: policies.policies,
    events,
  })

  const reportRun = pool
    ? operation<PostgresCall, QueryResult>({
        name: "report.run",
        adapter: postgresAdapter(pool, {
          // Same finding-3 fix as fetch: the postgres adapter's default classifies
          // a thrown error as "failure", which would count a bulkhead rejection
          // against the breaker. "ignored" for shedding, "failure" for the rest.
          classifyError: (error) =>
            error instanceof BulkheadRejectedError ? "ignored" : "failure",
        }),
        policies: policies.policies,
        events,
      })
    : undefined

  return {
    ordersGet,
    ordersCreate,
    partnerCall,
    reportRun,
    forPath(method, path) {
      if (method === "POST" && path === "/orders") return ordersCreate
      if (path.startsWith("/orders/")) return ordersGet
      if (path.startsWith("/partner/")) return partnerCall
      return undefined
    },
  }
}
