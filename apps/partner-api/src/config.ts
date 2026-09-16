/**
 * Configuration for the one workload every demo runs.
 *
 * The whole point of the suite is that the application code does not change
 * between demos: topology, scope and limits arrive here, are validated once, and
 * are then used by `buildPolicies`. If a demo needs different behaviour, it sets
 * different values - it does not get a different copy of the app.
 */

export type Topology = "local" | "distributed"
export type ScopeKind = "global" | "region" | "tenant"
export type CoordinatorErrorBehaviour = "fail-open" | "fail-closed"

export type AppConfig = {
  demo: string
  runId: string
  replica: string
  port: number
  adminToken: string
  namespace: string
  topology: Topology
  scope: ScopeKind
  onCoordinatorError: CoordinatorErrorBehaviour
  redis: {
    url: string
    commandTimeoutMs: number
    regionUrls: Record<string, string>
  }
  bulkhead: {
    limit: number
    leaseMs: number
    queue: { limit: number; timeoutMs: number } | undefined
  }
  breaker: {
    name: string
    minimumThroughput: number
    failureThreshold: number
    openMs: number
    halfOpenProbes: number
    halfOpenSuccesses: number
    windowSize: number
    probeLeaseTtlMs: number
  }
  timeoutMs: number
  retry: { maxAttempts: number; delayMs: number }
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(
      `${key} must be an integer, got ${JSON.stringify(raw)}`,
    )
  }
  return value
}

function fraction(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new RangeError(
      `${key} must be between 0 and 1, got ${JSON.stringify(raw)}`,
    )
  }
  return value
}

function oneOf<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  values: T[],
  fallback: T,
): T {
  const raw = env[key]
  if (raw === undefined || raw === "") return fallback
  if (!values.includes(raw as T)) {
    throw new RangeError(
      `${key} must be one of ${values.join(" | ")}, got ${JSON.stringify(raw)}`,
    )
  }
  return raw as T
}

/** Region coordinators are declared as `REDIS_URL_REGION_EU=redis://...`. */
function regionUrls(env: NodeJS.ProcessEnv): Record<string, string> {
  const urls: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const match = /^REDIS_URL_REGION_([A-Z0-9_]+)$/.exec(key)
    if (match?.[1] && value)
      urls[match[1].toLowerCase().replace(/_/g, "-")] = value
  }
  return urls
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const queueLimit = int(env, "BULKHEAD_QUEUE_LIMIT", 0)
  const breakerOpenMs = int(env, "BREAKER_OPEN_MS", 5_000)
  return {
    demo: env.DEMO ?? "adhoc",
    runId: env.RUN_ID ?? "unrecorded",
    replica: env.REPLICA ?? "0",
    port: int(env, "PORT", 4101),
    adminToken: env.ADMIN_TOKEN ?? "",
    namespace: env.CARACAL_NAMESPACE ?? `caracal-demo:${env.DEMO ?? "adhoc"}`,
    topology: oneOf<Topology>(
      env,
      "TOPOLOGY",
      ["local", "distributed"],
      "local",
    ),
    scope: oneOf<ScopeKind>(
      env,
      "SCOPE",
      ["global", "region", "tenant"],
      "global",
    ),
    onCoordinatorError: oneOf<CoordinatorErrorBehaviour>(
      env,
      "COORDINATOR_ERROR",
      ["fail-open", "fail-closed"],
      "fail-open",
    ),
    redis: {
      url: env.REDIS_URL ?? "redis://127.0.0.1:6379",
      commandTimeoutMs: int(env, "REDIS_COMMAND_TIMEOUT_MS", 1_000),
      regionUrls: regionUrls(env),
    },
    bulkhead: {
      limit: int(env, "BULKHEAD_LIMIT", 5),
      leaseMs: int(env, "BULKHEAD_LEASE_MS", 5_000),
      queue:
        queueLimit > 0
          ? {
              limit: queueLimit,
              timeoutMs: int(env, "BULKHEAD_QUEUE_TIMEOUT_MS", 250),
            }
          : undefined,
    },
    breaker: {
      name: env.BREAKER_NAME ?? "partner-api",
      minimumThroughput: int(env, "BREAKER_MINIMUM_THROUGHPUT", 20),
      failureThreshold: fraction(env, "BREAKER_FAILURE_THRESHOLD", 0.5),
      openMs: breakerOpenMs,
      halfOpenProbes: int(env, "BREAKER_HALF_OPEN_PROBES", 3),
      halfOpenSuccesses: int(env, "BREAKER_HALF_OPEN_SUCCESSES", 1),
      windowSize: int(env, "BREAKER_WINDOW_SIZE", 100),
      probeLeaseTtlMs: int(env, "BREAKER_PROBE_LEASE_MS", breakerOpenMs * 2),
    },
    timeoutMs: int(env, "POLICY_TIMEOUT_MS", 2_000),
    retry: {
      maxAttempts: int(env, "RETRY_MAX_ATTEMPTS", 2),
      delayMs: int(env, "RETRY_DELAY_MS", 50),
    },
  }
}

/** The configuration as it should appear next to a run's numbers. */
export function describeConfig(
  config: AppConfig,
): Record<string, string | number | boolean> {
  return {
    topology: config.topology,
    scope: config.scope,
    namespace: config.namespace,
    "scope label":
      config.scope === "tenant" ? "off (unbounded cardinality)" : "on",
    onCoordinatorError: config.onCoordinatorError,
    "bulkhead limit": config.bulkhead.limit,
    "bulkhead lease": `${config.bulkhead.leaseMs}ms`,
    queue: config.bulkhead.queue
      ? `${config.bulkhead.queue.limit} waiters, ${config.bulkhead.queue.timeoutMs}ms`
      : "none (immediate reject)",
    "breaker minimum throughput": config.breaker.minimumThroughput,
    "breaker failure threshold": config.breaker.failureThreshold,
    "breaker open": `${config.breaker.openMs}ms`,
    "breaker half-open probes": config.breaker.halfOpenProbes,
    "breaker probe lease": `${config.breaker.probeLeaseTtlMs}ms`,
    timeout: `${config.timeoutMs}ms`,
    "retry attempts": config.retry.maxAttempts,
    "redis command timeout": `${config.redis.commandTimeoutMs}ms`,
  }
}
