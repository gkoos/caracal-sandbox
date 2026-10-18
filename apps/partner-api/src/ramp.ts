/**
 * The application-side recovery ramp.
 *
 * Caracal owns the ceiling; this file owns the policy of moving it. On every
 * breaker close the controller writes a low admission limit, steps it up on a
 * timer, and finishes on the constructor baseline. On a re-open it drops back to
 * the floor and waits for the next close.
 *
 * Every replica runs one: a probe can close in any of them, so pinning the
 * controller to replica 0 would miss closes it never sees. The record is the
 * single writer, and compare-and-set makes concurrent ramps converge - a replica
 * that loses the race records a conflict and moves on.
 */
import type { OperationEvent } from "@gkoos/caracal"
import type { ConfigurationManager } from "@gkoos/caracal/redis"

export type RampTarget = "bulkhead" | "rate"

export type RampPhase =
  | "start"
  | "step"
  | "complete"
  | "open"
  | "restore"
  | "conflict"
  | "abort"

/** One line in `ramp-<replica>.ndjson`, and one row in the run summary. */
export type RampLine = {
  at: number
  phase: RampPhase
  target: RampTarget
  /** The applied limit, or the applied rate. */
  value: number
  revision: number
  triggerAt?: number
  operation?: string
  scope?: string
}

export type RampOptions = {
  readonly breakerName: string
  readonly target: RampTarget
  readonly policyName: string
  readonly baseline: number
  readonly floor: number
  readonly stepMs: number
  /** Held constant while a rate target is ramped. */
  readonly burst: number
  readonly managerFor: (scope: string) => ConfigurationManager
  readonly write: (line: RampLine) => void
}

export type RampSnapshot = {
  target: RampTarget
  baseline: number
  floor: number
  active: string[]
  applied: number
  conflicts: number
  lastValue: number | undefined
}

export type RampController = {
  /** An event sink for the operation pipeline. */
  readonly sink: { emit(event: OperationEvent): void }
  /** Cancels timers and writes the baseline back for every active identity. */
  stop(): Promise<void>
  snapshot(): RampSnapshot
}

type BreakerEvent = Extract<OperationEvent, { type: "breaker.state-changed" }>

/** `1, 2, 4, 8` for baseline 8 and floor 1, always ending on the baseline. */
function ladder(baseline: number, floor: number): number[] {
  if (floor >= baseline) return [baseline]
  const values = [floor]
  let next = floor
  while (next * 2 < baseline) {
    next *= 2
    values.push(next)
  }
  values.push(baseline)
  return values
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createRampController(options: RampOptions): RampController {
  const { breakerName, target, policyName, baseline, floor, stepMs, burst } =
    options
  const identities = new Map<string, BreakerEvent>()
  const epochs = new Map<string, number>()
  let stopped = false
  let applied = 0
  let conflicts = 0
  let lastValue: number | undefined

  const keyOf = (event: BreakerEvent): string =>
    `${event.context.operationName}|${event.scope}`

  /** Invalidates the running ramp for a key, so its timer stops at the next check. */
  function cancel(key: string): void {
    epochs.set(key, (epochs.get(key) ?? 0) + 1)
    identities.delete(key)
  }

  async function write(
    event: BreakerEvent,
    phase: RampPhase,
    value: number,
    triggerAt?: number,
  ): Promise<boolean> {
    const identity = {
      policy:
        target === "bulkhead" ? ("bulkhead" as const) : ("rateLimit" as const),
      name: policyName,
      operation: event.context.operationName,
      scope: event.scope,
    }
    const manager = options.managerFor(event.scope)
    try {
      const current = await manager.read(identity)
      const expected = current?.revision ?? 0
      const settings =
        target === "bulkhead"
          ? ({ policy: "bulkhead", limit: value } as const)
          : ({ policy: "rateLimit", rate: value, burst } as const)
      const result = await manager.update(identity, expected, settings)
      if (result.status === "conflict") {
        conflicts += 1
        options.write({
          at: Date.now(),
          phase: "conflict",
          target,
          value,
          revision: expected,
          triggerAt,
          operation: identity.operation,
          scope: identity.scope,
        })
        return false
      }
      applied += 1
      lastValue = value
      options.write({
        at: Date.now(),
        phase,
        target,
        value,
        revision: result.snapshot.revision,
        triggerAt,
        operation: identity.operation,
        scope: identity.scope,
      })
      return true
    } catch {
      options.write({
        at: Date.now(),
        phase: "abort",
        target,
        value,
        revision: 0,
        triggerAt,
        operation: identity.operation,
        scope: identity.scope,
      })
      return false
    }
  }

  async function runRamp(key: string, event: BreakerEvent): Promise<void> {
    const epoch = epochs.get(key) ?? 0
    identities.set(key, event)
    const values = ladder(baseline, floor)
    for (const [index, value] of values.entries()) {
      if (stopped || (epochs.get(key) ?? 0) !== epoch) return
      const phase =
        index === 0
          ? ("start" as const)
          : index === values.length - 1
            ? ("complete" as const)
            : ("step" as const)
      await write(event, phase, value, event.at)
      if (index < values.length - 1) await sleep(stepMs)
    }
    identities.delete(key)
  }

  const sink = {
    emit(event: OperationEvent): void {
      if (event.type !== "breaker.state-changed") return
      if (event.policyName !== breakerName) return
      const key = keyOf(event)
      if (event.state === "open") {
        // A recovery window should admit probes under the floor, not the old ceiling.
        cancel(key)
        void write(event, "open", floor)
        return
      }
      if (event.state === "closed" && event.previousState === "half-open") {
        cancel(key)
        void runRamp(key, event)
      }
    },
  }

  async function stop(): Promise<void> {
    stopped = true
    for (const [key, event] of [...identities.entries()]) {
      cancel(key)
      await write(event, "restore", baseline)
    }
  }

  function snapshot(): RampSnapshot {
    return {
      target,
      baseline,
      floor,
      active: [...identities.keys()],
      applied,
      conflicts,
      lastValue,
    }
  }

  return { sink, stop, snapshot }
}
