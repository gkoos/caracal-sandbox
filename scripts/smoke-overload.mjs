#!/usr/bin/env node
/**
 * The overload variant of the smoke: the bulkhead limit sits *below* the offered
 * concurrency, so the surplus is shed at the client.
 *
 *   npm run smoke:overload
 *
 * This is the run that produced finding 3. Against caracal `0.4.0` the shedding
 * opened the breaker, which then shed the rest of the run under `breaker-open`
 * and reported a failure rate the dependency never produced. `0.5.0` stopped
 * recording a refusal the adapter never ran for, so the checks here are the
 * witness pair - refusals happened, and the breaker never opened - and the
 * regression cannot come back unnoticed.
 *
 * `npm run` consumes `--flags` for its own configuration, so the variant is a
 * script with the environment set rather than a flag (see finding 5).
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "scripts/smoke.mjs"],
  {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      CONCURRENCY: process.env.CONCURRENCY ?? "16",
      BULKHEAD_LIMIT: process.env.BULKHEAD_LIMIT ?? "8",
    },
  },
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
