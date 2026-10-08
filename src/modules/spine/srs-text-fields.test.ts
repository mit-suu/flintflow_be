import { describe, it, expect } from "vitest"
import { PROJECT_TEXT_FIELDS, SRS_TEXT_FIELDS, SRS_TEXT_GROUPS, VALIDATION_TEXT_FIELDS, pickTextFields } from "./srs-text-fields.js"

describe("srs-text-fields", () => {
  it("bảng field chữ SRS (FLF-265 §2.1) — không id / mã / enum / relation_verbs", () => {
    expect(SRS_TEXT_GROUPS).toEqual(Object.keys(SRS_TEXT_FIELDS))
    const all: string[] = [...Object.values(SRS_TEXT_FIELDS).flat(), ...VALIDATION_TEXT_FIELDS, ...PROJECT_TEXT_FIELDS]
    for (const banned of ["id", "kind", "priority", "category", "tier", "code", "relation_verbs", "term_native"]) {
      expect(all, banned).not.toContain(banned)
    }
    expect(SRS_TEXT_FIELDS.messages).toEqual(["text"])
    expect(SRS_TEXT_FIELDS.functions).toEqual(["name", "trigger", "description", "normal", "abnormal"])
  })

  it("pickTextFields giữ thứ tự, field vắng mặt vẫn có key", () => {
    const picked = pickTextFields({ id: "N1", threshold: "2 s", statement: "Fast" }, SRS_TEXT_FIELDS.nfrs)
    expect(Object.keys(picked)).toEqual(["statement", "metric", "threshold"])
    expect(picked).toEqual({ statement: "Fast", metric: undefined, threshold: "2 s" })
  })
})
