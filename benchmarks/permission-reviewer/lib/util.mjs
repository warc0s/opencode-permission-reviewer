import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, rename, open, chmod, stat, lstat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
export const sha256 = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : stable(value))
    .digest("hex")
export function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]"
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + stable(value[k]))
        .join(",") +
      "}"
    )
  return JSON.stringify(value)
}
export const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
export async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (e) {
    if (e.code === "ENOENT") return false
    throw e
  }
}
export async function privateDir(path) {
  let existing
  try {
    existing = await lstat(path)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (existing) {
    assert(
      existing.isDirectory() && !existing.isSymbolicLink(),
      `Output path is not a regular directory: ${path}`,
    )
    assert((existing.mode & 0o077) === 0, `Output directory is not private: ${path}`)
    return
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}
export async function atomicJSON(path, value) {
  await privateDir(dirname(path))
  const tmp = path + `.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}
export async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"))
}
export async function readJSONL(path, { recoverTail = false } = {}) {
  const text = await readFile(path, "utf8")
  const lines = text.split("\n")
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    try {
      rows.push(JSON.parse(lines[i]))
    } catch (e) {
      if (recoverTail && i === lines.length - 1 && !text.endsWith("\n"))
        return {
          rows,
          truncatedBytes: Buffer.byteLength(lines[i]),
          validText: lines.slice(0, i).join("\n") + (i ? "\n" : ""),
        }
      throw new Error(`${path}:${i + 1}: invalid JSON (${e.message})`, { cause: e })
    }
  }
  return { rows, truncatedBytes: 0, validText: text }
}
export function rng(seed = 17) {
  let a = Number(seed) >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function shuffle(items, seed = 17) {
  const out = [...items],
    r = rng(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
export const groupBy = (rows, key) => {
  const out = new Map()
  for (const row of rows) {
    const k = typeof key === "function" ? key(row) : row[key]
    if (!out.has(k)) out.set(k, [])
    out.get(k).push(row)
  }
  return out
}
export function quantile(values, p) {
  if (!values.length) return null
  const a = [...values].sort((x, y) => x - y)
  const i = (a.length - 1) * p,
    lo = Math.floor(i)
  return a[lo] + (a[Math.ceil(i)] - a[lo]) * (i - lo)
}
export function numberArg(value, fallback, min, max, name = "number") {
  if (value === undefined) return fallback
  const n = Number(value)
  assert(
    Number.isInteger(n) && n >= min && n <= max,
    `${name} must be an integer in [${min},${max}]`,
  )
  return n
}
export function safeError(error) {
  return String(error?.message ?? error).slice(0, 2000)
}
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function lockDirectory(dir) {
  await privateDir(dir)
  const path = resolve(dir, ".run.lock")
  let fd
  try {
    fd = await open(path, "wx", 0o600)
  } catch (e) {
    if (e.code === "EEXIST")
      throw new Error(
        `Run directory is locked: ${path}. Verify no process is running before removing a stale lock.`,
        { cause: e },
      )
    throw e
  }
  await fd.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  return async () => {
    await fd.close()
    const { unlink } = await import("node:fs/promises")
    await unlink(path)
  }
}
