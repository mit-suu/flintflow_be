import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Op } from "./op.types.js"
import type { Spine } from "./spine.types.js"
import { addedScreenIds, addsUseCaseOrScreen, declareTempIds, newUseCaseScreenIssues, useCaseScreenNote, useCaseScreenProblemText, wantsSharedScreen, isAddUseCaseInstruction, normalizeUseCaseBatch, useCaseContext, useCaseMode, useCaseOverlapNote, useCaseOverlaps, applyScreenKind, screenKindChoice, screenKindQuestion } from "./use-case-propagation.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** Fixture 19 màn: S-9, mọi bước accepted. */
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

const withPhase = (phase: string, accepted = true): Spine => ({
  ...structuredClone(FIXTURE),
  progress: { ...FIXTURE.progress, current_phase: phase },
  steps: FIXTURE.steps.map((s) => ({ ...s, status: accepted ? s.status : "pending" }))
})

describe("isAddUseCaseInstruction", () => {
  it("lệnh thêm use case (vi / en) ⇒ true; sửa use case có sẵn hay thêm thứ khác ⇒ false", () => {
    expect(isAddUseCaseInstruction('Thêm use case mới "Send Absence Warning" cho Lecturer')).toBe(true)
    expect(isAddUseCaseInstruction("bổ sung UC gửi cảnh báo vắng")).toBe(true)
    expect(isAddUseCaseInstruction("Add a use case Export Grade Sheet")).toBe(true)
    expect(isAddUseCaseInstruction("Đổi tên use case Log In thành Sign In")).toBe(false)
    expect(isAddUseCaseInstruction("Thêm popup xác nhận cho màn Class List")).toBe(false)
  })
})

describe("useCaseMode", () => {
  it("chưa có màn hình (S-4.1 chưa accepted) ⇒ use_case_only", () => {
    expect(useCaseMode(withPhase("S-3", false))).toBe("use_case_only")
  })
  it("S-4 / đang ở S-5 ⇒ screen_pending (vòng S-5 mô tả màn mới)", () => {
    expect(useCaseMode(withPhase("S-4"))).toBe("screen_pending")
    expect(useCaseMode(withPhase("S-5"))).toBe("screen_pending")
  })
  it("đã qua S-5 hoặc đã có baseline ⇒ full", () => {
    expect(useCaseMode(withPhase("S-9"))).toBe("full")
    const baseline = { ...withPhase("S-5"), baselines: [{ id: "BL001", version: "v1.0", type: "generated" as const, doc_version: null, at: "2026-10-01T00:00:00.000Z", snapshot_ref: "x", checked_at_version: 1, waived_count: 0 }] }
    expect(useCaseMode(baseline)).toBe("full")
  })
})

describe("useCaseContext", () => {
  it("full ⇒ feature, vai trò, màn có luồng, chức năng, thông báo, quy tắc + một chức năng mẫu đủ chi tiết", () => {
    const context = useCaseContext(FIXTURE, "full")
    expect(context.mode).toBe("full")
    expect(context.roles).toContainEqual({ id: "R2", name: "Analyst", actor_id: "A02" })
    expect((context.screens as { id: string; flow_to: string[] }[]).find((s) => s.id === "S01")?.flow_to).toContain("S02")
    const sample = context.sample_function as Spine["functions"][number]
    expect(sample.normal.length).toBeGreaterThan(0)
    expect(sample.validations.length).toBeGreaterThan(0)
  })
  it("use_case_only ⇒ chỉ chế độ, không nạp thêm", () => {
    expect(useCaseContext(FIXTURE, "use_case_only")).toEqual({ mode: "use_case_only" })
  })
})

const batch = (): Op[] => [
  { op: "add", path: "use_cases[]", value: { name: "Send Absence Warning", actor_ids: ["A02"], function_ids: ["$newFn"], description: "…" } },
  { op: "add", path: "screens[]", value: { id: "$newScreen", name: "Absence Warning", description: "…", feature_id: "F3", flow_to: [], tabs: [] } },
  {
    op: "add",
    path: "functions[]",
    // feature_id sai (F1) và order trùng (0) — code phải sửa theo màn và cấp số kế tiếp
    value: { id: "$newFn", name: "Send Warning", screen_id: "$newScreen", feature_id: "F1", order: 0, trigger: "…", description: "…", normal: ["a"], abnormal: [], validations: [] }
  },
  { op: "add", path: "functions[]", value: { id: "$newFn2", name: "Preview Warning", screen_id: "$newScreen", feature_id: "F3", trigger: "…", description: "…", normal: [], abnormal: [], validations: [] } }
]

describe("normalizeUseCaseBatch", () => {
  it("chức năng mới: feature theo màn (bất biến 6), order kế tiếp không trùng trong feature (bất biến 5)", () => {
    const ops = normalizeUseCaseBatch(FIXTURE, batch())
    const maxF3 = Math.max(...FIXTURE.functions.filter((f) => f.feature_id === "F3" && f.screen_id !== null).map((f) => f.order))
    const fns = ops.filter((o) => o.path === "functions[]").map((o) => o.value as { feature_id: string; order: number })
    expect(fns.map((f) => f.feature_id)).toEqual(["F3", "F3"])
    expect(fns.map((f) => f.order)).toEqual([maxF3 + 1, maxF3 + 2])
  })

  it("màn mới: đã qua S-5 ⇒ signed_off; còn vòng S-5 ⇒ pending; primary_function_id = chức năng đầu của màn (op set cuối lô)", () => {
    const ops = normalizeUseCaseBatch(FIXTURE, batch())
    const screenOf = (spine: Spine) => normalizeUseCaseBatch(spine, batch()).find((o) => o.path === "screens[]")?.value as Record<string, unknown>
    expect(screenOf(FIXTURE)).toMatchObject({ detail_status: "signed_off", primary_function_id: null, is_popup: false, queue_order: null })
    expect(screenOf(withPhase("S-5")).detail_status).toBe("pending")
    expect(ops[ops.length - 1]).toEqual({ op: "set", path: "screens[id=$newScreen].primary_function_id", value: "$newFn" })
  })

  it("sắp lô theo phụ thuộc id tạm: màn → chức năng → use case → phần còn lại, không mất op nào", () => {
    const input: Op[] = [{ op: "set", path: "screens[id=S07].flow_to", value: ["S08", "$newScreen"] }, ...batch()]
    const ops = normalizeUseCaseBatch(FIXTURE, input)
    expect(ops.map((o) => o.path)).toEqual(["screens[]", "functions[]", "functions[]", "use_cases[]", "screens[id=S07].flow_to", "screens[id=$newScreen].primary_function_id"])
  })

  it("lô không thêm chức năng / màn ⇒ giữ nguyên", () => {
    const ops: Op[] = [{ op: "set", path: "use_cases[id=UC01].name", value: "Sign In" }]
    expect(normalizeUseCaseBatch(FIXTURE, ops)).toEqual(ops)
  })
})

describe("normalizeUseCaseBatch — mã thông báo (S-7.3) cho luồng bất thường mới", () => {
  const withFn = (message: Record<string, unknown>): Op[] => [
    ...batch(),
    { op: "add", path: "messages[]", value: { text: "Select at least one student, then send again.", function_ids: ["$newFn"], ...message } }
  ]
  const codeOf = (ops: Op[]) => (ops.find((o) => o.path === "messages[]")?.value as { code: string }).code

  it("model chọn vùng ⇒ giữ vùng, code cấp số kế tiếp không trùng", () => {
    expect(codeOf(normalizeUseCaseBatch(FIXTURE, withFn({ code: "E-AUTH-001" })))).toBe("E-AUTH-004")
    expect(codeOf(normalizeUseCaseBatch(FIXTURE, withFn({ code: "E-WARN-001" })))).toBe("E-WARN-001")
  })

  it("không có mã ⇒ vùng của thông báo cùng feature; feature chưa có thông báo ⇒ chữ đầu tên feature", () => {
    expect(codeOf(normalizeUseCaseBatch(FIXTURE, withFn({})))).toMatch(/^E-(CRED|PIPE|SPINE)-\d{3}$/)
    const noMessages = { ...FIXTURE, messages: [] }
    expect(codeOf(normalizeUseCaseBatch(noMessages, withFn({})))).toBe("SRSW-001")
  })

  it("hai thông báo mới trong một lô không trùng mã", () => {
    const ops: Op[] = [...withFn({ code: "E-WARN-001" }), { op: "add", path: "messages[]", value: { code: "E-WARN-001", text: "x", function_ids: ["$newFn"] } }]
    const codes = normalizeUseCaseBatch(FIXTURE, ops).filter((o) => o.path === "messages[]").map((o) => (o.value as { code: string }).code)
    expect(codes).toEqual(["E-WARN-001", "E-WARN-002"])
  })
})

describe("declareTempIds — model dùng id tạm mà quên khai báo (e2e FLF-311, GLM thật)", () => {
  /** Đúng dạng lô GLM trả: `$newFn1/2`, `$newScreen` được tham chiếu nhưng phần tử thêm vào không mang `id`. */
  const glmBatch = (): Op[] => [
    { op: "add", path: "use_cases[]", value: { name: "Share Read-Only Link", actor_ids: ["A02"], function_ids: ["$newFn1", "$newFn2"] } },
    { op: "add", path: "functions[]", value: { name: "Create Share Link", screen_id: "$newScreen", feature_id: "F4" } },
    { op: "add", path: "functions[]", value: { name: "Revoke Share Link", screen_id: "$newScreen", feature_id: "F4" } },
    { op: "add", path: "screens[]", value: { name: "Share Link", feature_id: "F4", flow_to: ["S07"], tabs: [] } },
    { op: "set", path: "screens[id=S10].flow_to", value: ["S07", "$newScreen"] },
    { op: "add", path: "permissions[]", value: { screen_id: "$newScreen", role_id: "R2", action: "view" } }
  ]

  it("gán id tạm được tham chiếu cho phần tử chưa có id cùng loại, theo thứ tự", () => {
    const ops = declareTempIds(glmBatch())
    const ids = (path: string) => ops.filter((o) => o.path === path).map((o) => (o.value as { id?: string }).id)
    expect(ids("functions[]")).toEqual(["$newFn1", "$newFn2"])
    expect(ids("screens[]")).toEqual(["$newScreen"])
  })

  it("đã khai báo đủ ⇒ không đổi; thiếu phần tử để gán ⇒ để nguyên (bất biến báo lỗi)", () => {
    const declaredBatch = batch()
    expect(declareTempIds(declaredBatch)).toEqual(declaredBatch)
    const orphanRef: Op[] = [{ op: "add", path: "use_cases[]", value: { name: "X", function_ids: ["$ghost"] } }]
    expect(declareTempIds(orphanRef)).toEqual(orphanRef)
  })

  it("lô GLM sau chuẩn hoá: mọi tham chiếu tạm có phần tử khai báo đứng trước nó", () => {
    const ops = normalizeUseCaseBatch(FIXTURE, glmBatch())
    const declaredAt = new Map<string, number>()
    ops.forEach((o, i) => {
      const id = (o.value as { id?: unknown } | undefined)?.id
      if (o.op === "add" && typeof id === "string") declaredAt.set(id, i)
    })
    ops.forEach((o, i) => {
      for (const ref of JSON.stringify(o).match(/\$new\w+/g) ?? []) expect(declaredAt.get(ref), `${ref} ở op ${i}`).toBeLessThanOrEqual(i)
    })
  })
})

describe("addedScreenIds / addsUseCaseOrScreen", () => {
  it("nhận ra màn và use case mới", () => {
    const after = { ...FIXTURE, screens: [...FIXTURE.screens, { ...FIXTURE.screens[0], id: "S20" }] }
    expect(addedScreenIds(FIXTURE, after)).toEqual(["S20"])
    expect(addsUseCaseOrScreen(FIXTURE, after)).toBe(true)
    expect(addsUseCaseOrScreen(FIXTURE, FIXTURE)).toBe(false)
  })
})

describe("newUseCaseScreenIssues — phần giao diện còn thiếu của use case mới, theo lựa chọn của user", () => {
  /** Lệnh sinh hai use case: Business Analyst (R2) gửi yêu cầu, Founder (R1) duyệt — màn mở từ S01. */
  const withUseCases = (pairs: { uc: string; actor: string; role: string; screen: string; edge?: boolean; view?: boolean }[]): Spine => {
    const after = structuredClone(FIXTURE)
    for (const [i, p] of pairs.entries()) {
      const fn = `FN9${i}`
      if (!after.screens.some((s) => s.id === p.screen)) after.screens.push({ ...FIXTURE.screens[1], id: p.screen, name: `Screen ${p.screen}`, flow_to: [] })
      if (p.edge !== false) after.screens[0].flow_to.push(p.screen)
      after.functions.push({ ...FIXTURE.functions[0], id: fn, screen_id: p.screen })
      after.use_cases.push({ ...FIXTURE.use_cases[0], id: p.uc, name: `Use Case ${p.uc}`, actor_ids: [p.actor], function_ids: [fn] })
      if (p.view !== false) after.permissions.push({ id: `P9${i}`, screen_id: p.screen, role_id: p.role, action: "view" })
    }
    return after
  }
  const shared = () =>
    withUseCases([
      { uc: "UC90", actor: "A02", role: "R2", screen: "S90" },
      { uc: "UC91", actor: "A01", role: "R1", screen: "S90", edge: false }
    ])

  it("mỗi use case một màn mới có luồng vào và quyền ⇒ không thiếu gì", () => {
    const after = withUseCases([
      { uc: "UC90", actor: "A02", role: "R2", screen: "S90" },
      { uc: "UC91", actor: "A01", role: "R1", screen: "S91" }
    ])
    expect(newUseCaseScreenIssues(FIXTURE, after)).toEqual([])
  })

  it("hai use case mới chung một màn mới, user không chọn dùng chung ⇒ nhắc tách", () => {
    const issues = newUseCaseScreenIssues(FIXTURE, shared())
    expect(issues).toEqual([{ kind: "shared_new_screen", use_case: "UC91", name: "Use Case UC91", other: "UC90", screen: "Screen S90" }])
    expect(useCaseScreenProblemText(issues[0])).toContain("unless the user chose one shared screen")
  })

  it("user chọn dùng chung một màn ⇒ không nhắc gì (không ép tách)", () => {
    expect(newUseCaseScreenIssues(FIXTURE, shared(), { allowShared: true })).toEqual([])
  })

  it("màn có sẵn dùng chung luôn được", () => {
    const after = withUseCases([
      { uc: "UC90", actor: "A02", role: "R2", screen: "S02", edge: false },
      { uc: "UC91", actor: "A01", role: "R1", screen: "S02", edge: false }
    ])
    expect(newUseCaseScreenIssues(FIXTURE, after)).toEqual([])
  })

  it("màn mới không có cạnh vào / vai trò thiếu quyền view / chức năng không màn ⇒ báo từng chỗ", () => {
    const after = withUseCases([
      { uc: "UC90", actor: "A02", role: "R2", screen: "S90", edge: false },
      { uc: "UC91", actor: "A01", role: "R1", screen: "S91", view: false }
    ])
    after.use_cases.push({ ...FIXTURE.use_cases[0], id: "UC92", name: "Use Case UC92", actor_ids: ["A03"], function_ids: [] })
    expect(newUseCaseScreenIssues(FIXTURE, after).map((i) => `${i.kind}:${i.use_case}`)).toEqual(["no_edge:UC90", "no_view:UC91", "no_screen:UC92"])
  })

  it("use case mới của actor hệ thống / thời gian ⇒ không cần màn", () => {
    const after = structuredClone(FIXTURE)
    after.use_cases.push({ ...FIXTURE.use_cases[0], id: "UC90", name: "Send Weekly Report", actor_ids: ["A09"], function_ids: [] })
    expect(newUseCaseScreenIssues(FIXTURE, after)).toEqual([])
  })

  it("useCaseScreenNote: ghi chú cho người dùng trên bản xem trước (vi / en), không có gì ⇒ null", () => {
    const issues = newUseCaseScreenIssues(FIXTURE, shared())
    expect(useCaseScreenNote(issues)).toContain('Nhắn "tách màn riêng"')
    expect(useCaseScreenNote(issues, "en")).toContain('"separate screens"')
    expect(useCaseScreenNote([])).toBeNull()
  })
})

describe("skill apply-change-op — khối luật 3e theo chế độ (FLF-311)", () => {
  const render = async (vars: Record<string, unknown>): Promise<string> => {
    const { getSkill, interpolatePrompt } = await import("../../shared/ai/prompt-registry.service.js")
    return interpolatePrompt(getSkill("apply-change-op").template, vars)
  }

  it("full ⇒ kiểm trùng use case + màn riêng khi có tương tác + chức năng đủ Functional Requirements", async () => {
    const prompt = await render({ use_case_mode: "full", use_case_ui: true })
    expect(prompt).toContain("One use case = one goal")
    expect(prompt).toContain("Same or overlapping goal as a `use_case_context.use_cases` entry")
    expect(prompt).toContain("**The UI of each new use case is the user's call**")
    expect(prompt).toContain("**the screen or popup the user chose**")
    expect(prompt).toContain('`choices` ["Màn hình riêng", "Popup mở từ <screen>"]')
    expect(prompt).toContain("`normal[]` steps, `abnormal[]` cases, `validations[]`")
    expect(prompt).not.toContain("the screen loop details it")
  })

  it("screen_pending ⇒ cùng luật kiểm trùng + màn, chức năng tối thiểu để vòng S-5 mô tả", async () => {
    const prompt = await render({ use_case_mode: "screen_pending", use_case_ui: true })
    expect(prompt).toContain("One use case = one goal")
    expect(prompt).toContain("the screen loop details it")
    expect(prompt).not.toContain("`normal[]` steps")
  })

  it("messages_ready ⇒ thêm luật 3f (thông báo cho luồng bất thường); không bật ⇒ không có", async () => {
    expect(await render({ use_case_mode: "full", use_case_ui: true, messages_ready: true })).toMatch(/^3f\. \*\*Application messages/m)
    expect(await render({ use_case_mode: "full", use_case_ui: true, messages_ready: false })).not.toMatch(/^3f\./m)
  })

  it("none / use_case_only ⇒ không có luật 3e (lệnh sửa thường giữ nguyên prompt cũ)", async () => {
    for (const mode of ["none", "use_case_only"]) expect(await render({ use_case_mode: mode, use_case_ui: false })).not.toMatch(/^3e\./m)
    expect(await render({ use_case_mode: "use_case_only", use_case_ui: false })).toContain("screens do not exist yet")
  })
})

describe("useCaseOverlaps — use case mới chồng mục tiêu với use case có sẵn (FLF-311)", () => {
  const uc = (id: string, name: string, actor_ids: string[]) => ({ id, name, actor_ids, function_ids: [], description: "", includes: [], extends: [] })
  const before = { use_cases: [uc("UC20", "Deactivate Student Record", ["A03"]), uc("UC08", "Create Student Record", ["A03"]), uc("UC24", "Archive Project", ["A01"])] }

  it("động từ cùng nhóm nghĩa + chung đối tượng, cùng actor ⇒ chồng (Suspend Student Account ~ Deactivate Student Record)", () => {
    const after = { use_cases: [...before.use_cases, uc("UC27", "Suspend Student Account", ["A03"])] }
    expect(useCaseOverlaps(before, after)).toEqual([
      { use_case: { id: "UC27", name: "Suspend Student Account" }, existing: { id: "UC20", name: "Deactivate Student Record" }, shared: ["student"] }
    ])
  })

  it("khác nhóm động từ (Update ~ Create), khác actor, hay khác đối tượng ⇒ không báo", () => {
    const after = {
      use_cases: [
        ...before.use_cases,
        uc("UC28", "Update Student Profile", ["A03"]),
        uc("UC29", "Suspend Student Account", ["A01"]),
        uc("UC30", "Deactivate Classroom", ["A03"])
      ]
    }
    expect(useCaseOverlaps(before, after)).toEqual([])
  })

  it("trùng tên (khác hoa thường) ⇒ báo; câu cảnh báo nêu use case cũ", () => {
    const overlaps = useCaseOverlaps(before, { use_cases: [...before.use_cases, uc("UC31", "archive project", ["A01"])] })
    expect(overlaps.map((o) => o.existing.id)).toEqual(["UC24"])
    expect(useCaseOverlapNote(overlaps)).toMatch(/UC24 "Archive Project"/)
    expect(useCaseOverlapNote([])).toBeNull()
  })

  it("ngữ cảnh model có danh sách use case để tự kiểm trùng", () => {
    expect((useCaseContext(FIXTURE, "full").use_cases as { id: string }[]).map((u) => u.id)).toContain("UC24")
  })
})

describe("màn hình riêng hay popup — người dùng chọn (FLF-311)", () => {
  it("screenKindChoice: đọc lời user (câu lệnh + tin User:), bỏ lời AI; nhắc sau cùng thắng", () => {
    expect(screenKindChoice("Thêm use case X dạng popup")).toBe("popup")
    expect(screenKindChoice("thêm UC X, làm màn hình riêng")).toBe("screen")
    expect(screenKindChoice("Popup mở từ My Grades")).toBe("popup")
    expect(screenKindChoice("Thêm use case X")).toBeNull()
    expect(screenKindChoice("người nhận là sinh viên", "User: thêm UC X\nAI: Màn hình riêng hay popup?")).toBeNull()
    expect(screenKindChoice("à không, màn hình riêng", "User: thêm UC X dạng popup")).toBe("screen")
  })

  it("screenKindChoice: chọn khác nhau cho từng use case trong một câu ⇒ null (để nguyên lựa chọn từng màn)", () => {
    expect(screenKindChoice("1 màn hình riêng, 2 popup mở từ Class Grade Sheet")).toBeNull()
    expect(screenKindChoice("popup à không, màn hình riêng")).toBe("screen")
  })

  it("wantsSharedScreen: user chọn dùng chung một màn", () => {
    expect(wantsSharedScreen("Dùng chung một màn hình")).toBe(true)
    expect(wantsSharedScreen("ok", "User: thêm UC X\nAI: hỏi\nUser: hai use case cùng một màn")).toBe(true)
    expect(wantsSharedScreen("One shared screen")).toBe(true)
    expect(wantsSharedScreen("Mỗi use case một màn hình riêng")).toBe(false)
  })

  it("screenKindQuestion: lô sinh nhiều use case có giao diện ⇒ hỏi cho từng use case, có lựa chọn dùng chung", () => {
    const ops: Op[] = [
      { op: "add", path: "screens[]", value: { id: "$s1", name: "Grade Review", feature_id: "F4", flow_to: [], tabs: [] } },
      { op: "add", path: "use_cases[]", value: { name: "Request Grade Review", actor_ids: ["A02"], description: "…" } },
      { op: "add", path: "use_cases[]", value: { name: "Decide Grade Review", actor_ids: ["A01"], description: "…" } },
      { op: "add", path: "use_cases[]", value: { name: "Send Review Reminder", actor_ids: ["A09"], description: "…" } }
    ]
    const ask = screenKindQuestion(FIXTURE, ops)
    expect(ask?.text).toContain('1. "Request Grade Review" (Business Analyst)')
    expect(ask?.text).toContain('2. "Decide Grade Review" (Founder)')
    expect(ask?.text).not.toContain("Send Review Reminder")
    expect(ask?.choices).toEqual(["Mỗi use case một màn hình riêng", "Dùng chung một màn hình", "Popup"])
    expect(screenKindQuestion(FIXTURE, ops, "en")?.choices[1]).toBe("One shared screen")
  })

  it("screenKindQuestion: câu hỏi nêu màn mở ra (từ cạnh luồng) + hai lựa chọn; lô không thêm màn ⇒ null", () => {
    const ops = normalizeUseCaseBatch(FIXTURE, [...batch(), { op: "set", path: "screens[id=S07].flow_to", value: ["S08", "$newScreen"] }])
    expect(screenKindQuestion(FIXTURE, ops)).toEqual({
      text: expect.stringContaining('popup mở từ "Project Workspace"'),
      choices: ["Màn hình riêng", "Popup mở từ Project Workspace"]
    })
    expect(screenKindQuestion(FIXTURE, ops, "en")?.choices).toEqual(["Separate screen", "Popup opened from Project Workspace"])
    expect(screenKindQuestion(FIXTURE, [{ op: "set", path: "use_cases[id=UC01].name", value: "X" }])).toBeNull()
  })

  it("applyScreenKind: đặt is_popup cho màn mới của lô, không đụng op khác", () => {
    const ops = applyScreenKind(batch(), "popup")
    expect((ops.find((o) => o.path === "screens[]")?.value as { is_popup: boolean }).is_popup).toBe(true)
    expect(ops.filter((o) => o.path !== "screens[]")).toEqual(batch().filter((o) => o.path !== "screens[]"))
  })
})
