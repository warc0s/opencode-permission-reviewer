import { expect, test } from "bun:test"
import { releaseMetadata } from "../scripts/release-metadata.ts"

test("release channels preserve latest when a legacy patch follows a dual release", () => {
  expect(releaseMetadata("v2.0.0", "2.0.0").dist_tag).toBe("latest")
  expect(releaseMetadata("v1.3.4", "1.3.4").dist_tag).toBe("v1")
  expect(releaseMetadata("v2.0.0-rc.1", "2.0.0-rc.1")).toMatchObject({
    dist_tag: "next",
    prerelease: true,
  })
  expect(releaseMetadata("v1.3.4+build-fixture", "1.3.4+build-fixture")).toMatchObject({
    dist_tag: "v1",
    prerelease: false,
  })
  expect(() => releaseMetadata("v2.0.0", "1.3.4")).toThrow("match")
  expect(() => releaseMetadata("vnot-a-version", "not-a-version")).toThrow("match")
})
