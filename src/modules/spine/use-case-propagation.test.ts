import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Op } from "./op.types.js"
import type { Spine } from "./spine.types.js"
import { addedScreenIds, addsUseCaseOrScreen, isAddUseCaseInstruction, normalizeUseCaseBatch, useCaseContext, useCaseMode } from "./use-case-propagation.js"

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

describe("addedScreenIds / addsUseCaseOrScreen", () => {
  it("nhận ra màn và use case mới", () => {
    const after = { ...FIXTURE, screens: [...FIXTURE.screens, { ...FIXTURE.screens[0], id: "S20" }] }
    expect(addedScreenIds(FIXTURE, after)).toEqual(["S20"])
    expect(addsUseCaseOrScreen(FIXTURE, after)).toBe(true)
    expect(addsUseCaseOrScreen(FIXTURE, FIXTURE)).toBe(false)
  })
})

describe("skill apply-change-op — khối luật 3e theo chế độ (FLF-311)", () => {
  const render = async (mode: string): Promise<string> => {
    const { getSkill, interpolatePrompt } = await import("../../shared/ai/prompt-registry.service.js")
    return interpolatePrompt(getSkill("apply-change-op").template, { use_case_mode: mode })
  }

  it("full ⇒ đủ chi tiết chức năng + màn + luồng + phân quyền; không có khối screen_pending", async () => {
    const prompt = await render("full")
    expect(prompt).toContain("all its related parts in the same batch")
    expect(prompt).toContain("`normal[]` steps, `abnormal[]` cases, `validations[]`")
    expect(prompt).not.toContain("the screen loop")
  })

  it("screen_pending ⇒ màn + chức năng tối thiểu, để vòng S-5 mô tả", async () => {
    const prompt = await render("screen_pending")
    expect(prompt).toContain("the screen loop")
    expect(prompt).not.toContain("all its related parts in the same batch")
  })

  it("none / use_case_only ⇒ không có luật 3e (lệnh sửa thường giữ nguyên prompt cũ)", async () => {
    for (const mode of ["none", "use_case_only"]) {
      const prompt = await render(mode)
      expect(prompt).not.toMatch(/^3e\./m)
    }
    expect(await render("use_case_only")).toContain("screens do not exist yet")
  })
})
