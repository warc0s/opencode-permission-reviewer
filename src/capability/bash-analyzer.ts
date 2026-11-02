import { homedir } from "node:os"
import { normalize, resolve, sep } from "node:path"
import type {
  CapabilityActionClass,
  CapabilityAssessment,
  ParsedCommand,
  Provenanced,
  Redirection,
} from "../types.ts"
import { shellBasename, type ShellToken } from "../shell-lexer.ts"
import { isSensitivePathToken } from "./sensitive-paths.ts"

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
  "tsx",
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

/** Options of the mutation tools that consume a separate value token, so the
 *  value is never mistaken for a source or destination operand. The lists
 *  cover structural options (destination and suffix selection). Options
 *  with optional values require an attached value and must not consume the
 *  following operand. */
const MUTATION_VALUE_OPTIONS: Record<string, Set<string>> = {
  cp: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  mv: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  ln: new Set(["-t", "--target-directory", "-S", "--suffix"]),
  rsync: new Set([
    "--backup-dir",
    "-e",
    "--rsh",
    "--rsync-path",
    "--exclude-from",
    "--include-from",
    "--files-from",
    "--suffix",
    "--password-file",
    "--log-file",
    "--out-format",
  ]),
}

/** A remote operand for rsync-style tools: a URL scheme, or an `host:path`
 *  / `user@host:path` shape whose part before the colon is a bare host (no
 *  slash), which is exactly how rsync decides local-with-colon vs remote. */
function isRemoteMutationOperand(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) return true
  const colon = value.indexOf(":")
  return colon > 0 && !value.slice(0, colon).includes("/")
}

/** Split a cp/mv/ln/rsync invocation into read sources and write
 *  destinations. The last positional operand is the destination (cp/mv/rsync
 *  destination, ln link name); `--target-directory`/`-t` names an additional
 *  destination directory everything lands under. Paths after `--` are
 *  operands like any other. */
function mutationOperands(
  base: string,
  cmd: ReadonlyArray<{ value: string }>,
): { sources: string[]; destinations: string[]; sawOperand: boolean } {
  const valueOpts = MUTATION_VALUE_OPTIONS[base] ?? new Set<string>()
  const operands: string[] = []
  let targetDirectory: string | undefined
  let endOfOptions = false
  for (let i = 1; i < cmd.length; i += 1) {
    const v = cmd[i]!.value
    if (!endOfOptions && v === "--") {
      endOfOptions = true
      continue
    }
    if (!endOfOptions && v.startsWith("--")) {
      if (valueOpts.has(v)) {
        if (v === "--target-directory") targetDirectory = cmd[i + 1]?.value
        i += 1
      } else if (valueOpts.has("--target-directory") && v.startsWith("--target-directory=")) {
        targetDirectory = v.slice("--target-directory=".length)
      }
      continue
    }
    if (!endOfOptions && v.startsWith("-") && v.length > 1) {
      for (let position = 1; position < v.length; position += 1) {
        const option = `-${v[position]!}`
        if (!valueOpts.has(option)) continue
        const attached = v.slice(position + 1)
        const value = attached || cmd[++i]?.value
        if (option === "-t") targetDirectory = value
        break
      }
      continue
    }
    operands.push(v)
  }
  if (targetDirectory !== undefined) {
    // `-t DIR` redirects every SOURCE argument into DIR: with it, no operand
    // is itself a destination.
    return { sources: operands, destinations: [targetDirectory], sawOperand: operands.length > 0 }
  }
  if (base === "rename") {
    // rename rewrites each named file, rather than copying to the last
    // operand. Keep every operand as a possible mutation across dialects.
    return { sources: [], destinations: operands, sawOperand: operands.length > 0 }
  }
  if (base === "ln" && operands.length === 1) {
    return { sources: operands, destinations: ["."], sawOperand: true }
  }
  const destinations: string[] = []
  if (operands.length > 0) destinations.push(operands[operands.length - 1]!)
  const sources = operands.length > 1 ? operands.slice(0, -1) : []
  return { sources, destinations, sawOperand: operands.length > 0 }
}

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
  "add",
  "am",
  "apply",
  "bisect",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "config",
  "fetch",
  "filter-branch",
  "gc",
  "init",
  "maintenance",
  "merge",
  "mv",
  "notes",
  "prune",
  "pull",
  "push",
  "rebase",
  "remote",
  "repack",
  "replace",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "submodule",
  "switch",
  "symbolic-ref",
  "tag",
  "update-ref",
  "worktree",
])

const GIT_NETWORK_SUBCOMMANDS = new Set(["clone", "fetch", "ls-remote", "pull", "push"])

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

const CREDENTIAL_READERS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "rg",
  "sed",
  "awk",
  "base64",
  "xxd",
  "od",
  "strings",
  "source",
  ".",
])

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
    // GNU find accepts traversal options before its search roots. In
    // particular, `-D` consumes a separate diagnostics value; treating that
    // value as the root would hide a later `/ -delete`.
    let index = 1
    while (index < cmd.length) {
      const value = cmd[index]!.value
      if (value === "--") {
        index += 1
        break
      }
      if (value === "-D") {
        index += 2
        continue
      }
      if (value === "-H" || value === "-L" || value === "-P" || /^-O\d+$/.test(value)) {
        index += 1
        continue
      }
      break
    }
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
  if (base === "sort") return sortMutation(cmd)
  if (base === "uniq") return outputOperandMutation(cmd, UNIQ_OPTIONS)
  if (base === "xxd") return outputOperandMutation(cmd, XXD_OPTIONS)
  if (base === "tree") return treeMutation(cmd)
  if (base === "yq") {
    // In-place edit: the file operand(s) after the expression are rewritten.
    if (!yqInPlace(cmd)) return undefined
    const targets = cmd
      .slice(1)
      .map((token) => token.value)
      .filter((value) => !value.startsWith("-"))
    return targets.length > 0 ? { writeTargets: targets } : { writeTargets: [directoryFallback] }
  }
  return undefined
}

/** A getopt_long option word: `--name` or `--name=value`, where `name` may be
 *  any unambiguous prefix of the full option name (`minimum` characters long,
 *  `--` included, so shorter prefixes that collide with another option of the
 *  same tool never match). */
function longOption(value: string, name: string, minimum: number): { inline?: string } | undefined {
  if (!value.startsWith("--")) return undefined
  const equals = value.indexOf("=")
  const word = equals === -1 ? value : value.slice(0, equals)
  if (word.length < minimum || !name.startsWith(word)) return undefined
  return equals === -1 ? {} : { inline: value.slice(equals + 1) }
}

/** GNU sort: `-o FILE` writes FILE and `--compress-program=PROG` runs PROG.
 *  Short options cluster getopt-style (`-uo FILE`, `-nruoFILE`): a letter that
 *  takes a value consumes the rest of the cluster, or the next word. */
function sortMutation(cmd: ShellToken[]): ReadOnlyToolMutation | undefined {
  const result: ReadOnlyToolMutation = { writeTargets: [] }
  for (let index = 1; index < cmd.length; index += 1) {
    const value = cmd[index]!.value
    if (value === "--") break
    if (value.startsWith("--")) {
      // "--o" is the shortest unambiguous prefix of --output, "--co" of
      // --compress-program (--check also starts with "c").
      const output = longOption(value, "--output", 3)
      if (output !== undefined) {
        const target = output.inline ?? cmd[index + 1]?.value
        if (output.inline === undefined) index += 1
        if (target !== undefined) result.writeTargets.push(target)
        continue
      }
      if (longOption(value, "--compress-program", 4) !== undefined) result.executesCode = true
      continue
    }
    if (!value.startsWith("-") || value === "-") continue
    for (let at = 1; at < value.length; at += 1) {
      const letter = value[at]!
      if (letter === "o" || "kStT".includes(letter)) {
        const attached = value.slice(at + 1)
        const argument = attached !== "" ? attached : cmd[index + 1]?.value
        if (attached === "") index += 1
        if (letter === "o" && argument !== undefined) result.writeTargets.push(argument)
        break
      }
    }
  }
  return result.writeTargets.length > 0 || result.executesCode === true ? result : undefined
}

/** How a `TOOL [OPTION]... [INPUT [OUTPUT]]` command spells its options. */
interface OperandToolOptions {
  /** Whether an option word takes the next word as its value. */
  valued(value: string): boolean
  /** getopt_long tools accept options after operands; xxd stops at the first. */
  permute: boolean
}

const UNIQ_OPTIONS: OperandToolOptions = {
  valued(value) {
    if (value.startsWith("--")) {
      // Long options with a separate value, by their shortest unambiguous
      // prefixes; an inline `=value` consumes nothing more.
      return (
        !value.includes("=") &&
        (longOption(value, "--skip-fields", 8) !== undefined ||
          longOption(value, "--skip-chars", 8) !== undefined ||
          longOption(value, "--check-chars", 4) !== undefined)
      )
    }
    // `-f N`, `-s N`, `-w N`: the letter ends the cluster, its value attached
    // or in the next word.
    for (let at = 1; at < value.length; at += 1) {
      if ("fsw".includes(value[at]!)) return at + 1 === value.length
    }
    return false
  },
  permute: true,
}

const XXD_OPTIONS: OperandToolOptions = {
  // xxd spells options as words with one or two dashes (`-cols 8`, `--cols 8`)
  // and also accepts attached values (`-c8`).
  valued(value) {
    const word = value.startsWith("--") ? value.slice(1) : value
    if (!"cglosnR".includes(word[1] ?? "")) return false
    return word.length === 2 || /^-[a-zA-Z]+$/.test(word)
  },
  permute: false,
}

/** `TOOL [OPTION]... [INPUT [OUTPUT]]` (uniq, xxd): a second operand is a file
 *  the command writes ("-" is standard output). */
function outputOperandMutation(
  cmd: ShellToken[],
  tool: OperandToolOptions,
): ReadOnlyToolMutation | undefined {
  const operands: string[] = []
  let options = true
  for (let index = 1; index < cmd.length; index += 1) {
    const value = cmd[index]!.value
    if (options && value === "--") {
      options = false
      continue
    }
    if (options && value.startsWith("-") && value !== "-") {
      if (tool.valued(value)) index += 1
      continue
    }
    operands.push(value)
    if (!tool.permute) options = false
  }
  const output = operands[1]
  return output !== undefined && output !== "-" ? { writeTargets: [output] } : undefined
}

/** tree: `-o FILE` writes FILE, and `-R` writes an `00Tree.html` listing into
 *  each directory it visits. Letters in a cluster that take a value consume the
 *  following words in order (`-Lo 2 out.txt`). */
function treeMutation(cmd: ShellToken[]): ReadOnlyToolMutation | undefined {
  const result: ReadOnlyToolMutation = { writeTargets: [] }
  const roots: string[] = []
  let recursiveOutput = false
  for (let index = 1; index < cmd.length; index += 1) {
    const value = cmd[index]!.value
    if (value === "--") {
      roots.push(...cmd.slice(index + 1).map((token) => token.value))
      break
    }
    if (value.startsWith("--")) {
      // tree's long options that take a separate value.
      if (
        !value.includes("=") &&
        /^--(?:charset|filelimit|timefmt|sort|hintro|houtro|infile|gitfile)$/.test(value)
      )
        index += 1
      continue
    }
    if (!value.startsWith("-") || value === "-") {
      roots.push(value)
      continue
    }
    let consumed = 0
    for (const letter of value.slice(1)) {
      if (letter === "R") recursiveOutput = true
      if ("LPIHTo".includes(letter)) {
        consumed += 1
        const argument = cmd[index + consumed]?.value
        if (letter === "o" && argument !== undefined) result.writeTargets.push(argument)
      }
    }
    index += consumed
  }
  if (recursiveOutput) result.writeTargets.push(...(roots.length > 0 ? roots : [directoryFallback]))
  return result.writeTargets.length > 0 ? result : undefined
}

/** yq (pflag): `-i`/`--inplace`, also inside a boolean cluster (`-iP`). A
 *  letter that takes a value ends the cluster (`-oi` is output format "i"). */
function yqInPlace(cmd: ShellToken[]): boolean {
  for (const token of cmd.slice(1)) {
    const value = token.value
    if (value === "--") return false
    if (value.startsWith("--")) {
      // pflag takes no abbreviations; a boolean may carry `=true`/`=false`.
      if (value === "--inplace" || (value.startsWith("--inplace=") && value !== "--inplace=false"))
        return true
      continue
    }
    if (!value.startsWith("-")) continue
    for (const letter of value.slice(1)) {
      if (letter === "i") return true
      if ("poIsf".includes(letter)) break
    }
  }
  return false
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
  return redirections.some(redirectionWritesPath)
}

function redirectionWritesPath(redirection: Redirection): boolean {
  const operator = redirection.operator.replace(/^\d+/, "")
  if ([">", ">>", ">|", "&>", "&>>", "<>"].includes(operator)) return true
  // Without an explicit IO number, `>&file` is the historical spelling of
  // redirecting stdout and stderr to a file. `2>&1` only duplicates an FD.
  return (
    operator === ">&" &&
    !/^\d/.test(redirection.operator) &&
    redirection.target !== "-" &&
    !/^\d+$/.test(redirection.target)
  )
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
  let absolute: string
  if (target === "~" || target.startsWith("~/")) {
    absolute = resolve(homedir(), target.slice(target === "~" ? 1 : 2))
  } else if (!target.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(target)) {
    absolute = resolve(directory, target)
  } else {
    absolute = normalize(target)
  }
  const absolutePath = absolute.startsWith("/") || /^[A-Za-z]:[\\/]/.test(absolute)
  const within = (root: string) => {
    const normalizedRoot = normalize(root)
    return absolute === normalizedRoot || absolute.startsWith(`${normalizedRoot}${sep}`)
  }
  if (!absolutePath) {
    // A path that still has no absolute form cannot be classified.
    return { temporary: temp, workspace: false, external }
  }
  const workspace = within(directory) || within(worktree)
  temp =
    absolute === "/tmp" ||
    absolute.startsWith("/tmp/") ||
    absolute === "/var/tmp" ||
    absolute.startsWith("/var/tmp/") ||
    absolute === "/dev/shm" ||
    absolute.startsWith("/dev/shm/") ||
    absolute === "/dev/null"
  external = !workspace && !temp
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
function gitSubcommandOf(cmd: ShellToken[]): { sub?: string; index?: number } {
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
    return { sub: value, index }
  }
  return {}
}

/** Distinguish the common read-only forms of Git subcommands that also have
 * mutation modes. Everything else in the mutation set stays conservative. */
function gitSubcommandMutates(cmd: ShellToken[], sub: string, index: number): boolean {
  if (!GIT_MUTATION_SUBCOMMANDS.has(sub)) return false
  const args = cmd.slice(index + 1).map((token) => token.value)
  const positional = args.filter((value) => value !== "--" && !value.startsWith("-"))
  if (sub === "branch") {
    if (args.length === 0) return false
    if (
      args.some((value) =>
        [
          "-a",
          "--all",
          "-r",
          "--remotes",
          "-l",
          "--list",
          "-v",
          "-vv",
          "--show-current",
          "--contains",
          "--no-contains",
          "--merged",
          "--no-merged",
          "--points-at",
          "--format",
          "--sort",
          "--column",
        ].includes(value),
      )
    )
      return false
  }
  if (sub === "tag") {
    if (args.length === 0) return false
    if (
      args.some((value) =>
        [
          "-l",
          "--list",
          "--contains",
          "--no-contains",
          "--merged",
          "--no-merged",
          "--points-at",
          "--format",
          "--sort",
          "--column",
        ].includes(value),
      )
    )
      return false
  }
  if (sub === "remote") {
    return positional.length > 0 && !["show", "get-url"].includes(positional[0]!)
  }
  if (sub === "config") {
    if (
      args.some((value) =>
        [
          "--list",
          "-l",
          "--get",
          "--get-all",
          "--get-regexp",
          "--get-urlmatch",
          "--show-origin",
          "--show-scope",
          "get",
          "get-all",
          "get-regexp",
          "get-urlmatch",
          "list",
        ].includes(value),
      )
    )
      return false
    return (
      positional.length >= 2 || args.some((value) => /(?:add|set|unset|remove|rename)/.test(value))
    )
  }
  if (sub === "worktree" && (positional.length === 0 || positional[0] === "list")) return false
  if (sub === "notes" && (positional.length === 0 || ["list", "show"].includes(positional[0]!)))
    return false
  if (
    sub === "submodule" &&
    (positional.length === 0 || ["status", "summary"].includes(positional[0]!))
  )
    return false
  if (sub === "symbolic-ref") {
    return args.includes("--delete") || positional.length >= 2
  }
  return true
}

/** Whether a token value is a static literal path candidate. Dynamic values
 *  (variables, command substitution, globs) never count as credential reads:
 *  the analyzer cannot resolve what they point at. */
function isLiteralPathValue(value: string): boolean {
  if (!value) return false
  if (/[$`*?[\]{}]/.test(value)) return false
  return true
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
  let networkPossible = false
  let childProcesses = false
  let persistence = false
  let privilegeEscalation = false
  let remoteEnabled = false
  let remoteMutation = false
  let gitObserved = false
  let gitMutation = false
  let credentialRead = false
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
      if (["bun", "node", "python", "python3", "deno", "tsx"].includes(base)) {
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
        networkPossible = true
        if (["run", "exec"].includes(sub ?? "")) {
          executesCode = true
          if (sub === "run") executesRepositoryCode = true
        }
        // A local manifest script or installed executable can use the network,
        // but its invocation is not evidence of an actual network operation.
        if (!["run", "exec"].includes(sub ?? "")) networkObserved = true
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
      // dd names its output as `of=PATH`; treating the whole assignment as a
      // relative path hides absolute destinations. Other members name output
      // files as ordinary operands.
      const outputOperands =
        base === "dd"
          ? cmd
              .slice(1)
              .map((token) => token.value)
              .filter((value) => value.startsWith("of="))
              .map((value) => value.slice(3))
          : cmd.slice(1).map((token) => token.value)
      for (const output of outputOperands) {
        const cls = classifyPath(output, directory, worktree)
        if (cls.temporary) temporaryWrite = true
        if (cls.workspace) workspaceWrite = true
        if (cls.external) externalWrite = true
      }
    }
    if (FILE_MUTATION_TOOLS.has(base)) {
      // cp/mv/ln/rsync: only the DESTINATIONS are writes. Sources of cp and
      // ln are plain reads (`cp /etc/hosts ./hosts` must not report an
      // external write for its source); mv also changes where each source
      // lives, so mv sources count as mutations of their origin location.
      // Remote destinations (`user@host:/srv/app`, rsync://…) are external
      // writes on another machine, whatever a relative-looking local
      // classification would say.
      const { sources, destinations, sawOperand } = mutationOperands(base, cmd)
      const optionEnd = cmd.findIndex((token) => token.value === "--")
      const mutatesSources =
        base === "mv" ||
        (base === "rsync" &&
          cmd
            .slice(1, optionEnd < 0 ? cmd.length : optionEnd)
            .some((token) => token.value === "--remove-source-files"))
      const writeOperands = mutatesSources ? [...destinations, ...sources] : destinations
      for (const operand of writeOperands) {
        if (base === "rsync" && isRemoteMutationOperand(operand)) {
          externalWrite = true
          continue
        }
        const cls = classifyPath(operand, directory, worktree)
        if (cls.temporary) temporaryWrite = true
        if (cls.workspace) workspaceWrite = true
        if (cls.external) externalWrite = true
      }
      if (!sawOperand) workspaceWrite = true
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
      const { sub, index } = gitSubcommandOf(cmd)
      if (sub !== undefined && GIT_NETWORK_SUBCOMMANDS.has(sub)) {
        networkObserved = true
      }
      if (sub !== undefined && index !== undefined && gitSubcommandMutates(cmd, sub, index)) {
        gitMutation = true
        if (sub === "push") externalWrite = true
        else workspaceWrite = true
      } else if (sub !== undefined && GIT_NETWORK_SUBCOMMANDS.has(sub)) {
        dominantClass = "network"
        classConfidence = "high"
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

  // Deterministic credential reads: a known file reader with a literal
  // credential path operand, or any command with a literal credential path as
  // an input (`<`) redirect target. Wrappers are already peeled in
  // `effective`, so `sudo cat ...` arrives here as `cat ...`. Facts accumulate
  // with OR across every command in the chain.
  for (let index = 0; index < parsed.effective.length; index += 1) {
    const cmd = parsed.effective[index]!
    if (cmd.length === 0) continue
    const base = shellBasename(cmd[0]!.value)
    const redirects = parsed.redirections[index] ?? []
    for (const r of redirects) {
      if (r.operator !== "<") continue
      if (!isLiteralPathValue(r.target)) continue
      if (isSensitivePathToken(r.target)) credentialRead = true
    }
    if (!CREDENTIAL_READERS.has(base)) continue
    for (let i = 1; i < cmd.length; i += 1) {
      const value = cmd[i]!.value
      // A token following a redirect operator is that redirect's target, not
      // a path operand: `cat > .env` writes the file, it does not read it.
      const prev = cmd[i - 1]!.value
      if (prev === "<" || prev === ">" || prev === ">>" || prev === "<<") continue
      if (/^[0-9]*[<>]/.test(prev)) continue
      if (value === "--") continue
      if (value.startsWith("-") && value.length > 1) continue
      if (value === "<" || value === ">" || value === ">>" || value === "<<") continue
      if (value.startsWith("<") || value.startsWith(">")) continue
      if (!isLiteralPathValue(value)) continue
      if (isSensitivePathToken(value)) credentialRead = true
    }
  }

  // Redirections across all commands.
  for (const segRedirects of parsed.redirections) {
    if (hasWriteRedirect(segRedirects)) {
      for (const r of segRedirects) {
        if (!redirectionWritesPath(r)) continue
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
    } else if (workspaceWrite) {
      dominantClass = "workspace-write"
      classConfidence = "medium"
    } else if (temporaryWrite) {
      dominantClass = "temporary-write"
      classConfidence = "high"
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
  // An unterminated or over-bound heredoc body means the scan never saw the
  // terminator: what follows cannot be proven to be commands rather than body
  // text, so the analysis cannot claim completeness.
  const heredocTruncated = parsed.heredocs.some((h) => h.truncated)
  if (parsed.heredocs.length > 0 && heredocTruncated) {
    warnings.push("one or more heredoc bodies were truncated or never terminated")
  }
  if (parsed.analysisTruncated) {
    warnings.push("command structure exceeded the static analysis depth or expansion budget")
  }

  const parserCompleteness = parsed.hasDynamicConstructs
    ? hasCommandSubstitution(parsed.sanitizedCommand) || parsed.heredocs.some((h) => h.dynamic)
      ? "opaque"
      : "partial"
    : parsed.analysisTruncated || heredocTruncated
      ? "partial"
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
    credentialRead: staticFact(credentialRead ? true : "unknown"),
    writeEffects: {
      temporaryWrite: staticFact(temporaryWrite ? true : "unknown"),
      workspaceWrite: staticFact(workspaceWrite ? true : "unknown"),
      externalWrite: staticFact(externalWrite ? true : "unknown"),
      deletion: staticFact(deletion ? true : "unknown"),
    },
    network: {
      observed: staticFact(networkObserved ? true : "unknown"),
      possible: heuristicFact(networkObserved || networkPossible ? true : "unknown"),
      destinations,
      observedAccess: staticFact(networkObserved ? true : "unknown"),
      possibleAccess: heuristicFact(networkObserved || networkPossible ? true : "unknown"),
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
