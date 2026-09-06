/** Minimal JSONC (JSON with comments) parser with zero dependencies.
 *
 * Strips line comments, block comments, and trailing commas (all in a single
 * string-aware pass), then delegates to `JSON.parse`. String contents are
 * preserved verbatim — comment markers and trailing-comma patterns inside
 * strings are NOT stripped.
 *
 * Used by the config loader to read `~/.config/opencode/permission-reviewer.jsonc`
 * and `.opencode/permission-reviewer.jsonc`. Returns `{}` on parse failure so
 * a malformed config file degrades to defaults rather than crashing the plugin.
 */
export function parseJsonc(text: string): Record<string, unknown> {
  try {
    return parseJsoncStrict(text)
  } catch {
    return {}
  }
}

/** Strict variant used by the config loader: throws on a syntax error or on a
 *  top-level non-object so callers can distinguish a malformed config file
 *  (worth warning about) from a missing one (the common case). */
export function parseJsoncStrict(text: string): Record<string, unknown> {
  const stripped = stripCommentsAndTrailingCommas(text)
  const parsed: unknown = JSON.parse(stripped)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("top-level value is not a JSON object")
  }
  return parsed as Record<string, unknown>
}

/** Strip JSONC comments and trailing commas while preserving string contents.
 *  Trailing commas are handled in the same pass as comments (both are
 *  string-aware), so a `,}` inside a string value is never corrupted. */
export function stripCommentsAndTrailingCommas(input: string): string {
  let out = ""
  let i = 0
  const len = input.length
  // Tracks the last non-whitespace character appended to `out`. Used to detect
  // trailing commas: when we encounter `}` or `]`, we check if the last real
  // character was `,` and remove it.
  let lastReal = ""
  const append = (ch: string) => {
    out += ch
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") lastReal = ch
  }

  while (i < len) {
    const ch = input[i]!
    const next = input[i + 1]

    // String literal — copy verbatim until the closing quote.
    if (ch === '"') {
      append(ch)
      i += 1
      while (i < len) {
        const c = input[i]!
        append(c)
        if (c === "\\" && i + 1 < len) {
          append(input[i + 1]!)
          i += 2
          continue
        }
        i += 1
        if (c === '"') break
      }
      continue
    }

    // Line comment.
    if (ch === "/" && next === "/") {
      i += 2
      while (i < len && input[i] !== "\n") i += 1
      continue
    }

    // Block comment.
    if (ch === "/" && next === "*") {
      i += 2
      while (i < len && !(input[i] === "*" && input[i + 1] === "/")) i += 1
      i += 2
      continue
    }

    // Structural close: if the last real character was a trailing comma,
    // remove it before appending the closing brace/bracket.
    if ((ch === "}" || ch === "]") && lastReal === ",") {
      // Walk back over the comma (and any whitespace after it in `out`).
      let j = out.length - 1
      while (j >= 0 && out[j] !== ",") j -= 1
      if (j >= 0) out = out.slice(0, j)
      lastReal = ""
    }

    append(ch)
    i += 1
  }

  return out
}
