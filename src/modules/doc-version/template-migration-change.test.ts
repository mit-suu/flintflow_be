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

  it("FLF-466: Change có người ghi `system_change:<id>` (đổi mẫu không còn CR giả) cũng bị loại, kể cả lô cờ tự tính", () => {
    const rows = [
      { txn: "t1", by: "system_change:6500000000000000000000aa", op: "set" },
      { txn: "t2", by: "CR-001", op: "set" },
      { txn: "t3", by: "650000000000000000000010", op: "set" }
    ]
    expect(isTemplateMigrationChange(rows[0])).toBe(true)
    expect(isTemplateMigrationChange(rows[1])).toBe(false)
    expect(withoutTemplateMigration(rows).map((r) => r.txn)).toEqual(["t2", "t3"])
  })
})
