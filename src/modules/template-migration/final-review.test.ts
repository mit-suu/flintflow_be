import { describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({ migrations: [] as { decisions: { id: string; choice: string }[]; groups: { extra: { id: string; section_id: string }[] } }[] }))
vi.mock("./template-migration.model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./template-migration.model.js")>()
  return { ...actual, TemplateMigration: { ...actual.TemplateMigration, find: () => ({ lean: async () => store.migrations }) } }
})
vi.mock("../template-migration/template-migration.model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./template-migration.model.js")>()
  return { ...actual, TemplateMigration: { ...actual.TemplateMigration, find: () => ({ lean: async () => store.migrations }) } }
})

const { normalizeAiElement } = await import("./resolve-step.js")
const { keptCustomSections, unmeasuredFilled } = await import("../import/mode1-guard.js")
const { runDeterministicCheck } = await import("../spine/deterministic-check.js")
const { readFileSync } = await import("node:fs")

describe("normalizeAiElement (op AI qua chuẩn hoá phần tử)", () => {
  it("bỏ id và khoá thừa không thuộc schema phần tử của mảng đích; giữ field hợp lệ; mảng lạ giữ nguyên", () => {
    expect(normalizeAiElement("other_requirements", { id: "OR-99", kind: "assumption", statement: "x", extra_field: 1, notes: "y" })).toEqual({ kind: "assumption", statement: "x" })
    expect(normalizeAiElement("business_rules", { statement: "s", tier: "detail", junk: true })).toEqual({ statement: "s", tier: "detail" })
    expect(normalizeAiElement("not_a_collection", { id: "1", a: 1 })).toEqual({ a: 1 })
  })
})

describe("mục khung thiếu không đo được", () => {
  const base = JSON.parse(readFileSync(new URL("../../../fixtures/spine-fixture-19-screens.json", import.meta.url), "utf8"))
  const run = (templateFilled: string[]) =>
    runDeterministicCheck({ ...base, custom_sections: [] }, [], {
      ruleProfile: { exclude: new Set(), downgrade: new Set(), templateLayout: new Set(["fixed:4.2.4", "fixed:5.5"]), templateMissing: new Set(["fixed:4.2.4", "fixed:5.5", "fixed:9.9"]), templateFilled: new Set(templateFilled) }
    }).filter((f) => f.rule_id === "template_section_migration_missing").map((f) => f.section_id)

  it("mục viết được qua mảng riêng (4.2.4, 5.5) cờ đỏ tới khi được đánh dấu đã viết; mục không có đường viết (9.9) không bắn (không có cách xoá cờ)", () => {
    expect(run([])).toEqual(["fixed:4.2.4", "fixed:5.5"])
    expect(run(["fixed:4.2.4"])).toEqual(["fixed:5.5"])
  })

  it("unmeasuredFilled: chỉ khi mảng có thêm phần tử so với mốc; không có mốc ⇒ có phần tử là đủ", () => {
    const missing = new Set(["fixed:4.2.4", "fixed:5.5", "fixed:9.9"])
    const spine = { nfrs: [{}, {}], glossary: [] } as never
    expect(unmeasuredFilled(missing, spine, { nfrs: [{}, {}] as never, glossary: [] })).toEqual([])
    expect(unmeasuredFilled(missing, spine, { nfrs: [{}] as never, glossary: [] })).toEqual(["fixed:4.2.4"])
    expect(unmeasuredFilled(missing, spine, null)).toEqual(["fixed:4.2.4"])
    expect(unmeasuredFilled(missing, null, null)).toEqual([])
  })
})

describe("keptCustomSections qua mọi lần đổi mẫu còn hiệu lực", () => {
  it("gộp quyết định keep_custom / drop_from_print của tất cả migration đã áp dụng, không chỉ lần mới nhất", async () => {
    store.migrations = [
      { decisions: [{ id: "e:a", choice: "keep_custom" }, { id: "e:b", choice: "delete" }], groups: { extra: [{ id: "e:a", section_id: "fixed:2.1" }, { id: "e:b", section_id: "custom:CS1" }] } },
      { decisions: [{ id: "e:c", choice: "drop_from_print" }], groups: { extra: [{ id: "e:c", section_id: "fixed:5.3" }] } }
    ]
    expect([...(await keptCustomSections("p"))].sort()).toEqual(["fixed:2.1", "fixed:5.3"])
  })
})
