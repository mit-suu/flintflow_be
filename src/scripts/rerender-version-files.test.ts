import { describe, expect, it } from "vitest"
import { parseRerenderArgs, planRerender, stampSourceOf } from "./rerender-version-files.js"

const binding = { source_file_ref: "f", source_sha256: "s" } as never

describe("rerender-version-files (bug #1 FLF-447)", () => {
  it("dry-run mặc định; --apply mới ghi; --versions tách dấu phẩy", () => {
    expect(parseRerenderArgs(["--project", "p1"])).toEqual({ projectId: "p1", versions: null, apply: false })
    expect(parseRerenderArgs(["--project", "p1", "--versions", "0.2, 1.0", "--apply"])).toEqual({ projectId: "p1", versions: ["0.2", "1.0"], apply: true })
    expect(parseRerenderArgs(["--apply", "--project"]).projectId).toBeNull()
  })

  it("bỏ bản import, version không binding / không snapshot; --versions giới hạn và cho phép 0.1", () => {
    const versions = [
      { version: "0.1", kind: "imported", template_source: binding, spine_snapshot: {}, baseline_ref: "b0" },
      { version: "0.2", kind: "cr_revision", template_source: binding, spine_snapshot: {}, baseline_ref: null },
      { version: "0.3", kind: "cr_revision", template_source: null, spine_snapshot: {}, baseline_ref: null },
      { version: "1.0", kind: "release", template_source: binding, spine_snapshot: null, baseline_ref: "b1" },
      { version: "1.1", kind: "cr_revision", template_source: binding, spine_snapshot: null, baseline_ref: null }
    ] as never
    const all = planRerender(versions, null)
    expect(all.rerender).toEqual(["0.2", "1.0"])
    expect(all.skipped.map((s) => s.version)).toEqual(["0.1", "0.3", "1.1"])
    expect(planRerender(versions, ["0.1", "1.0"]).rerender).toEqual(["0.1", "1.0"])
  })

  it("stamp theo loại version như lúc ghi", () => {
    expect(stampSourceOf("imported")).toBe("import")
    expect(stampSourceOf("release")).toBe("release")
  })
})
