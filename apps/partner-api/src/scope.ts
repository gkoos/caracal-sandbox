import type { ExecutionContext } from "@gkoos/caracal"
import type { ScopeKind } from "./config.js"

export type ScopeFunction = (context: ExecutionContext) => string

/**
 * Reads a metadata value that is about to become a coordination key.
 *
 * A scope key goes into a Redis key and into a metric label, so an unusable one
 * has to fail here rather than become a key like `tenant:undefined` that silently
 * pools unrelated traffic. Caracal rejects empty and oversized identities; this
 * rejects the shapes that would produce them.
 */
function required(
  context: ExecutionContext,
  key: string,
  scope: ScopeKind,
): string {
  const value = context.metadata[key]
  if (typeof value === "string" && value.trim().length > 0) return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  throw new TypeError(
    `scope "${scope}" needs metadata.${key} on every execution; got ${JSON.stringify(value)}`,
  )
}

/**
 * The scope function for a demo's topology.
 *
 * This is the whole lever the suite pulls: `global` says the constraint belongs
 * to the fleet, `region` says it belongs to a region, `tenant` says it belongs to
 * a tenant. Nothing else about the workload changes.
 */
export function scopeFunction(kind: ScopeKind): ScopeFunction {
  if (kind === "region") {
    return (context) => `region:${required(context, "region", kind)}`
  }
  if (kind === "tenant") {
    return (context) => `tenant:${required(context, "tenantId", kind)}`
  }
  return () => "global"
}

/** The scope keys a run is expected to produce, for checks and dashboards. */
export function expectedScopeKeys(
  kind: ScopeKind,
  values: readonly string[],
): string[] {
  if (kind === "global") return ["global"]
  return values.map((value) => `${kind}:${value}`)
}
