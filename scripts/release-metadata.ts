import { appendFile } from "node:fs/promises"
import { parse } from "semver"
import packageInfo from "../package.json"

export function releaseMetadata(tag: string, packageVersion: string) {
  const version = tag.startsWith("v") ? tag.slice(1) : ""
  const parsed = parse(version)
  if (!parsed || version !== packageVersion)
    throw new Error("Release tag must match the package version exactly")
  const prerelease = parsed.prerelease.length > 0
  return {
    tag,
    version,
    prerelease,
    dist_tag: prerelease ? "next" : parsed.major < 2 ? "v1" : "latest",
  }
}

if (import.meta.main) {
  const metadata = releaseMetadata(process.env.GITHUB_REF_NAME ?? "", packageInfo.version)
  if (!process.env.GITHUB_OUTPUT) throw new Error("Missing GitHub output destination")
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(metadata)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  )
}
