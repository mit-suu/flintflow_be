import { describe, expect, it } from "vitest"
import { isTemplateMigrationChange, withoutTemplateMigration } from "./template-migration-change.js"

describe("template-migration-change", () => {
  it("nhận diện theo tiền tố txn; Change thường và dòng Baseline giữ nguyên", () => {
    const rows = [
      { txn: "template-migration:abc", op: "set" },
      { txn: "CR-001", op: "set" },
      { txn: "release:1.0", op: "add" }
    ]
    expect(isTemplateMigrationChange(rows[0])).toBe(true)
    expect(withoutTemplateMigration(rows).map((r) => r.txn)).toEqual(["CR-001", "release:1.0"])
  })
})
