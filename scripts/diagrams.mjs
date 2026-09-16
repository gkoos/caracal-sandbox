#!/usr/bin/env node
/**
 * Generates one SVG topology diagram per demo, from a single visual language.
 *
 * The style is defined once here - palette, node anatomy, arrow and scope
 * conventions - so every demo's diagram is consistent by construction rather
 * than by agreement. Each demo adds a `scene` that only *places* the primitives.
 *
 *   npm run diagrams
 *
 * Palette anchors on caracal's brand (terracotta #c77748 on near-black #171d26):
 * the partner-api replica is the hero in brand terracotta; everything else is a
 * muted supporting role.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))

const P = {
  ink: "#171d26",
  muted: "#5a5d61",
  paper: "#fcfcfc",
  faint: "#9fa0a1",
  brand: "#c77748",
  brandLight: "#fbe8d7",
  loadgen: "#5a5d61",
  downstream: "#3e6f8e",
  postgres: "#33546b",
  redis: "#a03d3d",
  witness: "#2f7d5d",
  witnessLight: "#d9ece5",
  chaos: "#c0392b",
  arrow: "#5a5d61",
}

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** A rounded node: solid accent fill, white title, dimmed white subtitle. */
function node({ x, y, w = 150, h = 52, fill, title, sub }) {
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${fill}"/>`,
    `<text x="${x + w / 2}" y="${y + h / 2 - 3}" text-anchor="middle" fill="#fff" font-size="13" font-weight="600" font-family="${FONT}">${esc(title)}</text>`,
    sub
      ? `<text x="${x + w / 2}" y="${y + h / 2 + 13}" text-anchor="middle" fill="#fff" font-size="11" opacity="0.85" font-family="${FONT}">${esc(sub)}</text>`
      : "",
  ].join("")
}

/** A small ink-on-tint badge, used to annotate a policy inside a node. */
function badge({ x, y, text, fill = P.brandLight }) {
  const w = text.length * 6.4 + 16
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="18" rx="9" fill="${fill}"/>`,
    `<text x="${x + w / 2}" y="${y + 13}" text-anchor="middle" fill="${P.ink}" font-size="10.5" font-family="${FONT}">${esc(text)}</text>`,
  ].join("")
}

function arrow(
  x1,
  y1,
  x2,
  y2,
  { label, labelBelow = false, dashed = false, color = P.arrow } = {},
) {
  const dash = dashed ? ` stroke-dasharray="5 4"` : ""
  const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
  const ly = labelBelow ? mid.y + 12 : mid.y - 6
  return [
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.6"${dash} marker-end="url(#arrowhead)"/>`,
    label
      ? `<text x="${mid.x}" y="${ly}" text-anchor="middle" fill="${P.muted}" font-size="10.5" font-family="${FONT}">${esc(label)}</text>`
      : "",
  ].join("")
}

/** The witness: a dashed emerald line to a measure, labelled below the line. */
function witness(x1, y1, x2, y2, label) {
  return [
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${P.witness}" stroke-width="1.6" stroke-dasharray="5 4"/>`,
    `<text x="${(x1 + x2) / 2}" y="${y2 + 14}" text-anchor="middle" fill="${P.witness}" font-size="10.5" font-family="${FONT}">${esc(label)}</text>`,
  ].join("")
}

/** A red lightning bolt with the label to its right, for a chaos legend line. */
function bolt(x, y, label) {
  return [
    `<path d="M ${x} ${y - 10} L ${x - 6} ${y + 2} L ${x} ${y + 2} L ${x - 2} ${y + 12} L ${x + 6} ${y - 1} L ${x} ${y - 1} Z" fill="${P.chaos}"/>`,
    `<text x="${x + 12}" y="${y + 4}" fill="${P.chaos}" font-size="10.5" font-family="${FONT}">${esc(label)}</text>`,
  ].join("")
}

function caption(x, y, text) {
  return `<text x="${x}" y="${y}" text-anchor="middle" fill="${P.muted}" font-size="10.5" font-style="italic" font-family="${FONT}">${esc(text)}</text>`
}

function svg(w, h, body) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="${FONT}" role="img">`,
    `<title>caracal demo — topology</title>`,
    `<rect width="${w}" height="${h}" fill="${P.paper}"/>`,
    `<defs><marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${P.arrow}"/></marker></defs>`,
    body,
    `</svg>`,
  ].join("\n")
}

function replicaStack(
  parts,
  { n, x = 180, w = 165, sub = (i) => `replica ${i}` },
) {
  for (let i = 0; i < n; i += 1) {
    const y = 20 + i * 58
    parts.push(
      node({
        x,
        y,
        w,
        h: 44,
        fill: P.brand,
        title: "partner-api",
        sub: sub(i),
      }),
    )
  }
  return 18 + (n - 1) * 58
}

// Shared scaffold for the request-flow diagrams: replicas, loadgen, downstream.
function scaffold(parts, { replicasSub, loadgenSub, replicas = 4 }) {
  replicaStack(parts, { n: replicas, sub: replicasSub })
  parts.push(
    node({
      x: 20,
      y: 128,
      w: 100,
      h: 52,
      fill: P.loadgen,
      title: "loadgen",
      sub: loadgenSub,
    }),
  )
  parts.push(arrow(120, 154, 178, 154, { label: "round-robin" }))
  parts.push(
    node({
      x: 560,
      y: 118,
      w: 190,
      h: 56,
      fill: P.downstream,
      title: "downstream-mock",
      sub: "the dependency",
    }),
  )
  for (let i = 0; i < replicas; i += 1)
    parts.push(arrow(345, 42 + i * 58, 558, 125 + i * 14))
}

function valkeyNode(parts, sub) {
  parts.push(
    node({
      x: 180,
      y: 262,
      w: 165,
      h: 44,
      fill: P.redis,
      title: "valkey",
      sub,
    }),
  )
  parts.push(arrow(262.5, 238, 262.5, 262))
}

function witnessUnder(parts, label) {
  parts.push(witness(655, 174, 655, 198, label))
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

const scenes = {
  "01-local-only"() {
    const parts = []
    scaffold(parts, {
      replicasSub: (i) => `replica ${i} · bulkhead.local 5`,
      loadgenSub: "20 concurrent",
    })
    witnessUnder(parts, "witness: peak 20")
    parts.push(
      caption(
        390,
        345,
        "no Redis — bulkhead.local(5) is enforced per process, so the four limits add up",
      ),
    )
    return svg(780, 360, parts.join("\n"))
  },

  "02-distributed-basic"() {
    const parts = []
    scaffold(parts, {
      replicasSub: () => "replica · shared budget",
      loadgenSub: "20 concurrent",
    })
    valkeyNode(parts, "scope: global · limit 5")
    witnessUnder(parts, "witness: peak 5")
    parts.push(
      caption(
        390,
        345,
        "one shared budget — four replicas coordinate through valkey, so 5 means 5 total",
      ),
    )
    return svg(780, 360, parts.join("\n"))
  },

  "03-multi-region"() {
    const parts = []
    scaffold(parts, {
      replicasSub: () => "replica · scope region",
      loadgenSub: "60% eu · 40% us",
    })
    parts.push(
      node({
        x: 120,
        y: 272,
        w: 130,
        h: 44,
        fill: P.redis,
        title: "valkey-eu",
        sub: "region: eu",
      }),
    )
    parts.push(
      node({
        x: 270,
        y: 272,
        w: 130,
        h: 44,
        fill: P.redis,
        title: "valkey-us",
        sub: "region: us",
      }),
    )
    parts.push(arrow(200, 238, 185, 270, { label: "eu", labelBelow: true }))
    parts.push(arrow(325, 238, 335, 270, { label: "us", labelBelow: true }))
    parts.push(bolt(600, 98, "eu dependency fails"))
    witnessUnder(parts, "witness: eu vs us")
    parts.push(
      caption(
        390,
        345,
        "eu's breaker opens and sheds eu only — us keeps flowing at ~100%",
      ),
    )
    return svg(780, 360, parts.join("\n"))
  },

  "04-tenant-isolation"() {
    const parts = []
    scaffold(parts, {
      replicasSub: () => "replica · scope tenant",
      loadgenSub: "50 tenants",
    })
    valkeyNode(parts, "50 breaker keys")
    parts.push(bolt(24, 36, "t-49 noisy"))
    witnessUnder(parts, "witness: 50 tenants")
    parts.push(
      caption(
        390,
        345,
        "exactly one breaker opens — the noisy tenant's — and the other 49 never trip",
      ),
    )
    return svg(780, 360, parts.join("\n"))
  },

  "05-postgres-permit-hold"() {
    const parts = []
    parts.push(
      node({
        x: 30,
        y: 60,
        w: 150,
        h: 56,
        fill: P.brand,
        title: "partner-api",
        sub: "bulkhead · limit 1",
      }),
    )
    parts.push(
      node({
        x: 30,
        y: 180,
        w: 150,
        h: 44,
        fill: P.redis,
        title: "valkey",
        sub: "distributed permit",
      }),
    )
    parts.push(arrow(105, 180, 105, 118))
    parts.push(
      node({
        x: 560,
        y: 60,
        w: 190,
        h: 56,
        fill: P.postgres,
        title: "PostgreSQL",
        sub: "SELECT pg_sleep(2)",
      }),
    )
    parts.push(arrow(180, 88, 558, 88, { label: "timeout 500ms · query 2s" }))
    parts.push(
      badge({
        x: 250,
        y: 20,
        text: "permit held ~2000ms",
        fill: P.witnessLight,
      }),
    )
    parts.push(
      caption(
        390,
        345,
        "abort: unsupported — the caller times out at 500ms, the permit is held until the query ends",
      ),
    )
    return svg(780, 360, parts.join("\n"))
  },

  "06-observability-and-cost"() {
    const parts = []
    parts.push(
      node({
        x: 20,
        y: 112,
        w: 150,
        h: 52,
        fill: P.brand,
        title: "operation",
        sub: "events: {status} only",
      }),
    )
    parts.push(
      node({
        x: 215,
        y: 112,
        w: 130,
        h: 52,
        fill: P.loadgen,
        title: "event sink",
        sub: "fire-and-forget",
      }),
    )
    parts.push(arrow(170, 138, 213, 138))
    parts.push(
      node({
        x: 390,
        y: 112,
        w: 110,
        h: 52,
        fill: P.postgres,
        title: "OTel SDK",
        sub: "buffered",
      }),
    )
    parts.push(arrow(345, 138, 388, 138))
    parts.push(
      node({
        x: 545,
        y: 40,
        w: 190,
        h: 44,
        fill: P.redis,
        title: "Prometheus",
        sub: "caracal_executions_total",
      }),
    )
    parts.push(
      node({
        x: 545,
        y: 140,
        w: 190,
        h: 44,
        fill: P.downstream,
        title: "Jaeger",
        sub: "one trace per execution",
      }),
    )
    parts.push(arrow(500, 130, 543, 62))
    parts.push(arrow(500, 146, 543, 162))
    parts.push(
      caption(
        390,
        345,
        "a throwing or slow-async sink left p99 unchanged; only a synchronously blocking one hurt it",
      ),
    )
    return svg(780, 360, parts.join("\n"))
  },

  "07-chaos"() {
    const parts = []
    scaffold(parts, {
      replicasSub: () => "replica · lease 600ms",
      loadgenSub: "slow work",
    })
    valkeyNode(parts, "leases · limit 3")
    parts.push(
      node({
        x: 12,
        y: 262,
        w: 100,
        h: 44,
        fill: P.loadgen,
        title: "sampler",
        sub: "witness: leases",
      }),
    )
    parts.push(witness(112, 284, 180, 284, "live leases ≤ 3"))
    parts.push(bolt(24, 36, "kill replica-0"))
    parts.push(bolt(24, 68, "freeze replica-1"))
    parts.push(
      caption(
        390,
        345,
        "no sample exceeds 3, and the count returns to 0 — nothing leaks",
      ),
    )
    return svg(780, 360, parts.join("\n"))
  },

  "08-overload"() {
    const parts = []
    scaffold(parts, {
      replicasSub: () => "replica · shared budget",
      loadgenSub: "20 concurrent",
    })
    valkeyNode(parts, "scope: global · limit 20")
    bolt(600, 98, "dependency 503s beyond 8")
    witnessUnder(parts, "witness: peak 8 · overloaded")
    parts.push(
      caption(
        390,
        345,
        "the budget lets 20 through, but the dependency can only serve 8 — so it overloads",
      ),
    )
    return svg(780, 360, parts.join("\n"))
  },

  "09-local-bulkhead-lease"() {
    const parts = []
    scaffold(parts, {
      replicas: 1,
      replicasSub: () => "replica · bulkhead.local leaseMs 1s",
      loadgenSub: "2 concurrent · hangs",
    })
    witnessUnder(parts, "witness: the hung holder is aborted")
    parts.push(
      caption(
        390,
        345,
        "bulkhead.local(leaseMs) aborts the hung holder, so its permit is released",
      ),
    )
    return svg(780, 360, parts.join("\n"))
  },

  "10-dispose-abandoned-body"() {
    const parts = []
    scaffold(parts, {
      replicas: 1,
      replicasSub: () => "replica · fetch dispose",
      loadgenSub: "5xx · retried",
    })
    witnessUnder(parts, "witness: abandoned bodies")
    parts.push(
      caption(
        390,
        345,
        "retry abandons the 5xx body and the adapter's dispose cancels it",
      ),
    )
    return svg(780, 360, parts.join("\n"))
  },

  "11-local-breaker-probe-lease"() {
    const parts = []
    scaffold(parts, {
      replicas: 1,
      replicasSub: () => "replica · breaker probeLeaseTtlMs 1s",
      loadgenSub: "hung probe",
    })
    witnessUnder(parts, "witness: the probe slot is reclaimed")
    parts.push(
      caption(
        390,
        345,
        "a hung half-open probe releases its slot after probeLeaseTtlMs, so the breaker keeps admitting",
      ),
    )
    return svg(780, 360, parts.join("\n"))
  },
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

for (const [id, scene] of Object.entries(scenes)) {
  const dir = `${ROOT}case-studies/${id}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/diagram.svg`, `${scene()}\n`)
  console.log(`wrote case-studies/${id}/diagram.svg`)
}
