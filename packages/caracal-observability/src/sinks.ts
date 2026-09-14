import { appendFileSync } from "node:fs"
import type { EventSink, OperationEvent } from "@gkoos/caracal"

export type NdjsonSink = EventSink & {
  /** Flushes what is buffered and stops the timer. */
  close(): Promise<void>
  /** Lines dropped because the buffer was full and the sink was not flushed. */
  dropped(): number
  /** Lines written so far. */
  written(): number
}

export type NdjsonSinkOptions = {
  path: string
  /** How often the buffer is appended to disk. */
  flushIntervalMs?: number
  /** Lines kept in memory before the oldest are dropped. */
  maxBuffer?: number
}

/**
 * Appends events to a file as NDJSON, buffered in memory.
 *
 * The buffer is the point, not an optimisation: caracal calls `emit` in the
 * caller's path, so writing to disk per event would put file I/O inside the
 * latency the demo is measuring. Here `emit` only pushes onto an array, and a
 * timer appends batches. A full buffer drops the oldest lines and counts them,
 * because the alternative - growing without bound - would turn a run into an
 * out-of-memory kill.
 */
export function ndjsonSink(options: NdjsonSinkOptions): NdjsonSink {
  const buffer: string[] = []
  let dropped = 0
  let written = 0
  let closed = false
  const maxBuffer = options.maxBuffer ?? 50_000
  const timer = setInterval(flush, options.flushIntervalMs ?? 500)
  timer.unref?.()

  function flush(): void {
    if (buffer.length === 0) return
    const batch = buffer.splice(0, buffer.length)
    written += batch.length
    try {
      // Synchronous, on purpose: this runs on a timer, where blocking costs a
      // timer callback rather than a caller's request.
      appendFileSync(options.path, `${batch.join("\n")}\n`)
    } catch (error) {
      dropped += batch.length
      console.error(`ndjson sink failed to append: ${(error as Error).message}`)
    }
  }

  return {
    emit(event: OperationEvent) {
      if (closed) return
      if (buffer.length >= maxBuffer) {
        buffer.shift()
        dropped += 1
      }
      buffer.push(JSON.stringify(event))
    },
    async close() {
      closed = true
      clearInterval(timer)
      flush()
      await Promise.resolve()
    },
    dropped: () => dropped,
    written: () => written,
  }
}

/** Counts events by type without touching the disk. */
export function countingSink(): EventSink & {
  counts: Map<string, number>
  total(): number
  reset(): void
} {
  const counts = new Map<string, number>()
  return {
    counts,
    emit(event: OperationEvent) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
    },
    total: () => [...counts.values()].reduce((sum, value) => sum + value, 0),
    reset: () => counts.clear(),
  }
}

/**
 * Throws on every event.
 *
 * Caracal's sink contract says a throwing sink is dropped, so this exists to
 * demonstrate that a broken observability path cannot break the workload.
 */
export function failingSink(): EventSink & { attempts(): number } {
  let attempts = 0
  return {
    attempts: () => attempts,
    emit() {
      attempts += 1
      throw new Error("failing sink: this throw must not reach the caller")
    },
  }
}

/**
 * Blocks the event loop for `ms` on every event - the worst possible sink. A
 * synchronous sink is the only kind that can slow the workload down, and the
 * demo that uses this measures exactly how much.
 */
export function blockingSink(ms: number): EventSink {
  return {
    emit() {
      const until = Date.now() + ms
      while (Date.now() < until) {
        /* spin */
      }
    },
  }
}

/**
 * Returns a promise that settles long after nobody is waiting. Caracal never
 * awaits a sink, so this must have no effect on execution time.
 */
export function asyncSlowSink(ms: number): EventSink & { settled(): number } {
  let settled = 0
  return {
    settled: () => settled,
    emit() {
      void new Promise<void>((resolve) => setTimeout(resolve, ms)).then(() => {
        settled += 1
      })
    },
  }
}
