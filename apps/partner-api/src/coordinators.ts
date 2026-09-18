import type {
  AdmitProbeResult,
  BreakerCoordinator,
  BreakerIdentity,
  BulkheadCoordinator,
  ObserveResult,
  RateLimitCoordinator,
  SettleProbeResult,
} from "@gkoos/caracal"
import {
  createCoordinationClient,
  redisCircuitBreakerCoordinator,
  redisCoordinator,
  redisRateLimitCoordinator,
} from "@gkoos/caracal/redis"
import type { Redis } from "ioredis"
import type { AppConfig } from "./config.js"

/** What the fleet spent talking to the coordinator, for the cost panel. */
export type CoordinationStats = {
  eval: number
  evalsha: number
  commands: number
  errors: number
}

/** Hook for recording coordination activity as metrics, for the cost panels. */
export type CoordinationObserver = {
  command(kind: "eval" | "evalsha" | "hmget"): void
  error(): void
}

/** The script surface the two coordinator factories need, and nothing else. */
type ScriptClient = {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>
  evalsha(
    sha: string,
    numberOfKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>
}

export type CoordinatorSet = {
  namespace: string
  stats: CoordinationStats
  bulkhead: BulkheadCoordinator
  breaker: BreakerCoordinator
  rateLimit: RateLimitCoordinator
  /** Regions that have their own coordinator, from `REDIS_URL_REGION_*`. */
  regionCoordinators: string[]
  connect(): Promise<void>
  disconnect(): void
}

const DEFAULT_REGION = "default"

/** `region:eu-west-1` -> `eu-west-1`; anything else belongs to the default coordinator. */
function regionOfScope(scope: string): string {
  const prefix = "region:"
  return scope.startsWith(prefix) ? scope.slice(prefix.length) : DEFAULT_REGION
}

function recording(
  target: Redis,
  stats: CoordinationStats,
  observe?: CoordinationObserver,
): ScriptClient {
  return {
    async eval(script, numberOfKeys, ...args) {
      stats.commands += 1
      stats.eval += 1
      observe?.command("eval")
      try {
        return await target.eval(script, numberOfKeys, ...args)
      } catch (error) {
        stats.errors += 1
        observe?.error()
        throw error
      }
    },
    async evalsha(sha, numberOfKeys, ...args) {
      stats.commands += 1
      stats.evalsha += 1
      observe?.command("evalsha")
      try {
        return await target.evalsha(sha, numberOfKeys, ...args)
      } catch (error) {
        stats.errors += 1
        observe?.error()
        throw error
      }
    },
    async hmget(key, ...fields) {
      stats.commands += 1
      observe?.command("hmget")
      try {
        return await target.hmget(key, ...fields)
      } catch (error) {
        stats.errors += 1
        observe?.error()
        throw error
      }
    },
  }
}

/**
 * Builds the coordinator for a configured topology.
 *
 * One client is created per *declared* coordinator: the default one from
 * `REDIS_URL`, plus one per `REDIS_URL_REGION_<NAME>` entry. A policy's scope
 * decides which of them a call goes to, because both coordinator interfaces
 * receive the identity - including `scope` - with every call. That is the seam
 * that makes "an in-region coordinator going away is a regional failure" a
 * configuration, not a code change: without a region URL, every region shares the
 * default coordinator and is separated only by key.
 *
 * Every script call is counted, because "what does coordination cost" is one of
 * the questions the demos answer with a number rather than an adjective.
 */
export function createCoordinators(
  config: AppConfig,
  namespace: string,
  observe?: CoordinationObserver,
): CoordinatorSet {
  const stats: CoordinationStats = {
    eval: 0,
    evalsha: 0,
    commands: 0,
    errors: 0,
  }
  const regionNames = [...Object.keys(config.redis.regionUrls), DEFAULT_REGION]
  const regions = new Map<
    string,
    {
      client: Redis
      bulkhead: BulkheadCoordinator
      breaker: BreakerCoordinator
      rateLimit: RateLimitCoordinator
    }
  >()

  for (const region of regionNames) {
    const url = config.redis.regionUrls[region] ?? config.redis.url
    const client = createCoordinationClient(url, config.redis.commandTimeoutMs)
    const scripted = recording(client, stats, observe)
    regions.set(region, {
      client,
      bulkhead: redisCoordinator(scripted, { namespace }),
      breaker: redisCircuitBreakerCoordinator(scripted, { namespace }),
      rateLimit: redisRateLimitCoordinator(scripted, { namespace }),
    })
  }

  const regionFor = (scope: string) => {
    const region = regionOfScope(scope)
    const match = regions.get(region)
    if (match) return match
    const fallback = regions.get(DEFAULT_REGION)
    if (!fallback) throw new Error("no default coordinator registered")
    return fallback
  }

  return {
    namespace,
    stats,
    regionCoordinators: [...Object.keys(config.redis.regionUrls)],
    bulkhead: {
      command(identity, action, token, leaseMs, limit) {
        return regionFor(identity.scope).bulkhead.command(
          identity,
          action,
          token,
          leaseMs,
          limit,
        )
      },
    },
    breaker: {
      readState(identity: BreakerIdentity) {
        return regionFor(identity.scope).breaker.readState(identity)
      },
      observe(
        identity: BreakerIdentity,
        params: Parameters<BreakerCoordinator["observe"]>[1],
      ) {
        return regionFor(identity.scope).breaker.observe(
          identity,
          params,
        ) as Promise<ObserveResult>
      },
      admitProbe(
        identity: BreakerIdentity,
        params: Parameters<BreakerCoordinator["admitProbe"]>[1],
      ) {
        return regionFor(identity.scope).breaker.admitProbe(
          identity,
          params,
        ) as Promise<AdmitProbeResult>
      },
      settleProbe(
        identity: BreakerIdentity,
        params: Parameters<BreakerCoordinator["settleProbe"]>[1],
      ) {
        return regionFor(identity.scope).breaker.settleProbe(
          identity,
          params,
        ) as Promise<SettleProbeResult>
      },
    },
    rateLimit: {
      command(
        identity: { name: string; operation: string; scope: string },
        params: Parameters<RateLimitCoordinator["command"]>[1],
      ) {
        return regionFor(identity.scope).rateLimit.command(identity, params)
      },
    },
    async connect() {
      // Connect every declared coordinator up front. A lazily connected client
      // with `enableOfflineQueue: false` rejects the first command instead of
      // connecting, which would look like a coordinator outage.
      await Promise.all(
        [...regions.values()].map((region) => region.client.connect()),
      )
    },
    disconnect() {
      for (const region of regions.values()) region.client.disconnect()
    },
  }
}
