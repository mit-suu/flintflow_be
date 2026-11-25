import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { functionBlocksLikeSibling, functionFieldValues, patchFunctionOriginal, tagFunctionBlocks, type FunctionOriginalBlock } from "./function-original.js"
import { buildLayoutSections, functionSourceHash, type TemplateLayout } from "./layout-sections.js"

const LOCK5 = "An account is locked temporarily after five consecutive failed login attempts and unlocks automatically after 15 minutes."
const LOCK3 = "An account is locked temporarily after three consecutive failed login attempts and unlocks automatically after 15 minutes."

/** Chức năng 3.2.1 Log In của FAP PLAN 2 (dữ liệu thật, rút gọn). */
const fnOf = (over: Partial<Spine["functions"][number]> = {}): Spine["functions"][number] =>
  ({
    id: "FR-3.2.1",
    name: "Log In",
    feature_id: "F-01",
    screen_id: null,
    trigger: "Login; A lecturer, student or academic office staff member enters their username and password on the Login screen and clicks Log In.",
    description: "The user is authenticated and lands on the home page for their role.",
    normal: [
      "The user enters their username and password and clicks Log In.",
      "The system checks the credentials against the user accounts the academic management office created.",
      "The system opens the home page matching the user's role."
    ],
    abnormal: [
      "The username or password is wrong: the system shows an error message and keeps the user on the Login screen.",
      "The user fails five consecutive attempts: the system locks the account temporarily for 15 minutes.",
      "The authentication service is unavailable: the system shows a try-again message."
    ],
    validations: [
      { id: "V1", kind: "required", statement: "Username must not be empty." },
      { id: "V2", kind: "required", statement: "Password must not be empty." },
      { id: "V3", kind: "business", statement: LOCK5 }
    ],
    business_rule_ids: [],
    priority: null,
    order: 0,
    ...over
  }) as Spine["functions"][number]

const para = (text: string): FunctionOriginalBlock => ({ kind: "paragraph", text, rows: null, image_ref: null })
const item = (text: string): FunctionOriginalBlock => ({ kind: "list_item", text, rows: null, image_ref: null })
const head = (text: string): FunctionOriginalBlock => ({ kind: "heading", text, level: 1 })

/** Nguyên văn mục 3.2.1 của file: 4 tiêu đề con, nhãn, Data processing chép lại bước hệ thống của luồng chính. */
const LOGIN: FunctionOriginalBlock[] = [
  head("Function trigger"),
  item("Navigation path: Login"),
  item("Timing frequency: A lecturer, student or academic office staff member enters their username and password on the Login screen and clicks Log In."),
  head("Function description"),
  item("Actors / Roles: Lecturer, Student, Academic Management Office"),
  item("Purpose: The user is authenticated and lands on the home page for their role."),
  item('Interface: Login screen: "Log in to your account" text, Username input, Password input (masked), Log in button.'),
  para("Data processing:"),
  item("The system checks the credentials against the user accounts the academic management office created."),
  item("The system opens the home page matching the user's role."),
  head("Screen layout"),
  { kind: "image", text: "", rows: null, image_ref: "word/media/image9.png" },
  para("Screen Layout - Login"),
  head("Function details"),
  item("Data: User, Student"),
  para("Validation:"),
  item("Username must not be empty."),
  item("Password must not be empty."),
  item(`Business rules: ${LOCK5}`),
  para("Normal case:"),
  item("The user enters their username and password and clicks Log In."),
  item("The system checks the credentials against the user accounts the academic management office created."),
  item("The system opens the home page matching the user's role."),
  para("Abnormal case:"),
  item("The username or password is wrong: the system shows an error message and keeps the user on the Login screen."),
  item("The user fails five consecutive attempts: the system locks the account temporarily for 15 minutes."),
  item("The authentication service is unavailable: the system shows a try-again message.")
]

const spine = createEmptySpine({ name: "FAP" })
const texts = (blocks: readonly FunctionOriginalBlock[]) => blocks.map((b) => (b.kind === "image" ? "[image]" : b.kind === "heading" ? `# ${b.text}` : b.text))

describe("FLF-361 mục chức năng sau CR - chỉ sửa đúng phần tử đã đổi", () => {
  const before = functionFieldValues(spine, fnOf())
  const tagged = tagFunctionBlocks(LOGIN, before)

  it("gắn phần tử theo chữ: nhãn / Interface không mang phần tử; Business rules: … mang validation", () => {
    const tagOf = (t: string) => tagged.find((b) => b.kind !== "image" && b.kind !== "heading" && b.text === t)?.tags
    // trigger ghép "Login; A lecturer…" ⇒ mỗi dòng mang một đoạn
    expect(tagOf("Navigation path: Login")).toEqual([{ field: "trigger", index: 0, part: 0 }])
    expect(tagOf('Interface: Login screen: "Log in to your account" text, Username input, Password input (masked), Log in button.')).toBeUndefined()
    expect(tagOf("Normal case:")).toBeUndefined()
    expect(tagOf(`Business rules: ${LOCK5}`)).toEqual([{ field: "validations", index: 2 }])
    expect(tagOf("Purpose: The user is authenticated and lands on the home page for their role.")).toEqual([{ field: "description", index: 0 }])
  })

  it("CR-001 (khoá sau 3 lần): sửa đúng dòng quy tắc + dòng luồng lỗi; mọi dòng khác, nhãn, tiêu đề con giữ nguyên văn", () => {
    const after = functionFieldValues(
      spine,
      fnOf({
        abnormal: [before.abnormal[0], "The user fails three consecutive attempts: the system locks the account temporarily for 15 minutes.", before.abnormal[2]],
        validations: [...fnOf().validations.slice(0, 2), { id: "V3", kind: "business", statement: LOCK3 }]
      })
    )
    const out = patchFunctionOriginal(tagged, before, after)!
    const expected = texts(LOGIN).map((t) =>
      t === `Business rules: ${LOCK5}` ? `Business rules: ${LOCK3}` : t.startsWith("The user fails five") ? "The user fails three consecutive attempts: the system locks the account temporarily for 15 minutes." : t
    )
    expect(texts(out)).toEqual(expected)
  })

  it("thêm bước luồng chính ⇒ chèn sau bước đứng trước trong danh sách chính (không vào Data processing); xoá luồng lỗi ⇒ bỏ dòng, nhãn giữ", () => {
    const after = functionFieldValues(
      spine,
      fnOf({ normal: [...fnOf().normal.slice(0, 2), "The system records the login time.", fnOf().normal[2]], abnormal: fnOf().abnormal.slice(0, 2) })
    )
    const t = texts(patchFunctionOriginal(tagged, before, after)!)
    expect(t.filter((x) => x === "The system records the login time.")).toHaveLength(1)
    const at = t.indexOf("The system records the login time.")
    expect(t[at - 1]).toBe(fnOf().normal[1])
    expect(t.indexOf("The system records the login time.")).toBeGreaterThan(t.indexOf("Normal case:"))
    expect(t).not.toContain("The authentication service is unavailable: the system shows a try-again message.")
    expect(t).toContain("Abnormal case:")
    expect(t).toContain("Navigation path: Login")
  })

  it("trường file không ghi mà CR thêm ⇒ cuối mục có nhãn; phần tử có chữ mà không khối nào chứa ⇒ null (dựng lại cả mục)", () => {
    const withRule: Spine = { ...spine, business_rules: [{ id: "BR-07", tier: "detail", statement: "Sessions expire after 30 minutes", source_validation_ids: [] }] }
    const out = patchFunctionOriginal(tagged, before, functionFieldValues(withRule, fnOf({ business_rule_ids: ["BR-07"] })))!
    expect(texts(out).slice(-2)).toEqual(["Business rules", "Sessions expire after 30 minutes"])
    // trigger lúc import ghép từ hai dòng ("Login; A lecturer…"): giá trị mới khác số đoạn ⇒ không sửa tại chỗ được
    expect(patchFunctionOriginal(tagged, before, functionFieldValues(spine, fnOf({ trigger: "User opens the app" })))).toBeNull()
    // phần tử có chữ mà không khối nào chứa ⇒ null
    const lost = tagFunctionBlocks(LOGIN.filter((b) => b.kind === "image" || b.kind === "heading" || !b.text.startsWith("The authentication")), before)
    expect(patchFunctionOriginal(lost, before, functionFieldValues(spine, fnOf({ abnormal: [...fnOf().abnormal.slice(0, 2), "Service down: retry later."] })))).toBeNull()
  })

  it("phần tử nằm giữa câu của file, khác hoa thường đầu câu ⇒ vẫn khớp; sửa giữ chữ thường như file", () => {
    const vals = functionFieldValues(spine, fnOf({ normal: ["The system scans student records older than four years."] }))
    const blocks = tagFunctionBlocks([item("Every day at 2:00 AM the system scans student records older than four years.")], vals)
    expect(blocks[0].tags).toEqual([{ field: "normal", index: 0 }])
    const after = functionFieldValues(spine, fnOf({ normal: ["The system scans student records older than five years."] }))
    expect(texts(patchFunctionOriginal(blocks, vals, after)!)).toEqual(["Every day at 2:00 AM the system scans student records older than five years."])
  })

  it("trigger ghép hai dòng (Navigation path + Timing frequency): CR sửa cùng số đoạn ⇒ sửa đúng từng dòng, giữ nhãn; \"Validation: N/A\" khớp phần sau nhãn", () => {
    const after = functionFieldValues(spine, fnOf({ trigger: "Login > Home; A user enters their credentials and presses Enter." }))
    const t = texts(patchFunctionOriginal(tagged, before, after)!)
    expect(t).toContain("Navigation path: Login > Home")
    expect(t).toContain("Timing frequency: A user enters their credentials and presses Enter.")
    expect(t.length).toBe(LOGIN.length)
    const na = [head("Function details"), item("Validation: N/A")]
    const naBefore = functionFieldValues(spine, fnOf({ validations: [{ id: "V1", kind: "required", statement: "N/A" }] }))
    const naTagged = tagFunctionBlocks(na, naBefore)
    expect(naTagged[1].tags).toEqual([{ field: "validations", index: 0 }])
    const naAfter = functionFieldValues(spine, fnOf({ validations: [{ id: "V1", kind: "required", statement: "Email must be valid." }] }))
    expect(texts(patchFunctionOriginal(naTagged, naBefore, naAfter)!)).toEqual(["# Function details", "Validation: Email must be valid."])
  })

  it("buildLayoutSections: chưa sửa ⇒ nguyên văn có 4 tiêu đề con (cấp theo mục); CR sửa ⇒ đủ dòng của file", () => {
    const fn = fnOf()
    const s: Spine = { ...createEmptySpine({ name: "FAP" }), features: [{ id: "F-01", name: "Authentication", order: 0 }] as never, functions: [fn] }
    const template: TemplateLayout = {
      language: "en",
      layout: [
        { order: 0, heading_text: "3.2 Authentication", level: 2, section_id: "feature:F-01" },
        { order: 1, heading_text: "3.2.1 Log In", level: 3, section_id: "function:FR-3.2.1" }
      ] as never,
      functionOriginals: [{ section_id: "function:FR-3.2.1", source_hash: functionSourceHash(fn), field_values: before, blocks: tagged }]
    }
    const render = (sp: Spine) => buildLayoutSections(sp, template, [], { diagramPng: (id) => `ref:${id}` }).sections.find((x) => x.id === "function:FR-3.2.1")!
    const v01 = render(s)
    expect(v01.blocks.filter((b) => b.type === "heading")).toEqual(
      ["Function trigger", "Function description", "Screen layout", "Function details"].map((text) => ({ type: "heading", level: v01.level + 1, text }))
    )
    const edited = render({ ...s, functions: [fnOf({ validations: [...fn.validations.slice(0, 2), { id: "V3", kind: "business", statement: LOCK3 }] })] })
    const json = JSON.stringify(edited.blocks)
    for (const keep of ["Navigation path: Login", "Interface: Login screen", "Data processing:", "Normal case:", "Abnormal case:", "Username must not be empty."]) expect(json).toContain(keep)
    expect(json).toContain(`Business rules: ${LOCK3}`)
    expect(json).not.toContain("after five consecutive failed login attempts and unlocks")
    expect(edited.blocks.filter((b) => b.type === "heading")).toHaveLength(4)
  })

  it("FLF-468 (lát C): mẫu cố định, mục chức năng dùng tiêu đề con FPT — CR đổi trigger không sửa tại chỗ được (dựng lại cả mục) vẫn giữ khung FPT, không rơi về nhãn 'Kích hoạt:' / thẻ loại validation thô \"[business]\"", () => {
    const fn = fnOf({ trigger: "User opens the app" }) // số đoạn trigger khác lúc import ⇒ patchFunctionOriginal trả null
    const s: Spine = { ...createEmptySpine({ name: "FAP" }), features: [{ id: "F-01", name: "Authentication", order: 0 }] as never, functions: [fn] }
    const template: TemplateLayout = {
      language: "en",
      fixedTemplate: true,
      layout: [
        { order: 0, heading_text: "3.2 Authentication", level: 2, section_id: "feature:F-01" },
        { order: 1, heading_text: "3.2.1 Log In", level: 3, section_id: "function:FR-3.2.1" }
      ] as never,
      functionOriginals: [{ section_id: "function:FR-3.2.1", source_hash: functionSourceHash(fnOf()), field_values: before, blocks: tagged }]
    }
    const rendered = buildLayoutSections(s, template, [], { diagramPng: (id) => `ref:${id}` }).sections.find((x) => x.id === "function:FR-3.2.1")!
    const json = JSON.stringify(rendered.blocks)
    expect(json).toContain("Function trigger")
    expect(json).not.toContain("Kích hoạt")
    expect(json).not.toMatch(/\[business\]/)
  })
})

describe("FLF-468 (E2E-1) - thân chức năng mới theo khuôn chức năng anh em", () => {
  const text = (blocks: readonly FunctionOriginalBlock[] | null) => (blocks ?? []).map((b) => [b.kind, "text" in b ? b.text : ""])
  /** FR-3.5.1 kiểu đoạn có nhãn (không tiêu đề con): "Function trigger: …", "Function description: …". */
  const SIB_VALUES = functionFieldValues(spine, fnOf({
    trigger: "The Student opens SCR-08 Tuition.",
    description: "The system shows the unpaid fees and lets the Student pay online.",
    normal: ["The Student selects a fee and clicks Pay.", "The system redirects to the payment gateway."],
    abnormal: ["The gateway is down: the system shows a retry message."],
    validations: [{ id: "V1", kind: "required", statement: "A fee must be selected." }, { id: "V2", kind: "business", statement: "Only unpaid fees can be paid." }]
  }))
  const PAY: FunctionOriginalBlock[] = [
    para("Function trigger: The Student opens SCR-08 Tuition."),
    para("Function description: The system shows the unpaid fees and lets the Student pay online."),
    para("Normal case:"),
    item("The Student selects a fee and clicks Pay."),
    item("The system redirects to the payment gateway."),
    para("Abnormal case:"),
    item("The gateway is down: the system shows a retry message."),
    para("Validation:"),
    item("A fee must be selected."),
    item("Only unpaid fees can be paid.")
  ]
  const sibling = tagFunctionBlocks(PAY, SIB_VALUES)
  const fresh = functionFieldValues(spine, fnOf({
    id: "FR-05", name: "Reset Password", trigger: "The user clicks Forgot password.", description: "The system emails a reset link.",
    normal: ["The user enters their email.", "The system sends the link."], abnormal: ["The email is unknown: the system shows an error."],
    validations: [{ id: "V1", kind: "required", statement: "Email must not be empty." }, { id: "V2", kind: "business", statement: "A link expires after 30 minutes." }]
  }))

  it("mục mẫu kiểu đoạn có nhãn ⇒ Function trigger / Function description, nhãn riêng dòng, mỗi phần tử một khối cùng kiểu", () => {
    expect(text(functionBlocksLikeSibling(sibling, fresh, SIB_VALUES))).toEqual([
      ["paragraph", "Function trigger: The user clicks Forgot password."],
      ["paragraph", "Function description: The system emails a reset link."],
      ["paragraph", "Normal case:"], ["list_item", "The user enters their email."], ["list_item", "The system sends the link."],
      ["paragraph", "Abnormal case:"], ["list_item", "The email is unknown: the system shows an error."],
      ["paragraph", "Validation:"], ["list_item", "Email must not be empty."], ["list_item", "A link expires after 30 minutes."]
    ])
  })

  it("không in thẻ loại validation, không tiêu đề con, không dòng Screens", () => {
    const json = JSON.stringify(functionBlocksLikeSibling(sibling, fresh, SIB_VALUES))
    for (const raw of ["[required]", "[business]", "[format]", "Screens:", '"heading"']) expect(json).not.toContain(raw)
  })

  it("trường mục mẫu không có ⇒ nhãn mặc định ở cuối; trường của chức năng mới trống ⇒ bỏ", () => {
    const withoutAbnormal = PAY.filter((b) => !("text" in b) || !/^(Abnormal case|The gateway)/.test(b.text))
    const out = text(functionBlocksLikeSibling(tagFunctionBlocks(withoutAbnormal, SIB_VALUES), fresh, SIB_VALUES))
    expect(out.slice(-2)).toEqual([["paragraph", "Abnormal case:"], ["list_item", "The email is unknown: the system shows an error."]])
    const sparse = functionFieldValues(spine, fnOf({ id: "FR-06", trigger: "t", description: "", normal: [], abnormal: [], validations: [] }))
    expect(text(functionBlocksLikeSibling(sibling, sparse, SIB_VALUES))).toEqual([["paragraph", "Function trigger: t"]])
  })

  it("mục mẫu ghi nhãn ngay trong khối danh sách ⇒ mỗi phần tử mang nhãn đó (kể cả khi không có giá trị mẫu)", () => {
    const labelled = tagFunctionBlocks([item("Validation: A fee must be selected."), item("Validation: Only unpaid fees can be paid.")], SIB_VALUES)
    const expected = [["list_item", "Validation: Email must not be empty."], ["list_item", "Validation: A link expires after 30 minutes."]]
    expect(text(functionBlocksLikeSibling(labelled, fresh, SIB_VALUES)).slice(0, 2)).toEqual(expected)
    expect(text(functionBlocksLikeSibling(labelled, fresh)).slice(0, 2)).toEqual(expected)
  })

  it("mục mẫu dùng tiêu đề con hoặc không gắn phần tử nào ⇒ null (người gọi dùng khung FPT)", () => {
    expect(functionBlocksLikeSibling(tagFunctionBlocks(LOGIN, functionFieldValues(spine, fnOf())), fresh)).toBeNull()
    expect(functionBlocksLikeSibling([para("Free text")], fresh)).toBeNull()
  })
})
