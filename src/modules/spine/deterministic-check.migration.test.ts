/** Cờ sau đổi mẫu: mục để trống chặn phát hành, không trùng cờ vàng, mục giữ riêng không báo thiếu, tham chiếu "mục x.y". */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { planFlagOps } from "./flags.service.js"
import { runDeterministicCheck, NON_WAIVABLE_RULES, type FlagCandidate, type RuleProfile } from "./deterministic-check.js"

const base = JSON.parse(readFileSync(new URL("../../../fixtures/spine-fixture-19-screens.json", import.meta.url), "utf8"))
const block = (text: string) => ({ kind: "paragraph" as const, text, rows: null, image_ref: null })
const section = (id: string, text: string | null) => ({ id, heading: `Heading ${id}`, level: 2, blocks: text === null ? [] : [block(text)], source: "import" as const })
const spineWith = (customs: ReturnType<typeof section>[]) => ({ ...base, custom_sections: customs })
const profile = (extra: Partial<RuleProfile>): { ruleProfile: RuleProfile } => ({
  ruleProfile: { exclude: new Set(), downgrade: new Set(), templateLayout: new Set(["fixed:1", "custom:CS01", "custom:CS02"]), ...extra }
})
const byRule = (flags: FlagCandidate[], id: string) => flags.filter((f) => f.rule_id === id)

describe("template_section_migration_missing", () => {
  const missing = new Set(["custom:CS01", "custom:CS02"])

  it("mục còn trống / chỉ có chữ hướng dẫn ⇒ cờ đỏ không waive được; không kèm template_section_empty", () => {
    const spine = spineWith([section("CS01", "[Describe the scope.]"), section("CS02", null)])
    const flags = runDeterministicCheck(spine, [], profile({ templateMissing: missing }))
    const red = byRule(flags, "template_section_migration_missing")
    expect(red.map((f) => [f.level, f.section_id])).toEqual([["red", "custom:CS01"], ["red", "custom:CS02"]])
    expect(byRule(flags, "template_section_empty")).toEqual([])
    expect(NON_WAIVABLE_RULES.has("template_section_migration_missing")).toBe(true)
  })

  it("viết xong thì cờ hết (chỉ mục đã viết); mục khác của mẫu vẫn bắn template_section_empty như cũ", () => {
    const spine = spineWith([section("CS01", "Phạm vi của hệ thống gồm đăng nhập và báo cáo."), section("CS02", null)])
    const flags = runDeterministicCheck(spine, [], profile({ templateMissing: missing }))
    expect(byRule(flags, "template_section_migration_missing").map((f) => f.section_id)).toEqual(["custom:CS02"])
    const noMissing = runDeterministicCheck(spine, [], profile({}))
    expect(byRule(noMissing, "template_section_empty").map((f) => f.section_id)).toEqual(["custom:CS02"])
    expect(byRule(noMissing, "template_section_migration_missing")).toEqual([])
  })

  it("recompute không tự đóng cờ khi mục chưa viết, và đóng khi đã viết", () => {
    const empty = spineWith([section("CS01", null), section("CS02", "Có chữ thật ở đây.")])
    const opts = profile({ templateMissing: new Set(["custom:CS01"]) })
    const first = planFlagOps({ ...empty, flags: [] }, runDeterministicCheck(empty, [], opts))
    const opened = first.ops.filter((o) => o.op === "add" && (o.value as { rule_id: string }).rule_id === "template_section_migration_missing")
    expect(opened).toHaveLength(1)
    const flag = (opened[0].value as { id: string })
    const again = planFlagOps({ ...empty, flags: [opened[0].value as never] }, runDeterministicCheck(empty, [], opts))
    expect(again.resolved).toEqual([])

    const written = spineWith([section("CS01", "Đã viết xong."), section("CS02", "Có chữ thật ở đây.")])
    const closed = planFlagOps({ ...written, flags: [opened[0].value as never] }, runDeterministicCheck(written, [], opts))
    expect(closed.resolved).toEqual([flag.id])
  })
})

describe("template_section_absent với mục giữ riêng", () => {
  it("mục khung đã giữ thành mục riêng (keep_custom) không báo template_section_absent", () => {
    const spine = spineWith([section("CS01", "x")])
    const absent = (kept: Set<string>) => byRule(runDeterministicCheck(spine, [], profile({ templateKept: kept })), "template_section_absent").map((f) => f.section_id)
    const all = absent(new Set())
    expect(all.length).toBeGreaterThan(0)
    expect(absent(new Set([all[0]]))).toEqual(all.slice(1))
  })
})

describe("section_reference_after_migration", () => {
  const spine = spineWith([section("CS01", "Xem mục 3.2 và section 4.1.2 để biết thêm; mục 3.2 lặp lại."), section("CS02", "Không có tham chiếu, giá 3.5 triệu.")])

  it("chỉ bật sau đổi mẫu: mỗi (mục, số) một cờ vàng", () => {
    const flags = byRule(runDeterministicCheck(spine, [], profile({ checkSectionReferences: true })), "section_reference_after_migration")
    expect(flags.map((f) => [f.level, f.section_id, f.target_id])).toEqual([["yellow", "custom:CS01", "3.2"], ["yellow", "custom:CS01", "4.1.2"]])
    expect(byRule(runDeterministicCheck(spine, [], profile({})), "section_reference_after_migration")).toEqual([])
  })
})

describe("template_section_migration_missing — tên mục trong câu cờ", () => {
  const messageOf = (id: string, headings?: Map<string, string>) => {
    const spine = { ...spineWith([section("CS04", null)]), project: { ...base.project, form_factor: [] }, other_requirements: [], assumptions: [] }
    const flags = runDeterministicCheck(spine, [], profile({ templateMissing: new Set([id]), ...(headings ? { templateHeadings: headings } : {}) }))
    return byRule(flags, "template_section_migration_missing").find((f) => f.section_id === id)?.message ?? ""
  }

  it("dùng heading của mẫu hiện tại, không chèn chữ dự phòng và không lặp chữ Mục", () => {
    expect(messageOf("custom:CS04", new Map([["custom:CS04", "7 Document Conventions"]]))).toMatch(/^Mục "7 Document Conventions" có trong mẫu mới/)
    expect(messageOf("slot:platforms", new Map([["slot:platforms", "6 Operating Environment"]]))).toMatch(/^Mục "6 Operating Environment" có trong mẫu mới/)
    // Mục khung mang số mục FPT nhưng tài liệu gọi bằng heading khác
    expect(messageOf("fixed:5.4", new Map([["fixed:5.4", "8 Data Retention"]]))).toMatch(/^Mục "8 Data Retention" /)
  })

  it("không biết heading thì không ra 'Mục mục riêng' hay 'một mục của tài liệu'", () => {
    expect(messageOf("custom:CS04")).toMatch(/^Mục riêng "Heading CS04" có trong mẫu mới/)
    expect(messageOf("slot:platforms")).not.toMatch(/^Mục mục|một mục của tài liệu/)
  })
})
