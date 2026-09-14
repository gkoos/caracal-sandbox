#!/usr/bin/env node
/**
 * Switches the caracal under test between the published package and the local
 * checkout, without editing package.json by hand.
 *
 *   node scripts/link-local.mjs local    # pack ../caracal and install the tarball
 *   node scripts/link-local.mjs npm      # back to @gkoos/caracal@<pinned>
 *
 * The local checkout is installed as a tarball rather than as `file:../caracal`
 * on purpose: the package ships built `dist/` output, so a tarball install is
 * exactly what a consumer gets. A stale build is the failure mode to watch for,
 * which is why the age of dist/ is reported.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SOURCE = fileURLToPath(new URL("../../caracal", import.meta.url))

const pinned = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8"))
  .dependencies["@gkoos/caracal"]

function run(command, args) {
  console.log(`\n$ ${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: ROOT,
    shell: process.platform === "win32",
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function newestMtime(directory) {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const {readdirSync,statSync}=require("node:fs");const {join}=require("node:path");` +
        `let newest=0;const walk=(dir)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){` +
        `const full=join(dir,entry.name);if(entry.isDirectory())walk(full);` +
        `else newest=Math.max(newest,statSync(full).mtimeMs)}};walk(process.argv[1]);` +
        `process.stdout.write(String(newest))`,
      directory,
    ],
    { encoding: "utf8" },
  )
  return result.status === 0 ? Number(result.stdout) : 0
}

const mode = process.argv[2]
if (mode !== "local" && mode !== "npm") {
  console.error("usage: node scripts/link-local.mjs <local|npm>")
  process.exit(2)
}

if (mode === "npm") {
  run("npm", ["install", `@gkoos/caracal@${pinned}`, "--save-exact"])
  console.log(`\nnow on the published package (${pinned}).`)
  process.exit(0)
}

if (!existsSync(SOURCE)) {
  console.error(`local caracal checkout not found at ${SOURCE}`)
  process.exit(1)
}

const dist = `${SOURCE}/dist`
if (!existsSync(dist)) {
  console.error(
    `${dist} is missing - run \`npm run build\` in the caracal checkout first.`,
  )
  process.exit(1)
}

const distAge = Date.now() - newestMtime(dist)
const srcAge = Date.now() - newestMtime(`${SOURCE}/src`)
if (srcAge < distAge) {
  console.warn(
    `\nwarning: ${SOURCE}/src is newer than dist/ (` +
      `${Math.round((distAge - srcAge) / 60_000)} minutes). Run \`npm run build\` there, ` +
      "or this demo will test the previous build.",
  )
}

run("npm", ["pack", SOURCE, "--pack-destination", ROOT])
const tarball = spawnSync(
  process.execPath,
  [
    "-e",
    `const {readdirSync,statSync}=require("node:fs");` +
      `const files=readdirSync(process.argv[1]).filter((f)=>f.startsWith("gkoos-caracal-")&&f.endsWith(".tgz"));` +
      `files.sort((a,b)=>statSync(join(process.argv[1],b)).mtimeMs-statSync(join(process.argv[1],a)).mtimeMs);` +
      `function join(a,b){return require("node:path").join(a,b)}` +
      `process.stdout.write(files[0]??"")`,
    ROOT.replace(/[\\/]$/, ""),
  ],
  { encoding: "utf8" },
)
const file = tarball.stdout.trim()
if (!file) {
  console.error("npm pack produced no tarball")
  process.exit(1)
}
run("npm", ["install", `./${file}`, "--save-exact"])
console.log(
  `\nnow on the local checkout (${file}). Re-run \`npm run verify:api\` to confirm the surface.`,
)
