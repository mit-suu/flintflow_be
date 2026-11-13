import { describe, expect, it } from "vitest"
import { projectRefsFromImports } from "./migrate-org-template-versions.js"

describe("migrate-org-template-versions — projectRefsFromImports", () => {
  it("lấy lần import mới nhất của mỗi project; bản trống ⇒ 1", () => {
    const refs = projectRefsFromImports([
      { projectId: "p1", org_template_id: "t-old", org_template_version: null, createdAt: new Date("2026-10-01") },
      { projectId: "p1", org_template_id: "t-new", org_template_version: 3, createdAt: new Date("2026-10-05") },
      { projectId: "p2", org_template_id: "t2", org_template_version: null, createdAt: new Date("2026-10-02") }
    ])
    expect(Object.fromEntries(refs)).toEqual({ p1: { template_id: "t-new", version: 3 }, p2: { template_id: "t2", version: 1 } })
  })
})
