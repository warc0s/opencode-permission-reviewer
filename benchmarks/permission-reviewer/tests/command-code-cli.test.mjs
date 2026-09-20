import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { requestCommandCodeCli } from "../lib/command-code-cli.mjs"
import { validateModel } from "../lib/providers.mjs"

const model = {
  id: "deepseek-high",
  model: "deepseek/deepseek-v4.1-flash",
  transport: "command-code-cli",
  commandCodeBinEnv: "PRB_TEST_COMMAND_CODE_BIN",
  variant: "high",
  format: "text",
}

test("Command Code configuration uses a local CLI, not provider API credentials", () => {
  assert.equal(validateModel(model).transport, "command-code-cli")
  assert.throws(
    () => validateModel({ ...model, endpoint: "https://api.commandcode.ai" }),
    /no endpoint/,
  )
  assert.throws(() => validateModel({ ...model, apiKeyEnv: "CMD_API_KEY" }), /own authenticated/)
  assert.throws(() => validateModel({ ...model, variant: "medium" }), /effort variant/)
  assert.throws(() => validateModel({ ...model, format: "json_schema" }), /text profile/)
})

async function fakeCli() {
  const directory = await mkdtemp(join(tmpdir(), "prb-command-code-test-"))
  const binary = join(directory, "commandcode")
  await writeFile(
    binary,
    `#!/usr/bin/env node
let query = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { query += chunk })
process.stdin.on("end", () => {
  const args = process.argv.slice(2)
  const model = args[args.indexOf("--model") + 1]
  console.log(JSON.stringify({type:"event",event:{type:"model_request_start",model}}))
  if (process.env.PRB_TEST_FAKE_TOOL === "1")
    console.log(JSON.stringify({type:"event",event:{type:"tool_running",toolName:"read_file"}}))
  const finalText = JSON.stringify({
    system: query.includes("<reviewer_system>\\nSYNTHETIC POLICY"),
    evidence: query.includes("<permission_request>\\nSYNTHETIC EVIDENCE"),
    effort: args[args.indexOf("--effort") + 1],
    noSession: args.includes("--no-session"),
    noSkills: args.includes("--no-skills"),
  })
  console.log(JSON.stringify({
    type:"result",subtype:"success",stopReason:"end_turn",finalText,
    usage:{inputTokens:10,outputTokens:5,cacheReadTokens:2},
  }))
})
`,
  )
  await chmod(binary, 0o700)
  return { directory, binary }
}

test("Command Code runs one role-folded request without exposing provider credentials", async () => {
  const fixture = await fakeCli()
  const previous = process.env.PRB_TEST_COMMAND_CODE_BIN
  process.env.PRB_TEST_COMMAND_CODE_BIN = fixture.binary
  try {
    const result = await requestCommandCodeCli(model, {
      system: "SYNTHETIC POLICY",
      user: "SYNTHETIC EVIDENCE",
    })
    assert(result.ok)
    assert.equal(result.returnedModel, model.model)
    assert.equal(result.usage.prompt_tokens, 10)
    assert.deepEqual(JSON.parse(result.extracted.text), {
      system: true,
      evidence: true,
      effort: "high",
      noSession: true,
      noSkills: true,
    })
  } finally {
    if (previous === undefined) delete process.env.PRB_TEST_COMMAND_CODE_BIN
    else process.env.PRB_TEST_COMMAND_CODE_BIN = previous
    await rm(fixture.directory, { recursive: true })
  }
})

test("Command Code tool events request a safety stop", async () => {
  const fixture = await fakeCli()
  const previousBin = process.env.PRB_TEST_COMMAND_CODE_BIN
  const previousTool = process.env.PRB_TEST_FAKE_TOOL
  process.env.PRB_TEST_COMMAND_CODE_BIN = fixture.binary
  process.env.PRB_TEST_FAKE_TOOL = "1"
  try {
    const result = await requestCommandCodeCli(model, { system: "POLICY", user: "EVIDENCE" })
    assert.equal(result.ok, false)
    assert.equal(result.halt, true)
    assert.match(result.error, /tool action/)
  } finally {
    if (previousBin === undefined) delete process.env.PRB_TEST_COMMAND_CODE_BIN
    else process.env.PRB_TEST_COMMAND_CODE_BIN = previousBin
    if (previousTool === undefined) delete process.env.PRB_TEST_FAKE_TOOL
    else process.env.PRB_TEST_FAKE_TOOL = previousTool
    await rm(fixture.directory, { recursive: true })
  }
})
