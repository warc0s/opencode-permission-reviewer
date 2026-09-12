import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { buildEvidence, buildTranscript, normalizeMessages } from "../src/context.ts"
import { buildReviewerPrompt, DEFAULT_TENANT_POLICY } from "../src/policy.ts"
import { redactSecrets } from "../src/redact.ts"
import { request } from "./helpers.ts"

// Live-secret-shaped fixtures are built by string concatenation so that no
// continuous literal in source matches a static secret scanner (see AGENTS.md).
// Scanners key on the full token shape; splitting the recognized prefix from
// the body defeats that without weakening the assertion.
const AWS_EX = "AKIA" + "IOSFODNN7EXAMPLE"
const AWS_ASIA = "ASIA" + "IOSFODNN7EXAMPLE"
const GHP = "ghp_" + "syntheticGitHubToken01234567890abcdefghijklmnopqrstuv"
const GHU = "ghu_" + "syntheticGitHubUserToken01234567890abcdefghijklmnopqr"
const GH_FINE = "github_" + "pat_synthetictoken1234567890abcdef"
const OAI_PROJ = "sk-" + "proj-synthetictoken1234567890abcdef"
const OAI = "sk-" + "synthetictoken1234567890ABCDEF1234567890"
const OAI_FRAG = "sk-" + "synthetic"
const ANTHROPIC = "sk-" + "ant-synthetictoken1234567890ABCDEF"
const SLACK = "xox" + "b-synthetic-slack-token-1234567890"
const JWT = "ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signatureabcdefg"
const GLPAT = "gl" + "pat-syntheticgitlabtoken1234"
const NVAPI = "nv" + "api-syntheticnvidiatoken1234abcd"
const AWS_SECRET_VAL = "wJalrXUt" + "nFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
const AWS_SECRET_LINE = "AWS_SECRET_ACCESS_KEY=" + AWS_SECRET_VAL
const TELEGRAM = "123456789:" + "AAH-synthetic-telegram-bot-token-12345"
const PEM_BEGIN_RSA = "-----BEGIN RSA " + "PRIVATE KEY-----"
const PEM_END_RSA = "-----END RSA " + "PRIVATE KEY-----"
const PEM_BEGIN = "-----BEGIN " + "PRIVATE KEY-----"
const PEM_END = "-----END " + "PRIVATE KEY-----"
const PEM_BODY = "MIIEp" + "AIBAAKCAQEA"
// GPG ASCII-armored secret key (note the trailing ` BLOCK`).
const PGP_BEGIN = "-----BEGIN PGP " + "PRIVATE KEY BLOCK-----"
const PGP_END = "-----END PGP " + "PRIVATE KEY BLOCK-----"

describe("redactSecrets — credential formats", () => {
  test.each([
    ["AWS access key id", `env ${AWS_EX} here`, AWS_EX],
    ["AWS temporary session token id", `creds ${AWS_ASIA} here`, AWS_ASIA],
    ["GitHub PAT", GHP, "ghp_"],
    ["GitHub user-to-server token", GHU, "ghu_"],
    ["GitHub fine-grained", GH_FINE, "github_pat_"],
    ["OpenAI project key", OAI_PROJ, OAI_FRAG],
    ["OpenAI bare key", OAI, OAI_FRAG],
    ["Anthropic key", ANTHROPIC, "sk-ant-"],
    ["Slack token", SLACK, "xox"],
    ["Google API key", `AIza${"a".repeat(35)}`, `AIza${"a".repeat(5)}`],
    ["JWT", JWT, "eyJhbGci"],
  ])("redacts %s", (_label, input, secret) => {
    const out = redactSecrets(input)
    expect(out).not.toContain(secret)
    expect(out).toMatch(/\[REDACTED:[a-z]+\]/)
  })

  test("redacts Stripe-style live secret keys", () => {
    const prefix = "sk_"
    const rest = `${"live"}_syntheticStripeKey1234ab`
    const out = redactSecrets(prefix + rest)
    expect(out).not.toContain("syntheticStripeKey")
    expect(out).toContain("[REDACTED:stripe]")
  })

  test("redacts PEM private key blocks", () => {
    const pem = `${PEM_BEGIN_RSA}\n${PEM_BODY}\n${PEM_END_RSA}`
    const out = redactSecrets(`config = ${pem}`)
    expect(out).not.toContain(PEM_BODY)
    expect(out).toContain("[REDACTED:pem]")
  })

  test("redacts ASCII-armored GPG secret keys (PGP PRIVATE KEY BLOCK)", () => {
    const armored = `${PGP_BEGIN}\n${PEM_BODY}\n${PGP_END}`
    const out = redactSecrets(`exporter ran: gpg --export-secret-keys\n${armored}`)
    expect(out).not.toContain(PEM_BODY)
    expect(out).toContain("[REDACTED:pem]")
  })

  test("redacts a truncated PGP private key block to the end", () => {
    const truncated = `${PGP_BEGIN}\n${PEM_BODY}abcdef1234567890`
    const out = redactSecrets(`config = ${truncated} more text`)
    expect(out).not.toContain(`${PEM_BODY}abcdef`)
    expect(out).toContain("[REDACTED:pem]")
  })

  test("does NOT redact PGP PUBLIC KEY BLOCK, MESSAGE, or SIGNATURE", () => {
    const pub = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nabcd1234\n-----END PGP PUBLIC KEY BLOCK-----"
    const msg = "-----BEGIN PGP MESSAGE-----\nabcd1234\n-----END PGP MESSAGE-----"
    const sig = "-----BEGIN PGP SIGNATURE-----\nabcd1234\n-----END PGP SIGNATURE-----"
    expect(redactSecrets(pub)).toContain("abcd1234")
    expect(redactSecrets(msg)).toContain("abcd1234")
    expect(redactSecrets(sig)).toContain("abcd1234")
  })

  test("redacts URL userinfo credentials", () => {
    const out = redactSecrets("postgres://admin:s3cretpw@db.example.com:5432/app")
    expect(out).not.toContain("s3cretpw")
    expect(out).toContain("[REDACTED:userinfo]")
    expect(out).toContain("db.example.com")
  })

  test("redacts Bearer / Basic / Token prefixes", () => {
    expect(redactSecrets(`Authorization: Bearer ${OAI}`)).toContain("Bearer [REDACTED:openai]")
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzMTIzNDU2Nzg=")).toContain(
      "Basic [REDACTED:basic]",
    )
    expect(redactSecrets("Token: abcdefgh1234567890")).toContain("[REDACTED:credential]")
  })

  test("redacts lowercase auth schemes (bearer / basic / token)", () => {
    // Case-insensitive flag: lowercase scheme prefixes must also be scrubbed.
    const opaque = "abcdefghij1234567890"
    expect(redactSecrets(`bearer ${opaque}`)).toContain("[REDACTED:bearer]")
    expect(redactSecrets(`bearer ${opaque}`)).not.toContain(opaque)
    expect(redactSecrets(`authorization: bearer ${opaque}`)).not.toContain(opaque)
    expect(redactSecrets("authorization: basic dXNlcjpwYXNzMTIzNDU2Nzg=")).not.toContain(
      "dXNlcjpwYXNz",
    )
    expect(redactSecrets(`token ${opaque}`)).toContain("[REDACTED:token]")
    expect(redactSecrets(`token ${opaque}`)).not.toContain(opaque)
  })

  test("redacts Bearer tokens containing dashes", () => {
    const dashed = "dGhpcy1pcy1hLXNlY3JldC10b2tlbg"
    const out = redactSecrets(`Authorization: Bearer ${dashed}`)
    expect(out).not.toContain(dashed)
    expect(out).toContain("Bearer [REDACTED:bearer]")
  })

  test("redacts Basic tokens containing dashes and padding", () => {
    const dashed = "YWJjLWRlZi1naGk="
    const out = redactSecrets(`Authorization: Basic ${dashed}`)
    expect(out).not.toContain(dashed)
    expect(out).toContain("Basic [REDACTED:basic]")
  })

  test("dashed auth-scheme tokens stay redacted on a second pass", () => {
    const samples = [
      "Authorization: Bearer dGhpcy1pcy1hLXNlY3JldC10b2tlbg",
      "Authorization: Basic YWJjLWRlZi1naGk=",
    ]
    for (const sample of samples) {
      const once = redactSecrets(sample)
      expect(once).toContain("[REDACTED:")
      expect(redactSecrets(once)).toBe(once)
    }
  })

  test("redacts a dash-free Bearer token", () => {
    const plain = "abcdefghij1234567890"
    const out = redactSecrets(`Authorization: Bearer ${plain}`)
    expect(out).not.toContain(plain)
    expect(out).toContain("Bearer [REDACTED:bearer]")
  })

  test("redacts Cookie / Set-Cookie headers", () => {
    expect(redactSecrets("Cookie: session=abcdefgh1234567890")).not.toContain("abcdefgh")
    expect(redactSecrets("Set-Cookie: sid=abcdefgh1234567890")).not.toContain("abcdefgh")
  })

  test("redacts authorization / x-api-key / proxy-authorization header values", () => {
    // Direct header-value form (no Bearer/Basic scheme prefix), which the
    // auth-scheme rule does not catch — these hit the authorization-key rule.
    const opaque = "syntheticapikey1234567890abcd"
    expect(redactSecrets(`x-api-key: ${opaque}`)).not.toContain(opaque)
    expect(redactSecrets(`authorization: ${opaque}`)).not.toContain(opaque)
    expect(redactSecrets(`proxy-authorization: ${opaque}`)).not.toContain(opaque)
    expect(redactSecrets(`x-auth-token=${opaque}`)).not.toContain(opaque)
  })

  test("redacts compound env-var names (AWS_SECRET_ACCESS_KEY, DB_PASSWORD, …)", () => {
    expect(redactSecrets(AWS_SECRET_LINE)).not.toContain("wJalr")
    expect(redactSecrets("DB_PASSWORD=hunter2pass")).not.toContain("hunter2")
    expect(redactSecrets("PGPASSWORD=postgrespass123")).not.toContain("postgrespass")
    expect(redactSecrets(`OPENAI_API_KEY=${OAI}`)).not.toContain(OAI_FRAG)
  })

  test("redacts JSON / YAML credential assignments", () => {
    expect(redactSecrets('{"password": "hunter2pass"}')).not.toContain("hunter2")
    expect(redactSecrets("api_key: sksynthetic1234567890abcdef1234567890")).not.toContain(
      "sksynthetic",
    )
  })

  test("redacts truncated PEM blocks (BEGIN with no END)", () => {
    const truncated = `${PEM_BEGIN_RSA}\n${PEM_BODY}abcdef1234567890`
    const out = redactSecrets(`config = ${truncated} more text here`)
    expect(out).not.toContain(`${PEM_BODY}abcdef`)
    expect(out).toContain("[REDACTED:pem]")
  })

  test("redacts a truncated PEM longer than the historical 4096 window to the end", () => {
    // A real-sized key body (base64) well beyond the previous 4096-char cap,
    // with no END marker. The whole tail must be scrubbed, not just the head.
    const body = Buffer.from("x".repeat(6000)).toString("base64")
    const truncated = `${PEM_BEGIN}\n${body}`
    const out = redactSecrets(`prefix ${truncated} suffix`)
    expect(out).not.toContain(body.slice(0, 60))
    expect(out).not.toContain(body.slice(-60))
    expect(out).toContain("[REDACTED:pem]")
  })

  test("redacts GitLab / NVIDIA / Telegram tokens", () => {
    expect(redactSecrets(GLPAT)).toContain("[REDACTED:gitlab]")
    expect(redactSecrets(NVAPI)).toContain("[REDACTED:nvidia]")
    expect(redactSecrets(TELEGRAM)).toContain("[REDACTED:telegram]")
  })

  test("redacts bare session/cookie assignments", () => {
    expect(redactSecrets("session=abcdefgh1234567890")).not.toContain("abcdefgh")
    expect(redactSecrets('{"sid": "abcdefgh1234567890"}')).not.toContain("abcdefgh")
    expect(redactSecrets("csrf_token=abcdef1234567890abcd")).not.toContain("abcdef1234567890")
  })

  test("redacts private_key / passphrase / credential assignments", () => {
    const val = (c: string) => c.repeat(8)
    expect(redactSecrets(`private_key=${val("a")}`)).not.toContain("aaaaaaaa")
    expect(redactSecrets(`ssh_private_key=${val("b")}`)).not.toContain("bbbbbbbb")
    expect(redactSecrets(`service_private_key_data=${val("c")}`)).not.toContain("cccccccc")
    expect(redactSecrets("passphrase=correct-horse-battery-staple")).not.toContain("battery")
    expect(redactSecrets(`credential=${val("d")}`)).not.toContain("dddddddd")
    expect(redactSecrets(`credentials=${val("e")}`)).not.toContain("eeeeeeee")
    // The compound-name rule is case-insensitive: a mixed-case identifier that
    // embeds a credential word (and that the standalone rule cannot match) is
    // still redacted. This pins the `i` flag on its own.
    expect(redactSecrets(`my_Db_PaSsWoRd_1=${val("f")}`)).not.toContain("ffffffff")
    expect(redactSecrets(`svc_SeCrEt_field=${val("g")}`)).not.toContain("gggggggg")
  })

  test("preserves the key name and redacts only the value", () => {
    const out = redactSecrets("password=hunter2pass")
    expect(out).toContain("password=")
    expect(out).not.toContain("hunter2")
    expect(out).toContain("[REDACTED:credential]")
  })
})

describe("redactSecrets — does not overreach", () => {
  test.each([
    "bun test",
    "/repo/sk-internal",
    "tasks/sk-notes.md",
    "echo token",
    "tokenizer = extract()",
    "PORT=8080",
    "printf safe",
    "Run the tests only.",
    "token count: 5",
    "el secretario general",
    "tokenizer for the model",
    "cd /repo/api_key_utils",
    "the auth token was rotated",
    "export GITHUB_TOKEN=$TOKEN",
    "password=$(cat file)",
    "password=short",
    "https://example.com/health",
    "git@github.com:org/repo.git",
  ])("leaves %s untouched", (input) => {
    expect(redactSecrets(input)).toBe(input)
  })
})

describe("redactSecrets — robustness", () => {
  test("is idempotent", () => {
    const inputs = [
      `Bearer ${OAI}`,
      AWS_SECRET_LINE,
      "postgres://admin:s3cretpw@db.example.com:5432/app",
      "password=hunter2pass and api_key=sksynthetic1234567890abcdef",
      `${PEM_BEGIN}\nabc\n${PEM_END}`,
    ]
    for (const input of inputs) {
      const once = redactSecrets(input)
      expect(redactSecrets(once)).toBe(once)
    }
  })

  test("terminates quickly on adversarial inputs (no ReDoS)", () => {
    const big = Array.from({ length: 2000 }, () => `password = "${"x".repeat(40)}"`).join("\n")
    const start = Date.now()
    redactSecrets(big)
    expect(Date.now() - start).toBeLessThan(1000)

    const start2 = Date.now()
    redactSecrets(`${PEM_BEGIN}\n` + "x".repeat(50_000))
    expect(Date.now() - start2).toBeLessThan(1000)
  })

  test("never leaves a known credential format in the output", () => {
    const inputs = [AWS_EX, GHP, OAI, `Bearer ${JWT}`]
    for (const input of inputs) {
      expect(redactSecrets(input)).not.toContain(input)
    }
  })
})

describe("evidence redaction through buildEvidence", () => {
  test("secrets in transcript, intent, and request metadata are redacted before reaching the prompt", () => {
    const messages = normalizeMessages([
      {
        info: { id: "u1", role: "user" },
        parts: [{ type: "text", text: `My token is Bearer ${OAI}, please use it.` }],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "bash",
            callID: "c1",
            state: { input: { command: "curl https://example.com" } },
          },
        ],
      },
    ])
    const transcript = buildTranscript(messages, DEFAULT_CONFIG)
    const evidence = buildEvidence(
      {
        request: request({ metadata: { command: `export ${AWS_SECRET_LINE}` } }),
        directory: "/repo",
        worktree: "/repo",
        transcript,
        intentHistory: `USER_INTENT id=u1\nMy token is Bearer ${OAI}`,
        enrichment: "",
        sshAudit: [],
      },
      DEFAULT_CONFIG,
    )
    expect(evidence).not.toContain(OAI_FRAG)
    expect(evidence).not.toContain("wJalrXUt")
    expect(evidence).toContain("[REDACTED:openai]")
    expect(evidence).toContain("[REDACTED:credential]")
  })
})

describe("tenant policy redaction", () => {
  test("buildReviewerPrompt redacts a credential accidentally placed in the tenant policy", () => {
    const opaque = "abcdefghij1234567890"
    const maliciousPolicy = `## Notes\nCall bearer ${opaque} if you need auth.`
    const prompt = buildReviewerPrompt(maliciousPolicy, "harmless evidence")
    expect(prompt).not.toContain(opaque)
    expect(prompt).toContain("[REDACTED:bearer]")
    // The evidence and structure are preserved.
    expect(prompt).toContain("<approval_evidence>")
    expect(prompt).toContain("harmless evidence")
  })

  test("the default tenant policy is unaffected by redaction", () => {
    // The default policy mentions secrets/credentials in prose but contains no
    // literal credential assignment, so redaction must be a no-op on it.
    expect(redactSecrets(DEFAULT_TENANT_POLICY)).toBe(DEFAULT_TENANT_POLICY)
  })
})
