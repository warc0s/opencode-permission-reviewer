import type { PermissionRequest } from "./types.ts"
import { effectiveCommands, lexSegments, type ShellToken, shellBasename } from "./shell-lexer.ts"

/*
 * Deterministic emergency brake.
 *
 * Inspects a pending bash command for *unmistakable* broad destruction or
 * obvious credential export and rejects it before any model call. Everything
 * ambiguous is left to the reviewer.
 *
 * Root destruction is detected with a quote-aware, wrapper-aware shell lexer
 * (see shell-lexer.ts) so that privilege prefixes (`sudo`, `doas`, `env`,
 * `command`, …), absolute binary paths (`/bin/rm`, `/usr/bin/rm`), combined or
 * separated flags (`-rf`, `-r -f`, `--recursive --force`), end-of-options
 * (`--`), and command-string forms (`sh -c '…'`, `su -c …`, `ssh host …`,
 * `busybox rm …`, `chroot root …`) are peeled before judging the executable.
 *
 * It deliberately does NOT expand variables, globs, command substitutions, or
 * heredocs. Those remain the reviewer's job; the brake only catches literal,
 * unambiguous `rm -rf /`-style root destruction (target resolves to `/`).
 */

const ROOT_DESTRUCTION_REGEX = [
  // Fork bomb. (Block-device formatting/overwrite and rm/find destruction are
  // handled by the lexer-based detectors below so that `echo "mkfs …"` and
  // other non-executable mentions do not trip the brake.)
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
]

const SECRET_EXPORT_UTILITIES = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat"])

const SECRET_EXPORT_TARGETS = [
  /(?:\.ssh\/(?:id_|authorized_keys)|\.aws\/credentials|\.config\/gh\/hosts\.yml)/i,
  /(?:api[_-]?key|access[_-]?token|private[_-]?key|session[_-]?cookie)/i,
]

const ROOT_DESTRUCTION_REASON =
  "Emergency brake: command contains unmistakable broad system destruction."
const SECRET_EXPORT_REASON =
  "Emergency brake: command appears to export credential material through a network utility."

/** Short flags that make `rm` recursive / forceful when clustered (e.g. `-rf`). */
function hasRmFlags(tokens: ShellToken[]): { recursive: boolean; force: boolean } {
  let recursive = false
  let force = false
  let endOfFlags = false
  for (let i = 1; i < tokens.length; i += 1) {
    const value = tokens[i]!.value
    if (!endOfFlags && value === "--") {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && value.startsWith("-") && value.length > 1) {
      if (value === "--recursive" || value === "-R") recursive = true
      else if (value === "--force") force = true
      else if (value.startsWith("--")) {
        // Other long flags (--no-preserve-root, --one-file-system, …): no effect on r/f.
        continue
      } else {
        // Clustered short flags; GNU rm allows them interleaved with operands.
        if (value.includes("r") || value.includes("R")) recursive = true
        if (value.includes("f")) force = true
      }
      continue
    }
  }
  return { recursive, force }
}

/**
 * A literal target resolves to the filesystem root `/` after dropping trailing
 * `.`, `..`, and empty components. We do NOT touch variables, globs, command
 * substitutions, or backslash escapes (the lexer already produced the shell
 * value): those stay non-literal and out of the brake's remit, so `rm -rf '\/'`
 * is left untouched (it is a file literally named `\`-slash, not root).
 */
function resolvesToRoot(rawTarget: string): boolean {
  if (!rawTarget.startsWith("/")) return false
  const stack: string[] = []
  for (const part of rawTarget.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.length === 0
}

function isRmRootDestruction(command: string): boolean {
  for (const segment of lexSegments(command)) {
    for (const effective of effectiveCommands(segment)) {
      if (effective.length === 0) continue
      if (shellBasename(effective[0]!.value) !== "rm") continue
      const { recursive, force } = hasRmFlags(effective)
      if (!recursive || !force) continue
      let endOfFlags = false
      for (let i = 1; i < effective.length; i += 1) {
        const value = effective[i]!.value
        if (!endOfFlags && value === "--") {
          endOfFlags = true
          continue
        }
        if (!endOfFlags && value.startsWith("-") && value.length > 1) continue
        if (resolvesToRoot(value)) return true
      }
    }
  }
  return false
}

/**
 * `find / … -delete` and `find / … -exec rm -rf {} …` reach root through the
 * find expression rather than through a literal `rm` operand, so the rm lexer
 * above does not see them. Detect them directly: when the search root resolves
 * to `/` and the expression deletes its results, the destruction is unmistakable.
 */
function isFindRootDestruction(command: string): boolean {
  for (const segment of lexSegments(command)) {
    for (const effective of effectiveCommands(segment)) {
      if (effective.length === 0) continue
      if (shellBasename(effective[0]!.value) !== "find") continue
      let root: string | null = null
      let hasDelete = false
      let hasExecRm = false
      for (let i = 1; i < effective.length; i += 1) {
        const value = effective[i]!.value
        // The search root is the first non-flag operand; everything after it
        // belongs to the expression. Flags that take a value (e.g. `-maxdepth`)
        // are not modelled here, so `find -maxdepth 1 / …` is a false negative
        // (rare and safe) — we never falsely trip.
        if (root === null) {
          if (value.startsWith("-") && value.length > 1) continue
          if (value === "--") continue
          root = value
          continue
        }
        if (value === "-delete") hasDelete = true
        if (value === "-exec" || value === "-execdir" || value === "-ok" || value === "-okdir") {
          // First non-placeholder token after -exec is the executable; if it is
          // `rm` with recursive+force flags, find destroys its matches.
          let j = i + 1
          while (
            j < effective.length &&
            (effective[j]!.value === "{" || effective[j]!.value === "}")
          )
            j += 1
          if (j < effective.length && shellBasename(effective[j]!.value) === "rm") {
            const { recursive, force } = hasRmFlags(effective.slice(j))
            if (recursive && force) hasExecRm = true
          }
        }
      }
      if (root !== null && resolvesToRoot(root) && (hasDelete || hasExecRm)) return true
    }
  }
  return false
}

/**
 * Block-device destruction that is unmistakable regardless of arguments:
 * formatting (`mkfs*`, `mke2fs`, `mkswap`), signature wipe (`wipefs -a`),
 * raw overwrite (`dd of=/dev/…`, `shred /dev/…`), partition-table destruction
 * (`sgdisk --zap-all`/`-z`/`--delete=N`, `sfdisk --delete`/`--wipe`,
 * `parted mklabel`/`rm`). Detected via the lexer so privilege wrappers and
 * `echo "mkfs …"` (where the destructive tool is an argument, not the
 * executable) are handled correctly.
 */
const MKFS_FAMILY = /^mkfs(?:\.[a-z0-9]+)?$/
/**
 * Whitelist of real block-device path prefixes so that pseudo-devices
 * (`/dev/null`, `/dev/zero`, `/dev/shm/…`, `/dev/fd/…`, etc.) — which sit under
 * `/dev/` but are not disks — do not trip the brake on legitimate patterns
 * like `dd … of=/dev/null` or `shred /dev/shm/scratch`.
 */
const BLOCK_DEVICE_RE =
  /^\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk|loop|md|dm-|zram|drbd|bcache|mapper\/|disk\/by-)/

function isBlockDeviceTarget(value: string): boolean {
  return BLOCK_DEVICE_RE.test(value)
}

/** Whether a short-flag cluster (e.g. `-af`) contains a given flag letter. */
function shortFlagClusterIncludes(value: string, letter: string): boolean {
  return (
    value.startsWith("-") && !value.startsWith("--") && value.length > 1 && value.includes(letter)
  )
}

function isDeviceDestruction(command: string): boolean {
  for (const segment of lexSegments(command)) {
    for (const effective of effectiveCommands(segment)) {
      if (effective.length === 0) continue
      const base = shellBasename(effective[0]!.value)
      const args = effective.slice(1)
      const targetsBlock = args.some((t) => isBlockDeviceTarget(t.value))

      // mkfs / mkfs.* / mke2fs / mkswap: any real block target is destruction,
      // unless a dry-run flag is present (`-n` for mke2fs/mkfs.ext4, `-V`/`-t`
      // alone do not write but are rare; `-n` is the canonical dry-run).
      if (MKFS_FAMILY.test(base) || base === "mke2fs" || base === "mkswap") {
        if (!targetsBlock) continue
        const dryRun = args.some((t) => t.value === "-n" || t.value === "--dry-run")
        if (!dryRun) return true
      }
      // shred: any real block target is destruction.
      if (base === "shred" && targetsBlock) return true

      // wipefs: only --all/-a (alone or clustered like `-af`)/-t wipes
      // signatures; bare wipefs just lists signatures.
      if (base === "wipefs" && targetsBlock) {
        const wipes = args.some((t) => {
          const v = t.value
          return (
            v === "--all" ||
            v === "-a" ||
            shortFlagClusterIncludes(v, "a") ||
            v.startsWith("-t") ||
            v === "--types"
          )
        })
        if (wipes) return true
      }

      // dd: detect `of=<real block device>` (the lexer already stripped quotes).
      if (base === "dd") {
        const hitsBlock = args.some((t) => {
          if (!t.value.startsWith("of=")) return false
          return isBlockDeviceTarget(t.value.slice(3))
        })
        if (hitsBlock) return true
      }

      // sgdisk: destructive ops are --zap-all/-Z (wipe everything), -z/--zap
      // (destroy GPT data structures), and --delete[=N]/-d _N (delete a
      // partition). -d requires a following partition-number argument.
      if (base === "sgdisk" && targetsBlock) {
        const destructive = args.some((t) => {
          const v = t.value
          return (
            v === "--zap-all" ||
            v === "-Z" ||
            v === "--zap" ||
            v === "-z" ||
            v.startsWith("--delete")
          )
        })
        const deleteShort = args.some((t) => t.value === "-d" || t.value === "--delete")
        if (destructive || (deleteShort && args.some((t) => /^[0-9]+$/.test(t.value)))) return true
      }

      // sfdisk: --delete (with partition list) and --wipe* destroy data.
      // NOTE: sfdisk's `-d` is `--dump` (read-only backup), NOT delete — do not
      // share the sgdisk short-flag set.
      if (base === "sfdisk" && targetsBlock) {
        const destructive = args.some((t) => {
          const v = t.value
          return v === "--delete" || v.startsWith("--wipe")
        })
        if (destructive) return true
      }

      // parted: `mklabel` rewrites the partition table; `rm N` deletes a
      // partition.
      if (base === "parted" && targetsBlock) {
        const destructive = args.some((t) => t.value === "mklabel" || t.value === "rm")
        if (destructive) return true
      }
    }
  }
  return false
}

/**
 * Obvious credential export through a network utility. Detected structurally —
 * the executable itself must be the network tool — so a quoted mention inside
 * unrelated text (`echo "curl api_key"`, docs, commit messages) does not trip
 * the brake, exactly like the destruction detectors above. Wrapper peeling
 * (`sh -c`, `ssh host …`, `sudo …`) still reaches the real executable.
 */
function isObviousSecretExport(command: string): boolean {
  for (const segment of lexSegments(command)) {
    for (const effective of effectiveCommands(segment)) {
      if (effective.length === 0) continue
      if (!SECRET_EXPORT_UTILITIES.has(shellBasename(effective[0]!.value))) continue
      const args = effective
        .slice(1)
        .map((token) => token.value)
        .join(" ")
      if (SECRET_EXPORT_TARGETS.some((pattern) => pattern.test(args))) return true
    }
  }
  return false
}

export function emergencyBrakeReason(request: PermissionRequest): string | undefined {
  if (request.permission !== "bash") return
  const command =
    typeof request.metadata.command === "string"
      ? request.metadata.command
      : request.patterns.filter((pattern) => typeof pattern === "string").join("\n")

  if (isRmRootDestruction(command)) return ROOT_DESTRUCTION_REASON
  if (isFindRootDestruction(command)) return ROOT_DESTRUCTION_REASON
  if (isDeviceDestruction(command)) return ROOT_DESTRUCTION_REASON
  if (ROOT_DESTRUCTION_REGEX.some((pattern) => pattern.test(command)))
    return ROOT_DESTRUCTION_REASON
  if (isObviousSecretExport(command)) return SECRET_EXPORT_REASON
}
