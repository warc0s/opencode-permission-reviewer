/*
 * Minimal shell-aware tokenizer used by the deterministic emergency brake.
 *
 * This is NOT a full shell interpreter. It performs just enough static
 * analysis to evaluate the *real* executable of a command:
 *   - grouping of single/double quotes (so separators inside quotes do not
 *     split a token, and `printf "a; sudo rm -rf /"` stays one argument),
 *   - splitting on logical command separators (`;`, `|`, `&`, newlines),
 *   - stripping `#` comments when they begin a token,
 *   - a recursive "effective command" resolver that peels privilege wrappers
 *     (`sudo`, `doas`, `env`, `command`, `nice`, `nohup`, `time`, `stdbuf`,
 *     `ionice`, `pkexec`, `fakeroot`, `setsid`, `setpriv`, `unshare`, `run0`,
 *     `watch`, `xargs`) and destructures command-string forms (`sh -c`,
 *     `su -c`, `env -S`, `ssh host cmd`, `busybox applet`, `chroot root cmd`,
 *     `timeout duration cmd`).
 *
 * It deliberately does NOT expand variables, globs, command substitutions,
 * heredocs, or arithmetic. Those remain the model reviewer's job; the brake
 * is only a last line of defense for *unmistakable* literal destruction.
 */

export interface ShellToken {
  /** Original text including any surrounding quotes. */
  raw: string
  /** Unquoted/normalized value used for comparisons. */
  value: string
}

export interface ShellSegment {
  tokens: ShellToken[]
}

const SEPARATORS = new Set([";", "|", "&", "\n", "\r", "(", ")"])
const WHITESPACE = new Set([" ", "\t"])

const TRANSPARENT_WRAPPERS = new Set([
  "sudo",
  "doas",
  "pkexec",
  "env",
  "command",
  "nice",
  "nohup",
  "time",
  "stdbuf",
  "ionice",
  "fakeroot",
  "setsid",
  "setpriv",
  "unshare",
  "run0",
  "watch",
  "xargs",
  "timeout",
])

/**
 * Wrapper short options that consume the next token as their value. Only flags
 * documented to take an argument are listed; pure flags (sudo -S/-A, unshare
 * --mount/--pid/…, run0 --mkdir/--no-ask-password) are intentionally absent so
 * the real executable that follows them is not swallowed by mistake.
 */
const VALUE_OPTIONS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "--user", "-g", "--group", "-C", "-p", "-R", "-T", "-U", "-D", "-r", "-t"]),
  doas: new Set(["-u", "--user", "-a"]),
  pkexec: new Set(["--user", "--session"]),
  env: new Set(["-u", "--unset", "-S", "-C"]),
  nice: new Set(["-n", "--adjustment"]),
  time: new Set(["-o", "--output", "-f"]),
  ionice: new Set(["-c", "-n"]),
  setpriv: new Set([
    "--reuid",
    "--regid",
    "--inh-caps",
    "--bounding-set",
    "--ambient-caps",
    "--clear-groups",
  ]),
  command: new Set(),
  nohup: new Set(),
  stdbuf: new Set(),
  fakeroot: new Set(),
  setsid: new Set(),
  unshare: new Set(),
  run0: new Set(["--unit", "--service", "--slice", "--setenv", "--chdir"]),
  // watch takes only two value options (-n/--interval); its pure flags
  // (-d, -g, -t, -b, -c, -e, …) stay absent like the other wrappers above.
  watch: new Set(["-n", "--interval"]),
  // xargs value-taking options with a separate argument: without these the
  // generic peel would mistake the option's argument for the command. Pure
  // flags (-0, -r, -t, …) stay absent, as do options with optional arguments
  // (-E, -l, --replace), where skipping a following token could swallow the
  // real executable instead.
  xargs: new Set([
    "-I",
    "-n",
    "-P",
    "-s",
    "-L",
    "--arg-file",
    "--max-args",
    "--max-chars",
    "--max-procs",
    "--max-lines",
  ]),
  // timeout value options; the DURATION operand itself is skipped by dedicated
  // handling in walk(), not by the generic loop.
  timeout: new Set(["-k", "-s", "--kill-after", "--signal"]),
}

const SHELL_BINARIES = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish"])
const SU_BINARIES = new Set(["su", "runuser", "super"])
const SSH_VALUE_OPTIONS = new Set([
  "-i",
  "-l",
  "-p",
  "-o",
  "-F",
  "-J",
  "-b",
  "-c",
  "-e",
  "-m",
  "-w",
  "-W",
  "-D",
  "-L",
  "-R",
  "-I",
  "-Q",
  "-O",
  "-E",
])
const SHELL_KEYWORDS = new Set(["{", "}", "(", ")", "then", "else", "do", "elif", "!"])

function basename(exe: string): string {
  const slash = exe.lastIndexOf("/")
  return slash >= 0 ? exe.slice(slash + 1) : exe
}

/**
 * Tokenize `command` into logical segments (one per sub-command separated by
 * `;`, `|`, `&`, or newline) with quote-aware, comment-aware grouping.
 */
export function lexSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = []
  let tokens: ShellToken[] = []
  let value = ""
  let raw = ""
  let hasToken = false
  let inSingle = false
  let inDouble = false

  const flushToken = () => {
    if (hasToken) {
      tokens.push({ raw, value })
      value = ""
      raw = ""
      hasToken = false
    }
  }
  const flushSegment = () => {
    flushToken()
    if (tokens.length > 0) {
      segments.push({ tokens })
      tokens = []
    }
  }

  let i = 0
  while (i < command.length) {
    const c = command[i]!
    if (inSingle) {
      raw += c
      if (c === "'") inSingle = false
      else value += c
      i += 1
      continue
    }
    if (inDouble) {
      raw += c
      if (c === '"') {
        inDouble = false
      } else if (c === "\\" && i + 1 < command.length) {
        const next = command[i + 1]!
        raw += next
        if ('$`"\\n'.includes(next)) {
          value += next === "n" ? "\n" : next
          i += 2
          continue
        }
        value += "\\"
        i += 1
        continue
      } else {
        value += c
      }
      i += 1
      continue
    }
    if (c === "'") {
      inSingle = true
      raw += c
      hasToken = true
      i += 1
      continue
    }
    if (c === '"') {
      inDouble = true
      raw += c
      hasToken = true
      i += 1
      continue
    }
    if (SEPARATORS.has(c)) {
      flushSegment()
      i += 1
      continue
    }
    if (WHITESPACE.has(c)) {
      flushToken()
      i += 1
      continue
    }
    if (c === "#" && !hasToken) {
      // Line comment: consume until newline (newline itself closes the segment).
      while (i < command.length && command[i] !== "\n") i += 1
      continue
    }
    if (c === "\\" && i + 1 < command.length) {
      const next = command[i + 1]!
      raw += "\\" + next
      value += next
      hasToken = true
      i += 2
      continue
    }
    value += c
    raw += c
    hasToken = true
    i += 1
  }
  flushSegment()
  return segments
}

/**
 * Resolve a segment into its "effective commands" — the token lists starting
 * at each real executable, after peeling wrappers and destructuring
 * command-string forms. May yield multiple commands when a shell/su `-c` body
 * itself contains separators.
 */
export function effectiveCommands(segment: ShellSegment): ShellToken[][] {
  const out: ShellToken[][] = []
  walk(segment.tokens, out)
  return out
}

function walk(tokens: ShellToken[], out: ShellToken[][]): void {
  let i = 0
  while (i < tokens.length && SHELL_KEYWORDS.has(tokens[i]!.value)) i += 1

  // Consume leading VAR=value assignments (env-style, only at the head).
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!.value)) i += 1

  while (i < tokens.length) {
    const tok = tokens[i]!
    if (tok.value === "--") {
      break
    }
    const base = basename(tok.value)
    if (base === "env") {
      // `env -S 'command string'` (or unquoted: `env -S cmd args…`) carries a
      // parsed command line, and any operands after the string are appended to
      // it. Recurse into the concatenation so `env -S rm -rf /` is caught.
      const sIndex = findOptionIndex(tokens, i + 1, "-S")
      if (sIndex !== -1 && sIndex + 1 < tokens.length) {
        const script = tokens[sIndex + 1]!.value
        const tail = tokens
          .slice(sIndex + 2)
          .map((t) => t.value)
          .join(" ")
        for (const sub of lexSegments(tail ? `${script} ${tail}` : script)) walk(sub.tokens, out)
        return
      }
    }
    if (base === "timeout") {
      // timeout [OPTION]... DURATION COMMAND [ARG]...: unlike the generic
      // wrappers, a mandatory non-option DURATION operand sits between the
      // options and the command, so skip options, then exactly one duration
      // token, then recurse into the real command tail. With no command left
      // (plain `timeout 5` just errors) there is nothing to peel to.
      const valueOpts = VALUE_OPTIONS.timeout ?? new Set<string>()
      let j = i + 1
      while (j < tokens.length) {
        const opt = tokens[j]!.value
        if (opt === "--") {
          j += 1
          break
        }
        if (opt.startsWith("-") && opt.length > 1) {
          if (valueOpts.has(opt)) j += 2
          else j += 1
          continue
        }
        break
      }
      if (j < tokens.length) j += 1
      if (j < tokens.length) walk(tokens.slice(j), out)
      return
    }
    if (TRANSPARENT_WRAPPERS.has(base)) {
      const valueOpts = VALUE_OPTIONS[base] ?? new Set<string>()
      i += 1
      while (i < tokens.length) {
        const opt = tokens[i]!.value
        if (opt === "--") {
          i += 1
          break
        }
        // Env-style VAR=value arguments that follow a wrapper (e.g. `env FOO=bar …`).
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(opt)) {
          i += 1
          continue
        }
        if (opt.startsWith("-") && opt.length > 1) {
          if (valueOpts.has(opt)) i += 2
          else i += 1
          continue
        }
        break
      }
      continue
    }
    if (SHELL_BINARIES.has(base) || SU_BINARIES.has(base)) {
      const script = findCommandString(tokens, i + 1)
      if (script !== null) {
        for (const sub of lexSegments(script)) walk(sub.tokens, out)
        return
      }
    }
    if (base === "ssh") {
      const rest = consumeSshRemote(tokens, i + 1)
      if (rest.length > 0) {
        for (const sub of lexSegments(rest.map((t) => t.value).join(" "))) walk(sub.tokens, out)
      }
      return
    }
    if (base === "busybox") {
      if (i + 1 < tokens.length) walk(tokens.slice(i + 1), out)
      return
    }
    if (base === "chroot") {
      // chroot [OPTION]... NEWROOT [COMMAND [ARG]...]: skip options, then the
      // NEWROOT token, then recurse into the real command tail.
      let j = i + 1
      while (j < tokens.length) {
        const opt = tokens[j]!.value
        if (opt === "--") {
          j += 1
          break
        }
        if (opt.startsWith("-") && opt.length > 1) {
          j += 1
          continue
        }
        break
      }
      if (j + 1 < tokens.length) walk(tokens.slice(j + 1), out)
      return
    }
    out.push(tokens.slice(i))
    return
  }
}

/** Find a `-c`/`--command` command-string argument and return its (unquoted) value. */
function findCommandString(tokens: ShellToken[], start: number): string | null {
  let i = start
  let endOfFlags = false
  while (i < tokens.length) {
    const t = tokens[i]!.value
    if (!endOfFlags && t === "--") {
      endOfFlags = true
      i += 1
      continue
    }
    if (!endOfFlags && t === "-c") {
      return i + 1 < tokens.length ? tokens[i + 1]!.value : null
    }
    // Long form: `--command` (next token) or `--command=VALUE`.
    if (!endOfFlags && t === "--command") {
      return i + 1 < tokens.length ? tokens[i + 1]!.value : null
    }
    if (!endOfFlags && t.startsWith("--command=")) {
      return t.slice("--command=".length)
    }
    // Combined short flag containing `c` (e.g. `bash -ic '...'`); value is next token.
    if (
      !endOfFlags &&
      t.startsWith("-") &&
      !t.startsWith("--") &&
      t.length > 1 &&
      t.includes("c")
    ) {
      return i + 1 < tokens.length ? tokens[i + 1]!.value : null
    }
    i += 1
  }
  return null
}

/** Find the token index of a named short option (e.g. `env -S`), or -1. */
function findOptionIndex(tokens: ShellToken[], start: number, name: string): number {
  let i = start
  let endOfFlags = false
  while (i < tokens.length) {
    const t = tokens[i]!.value
    if (!endOfFlags && t === "--") {
      endOfFlags = true
      i += 1
      continue
    }
    if (!endOfFlags && t === name) return i
    i += 1
  }
  return -1
}

/** Consume ssh options + host and return the remaining remote-command tokens. */
function consumeSshRemote(tokens: ShellToken[], start: number): ShellToken[] {
  let i = start
  let hostSeen = false
  while (i < tokens.length) {
    const t = tokens[i]!.value
    if (t === "--") {
      i += 1
      break
    }
    if (t.startsWith("-") && t.length > 1) {
      if (SSH_VALUE_OPTIONS.has(t)) i += 2
      else i += 1
      continue
    }
    if (!hostSeen) {
      hostSeen = true
      i += 1
      continue
    }
    break
  }
  return tokens.slice(i)
}

export { basename as shellBasename }
