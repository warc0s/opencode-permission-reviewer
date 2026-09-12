/*
 * Always-on secret redaction for review evidence.
 *
 * The reviewer is a normal model invocation and may run on a *different*
 * provider than the primary agent. Anything the user pasted into the session
 * — a Bearer token, an AWS key, a private key, a password in a config — would
 * otherwise travel verbatim to that second provider. This module scrubs the
 * common credential formats from the final evidence string before it is
 * wrapped into the reviewer prompt.
 *
 * Redaction is conservative and lossy by design: a `[REDACTED:type]` marker
 * preserves enough signal ("there was a credential here of kind X") for the
 * reviewer to reason about authorization, while never exposing the value.
 * It is applied at the truncate boundary (see context.ts) and to the reviewer
 * session title, so no copy of the evidence reaches the model unredacted.
 *
 * Limitations (intentional): variables, globs, command substitutions and
 * arbitrary prose secrets are not detected; only literal credential formats.
 * The marker is stable (idempotent) thanks to `(?!\[REDACTED)` guards.
 */

const REDACT = (type: string) => `[REDACTED:${type}]`

// Order matters: run specific token formats first, then URL userinfo, then
// auth headers, then generic credential assignments. Each value-level rule
// carries a `(?!\[REDACTED)` guard so a second pass is a no-op.
const RULES: ReadonlyArray<{ re: RegExp; replace: (match: string, groups: string[]) => string }> = [
  // PEM private key blocks (bounded to avoid pathological backtracking). The
  // optional ` BLOCK` arm covers ASCII-armored GPG secret keys
  // (`-----BEGIN PGP PRIVATE KEY BLOCK-----`), which the simpler alternation
  // missed because of the trailing ` BLOCK`.
  {
    re: /-----BEGIN (?:[A-Z ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]{0,8192}?-----END (?:[A-Z ]*PRIVATE KEY(?: BLOCK)?)-----/g,
    replace: () => REDACT("pem"),
  },
  // Truncated PEM (BEGIN with no matching END within the complete-block
  // window above): redact from the BEGIN marker to the end of the string so a
  // long private key whose END was chopped by an upstream truncation cannot
  // leak its tail. The `*` quantifier is a single greedy linear scan (no
  // alternation), so it is safe from pathological backtracking.
  {
    re: /-----BEGIN (?:[A-Z ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*/g,
    replace: () => REDACT("pem"),
  },
  // AWS access key ids: long-term (AKIA) and temporary/session (ASIA).
  { re: /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g, replace: () => REDACT("aws") },
  // GitHub tokens (ghu_ covers user-to-server OAuth tokens).
  { re: /\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{36,251}\b/g, replace: () => REDACT("github") },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,251}\b/g, replace: () => REDACT("github") },
  // OpenAI: project keys and long bare `sk-…` keys (excludes Anthropic).
  { re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, replace: () => REDACT("openai") },
  { re: /\bsk-(?!ant-)[A-Za-z0-9]{30,}\b/g, replace: () => REDACT("openai") },
  // Anthropic.
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replace: () => REDACT("anthropic") },
  // Slack tokens.
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => REDACT("slack") },
  // Google API key.
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => REDACT("google") },
  // Stripe live/test restricted/secret keys.
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: () => REDACT("stripe") },
  // GitLab, NVIDIA, Telegram bot tokens.
  { re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replace: () => REDACT("gitlab") },
  { re: /\bnvapi-[A-Za-z0-9_-]{20,}\b/g, replace: () => REDACT("nvidia") },
  { re: /\b\d{8,12}:AA[A-Za-z0-9_-]{30,}\b/g, replace: () => REDACT("telegram") },
  // JWT (three base64url segments).
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => REDACT("jwt"),
  },
  // Credentials embedded in a URL userinfo component: scheme://user:pass@host
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@[\]]+):([^\s/@[\]]+)@/gi,
    replace: (_m, g) => `${g[0] ?? ""}${REDACT("userinfo")}@`,
  },
  // Auth-scheme prefixes (Bearer / Basic / Token) followed by a token.
  // Case-insensitive so lowercase "bearer", "basic", "token" are caught too.
  {
    re: /\b(Bearer|Basic|Token)\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, g) => {
      const scheme = g[0] ?? ""
      return `${scheme} ${REDACT(scheme.toLowerCase())}`
    },
  },
  // Cookie headers.
  {
    re: /(^|[^A-Za-z0-9_])(Cookie|Set-Cookie)(\s*[:=]\s*)(["']?)(?!\[REDACTED)([A-Za-z0-9._~+/%=-]{8,})(["']?)/g,
    replace: (_m, g) =>
      `${g[0] ?? ""}${g[1] ?? ""}${g[2] ?? ""}${g[3] ?? ""}${REDACT("credential")}${g[5] ?? ""}`,
  },
  // Authorization-style headers and JSON/YAML keys.
  {
    re: /(^|[^A-Za-z0-9_])(authorization|proxy-authorization|x-api-key|x-auth-token)(\s*[:=]\s*)(["']?)(?!\[REDACTED)([A-Za-z0-9._~+/-]{8,})(["']?)/gi,
    replace: (_m, g) =>
      `${g[0] ?? ""}${g[1] ?? ""}${g[2] ?? ""}${g[3] ?? ""}${REDACT("credential")}${g[5] ?? ""}`,
  },
  // Generic credential assignments (covers compound env names like DB_PASSWORD,
  // AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN via the underscore-tolerant prefix).
  // First, compound variable names whose identifier contains a credential word.
  // Case-insensitive so lowercase forms (ssh_private_key, passphrase,
  // service_credentials) are caught alongside their UPPER_CASE counterparts.
  {
    re: /(^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*(?:SECRET|PASSWORD|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|PASSPHRASE|CREDENTIALS?)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)(?!\[REDACTED)([^$`{}()\s"'#[\]]{8,})(["']?)/gi,
    replace: (_m, g) =>
      `${g[0] ?? ""}${g[1] ?? ""}${g[2] ?? ""}${g[3] ?? ""}${REDACT("credential")}${g[5] ?? ""}`,
  },
  // Then lowercase credential keywords as standalone-ish keys (also catches the
  // bare forms private_key / passphrase / credential that the compound rule
  // above misses because it requires a leading identifier).
  {
    re: /(^|_|[^A-Za-z0-9_])(api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret|secret|password|passwd|token|cookie|csrf[_-]?token|session[_-]?id|sessionid|session|sid|private[_-]?key|passphrase|credentials?)(["']?\s*[:=]\s*["']?)(?!\[REDACTED)([^$`{}()\s"'#[\]]{8,})/gi,
    replace: (_m, g) => `${g[0] ?? ""}${g[1] ?? ""}${g[2] ?? ""}${REDACT("credential")}`,
  },
]

export function redactSecrets(input: string): string {
  let result = input
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    result = result.replace(rule.re, (match, ...rest) => {
      // rest ends with (offset, string) when a full function is used; keep only
      // the captured groups. The number of trailing items depends on whether
      // named groups exist, but the capture groups always come first.
      const groups = rest.slice(0, rest.length - 2)
      return rule.replace(match, groups)
    })
  }
  return result
}
