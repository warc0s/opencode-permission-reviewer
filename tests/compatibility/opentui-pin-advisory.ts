import pkg from "../../package.json"

// Read registry metadata only. @opentui/solid peer-pins solid-js exactly and
// Dependabot ignores the @opentui/* + solid-js set, so nothing else reports
// when upstream moves that pin. Failing here turns the scheduled run red, which
// is the signal to move the three packages together and revisit the seroval
// residual admitted by the consumer audit in tests/package-smoke.test.ts.
const pinned = pkg.dependencies["solid-js"]
const lookup = Bun.spawn(
  ["npm", "view", "@opentui/solid@latest", "version", "peerDependencies", "--json"],
  { stdout: "pipe", stderr: "pipe" },
)
const [code, stdout, stderr] = await Promise.all([
  lookup.exited,
  new Response(lookup.stdout).text(),
  new Response(lookup.stderr).text(),
])
if (code !== 0) throw new Error(`Registry lookup failed for @opentui/solid: ${stderr}`)
const latest = JSON.parse(stdout) as {
  version?: unknown
  peerDependencies?: Record<string, unknown>
}
const version = latest.version
const peer = latest.peerDependencies?.["solid-js"]
if (typeof version !== "string" || typeof peer !== "string")
  throw new Error("Invalid registry metadata for @opentui/solid")
if (peer !== pinned) {
  console.log(
    `::error::@opentui/solid ${version} peers solid-js ${peer}; this package pins solid-js ${pinned}. Move @opentui/core, @opentui/solid and solid-js together, then drop the seroval residual from tests/package-smoke.test.ts and the README if the new solid-js no longer carries it.`,
  )
  process.exitCode = 1
} else {
  console.log(`@opentui/solid ${version}: solid-js peer pin ${peer} unchanged`)
}
