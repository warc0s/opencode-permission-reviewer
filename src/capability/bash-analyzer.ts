import { homedir } from "node:os"
import { normalize, resolve } from "node:path"
import type {
  CapabilityActionClass,
  CapabilityAssessment,
  ParsedCommand,
  Provenanced,
  Redirection,
} from "../types.ts"
import { shellBasename, type ShellToken } from "../shell-lexer.ts"

/*
 * Bash capability analyzer.
 *
 * Walks a `ParsedCommand` and produces `CapabilityAssessment` facts — each one
 * `Provenanced<boolean | "unknown">` so the reviewer LLM and audit can weigh
 * claims by how reliably they were established. The analyzer never makes a
 * safety decision: it only describes what the action CAN do, what it APPEARS to
 * do, and how completely the command could be analyzed.
 *
 * Reuses the existing lexer's effective-command resolution (wrappers peeled,
 * command-string forms destructured) so privilege prefixes, absolute paths, and
 * `sh -c` bodies are handled consistently with the emergency brake.
 */

// --- executable families ----------------------------------------------------

const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "mksh",
  "fish",
  "python",
  "python2",
  "python3",
  "py",
  "node",
  "nodejs",
  "bun",
  "deno",
  "ruby",
  "rb",
  "perl",
  "php",
  "lua",
  "tclsh",
  "wish",
  "java",
  "javac",
  "dotnet",
  "Rscript",
  "julia",
  "awk",
  "gawk",
  "nawk",
])

const TEST_RUNNERS = new Set([
  "pytest",
  "py.test",
  "unittest",
  "jest",
  "vitest",
  "mocha",
  "ava",
  "karma",
  "jasmine",
  "cypress",
  "playwright",
  "nx",
  "rake",
  "rspec",
  "minitest",
  "go", // `go test`
  "cargo", // `cargo test`
  "gradle", // `gradle test`
  "mvn", // `mvn test`
  "make", // often runs a test target
  "cmake",
  "ctest",
  "tap",
  "tape",
  "nu",
])

const PACKAGE_MANAGERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun", // also an interpreter; dual-classified below
  "pip",
  "pip3",
  "pipx",
  "poetry",
  "uv",
  "conda",
  "mamba",
  "gem",
  "bundle",
  "cargo",
  "go", // `go get` / `go install`
  "composer",
  "mvn",
  "gradle",
  "apt",
  "apt-get",
  "apk",
  "dnf",
  "yum",
  "zypper",
  "pacman",
  "brew",
  "port",
  "nix",
  "flatpak",
  "snap",
  "choco",
  "scoop",
  "winget",
])

const PACKAGE_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(["install", "i", "add", "ci", "update", "upgrade", "run", "exec", "x"]),
  pnpm: new Set(["install", "add", "update", "upgrade", "exec", "run", "dlx"]),
  yarn: new Set(["add", "install", "upgrade", "remove", "run", "exec"]),
  bun: new Set(["add", "install", "update", "upgrade", "remove", "run", "x"]),
  pip: new Set(["install", "download"]),
  pip3: new Set(["install", "download"]),
  poetry: new Set(["install", "add", "update", "upgrade"]),
  uv: new Set(["pip install", "add", "sync"]),
  pipx: new Set(["install", "inject", "upgrade"]),
  conda: new Set(["install", "create", "update"]),
  gem: new Set(["install", "update"]),
  bundle: new Set(["install", "update"]),
  cargo: new Set(["install", "add", "update", "fetch"]),
  go: new Set(["get", "install", "mod download", "mod tidy"]),
  composer: new Set(["install", "update", "require"]),
  apt: new Set(["install", "upgrade", "update", "remove", "purge"]),
  "apt-get": new Set(["install", "upgrade", "update", "remove", "purge"]),
  apk: new Set(["add", "upgrade", "del"]),
  dnf: new Set(["install", "upgrade", "remove"]),
  yum: new Set(["install", "upgrade", "remove"]),
  pacman: new Set(["-S", "-Sy", "-Syu", "-R", "-Rs"]),
  brew: new Set(["install", "upgrade", "reinstall"]),
}

const NETWORK_CLIENTS = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ftp",
  "sftp",
  "scp",
  "rsync",
  "telnet",
  "dig",
  "nslookup",
  "host",
  "ping",
  "traceroute",
  "openssl",
  "httpie",
  "http",
  "aria2c",
  "axon",
])

const FILE_WRITE_TOOLS = new Set(["tee", "dd", "install", "truncate", "shred"])

const FILE_MUTATION_TOOLS = new Set(["cp", "mv", "rename", "ln", "link", "symlink", "rsync"])

/** Executables with no observable side effects on the local filesystem when
 *  invoked with plain arguments. An executable NOT in this set (and in none of
 *  the effect families above) is classified "unknown", not read-only: the
 *  analyzer's inability to detect effects is not evidence that none exist. */
const READ_ONLY_TOOLS = new Set([
  "cat",
  "less",
  "more",
  "ls",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "pwd",
  "echo",
  "printf",
  "date",
  "whoami",
  "id",
  "uname",
  "hostname",
  "who",
  "w",
  "uptime",
  "which",
  "type",
  "printenv",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "du",
  "df",
  "tree",
  "jq",
  "yq",
  "sort",
  "uniq",
  "cut",
  "column",
  "tr",
  "diff",
  "cmp",
  "comm",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "cksum",
  "base64",
  "xxd",
  "od",
  "strings",
  "nl",
  "tac",
  "rev",
  "fold",
  "fmt",
  "expand",
  "unexpand",
  "seq",
  "true",
  "false",
  "sleep",
  "clear",
  "test",
  "[",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "man",
  "info",
  "tput",
])

/** Shell builtins with no filesystem side effects of their own (directory and
 *  environment manipulation only). */
const NO_EFFECT_BUILTINS = new Set([
  "cd",
  "pushd",
  "popd",
  "dirs",
  "export",
  "unset",
  "set",
  "shopt",
  "alias",
  "unalias",
  "exit",
  "return",
  "shift",
  "wait",
  "jobs",
  "fg",
  "bg",
  "read",
  "local",
  "declare",
  "readonly",
  "getopts",
  "hash",
  "help",
  "let",
  "trap",
  "ulimit",
  "umask",
  "builtin",
  "command",
])

const DELETION_TOOLS = new Set(["rm", "rmdir", "unlink", "shred", "truncate"])

const GIT_MUTATION_SUBCOMMANDS = new Set([
  "push",
  "commit",
  "reset",
  "rebase",
  "merge",
  "cherry-pick",
  "revert",
  "rm",
  "clean",
  "stash",
  "checkout",
  "restore",
  "switch",
  "init",
  "gc",
  "prune",
  "am",
  "apply",
  "filter-branch",
])

const PRIVILEGE_WRAPPERS = new Set([
  "sudo",
  "doas",
  "pkexec",
  "su",
  "runuser",
  "super",
  "setpriv",
  "setcap",
  "capsh",
])

const SERVICE_MANAGERS = new Set([
  "systemctl",
  "service",
  "rc-service",
  "rc-update",
  "initctl",
  "launchctl",
  "supervisorctl",
  "pm2",
  "forever",
  "nodemon",
  "god",
  "circus",
])

const PERSISTENCE_WRAPPERS = new Set(["nohup", "setsid", "disown"])
const PERSISTENCE_TOOLS = new Set(["at", "atq", "atrm", "cron", "crontab"])

const SSH_TOOLS = new Set(["ssh", "mosh", "autossh"])

const SHELL_KEYWORDS = new Set(["{", "}", "(", ")", "then", "else", "do", "elif", "!"])

// --- helpers ----------------------------------------------------------------

/** Mutating forms of executables that are otherwise treated as read-only.
 *  "This executable usually only reads" must never become "this invocation
 *  only reads": find/sort/yq all have flags that delete, write, or execute. */
interface ReadOnlyToolMutation {
  deletion?: boolean
  executesCode?: boolean
  /** Paths written or (for -delete) destroyed, classified like any write. */
  writeTargets: string[]
}

/** Placeholder target when a mutating form names no operand: conservatively
 *  treated as a workspace write (the current directory). */
const directoryFallback = "."

function readOnlyToolMutation(cmd: ShellToken[], base: string): ReadOnlyToolMutation | undefined {
  if (base === "find") {
    // Leading non-flag operands are the search roots (what -delete destroys).
    let index = 1
    const roots: string[] = []
    while (
      index < cmd.length &&
      !cmd[index]!.value.startsWith("-") &&
      cmd[index]!.value !== "!" &&
      cmd[index]!.value !== "("
    ) {
      roots.push(cmd[index]!.value)
      index += 1
    }
    const result: ReadOnlyToolMutation = { writeTargets: [] }
    for (; index < cmd.length; index += 1) {
      const value = cmd[index]!.value
      if (value === "-delete") {
        result.deletion = true
        result.writeTargets.push(...roots)
      } else if (value.startsWith("-exec") || value.startsWith("-ok")) {
        // -exec / -execdir / -ok / -okdir run an arbitrary command per match.
        result.executesCode = true
      } else if (value === "-fls" || value.startsWith("-fprint")) {
        const target = cmd[index + 1]?.value
        if (target !== undefined && !target.startsWith("-")) result.writeTargets.push(target)
      }
    }
    return result.deletion || result.executesCode || result.writeTargets.length > 0
      ? result
      : undefined
  }
  if (base === "sort") {
    const result: ReadOnlyToolMutation = { writeTargets: [] }
    for (let index = 1; index < cmd.length; index += 1) {
      const value = cmd[index]!.value
      if (value === "-o" || value === "--output") {
        const target = cmd[index + 1]?.value
        if (target !== undefined && !target.startsWith("-")) result.writeTargets.push(target)
      } else if (value.startsWith("--output=")) {
        result.writeTargets.push(value.slice("--output=".length))
      }
    }
    return result.writeTargets.length > 0 ? result : undefined
  }
  if (base === "yq") {
    // In-place edit: the file operand(s) after the expression are rewritten.
    if (!cmd.some((token) => token.value === "-i" || token.value === "--inplace")) return undefined
    const targets = cmd
      .slice(1)
      .map((token) => token.value)
      .filter((value) => !value.startsWith("-"))
    return targets.length > 0 ? { writeTargets: targets } : { writeTargets: [directoryFallback] }
  }
  return undefined
}

/** Command substitution (`$(...)` or backticks) makes analysis opaque. */
function hasCommandSubstitution(command: string): boolean {
  return /\$\(|`/.test(command)
}

function staticFact(
  value: boolean | "unknown",
  notes?: string[],
): Provenanced<boolean | "unknown"> {
  return {
    value,
    source: "static-analysis",
    confidence: value === "unknown" ? "unknown" : "high",
    ...(notes === undefined || notes.length === 0 ? {} : { notes }),
  }
}

function heuristicFact(
  value: boolean | "unknown",
  notes?: string[],
): Provenanced<boolean | "unknown"> {
  return {
    value,
    source: "heuristic",
    confidence: value === "unknown" ? "unknown" : "medium",
    ...(notes === undefined || notes.length === 0 ? {} : { notes }),
  }
}

/** Inspect a command for an inline-code flag (`-c`, `--command`, `-e`). */
function hasInlineCodeOption(tokens: ShellToken[]): { interpreter: string; inline: boolean } {
  if (tokens.length === 0) return { interpreter: "", inline: false }
  const base = shellBasename(tokens[0]!.value)
  if (!INTERPRETERS.has(base)) return { interpreter: base, inline: false }
  for (let i = 1; i < tokens.length; i += 1) {
    const v = tokens[i]!.value
    if (v === "-c" || v === "--command" || v === "-e" || v.startsWith("--command=")) {
      return { interpreter: base, inline: true }
    }
  }
  return { interpreter: base, inline: false }
}

/** Whether any redirection in a segment writes to a file. */
function hasWriteRedirect(redirections: Redirection[]): boolean {
  return redirections.some((r) => r.operator === ">" || r.operator === ">>" || r.operator === "&>")
}

/** Classify a path target as temporary, workspace, or external. Relative
 *  targets (including `..` segments and `~/` homes) are resolved against the
 *  working directory first, and ABSOLUTE targets are lexically normalized, so
 *  neither `../../outside` nor `/worktree/../etc` can masquerade as a
 *  workspace path through a prefix it only appears to have. Lexical
 *  normalization cannot resolve symlinked directory components — the class
 *  always describes the stated path, not a filesystem-verified destination. */
function classifyPath(
  target: string,
  directory: string,
  worktree: string,
): { temporary: boolean; workspace: boolean; external: boolean } {
  if (!target || target.startsWith("&"))
    return { temporary: false, workspace: false, external: false }
  let temp = false
  let external = false
  let workspace = false
  let absolute: string
  if (target === "~" || target.startsWith("~/")) {
    absolute = resolve(homedir(), target.slice(target === "~" ? 1 : 2))
  } else if (!target.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(target)) {
    absolute = resolve(directory, target)
  } else {
    absolute = normalize(target)
  }
  if (
    absolute.startsWith("/tmp/") ||
    absolute.startsWith("/var/tmp/") ||
    absolute.startsWith("/dev/shm/") ||
    absolute === "/dev/null"
  ) {
    temp = true
  } else if (absolute.startsWith("/") || /^[A-Za-z]:[\\/]/.test(absolute)) {
    // Absolute path outside the known temp roots.
    if (absolute === directory || absolute === worktree || absolute.startsWith(`${worktree}/`)) {
      workspace = true
    } else if (absolute.startsWith(`${directory}/`) || absolute === directory) {
      workspace = true
    } else {
      external = true
    }
  } else {
    // A path that still has no absolute form cannot be classified.
    workspace = false
  }
  return { temporary: temp, workspace, external }
}

function destinationFromTokens(tokens: ShellToken[]): string[] {
  const out: string[] = []
  for (let i = 1; i < tokens.length; i += 1) {
    const v = tokens[i]!.value
    if (/^[a-z][a-z0-9+.-]*:\/\/[^\s]+/.test(v)) out.push(v)
    else if (/^[a-z0-9.-]+\.[a-z]{2,}(:[0-9]+)?(\/[^\s]*)?$/i.test(v)) out.push(v)
  }
  return out
}

/** Resolve a git subcommand from the token stream, skipping global git flags
 *  (`-C <path>`, `-c <cfg>`, `--git-dir`, …) so `git -C /repo push` still
 *  detects the `push` mutation. Mirrors the flag-aware resolution used by the
 *  git evidence enrichment. */
function gitSubcommandOf(cmd: ShellToken[]): { sub?: string } {
  let index = 1
  while (index < cmd.length) {
    const value = cmd[index]!.value
    if (
      value === "-C" ||
      value === "-c" ||
      value === "--git-dir" ||
      value === "--work-tree" ||
      value === "--namespace" ||
      value === "--exec-path" ||
      value === "--super-prefix"
    ) {
      index += 2
      continue
    }
    if (value.startsWith("-") && value.length > 1) {
      index += 1
      continue
    }
    return { sub: value }
  }
  return {}
}

// --- analyzer ---------------------------------------------------------------

/** Analyze a parsed bash command and produce capability facts. */
export function analyzeCapability(
  parsed: ParsedCommand,
  directory: string,
  worktree: string,
): CapabilityAssessment {
  const warnings: string[] = []
  let executesCode = false
  let executesRepositoryCode = false
  let createsAdHocCode = false
  let invokesTestRunner = false
  let invokesPackageLifecycle = false
  let temporaryWrite = false
  let workspaceWrite = false
  let externalWrite = false
  let deletion = false
  let networkObserved = false
  let childProcesses = false
  let persistence = false
  let privilegeEscalation = false
  let remoteEnabled = false
  let remoteMutation = false
  let gitObserved = false
  let gitMutation = false
  let sawReadOnlyExecutable = false
  let sawUnknownExecutable = false
  const destinations: string[] = []
  let dominantClass: CapabilityActionClass = "unknown"
  let classConfidence: "high" | "medium" | "low" = "low"

  const heredocOutputs = new Set(
    parsed.heredocs.map((h) => h.outputTarget).filter(Boolean) as string[],
  )

  // Wrappers the lexer peels (sudo, nohup, ssh, …) must be detected on the
  // original segment heads, because `effective` starts at the real executable
  // after peeling. We walk segments skipping shell keywords and VAR=value
  // assignments exactly like the lexer does.
  for (const segment of parsed.segments) {
    let k = 0
    while (k < segment.tokens.length && SHELL_KEYWORDS.has(segment.tokens[k]!.value)) k += 1
    while (k < segment.tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment.tokens[k]!.value)) {
      k += 1
    }
    if (k < segment.tokens.length) {
      const head = shellBasename(segment.tokens[k]!.value)
      if (PRIVILEGE_WRAPPERS.has(head)) {
        privilegeEscalation = true
        childProcesses = true
      }
      if (PERSISTENCE_WRAPPERS.has(head)) {
        persistence = true
        childProcesses = true
      }
      if (SSH_TOOLS.has(head)) {
        remoteEnabled = true
        childProcesses = true
        // A remote command that mutates is a remote-mutation hint. The remote
        // command may be a single quoted token (`ssh host 'rm -rf /'`), so split
        // each tail token on whitespace before searching for mutation signals.
        const tail = segment.tokens.slice(k + 1).flatMap((t) => t.value.split(/\s+/))
        if (tail.some((v) => GIT_MUTATION_SUBCOMMANDS.has(v) || v === "rm")) {
          remoteMutation = true
        }
        if (dominantClass === "unknown") {
          dominantClass = "remote-operation"
          classConfidence = "high"
        }
      }
    }
  }

  for (const cmd of parsed.effective) {
    if (cmd.length === 0) continue
    const base = shellBasename(cmd[0]!.value)
    // A "usually read-only" executable in a mutating form (find -delete,
    // sort -o, yq -i) is a mutation: surface its effects here and disqualify
    // the read-only classification below.
    const roMutation = readOnlyToolMutation(cmd, base)
    if (roMutation !== undefined) {
      if (roMutation.deletion === true) deletion = true
      if (roMutation.executesCode === true) {
        executesCode = true
        childProcesses = true
      }
      for (const target of roMutation.writeTargets) {
        const cls = classifyPath(target, directory, worktree)
        if (cls.temporary) temporaryWrite = true
        if (cls.workspace) workspaceWrite = true
        if (cls.external) externalWrite = true
      }
    }
    // Track whether the executable itself is a known no-effect tool. Commands
    // that match one of the effect families below override this in class
    // resolution; for everything else, an unrecognized executable keeps the
    // class "unknown" instead of defaulting to read-only.
    if (
      (READ_ONLY_TOOLS.has(base) || NO_EFFECT_BUILTINS.has(base)) &&
      roMutation === undefined &&
      !INTERPRETERS.has(base) &&
      !PACKAGE_MANAGERS.has(base) &&
      !NETWORK_CLIENTS.has(base) &&
      !FILE_WRITE_TOOLS.has(base) &&
      !FILE_MUTATION_TOOLS.has(base) &&
      !DELETION_TOOLS.has(base) &&
      !SERVICE_MANAGERS.has(base) &&
      !PERSISTENCE_TOOLS.has(base) &&
      !PRIVILEGE_WRAPPERS.has(base)
    ) {
      sawReadOnlyExecutable = true
    } else if (
      base !== "git" &&
      !INTERPRETERS.has(base) &&
      !TEST_RUNNERS.has(base) &&
      !PACKAGE_MANAGERS.has(base) &&
      !NETWORK_CLIENTS.has(base) &&
      !SSH_TOOLS.has(base) &&
      !FILE_WRITE_TOOLS.has(base) &&
      !FILE_MUTATION_TOOLS.has(base) &&
      !DELETION_TOOLS.has(base) &&
      !SERVICE_MANAGERS.has(base) &&
      !PERSISTENCE_TOOLS.has(base) &&
      !PERSISTENCE_WRAPPERS.has(base) &&
      !PRIVILEGE_WRAPPERS.has(base)
    ) {
      sawUnknownExecutable = true
    }

    // Executable detection.
    if (INTERPRETERS.has(base)) {
      executesCode = true
      if (base === "bun" || base === "node" || base === "python" || base === "python3") {
        childProcesses = true
      }
      const { inline } = hasInlineCodeOption(cmd)
      if (inline) createsAdHocCode = true
      // If the interpreter targets a generated/heredoc file, it's ad-hoc code.
      for (let i = 1; i < cmd.length; i += 1) {
        const arg = cmd[i]!.value
        if (heredocOutputs.has(arg)) createsAdHocCode = true
        if (arg.startsWith(directory) || arg.startsWith(worktree)) executesRepositoryCode = true
      }
    }
    if (TEST_RUNNERS.has(base)) {
      invokesTestRunner = true
      executesCode = true
      executesRepositoryCode = true
      childProcesses = true
    }
    // `<runtime> test` / `<runtime> t` (bun, npm, pnpm, yarn, deno, …). Test
    // invocations always execute code: the runner and the suite itself are
    // executable repository content, so `executesCode` must be true, not
    // unknown (a `read-only` class for `npm test` understates the effect).
    if (INTERPRETERS.has(base) || PACKAGE_MANAGERS.has(base)) {
      const sub = cmd[1]?.value
      if (sub === "test" || sub === "t" || sub === "check" || sub === "verify") {
        invokesTestRunner = true
        executesCode = true
        executesRepositoryCode = true
        childProcesses = true
      }
    }
    if (PACKAGE_MANAGERS.has(base)) {
      const sub = cmd[1]?.value
      const subs = PACKAGE_SUBCOMMANDS[base]
      if (subs === undefined || sub === undefined || subs.has(sub)) {
        invokesPackageLifecycle = true
        childProcesses = true
        networkObserved = true
      }
    }
    if (NETWORK_CLIENTS.has(base)) {
      networkObserved = true
      destinations.push(...destinationFromTokens(cmd))
      dominantClass = "network"
      classConfidence = "high"
    }
    if (SSH_TOOLS.has(base)) {
      remoteEnabled = true
      childProcesses = true
      // ssh with a remote command that mutates → remote mutation hint.
      if (cmd.some((t) => GIT_MUTATION_SUBCOMMANDS.has(t.value) || t.value === "rm")) {
        remoteMutation = true
      }
      dominantClass = "remote-operation"
      classConfidence = "high"
    }
    if (FILE_WRITE_TOOLS.has(base)) {
      for (const r of extractRedirectsFor(cmd)) {
        const cls = classifyPath(r.target, directory, worktree)
        if (cls.temporary) temporaryWrite = true
        if (cls.workspace) workspaceWrite = true
        if (cls.external) externalWrite = true
      }
      // tee/dd also write via arguments.
      for (let i = 1; i < cmd.length; i += 1) {
        const cls = classifyPath(cmd[i]!.value, directory, worktree)
        if (cls.temporary) temporaryWrite = true
        if (cls.workspace) workspaceWrite = true
        if (cls.external) externalWrite = true
      }
    }
    if (FILE_MUTATION_TOOLS.has(base)) {
      // cp/mv/ln/rsync move or link content: classify every operand so an
      // external destination (`mv file /etc/config`) is reported as an
      // external write instead of a blanket workspace write.
      let anyOperand = false
      for (let i = 1; i < cmd.length; i += 1) {
        const v = cmd[i]!.value
        if (v.startsWith("-")) continue
        if (/^[a-z][a-z0-9+.-]*:\/\//.test(v)) continue
        anyOperand = true
        const cls = classifyPath(v, directory, worktree)
        if (cls.temporary) temporaryWrite = true
        if (cls.workspace) workspaceWrite = true
        if (cls.external) externalWrite = true
      }
      if (!anyOperand) workspaceWrite = true
    }
    if (DELETION_TOOLS.has(base)) {
      deletion = true
      let anyTarget = false
      for (let i = 1; i < cmd.length; i += 1) {
        const v = cmd[i]!.value
        if (v.startsWith("-")) continue
        anyTarget = true
        const cls = classifyPath(v, directory, worktree)
        if (cls.temporary) temporaryWrite = true
        if (cls.workspace) workspaceWrite = true
        if (cls.external) externalWrite = true
      }
      if (!anyTarget) workspaceWrite = true
    }
    if (base === "git") {
      gitObserved = true
      const { sub } = gitSubcommandOf(cmd)
      if (sub !== undefined && GIT_MUTATION_SUBCOMMANDS.has(sub)) {
        gitMutation = true
        if (sub === "push") externalWrite = true
        if (sub === "commit" || sub === "reset" || sub === "merge" || sub === "rebase") {
          workspaceWrite = true
        }
      }
    }
    if (PRIVILEGE_WRAPPERS.has(base)) {
      // Privilege wrappers were already detected on the segment head above;
      // the lexer peels them so `effective` starts at the real executable.
    }
    if (SERVICE_MANAGERS.has(base)) {
      persistence = true
      childProcesses = true
      privilegeEscalation = true
      if (dominantClass === "unknown") {
        dominantClass = "service-management"
        classConfidence = "high"
      }
    }
    if (PERSISTENCE_TOOLS.has(base)) {
      persistence = true
      childProcesses = true
    }
    // Background operator `&` is already a segment separator; `disown`/`nohup`
    // are handled above. A trailing `&` inside one logical command is rare with
    // our lexer but `setsid`/`nohup` cover the common persistence cases.
  }

  // Redirections across all commands.
  for (const segRedirects of parsed.redirections) {
    if (hasWriteRedirect(segRedirects)) {
      for (const r of segRedirects) {
        if (r.operator !== ">" && r.operator !== ">>" && r.operator !== "&>") continue
        const cls = classifyPath(r.target, directory, worktree)
        if (cls.temporary) temporaryWrite = true
        if (cls.workspace) workspaceWrite = true
        if (cls.external) externalWrite = true
      }
    }
  }

  // Heredoc that writes to a file is a write effect.
  for (const h of parsed.heredocs) {
    if (h.outputTarget !== undefined) {
      const cls = classifyPath(h.outputTarget, directory, worktree)
      if (cls.temporary) temporaryWrite = true
      if (cls.workspace) workspaceWrite = true
      if (cls.external) externalWrite = true
    }
  }

  // Action class resolution: prefer the most specific observed surface.
  if (dominantClass === "unknown") {
    if (deletion) {
      dominantClass = "destruction"
      classConfidence = "high"
    } else if (gitMutation) {
      dominantClass = "git-mutation"
      classConfidence = "high"
    } else if (externalWrite) {
      dominantClass = "external-write"
      classConfidence = "high"
    } else if (createsAdHocCode || executesCode) {
      dominantClass = "code-execution"
      classConfidence = createsAdHocCode ? "high" : "medium"
    } else if (invokesPackageLifecycle) {
      dominantClass = "package-management"
      classConfidence = "high"
    } else if (persistence) {
      dominantClass = "persistence"
      classConfidence = "high"
    } else if (privilegeEscalation) {
      dominantClass = "privilege-escalation"
      classConfidence = "high"
    } else if (temporaryWrite) {
      dominantClass = "temporary-write"
      classConfidence = "high"
    } else if (workspaceWrite) {
      dominantClass = "workspace-write"
      classConfidence = "medium"
    } else if (sawUnknownExecutable) {
      // An unrecognized executable is present: report unknown rather than
      // read-only. Absence of detected effects is not evidence of absence.
      dominantClass = "unknown"
      classConfidence = "low"
    } else if (sawReadOnlyExecutable || (gitObserved && !gitMutation)) {
      dominantClass = "read-only"
      classConfidence = "medium"
    } else {
      dominantClass = "unknown"
      classConfidence = "low"
    }
  }

  if (parsed.hasDynamicConstructs) {
    warnings.push("command contains dynamic constructs (variables, substitution, or globs)")
  }
  if (parsed.heredocs.length > 0 && parsed.heredocs.some((h) => h.dynamic)) {
    warnings.push("one or more heredoc bodies have unresolvable expansion")
  }

  const parserCompleteness = parsed.hasDynamicConstructs
    ? hasCommandSubstitution(parsed.sanitizedCommand) || parsed.heredocs.some((h) => h.dynamic)
      ? "opaque"
      : "partial"
    : "complete-for-supported-form"

  const summaryParts: string[] = [dominantClass]
  if (createsAdHocCode) summaryParts.push("ad-hoc code")
  if (executesRepositoryCode) summaryParts.push("repository code")
  if (invokesPackageLifecycle) summaryParts.push("package lifecycle scripts")
  if (gitMutation) summaryParts.push("git mutation")
  if (networkObserved) summaryParts.push("network")
  if (persistence) summaryParts.push("persistence")
  if (privilegeEscalation) summaryParts.push("privilege escalation")

  return {
    actionClass: {
      value: dominantClass,
      source: "static-analysis",
      confidence: classConfidence,
    },
    summary: summaryParts.join(", "),
    executesCode: staticFact(executesCode ? true : "unknown"),
    executesRepositoryCode: staticFact(executesRepositoryCode ? true : "unknown"),
    createsAdHocCode: staticFact(createsAdHocCode ? true : "unknown"),
    invokesExistingTestRunner: staticFact(invokesTestRunner ? true : "unknown"),
    invokesPackageLifecycleScripts: staticFact(invokesPackageLifecycle ? true : "unknown"),
    writeEffects: {
      temporaryWrite: staticFact(temporaryWrite ? true : "unknown"),
      workspaceWrite: staticFact(workspaceWrite ? true : "unknown"),
      externalWrite: staticFact(externalWrite ? true : "unknown"),
      deletion: staticFact(deletion ? true : "unknown"),
    },
    network: {
      observed: staticFact(networkObserved ? true : "unknown"),
      possible: heuristicFact(networkObserved ? true : "unknown"),
      destinations,
      observedAccess: staticFact(networkObserved ? true : "unknown"),
      possibleAccess: heuristicFact("unknown"),
    },
    process: {
      childProcesses: staticFact(childProcesses ? true : "unknown"),
      persistence: staticFact(persistence ? true : "unknown"),
      privilegeEscalation: staticFact(privilegeEscalation ? true : "unknown"),
    },
    remote: {
      enabled: staticFact(remoteEnabled ? true : "unknown"),
      mutationHint: staticFact(remoteMutation ? true : "unknown"),
    },
    git: {
      observed: staticFact(gitObserved ? true : "unknown"),
      possible: heuristicFact(gitMutation ? true : "unknown"),
      observedAccess: staticFact(gitObserved ? true : "unknown"),
      possibleAccess: heuristicFact("unknown"),
    },
    parserCompleteness,
    analysisWarnings: warnings,
  }
}

/** Recover the redirections attached to a specific effective command. */
function extractRedirectsFor(cmd: ShellToken[]): Redirection[] {
  // Recompute from the token list directly (the parser stores redirections per
  // effective-command index, which we avoid coupling to here).
  const out: Redirection[] = []
  for (let i = 0; i < cmd.length; i += 1) {
    const tok = cmd[i]!
    const value = tok.value
    const combined = /^([0-9]?>>?)\s*(.+)$/.exec(value)
    if (combined) {
      out.push({ operator: combined[1]!, target: combined[2]!, quoted: false })
      continue
    }
    if (value.startsWith(">") || value.startsWith("<")) {
      const op = value.startsWith(">>") ? ">>" : value[0]!
      out.push({ operator: op, target: value.slice(op === ">>" ? 2 : 1), quoted: false })
    }
  }
  return out
}
