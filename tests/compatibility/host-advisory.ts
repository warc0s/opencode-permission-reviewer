import contracts from "./host-contracts.json"

// Read registry metadata only. New releases never silently expand supported engines.
for (const [name, reference] of [
  [contracts.v1.package, contracts.v1.reference],
  [contracts.v2.package, contracts.v2.version],
] as const) {
  const process = Bun.spawn(["npm", "view", `${name}@latest`, "version", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Registry lookup failed for ${name}: ${stderr}`)
  const latest: unknown = JSON.parse(stdout)
  if (typeof latest !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(latest))
    throw new Error(`Invalid registry version for ${name}`)
  if (latest !== reference)
    console.log(
      `::warning::${name} registry latest is ${latest}; verified reference remains ${reference}. Validate a new matrix before changing support.`,
    )
  else console.log(`${name}: verified reference ${reference} is still latest`)
}
