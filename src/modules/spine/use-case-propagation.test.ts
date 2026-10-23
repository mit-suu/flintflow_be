import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import { planTransaction } from "./op-engine.js"
import type { Op } from "./op.types.js"
import type { Spine } from "./spine.types.js"
import { addedScreenIds, addsUseCaseOrScreen, declareTempIds, newUseCaseScreenIssues, useCaseScreenNote, useCaseScreenProblemText, wantsSharedScreen, isAddUseCaseInstruction, normalizeUseCaseBatch, useCaseContext, useCaseMode, useCaseOverlapNote, useCaseOverlaps, applyScreenKind, screenKindChoice, screenKindQuestion, askedList, askedUseCases, confirmedProposals, parseUiAnswer, uiPlanFor, uiPlanForModel, applyUiPlan, uiPlanIssues, uiPlanNote, uiPlanProblemText } from "./use-case-propagation.js"

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

describe("declareTempIds — cạnh luồng thêm từng phần tử (flow_to[]) bằng id tạm chưa khai báo (gặp khi chạy AI thật)", () => {
  it("id tạm trong value của add …flow_to[] và trong selector …flow_to[=$x] được gán cho màn mới chưa có id", () => {
    const ops = declareTempIds([
      { op: "add", path: "screens[]", value: { name: "Confirm", feature_id: "F4", flow_to: [], tabs: [] } },
      { op: "add", path: "screens[id=S01].flow_to[]", value: "$newPopup" }
    ] as Op[])
    expect((ops[0].value as { id: string }).id).toBe("$newPopup")
    const bySelector = declareTempIds([
      { op: "add", path: "screens[]", value: { name: "Confirm", feature_id: "F4", flow_to: [], tabs: [] } },
      { op: "remove", path: "screens[id=S01].flow_to[=$p2]" }
    ] as Op[])
    expect((bySelector[0].value as { id: string }).id).toBe("$p2")
  })
})

describe("normalizeUseCaseBatch — màn mới trỏ tới màn mới đứng sau (gặp khi chạy AI thật)", () => {
  it("cạnh giữa hai màn mới thành op set flow_to cuối lô; lô áp thử được", () => {
    const ops = normalizeUseCaseBatch(FIXTURE, [
      { op: "add", path: "screens[]", value: { id: "$newScreen", name: "Select Session", description: "…", feature_id: "F4", flow_to: ["$newPopup", "S02"], tabs: [] } },
      { op: "add", path: "screens[]", value: { id: "$newPopup", name: "Confirm Request", description: "…", feature_id: "F4", flow_to: [], tabs: [], is_popup: true } },
      { op: "add", path: "functions[]", value: { ...FIXTURE.functions[0], id: "$fn", screen_id: "$newScreen", validations: [] } },
      { op: "add", path: "use_cases[]", value: { name: "Submit Absence Request", actor_ids: ["A02"], function_ids: ["$fn"], description: "…", includes: [], extends: [] } },
      { op: "set", path: `screens[id=${FIXTURE.screens[0].id}].flow_to`, value: [...FIXTURE.screens[0].flow_to, "$newScreen"] }
    ] as Op[])
    expect((ops[0].value as { flow_to: string[] }).flow_to).toEqual(["S02"])
    expect(ops.find((o) => o.path === "screens[id=$newScreen].flow_to")?.value).toEqual(["$newPopup", "S02"])
    expect(() => planTransaction(FIXTURE, { base_version: FIXTURE.spine_version, ops, by: "test", step_id: null }, { startSeq: 1 })).not.toThrow()
    // Popup không nằm trong function_ids của use case vẫn được kể là bước sau ⇒ câu hỏi chi tiết, liệt kê đủ bước
    const ask = screenKindQuestion(FIXTURE, ops)!
    expect(ask.text).toContain('1. "Submit Absence Request" (Business Analyst) — màn mới: "Select Session" → "Confirm Request"')
    expect(ask.text).toContain(`mở từ "${FIXTURE.screens[0].name}"`)
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
    expect(newUseCaseScreenIssues(FIXTURE, after).map((i) => `${i.kind}:${"use_case" in i ? i.use_case : ""}`)).toEqual(["no_edge:UC90", "no_view:UC91", "no_screen:UC92"])
  })

  it("lệnh thêm use case mà lô không có use case nào ⇒ no_use_case (gặp khi chạy AI thật); không yêu cầu ⇒ im lặng", () => {
    const onlyScreen = structuredClone(FIXTURE)
    onlyScreen.screens.push({ ...FIXTURE.screens[1], id: "S90", name: "Absence Request", flow_to: [] })
    expect(newUseCaseScreenIssues(FIXTURE, onlyScreen, { expectUseCase: true })).toContainEqual({ kind: "no_use_case" })
    expect(newUseCaseScreenIssues(FIXTURE, onlyScreen)).toEqual([])
    expect(useCaseScreenNote([{ kind: "no_use_case" }])).toContain("chưa có use case nào")
  })

  it("màn vào chỉ mở từ màn mà vai trò của actor không xem được ⇒ not_in_actor_flow", () => {
    const after = withUseCases([{ uc: "UC90", actor: "A02", role: "R2", screen: "S90" }])
    after.permissions = after.permissions.filter((p) => !(p.screen_id === FIXTURE.screens[0].id && p.role_id === "R2"))
    const issues = newUseCaseScreenIssues(FIXTURE, after).filter((i) => i.kind === "not_in_actor_flow")
    expect(issues).toHaveLength(1)
    expect(useCaseScreenNote(issues)).toContain("chưa có trong luồng của actor đó")
    const ok = withUseCases([{ uc: "UC90", actor: "A02", role: "R2", screen: "S90" }])
    ok.permissions.push({ id: "P98", screen_id: FIXTURE.screens[0].id, role_id: "R2", action: "view" })
    expect(newUseCaseScreenIssues(FIXTURE, ok).filter((i) => i.kind === "not_in_actor_flow")).toEqual([])
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
    expect(prompt).toContain("Never ask about the UI yourself")
    expect(prompt).toContain("listed in `proposed_use_cases`")
    expect(prompt).toContain("one screen per step, chained in order by `flow_to`")
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

describe("kế hoạch giao diện theo từng use case / từng màn — nhiều use case, use case đề xuất, nhiều bước (FLF-311)", () => {
  /** Lô: use case yêu cầu nhiều bước (3 màn) + use case đề xuất cho Founder + use case nền của Scheduler. */
  const multiOps = (): Op[] => [
    { op: "add", path: "screens[]", value: { id: "$s1", name: "Select Course", feature_id: "F4", flow_to: ["$s2"], tabs: [] } },
    { op: "add", path: "screens[]", value: { id: "$s2", name: "Enter Reason", feature_id: "F4", flow_to: ["$s3"], tabs: [] } },
    { op: "add", path: "screens[]", value: { id: "$s3", name: "Confirm Request", feature_id: "F4", flow_to: [], tabs: [] } },
    { op: "add", path: "screens[]", value: { id: "$s4", name: "Review Queue", feature_id: "F4", flow_to: [], tabs: [] } },
    { op: "add", path: "functions[]", value: { ...FIXTURE.functions[0], id: "$f1", screen_id: "$s1" } },
    { op: "add", path: "functions[]", value: { ...FIXTURE.functions[0], id: "$f2", screen_id: "$s2" } },
    { op: "add", path: "functions[]", value: { ...FIXTURE.functions[0], id: "$f3", screen_id: "$s3" } },
    { op: "add", path: "functions[]", value: { ...FIXTURE.functions[0], id: "$f4", screen_id: "$s4" } },
    { op: "add", path: "functions[]", value: { ...FIXTURE.functions[0], id: "$f5", screen_id: null } },
    { op: "add", path: "use_cases[]", value: { name: "Request Grade Review", actor_ids: ["A02"], function_ids: ["$f1", "$f2", "$f3"], description: "…" } },
    { op: "add", path: "use_cases[]", value: { name: "Decide Grade Review", actor_ids: ["A01"], function_ids: ["$f4"], description: "…" } },
    { op: "add", path: "use_cases[]", value: { name: "Send Review Reminder", actor_ids: ["A09"], function_ids: ["$f5"], description: "…" } },
    { op: "set", path: "screens[id=S01].flow_to", value: [...FIXTURE.screens[0].flow_to, "$s1", "$s4"] },
    { op: "add", path: "permissions[]", value: { screen_id: "$s4", role_id: "R1", action: "view" } },
    { op: "add", path: "messages[]", value: { code: "GR-001", text: "…", function_ids: ["$f4", "$f1"] } }
  ]
  const PROPOSED = ["Decide Grade Review", "Send Review Reminder"]

  it("screenKindQuestion: tách 'bạn yêu cầu' / 'AI đề xuất', nêu các màn dự kiến theo thứ tự, use case nền ghi chạy nền", () => {
    const ask = screenKindQuestion(FIXTURE, multiOps(), "vi", PROPOSED)!
    const lines = ask.text.split("\n")
    expect(lines[0]).toBe("Yêu cầu này thêm các use case sau:")
    expect(lines[1]).toBe('1. "Request Grade Review" (Business Analyst) — màn mới: "Select Course" → "Enter Reason" → "Confirm Request"')
    expect(lines[2]).toBe("AI đề xuất thêm để khớp dự án (giữ hay bỏ):")
    expect(lines[3]).toBe('2. "Decide Grade Review" (Founder) — màn mới: "Review Queue"')
    expect(lines[4]).toBe('3. "Send Review Reminder" (Scheduler) — chạy nền, không cần màn')
    expect(ask.choices).toEqual(["Giữ tất cả, mỗi use case màn riêng", "Bỏ các use case AI đề xuất", "Dùng chung một màn hình"])
  })

  it("screenKindQuestion: một use case nhiều màn (không đề xuất) cũng hỏi chi tiết", () => {
    const ops = multiOps().filter((o) => !(o.path === "use_cases[]" && (o.value as { name: string }).name !== "Request Grade Review"))
    const ask = screenKindQuestion(FIXTURE, ops)!
    expect(ask.text).toContain('1. "Request Grade Review" (Business Analyst) — màn mới: "Select Course" → "Enter Reason" → "Confirm Request"')
    expect(ask.choices[0]).toBe("Mỗi use case một màn hình riêng")
  })

  it("askedList: đọc lại câu hỏi gần nhất — tên, nhóm đề xuất, màn dự kiến", () => {
    const ask = screenKindQuestion(FIXTURE, multiOps(), "vi", PROPOSED)!
    const history = `User: thêm use case phúc khảo\nAI: ${ask.text}`
    expect(askedList(history)).toEqual([
      { name: "Request Grade Review", proposed: false, screens: ["Select Course", "Enter Reason", "Confirm Request"] },
      { name: "Decide Grade Review", proposed: true, screens: ["Review Queue"] },
      { name: "Send Review Reminder", proposed: true, screens: [] }
    ])
    expect(askedUseCases("AI: Màn hình riêng hay popup?")).toEqual([])
  })

  const ASKED = [
    { name: "Request Grade Review", proposed: false, screens: ["Select Course", "Enter Reason", "Confirm Request"] },
    { name: "Decide Grade Review", proposed: true, screens: ["Review Queue"] },
    { name: "View Review Status", proposed: true, screens: ["Review Status"] },
    { name: "Send Review Reminder", proposed: true, screens: [] }
  ]
  const pick = (plan: ReturnType<typeof parseUiAnswer>) => plan.map(({ index, kind, group, screen, drop, merge, popupScreens }) => ({ index, kind, group, screen, drop, merge, popupScreens }))

  it("parseUiAnswer: trả lời theo số và theo màn — màn riêng + bước popup, dùng chung, bỏ, gộp thành 1 màn", () => {
    const plan = parseUiAnswer('1 màn riêng, bước "Confirm Request" là popup; 2 và 3 dùng chung một màn; bỏ 4', ASKED)
    expect(pick(plan)).toEqual([
      { index: 1, kind: "own", group: undefined, screen: undefined, drop: undefined, merge: undefined, popupScreens: ["Confirm Request"] },
      { index: 2, kind: "shared", group: 2, screen: undefined, drop: undefined, merge: undefined, popupScreens: undefined },
      { index: 3, kind: "shared", group: 2, screen: undefined, drop: undefined, merge: undefined, popupScreens: undefined },
      { index: 4, kind: undefined, group: undefined, screen: undefined, drop: true, merge: undefined, popupScreens: undefined }
    ])
    const merged = parseUiAnswer("1 gộp thành 1 màn, 2 popup mở từ Dashboard, 3 dùng màn có sẵn Class List", ASKED)
    expect(pick(merged).slice(0, 3)).toEqual([
      { index: 1, kind: undefined, group: undefined, screen: undefined, drop: undefined, merge: true, popupScreens: undefined },
      { index: 2, kind: "popup", group: undefined, screen: "Dashboard", drop: undefined, merge: undefined, popupScreens: undefined },
      { index: 3, kind: "existing", group: undefined, screen: "Class List", drop: undefined, merge: undefined, popupScreens: undefined }
    ])
  })

  it("parseUiAnswer: nút chọn nhanh — giữ tất cả / bỏ use case đề xuất / dùng chung", () => {
    expect(parseUiAnswer("Giữ tất cả, mỗi use case màn riêng", ASKED).map((e) => [e.index, e.kind ?? null, e.drop ?? false])).toEqual([
      [1, "own", false],
      [2, "own", false],
      [3, "own", false],
      [4, "own", false]
    ])
    expect(parseUiAnswer("Bỏ các use case AI đề xuất", ASKED).map((e) => [e.index, e.drop ?? false])).toEqual([
      [2, true],
      [3, true],
      [4, true]
    ])
    expect(new Set(parseUiAnswer("Dùng chung một màn hình", ASKED).map((e) => `${e.kind}:${e.group}`))).toEqual(new Set(["shared:1"]))
  })

  it("parseUiAnswer: '1 màn riêng, bỏ các use case AI đề xuất' ⇒ giữ 1 (chữ 'bỏ' của cụm đề xuất không thuộc số 1) — lỗi gặp khi chạy AI thật", () => {
    expect(parseUiAnswer("1 màn riêng, bỏ các use case AI đề xuất", ASKED).map((e) => [e.index, e.kind ?? null, e.drop ?? false])).toEqual([
      [1, "own", false],
      [2, null, true],
      [3, null, true],
      [4, null, true]
    ])
  })

  it("parseUiAnswer: trả lời không đọc được ⇒ chỉ còn use case đề xuất (mặc định giữ), không quyết định gì thêm", () => {
    expect(parseUiAnswer("ok", ASKED).map((e) => [e.index, e.kind ?? null, e.drop ?? false])).toEqual([
      [2, null, false],
      [3, null, false],
      [4, null, false]
    ])
    expect(parseUiAnswer("ok", ["A", "B"])).toEqual([])
  })

  it("uiPlanFor: chỉ khi hội thoại có câu hỏi chi tiết", () => {
    const ask = screenKindQuestion(FIXTURE, multiOps(), "vi", PROPOSED)!
    expect(uiPlanFor("1 popup, bỏ 3", `AI: ${ask.text}`).map((e) => [e.index, e.kind ?? null, e.drop ?? false])).toEqual([
      [1, "popup", false],
      [2, null, false],
      [3, null, true]
    ])
    expect(uiPlanFor("Màn hình riêng", "AI: Màn hình riêng hay popup?")).toEqual([])
  })

  it("uiPlanForModel: câu cho model — bỏ, dùng chung (nêu tên cùng nhóm), gộp màn, màn popup", () => {
    const plan = parseUiAnswer('1 màn riêng, bước "Confirm Request" là popup; 2 và 3 dùng chung; bỏ 4', ASKED)
    expect(uiPlanForModel(plan)).toEqual([
      { use_case: "Request Grade Review", ui: 'its own new screen(s), used by no other new use case; screen(s) "Confirm Request" are popups' },
      { use_case: "Decide Grade Review", ui: 'one new screen shared with "View Review Status"' },
      { use_case: "View Review Status", ui: 'one new screen shared with "Decide Grade Review"' },
      { use_case: "Send Review Reminder", ui: "DROPPED by the user: do not add this use case or any of its parts" }
    ])
    expect(uiPlanForModel(parseUiAnswer("1 gộp thành 1 màn", ASKED))[0].ui).toContain("exactly ONE screen")
  })

  it("applyUiPlan: bỏ use case người dùng không giữ cùng phần chỉ của nó; màn nêu tên thành popup", () => {
    const plan = parseUiAnswer('1 màn riêng, bước "Confirm Request" là popup; bỏ 2; bỏ 4', [ASKED[0], ASKED[1], ASKED[2], ASKED[3]])
    const ops = applyUiPlan(multiOps(), plan)
    const names = ops.filter((o) => o.path === "use_cases[]").map((o) => (o.value as { name: string }).name)
    expect(names).toEqual(["Request Grade Review"])
    expect(ops.some((o) => o.path === "screens[]" && (o.value as { id: string }).id === "$s4")).toBe(false)
    expect(ops.some((o) => o.path === "functions[]" && ["$f4", "$f5"].includes((o.value as { id: string }).id))).toBe(false)
    expect(ops.some((o) => o.path === "permissions[]")).toBe(false)
    expect(ops.find((o) => o.path === "screens[id=S01].flow_to")?.value).toEqual([...FIXTURE.screens[0].flow_to, "$s1"])
    expect((ops.find((o) => o.path === "messages[]")?.value as { function_ids: string[] }).function_ids).toEqual(["$f1"])
    const popupOf = (id: string) => (ops.find((o) => o.path === "screens[]" && (o.value as { id: string }).id === id)?.value as { is_popup: boolean }).is_popup
    expect([popupOf("$s1"), popupOf("$s2"), popupOf("$s3")]).toEqual([false, false, true])
  })

  /** Spine sau lô: mỗi phần tử `screens[i]` là danh sách màn (id thật) của use case thứ i. */
  const afterOf = (screens: string[][], names: string[], popup: string[] = [], edges: [string, string][] = []): Spine => {
    const after = structuredClone(FIXTURE)
    for (const id of new Set(screens.flat())) after.screens.push({ ...FIXTURE.screens[1], id, name: `Screen ${id}`, flow_to: [], is_popup: popup.includes(id) })
    for (const [from, to] of edges) after.screens.find((s) => s.id === from)?.flow_to.push(to)
    screens.forEach((list, i) => {
      const fns = list.map((s, j) => {
        after.functions.push({ ...FIXTURE.functions[0], id: `FN9${i}${j}`, screen_id: s })
        return `FN9${i}${j}`
      })
      after.use_cases.push({ ...FIXTURE.use_cases[0], id: `UC9${i}`, name: names[i], actor_ids: ["A02"], function_ids: fns })
    })
    return after
  }

  it("uiPlanIssues: đúng kế hoạch ⇒ không lệch; use case bị bỏ vẫn còn / chưa gộp màn / màn chưa popup ⇒ báo", () => {
    const plan = parseUiAnswer('1 màn riêng, bước "Screen S92" là popup; bỏ 2', ASKED.slice(0, 2))
    const ok = afterOf([["S90", "S91", "S92"]], ["Request Grade Review"], ["S92"])
    expect(uiPlanIssues(FIXTURE, ok, plan)).toEqual([])
    const wrong = afterOf([["S90", "S91", "S92"], ["S93"]], ["Request Grade Review", "Decide Grade Review"])
    expect(uiPlanIssues(FIXTURE, wrong, plan).map((i) => i.kind).sort()).toEqual(["dropped_present", "screen_not_popup"])
    const notMerged = uiPlanIssues(FIXTURE, ok, parseUiAnswer("1 gộp thành 1 màn", ASKED.slice(0, 2)))
    expect(notMerged).toContainEqual({ kind: "not_merged", name: "Request Grade Review", count: 3 })
    expect(uiPlanNote(notMerged)).toContain("chưa gộp thành một màn")
  })

  it("uiPlanIssues: dùng chung bị tách / màn riêng bị chung / chọn popup mà không phải popup", () => {
    const plan = parseUiAnswer("1 màn riêng, 2 và 3 dùng chung, 4 popup", ASKED.map((a) => ({ ...a, proposed: false })))
    const after = afterOf([["S90"], ["S90"], ["S91"], ["S92"]], ASKED.map((a) => a.name))
    expect(uiPlanIssues(FIXTURE, after, plan).map((i) => i.kind).sort()).toEqual(["not_own", "not_popup", "not_shared"])
    expect(uiPlanProblemText({ kind: "dropped_present", name: "X" })).toContain("The user dropped use case")
  })

  it("newUseCaseScreenIssues: use case nhiều bước mà các màn không nối thành chuỗi ⇒ not_chained", () => {
    const edgeIn: [string, string][] = [[FIXTURE.screens[0].id, "S90"]]
    const view = (a: Spine) => {
      a.permissions.push({ id: "P99", screen_id: "S90", role_id: "R2", action: "view" })
      return a
    }
    const chained = view(afterOf([["S90", "S91", "S92"]], ["Request Grade Review"], [], [...edgeIn, ["S90", "S91"], ["S91", "S92"]]))
    expect(newUseCaseScreenIssues(FIXTURE, chained).filter((i) => i.kind === "not_chained")).toEqual([])
    const loose = view(afterOf([["S90", "S91", "S92"]], ["Request Grade Review"], [], [...edgeIn, ["S90", "S91"], [FIXTURE.screens[0].id, "S92"]]))
    const issues = newUseCaseScreenIssues(FIXTURE, loose).filter((i) => i.kind === "not_chained")
    expect(issues).toHaveLength(1)
    expect(useCaseScreenNote(issues)).toContain("chưa nối nhau theo thứ tự")
  })

  it("confirmedProposals: use case người dùng xin (tên có trong lời user) không bị coi là đề xuất; model đánh dấu tất cả ⇒ cái đầu vẫn là yêu cầu — lỗi gặp khi chạy AI thật", () => {
    const ops = multiOps()
    expect(confirmedProposals(FIXTURE, ops, ["Request Grade Review", "Decide Grade Review"], 'Thêm use case "Request Grade Review": Student…')).toEqual(["Decide Grade Review"])
    expect(confirmedProposals(FIXTURE, ops, ["Request Grade Review", "Decide Grade Review", "Send Review Reminder"], "Thêm use case phúc khảo cho sinh viên")).toEqual([
      "Decide Grade Review",
      "Send Review Reminder"
    ])
    expect(confirmedProposals(FIXTURE, ops, ["Not In Batch"], "")).toEqual([])
    // Người dùng mô tả việc của actor khác (Founder duyệt) ⇒ use case của actor đó là yêu cầu, không phải đề xuất
    expect(confirmedProposals(FIXTURE, ops, ["Decide Grade Review", "Send Review Reminder"], "Business Analyst gửi yêu cầu; Founder duyệt kết quả")).toEqual([
      "Send Review Reminder"
    ])
  })

  it("applyUiPlan: bỏ use case ⇒ bỏ cả màn bước sau / popup đi tiếp từ màn đã bỏ dù model quên đưa chức năng của nó vào function_ids — lỗi gặp khi chạy AI thật", () => {
    const ops: Op[] = [
      { op: "add", path: "screens[]", value: { id: "$a", name: "Absence Request", feature_id: "F4", flow_to: ["$b"], tabs: [] } },
      { op: "add", path: "screens[]", value: { id: "$b", name: "Confirm Absence Request", feature_id: "F4", flow_to: [], tabs: [], is_popup: true } },
      { op: "add", path: "functions[]", value: { ...FIXTURE.functions[0], id: "$f1", screen_id: "$a" } },
      { op: "add", path: "functions[]", value: { ...FIXTURE.functions[0], id: "$f2", screen_id: "$b" } },
      { op: "add", path: "use_cases[]", value: { name: "Submit Absence Request", actor_ids: ["A02"], function_ids: ["$f1"], description: "…" } },
      { op: "add", path: "permissions[]", value: { screen_id: "$b", role_id: "R2", action: "view" } },
      { op: "set", path: "screens[id=S01].flow_to", value: [...FIXTURE.screens[0].flow_to, "$a"] }
    ]
    const left = applyUiPlan(ops, [{ index: 1, name: "Submit Absence Request", proposed: true, drop: true }])
    expect(left.map((o) => o.path)).toEqual(["screens[id=S01].flow_to"])
    expect(left[0].value).toEqual(FIXTURE.screens[0].flow_to)
  })
})
