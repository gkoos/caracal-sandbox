#!/usr/bin/env node
/**
 * Docker stack control for the demo infrastructure.
 *
 *   node scripts/stack.mjs up                    # core: valkey, valkey-eu, postgres, otel, jaeger, prometheus, grafana
 *   node scripts/stack.mjs up --profile chaos    # + toxiproxy
 *   node scripts/stack.mjs up --profile cluster  # + three-master Valkey cluster
 *   node scripts/stack.mjs down | reset | ps | logs | config
 *
 * Workloads are not part of this stack: partner-api replicas, the load generator
 * and downstream-mock run on the host by default (see README.md).
 */
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const COMPOSE = fileURLToPath(new URL("../stack/compose.yaml", import.meta.url))
const ROOT = fileURLToPath(new URL("..", import.meta.url))

const URLS = [
  ["Grafana", "http://localhost:3000/d/caracal-overview"],
  ["Prometheus", "http://localhost:9090"],
  ["Jaeger", "http://localhost:16686"],
]

const [, , command = "help", ...rest] = process.argv

const profiles = []
const flags = []
for (let index = 0; index < rest.length; index += 1) {
  const arg = rest[index]
  if (arg === "--profile" || arg === "-p") {
    profiles.push("--profile", rest[index + 1] ?? "")
    index += 1
  } else {
    flags.push(arg)
  }
}

const commands = {
  up: ["up", "-d", "--wait"],
  down: ["down", ...(flags.includes("--volumes") ? ["--volumes"] : [])],
  reset: ["down", "--volumes", "--remove-orphans"],
  ps: ["ps"],
  logs: ["logs", "-f", "--tail", "50"],
  config: ["config"],
  pull: ["pull"],
}

if (!commands[command]) {
  console.error(
    "usage: node scripts/stack.mjs <up|down|reset|ps|logs|config|pull> [--profile chaos|cluster]",
  )
  process.exit(2)
}

function compose(args) {
  const result = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE, ...profiles, ...args],
    { stdio: "inherit", cwd: ROOT },
  )
  if (result.error) {
    console.error(`failed to run docker compose: ${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

let status = compose(commands[command])
if (status === 0 && command === "reset") status = compose(commands.up)

if (status === 0 && command === "up") {
  console.log("\nstack up:")
  for (const [name, url] of URLS) console.log(`  ${name.padEnd(11)} ${url}`)
  const extra = profiles.includes("chaos")
    ? "  Toxiproxy   control http://localhost:8474, proxy redis://127.0.0.1:6380\n"
    : ""
  if (extra) process.stdout.write(extra)
}

process.exit(status)
