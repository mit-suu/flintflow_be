/** Sau đổi mẫu: mục khung ngoài bảng đo dữ liệu vẫn chặn phát hành (phần nhỏ `slot:*` đo theo dữ liệu của slot); tham chiếu "mục x.y" chỉ cờ chữ có từ trước đổi mẫu. */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { runDeterministicCheck, type FlagCandidate, type RuleProfile } from "./deterministic-check.js"

const base = JSON.parse(readFileSync(new URL("../../../fixtures/spine-fixture-19-screens.json", import.meta.url), "utf8"))
const profile = (extra: Partial<RuleProfile>): { ruleProfile: RuleProfile } => ({ ruleProfile: { exclude: new Set(), downgrade: new Set(), templateLayout: new Set(["fixed:1", "slot:security", "custom:CS01"]), ...extra } })
const byRule = (flags: FlagCandidate[], id: string) => flags.filter((f) => f.rule_id === id)
const block = (text: string) => ({ kind: "paragraph" as const, text, rows: null, image_ref: null })

describe("template_section_migration_missing — mục không có trong bảng dữ liệu của mục khung", () => {
  const missing = new Set(["slot:security"])

  it("phần nhỏ của mẫu (slot) chưa có dữ liệu ⇒ cờ đỏ chặn phát hành; có dữ liệu ⇒ hết", () => {
    const empty = { ...base, custom_sections: [], common_requirements: [] }
    expect(byRule(runDeterministicCheck(empty, [], profile({ templateMissing: missing })), "template_section_migration_missing").map((f) => [f.level, f.section_id])).toEqual([["red", "slot:security"]])
    const filled = { ...base, custom_sections: [], common_requirements: [{ id: "CR-1", category: "security", statement: "Passwords are stored hashed." }] }
    expect(byRule(runDeterministicCheck(filled, [], profile({ templateMissing: missing })), "template_section_migration_missing")).toEqual([])
  })
})

describe("section_reference_after_migration — chỉ chữ có từ trước đổi mẫu", () => {
  const section = (text: string) => ({ id: "CS01", heading: "Notes", level: 2, blocks: [block(text)], source: "import" as const })
  const spine = { ...base, custom_sections: [section("Xem mục 3.2 (có từ trước). BA viết thêm sau đổi mẫu: xem mục 5.1.")] }
  const referenceOf = (ruleProfile: Partial<RuleProfile>) => byRule(runDeterministicCheck(spine, [], profile({ checkSectionReferences: true, ...ruleProfile })), "section_reference_after_migration").map((f) => f.target_id)

  it("không có mốc ⇒ cờ mọi tham chiếu; có mốc ⇒ chỉ tham chiếu đã có lúc đổi mẫu", () => {
    expect(referenceOf({})).toEqual(["3.2", "5.1"])
    expect(referenceOf({ referenceBaseline: new Map([["CS01", ["3.2"]]]) })).toEqual(["3.2"])
    // Mục riêng mới sau đổi mẫu (không có trong mốc) ⇒ không cờ
    expect(referenceOf({ referenceBaseline: new Map() })).toEqual([])
  })
})
