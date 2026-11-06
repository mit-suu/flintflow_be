import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { changedFunctionFields, functionFieldHashes, patchFunctionOriginal, type FunctionOriginalBlock } from "./function-original.js"
import { buildLayoutSections, functionSourceHash, type TemplateLayout } from "./layout-sections.js"

const fnOf = (over: Partial<Spine["functions"][number]> = {}): Spine["functions"][number] =>
  ({
    id: "FR-01",
    name: "Log In",
    feature_id: "F-01",
    screen_id: null,
    trigger: "User opens the Login screen",
    description: "Authenticate the user.",
    normal: ["Enter email and password", "Click Log in", "System opens the home page"],
    abnormal: ["Wrong password: show MSG01"],
    validations: [{ id: "V1", kind: "business", statement: "Account locks after 5 failed attempts" }],
    business_rule_ids: [],
    priority: null,
    order: 0,
    ...over
  }) as Spine["functions"][number]

const para = (text: string, fields?: string[]): FunctionOriginalBlock => ({ kind: "paragraph", text, rows: null, image_ref: null, ...(fields ? { fields } : {}) })
const item = (text: string, fields?: string[]): FunctionOriginalBlock => ({ kind: "list_item", text, rows: null, image_ref: null, ...(fields ? { fields } : {}) })

/** Mục 3.2.1 Log In kiểu FAP: 4 tiêu đề con, nhãn của file, Navigation path / Interface không có trong Spine. */
const LOGIN: FunctionOriginalBlock[] = [
  { kind: "heading", text: "Function trigger", level: 1 },
  item("Navigation path: Home → Log In"),
  item("Timing frequency: User opens the Login screen", ["trigger"]),
  { kind: "heading", text: "Function description", level: 1 },
  item("Interface: Login form with email, password"),
  { kind: "heading", text: "Screen layout", level: 1 },
  { kind: "image", text: "Screen Layout — Login", rows: null, image_ref: "word/media/image9.png" },
  { kind: "heading", text: "Function details", level: 1 },
  para("Normal case:"),
  item("Enter email and password", ["normal"]),
  item("Click Log in", ["normal"]),
  item("System opens the home page", ["normal"]),
  para("Abnormal case:"),
  item("Wrong password: show MSG01", ["abnormal"]),
  para("Business rules:"),
  item("Account locks after 5 failed attempts", ["validations"])
]

const texts = (blocks: readonly FunctionOriginalBlock[]) => blocks.map((b) => (b.kind === "image" ? `[image]` : b.kind === "heading" ? `# ${b.text}` : b.text))

describe("FLF-361 mục chức năng sau CR — chỉ khối của trường đã đổi dựng lại", () => {
  const spine = createEmptySpine({ name: "FAP" })

  it("CR sửa 1 quy tắc: Navigation path / Interface / Screen layout / luồng chính / tiêu đề con giữ nguyên, quy tắc mới đúng chỗ", () => {
    const before = fnOf()
    const after = fnOf({ validations: [{ id: "V1", kind: "business", statement: "Account locks after 3 failed attempts" }] })
    const changed = changedFunctionFields(after, functionFieldHashes(before))
    expect([...changed]).toEqual(["validations"])
    const out = patchFunctionOriginal(LOGIN, spine, after, changed, functionFieldHashes(before))!
    expect(texts(out)).toEqual(texts(LOGIN).map((t) => (t === "Account locks after 5 failed attempts" ? "Account locks after 3 failed attempts" : t)))
  })

  it("trường một dòng có nhãn đầu dòng ⇒ giữ nhãn của file; xoá hết luồng lỗi ⇒ bỏ khối, nhãn của file giữ", () => {
    const before = fnOf()
    const after = fnOf({ trigger: "User clicks Log in on the header", abnormal: [] })
    const out = patchFunctionOriginal(LOGIN, spine, after, changedFunctionFields(after, functionFieldHashes(before)), functionFieldHashes(before))!
    expect(texts(out)).toContain("Timing frequency: User clicks Log in on the header")
    expect(texts(out)).not.toContain("Wrong password: show MSG01")
    expect(texts(out)).toContain("Abnormal case:")
    expect(texts(out)).toContain("Navigation path: Home → Log In")
  })

  it("trường file không ghi mà CR thêm ⇒ cuối mục có nhãn; trường có chữ mà không biết khối nào ⇒ null (dựng lại cả mục)", () => {
    const before = fnOf({ business_rule_ids: [] })
    const withRule: Spine = { ...spine, business_rules: [{ id: "BR-07", tier: "detail", statement: "Sessions expire after 30 minutes", source_validation_ids: [] }] }
    const after = fnOf({ business_rule_ids: ["BR-07"] })
    const out = patchFunctionOriginal(LOGIN, withRule, after, changedFunctionFields(after, functionFieldHashes(before)), functionFieldHashes(before))!
    expect(texts(out).slice(-2)).toEqual(["Business rules", "Sessions expire after 30 minutes"])

    const noFields = LOGIN.map(({ fields: _f, ...b }) => b as FunctionOriginalBlock)
    const edited = fnOf({ normal: ["Enter email"] })
    expect(patchFunctionOriginal(noFields, spine, edited, changedFunctionFields(edited, functionFieldHashes(fnOf())), functionFieldHashes(fnOf()))).toBeNull()
  })

  it("buildLayoutSections: chưa sửa ⇒ nguyên văn có 4 tiêu đề con (cấp theo mục); CR sửa ⇒ vẫn đủ dòng của file", () => {
    const fn = fnOf()
    const s: Spine = { ...createEmptySpine({ name: "FAP" }), features: [{ id: "F-01", name: "Authentication", order: 0 }] as never, functions: [fn] }
    const template = (f: Spine["functions"][number]): TemplateLayout => ({
      language: "en",
      layout: [
        { order: 0, heading_text: "3.2 Authentication", level: 2, section_id: "feature:F-01" },
        { order: 1, heading_text: "3.2.1 Log In", level: 3, section_id: "function:FR-01" }
      ] as never,
      functionOriginals: [{ section_id: "function:FR-01", source_hash: functionSourceHash(f), field_hashes: functionFieldHashes(f), blocks: LOGIN }]
    })
    const render = (sp: Spine) => buildLayoutSections(sp, template(fn), [], { diagramPng: (id) => `ref:${id}` }).sections.find((x) => x.id === "function:FR-01")!
    const v01 = render(s)
    const level = v01.level
    expect(v01.blocks.filter((b) => b.type === "heading")).toEqual(
      ["Function trigger", "Function description", "Screen layout", "Function details"].map((text) => ({ type: "heading", level: level + 1, text }))
    )
    const edited = render({ ...s, functions: [fnOf({ validations: [{ id: "V1", kind: "business", statement: "Account locks after 3 failed attempts" }] })] })
    const json = JSON.stringify(edited.blocks)
    for (const keep of ["Navigation path: Home → Log In", "Interface: Login form with email, password", "Normal case:", "Click Log in", "Function details"]) expect(json).toContain(keep)
    expect(json).toContain("Account locks after 3 failed attempts")
    expect(json).not.toContain("after 5 failed")
    expect(json).not.toContain("Normal Flow")
  })
})
