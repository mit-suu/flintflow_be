/**
 * ai-review.test.ts
 * FLF-449 việc 5, 6: S-9.2 Soát chất lượng (`quality`) và S-8.4 Rà nhất quán (`consistency`) bằng AI.
 * Model giả; repository, op-engine, meter, tài liệu mock trong bộ nhớ.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({ record: null as null | Record<string, any>, transactions: [] as any[] }))
const docs = vi.hoisted(() => ({ buildDocumentContext: vi.fn(async (_req?: unknown) => ({ contextText: "" })) }))
const meterMock = vi.hoisted(() => ({
  reserveCall: vi.fn(async () => "u1"),
  finalizeCall: vi.fn(async () => undefined),
  releaseCall: vi.fn(async () => undefined)
}))

vi.mock("../../spine/spine.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../spine/spine.repository.js")>()
  return { ...actual, get: vi.fn(async () => (store.record ? structuredClone(store.record) : null)) }
})
vi.mock("../../spine/op-engine.js", () => ({
  applyTransaction: vi.fn(async (_projectId: string, txn: { base_version: number; ops: any[]; step_id?: string; reason?: string }) => {
    store.transactions.push(txn)
    for (const op of txn.ops) {
      if (op.op === "add" && op.path === "flags[]") store.record!.flags.push(structuredClone(op.value))
      else if (op.op === "set") {
        const m = /^flags\[id=(\w+)\]\.(\w+)$/.exec(op.path)!
        store.record!.flags.find((f: any) => f.id === m[1])[m[2]] = op.value
      }
    }
    store.record!.spine_version += 1
    return { spine_version: store.record!.spine_version }
  })
}))
vi.mock("../meter.service.js", () => meterMock)
vi.mock("../../../shared/ai/document-context.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/ai/document-context.service.js")>()
  return { ...actual, buildDocumentContext: docs.buildDocumentContext }
})

import { env } from "../../../config/env.js"
import { createEmptySpine } from "../../spine/spine.repository.js"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Flag, Spine } from "../../spine/spine.types.js"
import type { AiActionInput, AiActionResult } from "../../../shared/ai/ai-action.types.js"
import type { ReviewOutput } from "../../../shared/ai/response-parser.js"
import { AI_REVIEW_MAX_BATCHES, buildReviewBatches, estimateReviewBatches, humanizeReviewMessage, runAiReview, type AiReviewExecutor } from "./ai-review.js"

const PROJECT = "650000000000000000000099"
const USER = "650000000000000000000098"

type RawFlag = ReviewOutput["flags"][number]

const answer = (flags: RawFlag[]): AiActionResult<ReviewOutput> => ({
  success: true,
  data: { flags },
  rawText: "{}",
  actionType: "review" as never,
  provider: "mock",
  aiModel: "mock",
  tokensUsed: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  latencyMs: 1,
  logId: "log",
  cost: 2
})

const executorOf = (flags: RawFlag[] | ((input: AiActionInput) => RawFlag[])) =>
  vi.fn<AiReviewExecutor>(async (input) => answer(typeof flags === "function" ? flags(input) : flags))

/** Spine nhỏ: 2 yêu cầu có câu mâu thuẫn, quyết định, giả định, NFR nhắc dịch vụ không có ở giao diện ngoài. */
const smallSpine = (): Spine => {
  const spine = createEmptySpine({ name: "Booking" })
  spine.features = [{ id: "F1", name: "Booking", order: 0 }]
  spine.actors = [{ id: "A01", name: "Guest", kind: "human", description: "Books rooms." }]
  spine.functions = [
    {
      id: "FN12",
      screen_id: null,
      feature_id: "F1",
      order: 0,
      name: "Cancel Booking",
      trigger: "Guest clicks Cancel.",
      description: "Guest cancels a booking.",
      normal: ["System cancels the booking free of charge up to 24 hours before check-in."],
      abnormal: [],
      validations: [],
      business_rule_ids: ["BR03"],
      priority: null
    }
  ]
  spine.business_rules = [{ id: "BR03", tier: "high", statement: "Free cancellation up to 4 hours before check-in.", source_validation_ids: [] }]
  spine.nfrs = [{ id: "NFR1", category: "other", statement: "The system sends receipts through the email service and keeps nightly backups.", kind: "quantitative", priority: null } as never]
  spine.sections = [
    { id: "fixed:1", asset_version: "v" },
    { id: "feature:F1", asset_version: "v" },
    { id: "function:FN12", asset_version: "v" }
  ] as never
  spine.decisions = [
    { id: "D1", topic_key: "retention", question: "What happens to expired profiles?", answer: "Expired profiles are anonymised, not deleted.", step_id: "S-2", at: "2026-11-25T00:00:00.000Z", superseded_by: null },
    { id: "D2", topic_key: "old", question: "Old question?", answer: "Replaced answer.", step_id: "S-2", at: "2026-11-25T00:00:00.000Z", superseded_by: "D1" }
  ]
  spine.assumptions = [
    { id: "AS49", path: "project.form_factor", statement: "Customers use their phones.", rationale: "", origin_step_id: "S-1", status: "confirmed", confirmed_at: null },
    { id: "AS57", path: "project.form_factor", statement: "The product is used on desktop and tablet only.", rationale: "", origin_step_id: "S-1", status: "unconfirmed", confirmed_at: null },
    { id: "AS60", path: "project.form_factor", statement: "Rejected idea about kiosks.", rationale: "", origin_step_id: "S-1", status: "rejected", confirmed_at: null }
  ]
  return spine
}

const seed = (spine: Spine, version = 5): void => {
  store.record = { projectId: PROJECT, ...structuredClone(spine), spine_version: version }
  store.transactions = []
}

const flagOf = (over: Partial<Flag>): Flag => ({
  id: "FL001",
  level: "yellow",
  rule_id: "ai_review",
  lens: "requirement_conflict",
  section_id: "function:FN12",
  target_id: "FN12",
  message: "old",
  remediation_step: "S-9.2",
  opened_at_version: 1,
  resolved_at: null,
  waived_by_user: false,
  waive_reason: null,
  waived_at_version: null,
  kept_reason: null,
  kept_by: null,
  kept_at: null,
  ...over
})

const conflict: RawFlag = {
  level: "yellow",
  rule_id: "requirement_conflict",
  section_id: "function:FN12",
  target_id: "FN12",
  quote: "Free cancellation up to 4 hours before check-in.",
  message: "Cancel Booking says 24 hours but the cancellation rule says 4 hours. Use one value."
}

const openFlags = () => (store.record!.flags as Flag[]).filter((f) => f.resolved_at === null && f.rule_id === "ai_review")

beforeEach(() => {
  store.record = null
  store.transactions = []
  meterMock.reserveCall.mockClear()
  meterMock.finalizeCall.mockClear()
  meterMock.releaseCall.mockClear()
  docs.buildDocumentContext.mockReset()
  docs.buildDocumentContext.mockResolvedValue({ contextText: "" })
  env.QUALITY_LENS_ENABLED = true
  env.CONSISTENCY_LLM_ENABLED = true
})

describe("runAiReview - S-9.2 quality", () => {
  it("(1) 3 cờ hợp lệ có quote thật ⇒ mở 3 cờ ai_review đúng lens, yellow, remediation S-9.2", async () => {
    seed(smallSpine())
    const exec = executorOf([
      conflict,
      { level: "yellow", rule_id: "ambiguity", section_id: "function:FN12", target_id: "FN12", quote: "Guest cancels a booking.", message: "Description is vague." },
      { level: "yellow", rule_id: "fr_nfr_conflict", section_id: "fixed:1", target_id: "NFR1", quote: "nightly backups", message: "Backups conflict." }
    ])
    const result = await runAiReview(PROJECT, USER, "quality", { executor: exec })

    expect(result.skipped).toBe(false)
    expect(result.opened).toHaveLength(3)
    const flags = openFlags()
    expect(flags.map((f) => f.lens).sort()).toEqual(["ambiguity", "fr_nfr_conflict", "requirement_conflict"])
    expect(flags.every((f) => f.level === "yellow" && f.remediation_step === "S-9.2" && f.rule_id === "ai_review")).toBe(true)
    expect(store.transactions).toHaveLength(1)
    expect(store.transactions[0]).toMatchObject({ step_id: "S-9.2", reason: "S-9.2 Soát chất lượng" })
    // mỗi lô một lượt reserve + finalize
    expect(meterMock.reserveCall).toHaveBeenCalledTimes(result.batches)
    expect(meterMock.finalizeCall).toHaveBeenCalledTimes(result.batches)
  })

  it("(2) cờ red hoặc lens ngoài profile ⇒ bỏ", async () => {
    seed(smallSpine())
    const exec = executorOf([
      { ...conflict, level: "red" },
      { ...conflict, rule_id: "term_drift" },
      { ...conflict, rule_id: "semantic_duplicate" },
      { ...conflict, rule_id: "goal_not_covered" }
    ])
    const result = await runAiReview(PROJECT, USER, "quality", { executor: exec })
    expect(result.opened).toEqual([])
    expect(openFlags()).toHaveLength(0)
    expect(store.transactions).toHaveLength(0)
  })

  it("(3) quote bịa ⇒ bỏ, dropped_unquoted đếm đúng; thiếu quote cũng bỏ", async () => {
    seed(smallSpine())
    const exec = executorOf([
      conflict,
      { ...conflict, section_id: "fixed:1", target_id: null, quote: "A sentence that is nowhere in the document", message: "Made up." },
      { ...conflict, section_id: "fixed:1", target_id: null, quote: undefined, message: "No quote." }
    ])
    const result = await runAiReview(PROJECT, USER, "quality", { executor: exec })
    expect(result.opened).toHaveLength(1)
    expect(result.dropped_unquoted).toBe(2)
  })

  it("(4) target_id không tồn tại ⇒ null; section_id lạ ⇒ section của phần tử, không có thì fixed:1", async () => {
    seed(smallSpine())
    const exec = executorOf([
      { ...conflict, target_id: "FN999", section_id: "weird:x", message: "Unknown target and section." },
      { ...conflict, target_id: "FN12", section_id: "weird:y", message: "Known target, odd section." }
    ])
    await runAiReview(PROJECT, USER, "quality", { executor: exec })
    const byMessage = (m: string) => openFlags().find((f) => f.message === m)!
    expect(byMessage("Unknown target and section.")).toMatchObject({ target_id: null, section_id: "fixed:1" })
    expect(byMessage("Known target, odd section.")).toMatchObject({ target_id: "FN12", section_id: "function:FN12" })
  })

  it("(5) chạy lại ⇒ cờ cũ chưa giữ bị đóng, cờ mới mở, không nhân đôi", async () => {
    seed(smallSpine())
    const exec = executorOf([conflict])
    const first = await runAiReview(PROJECT, USER, "quality", { executor: exec })
    const second = await runAiReview(PROJECT, USER, "quality", { executor: exec })

    expect(second.closed).toEqual(first.opened)
    expect(second.opened).toHaveLength(1)
    expect(openFlags()).toHaveLength(1)
    expect((store.record!.flags as Flag[]).filter((f) => f.rule_id === "ai_review")).toHaveLength(2)
  })

  it("(5) cờ đã Giữ nguyên + lý do vẫn mở; cờ mới trùng chỗ và lens không thêm; cờ waive không đụng", async () => {
    const spine = smallSpine()
    spine.flags = [
      flagOf({ id: "FL001", kept_reason: "Business owner confirmed 4 hours is correct for this property.", kept_by: USER, kept_at: "2026-11-25T00:00:00.000Z" }),
      flagOf({ id: "FL002", lens: "ambiguity", section_id: "fixed:1", target_id: null, waived_by_user: true, waive_reason: "Accepted by the product owner today.", waived_at_version: 5 }),
      flagOf({ id: "FL003", lens: "fr_nfr_conflict", section_id: "fixed:1", target_id: null, message: "stale one" })
    ]
    seed(spine)
    const exec = executorOf([
      conflict,
      { level: "yellow", rule_id: "ambiguity", section_id: "fixed:1", quote: "Booking", message: "Name vague." }
    ])
    const result = await runAiReview(PROJECT, USER, "quality", { executor: exec })

    const byId = (id: string) => (store.record!.flags as Flag[]).find((f) => f.id === id)!
    expect(byId("FL001").resolved_at, "cờ đã giữ vẫn mở").toBeNull()
    expect(byId("FL002").resolved_at, "cờ waive không đụng").toBeNull()
    expect(byId("FL002").waived_by_user).toBe(true)
    expect(byId("FL003").resolved_at, "cờ cũ chưa giữ bị đóng").not.toBeNull()
    expect(result.closed).toEqual(["FL003"])
    expect(result.opened, "cả hai cờ mới trùng chỗ + lens với cờ người đã quyết").toEqual([])
  })

  it("(6) env tắt ⇒ skipped, executor không được gọi", async () => {
    seed(smallSpine())
    env.QUALITY_LENS_ENABLED = false
    const exec = executorOf([conflict])
    const result = await runAiReview(PROJECT, USER, "quality", { executor: exec })
    expect(result).toMatchObject({ skipped: true, opened: [], batches: 0 })
    expect(exec).not.toHaveBeenCalled()
    expect(meterMock.reserveCall).not.toHaveBeenCalled()
  })

  it("(8) quality truyền decisions còn hiệu lực, assumptions bỏ rejected, documents; consistency không truyền", async () => {
    seed(smallSpine())
    docs.buildDocumentContext.mockResolvedValue({ contextText: "[Doc] Minutes list 3 roles." })
    const exec = executorOf([])
    await runAiReview(PROJECT, USER, "quality", { executor: exec })
    const vars = exec.mock.calls[0][0].promptVariables!
    expect(vars.decisions.map((d: { id: string }) => d.id)).toEqual(["D1"])
    expect(vars.assumptions.map((a: { id: string }) => a.id)).toEqual(["AS49", "AS57"])
    expect(vars.documents).toBe("[Doc] Minutes list 3 roles.")
    expect(vars.lenses).toContain("decision_conflict")
    expect(vars.lenses).not.toContain("semantic_duplicate")
    expect(vars.call_kind).toBe("review")
    expect(vars.step_id).toBe("S-9.2")
    expect(vars.element_index.map((e: { id: string }) => e.id)).toContain("FN12")
    expect(docs.buildDocumentContext).toHaveBeenCalledWith({ projectId: PROJECT, actionType: "review" })

    docs.buildDocumentContext.mockClear()
    const exec2 = executorOf([])
    await runAiReview(PROJECT, USER, "consistency", { executor: exec2 })
    const vars2 = exec2.mock.calls[0][0].promptVariables!
    expect(vars2.decisions).toEqual([])
    expect(vars2.assumptions).toEqual([])
    expect(vars2.documents).toBe("")
    expect(vars2.call_kind).toBe("consistency_pass")
    expect(vars2.lenses).toContain("semantic_duplicate")
    expect(vars2.lenses).not.toContain("decision_conflict")
    expect(docs.buildDocumentContext).not.toHaveBeenCalled()
  })

  it("truyền ngôn ngữ trả lời xuống prompt", async () => {
    seed(smallSpine())
    const exec = executorOf([])
    await runAiReview(PROJECT, USER, "quality", { executor: exec, replyLanguage: "en" })
    expect(exec.mock.calls[0][0].replyLanguage).toBe("en")
  })

  it("(9) FAP 16c: quyết định ẩn danh hoá + quy tắc ghi tự xoá sau 4 năm ⇒ mở cờ decision_conflict", async () => {
    const spine = smallSpine()
    spine.business_rules.push({ id: "BR09", tier: "high", statement: "Profiles are deleted automatically after 4 years of inactivity.", source_validation_ids: [] })
    seed(spine)
    const exec = executorOf([
      {
        level: "yellow",
        rule_id: "decision_conflict",
        section_id: "fixed:1",
        target_id: "BR09",
        quote: "Profiles are deleted automatically after 4 years of inactivity.",
        message: "The rule on inactive profiles says they are deleted, but you decided expired profiles are anonymised, not deleted."
      }
    ])
    const result = await runAiReview(PROJECT, USER, "quality", { executor: exec })
    expect(result.opened).toHaveLength(1)
    expect(openFlags()[0]).toMatchObject({ lens: "decision_conflict", target_id: "BR09" })
  })

  it("(11) FLF-413 #14: hai giả định trái nhau ⇒ mở cờ assumption_conflict (quote lấy từ statement)", async () => {
    seed(smallSpine())
    const exec = executorOf([
      {
        level: "yellow",
        rule_id: "assumption_conflict",
        section_id: "fixed:1",
        quote: "The product is used on desktop and tablet only.",
        message: "One assumption says desktop and tablet only, another says customers use their phones."
      }
    ])
    const result = await runAiReview(PROJECT, USER, "quality", { executor: exec })
    expect(result.opened).toHaveLength(1)
    expect(openFlags()[0].lens).toBe("assumption_conflict")
  })

  it("source_conflict: quote lấy từ tài liệu tải lên", async () => {
    seed(smallSpine())
    docs.buildDocumentContext.mockResolvedValue({ contextText: "The minutes define three roles: Guest, Host and Auditor." })
    const exec = executorOf([
      { level: "yellow", rule_id: "source_conflict", section_id: "fixed:1", quote: "three roles: Guest, Host and Auditor", message: "Minutes list 3 roles, SRS lists 1 actor." }
    ])
    const result = await runAiReview(PROJECT, USER, "quality", { executor: exec })
    expect(result.opened).toHaveLength(1)
  })
})

describe("runAiReview - S-8.4 consistency", () => {
  it("(10) FAP 16d: NFR nhắc dịch vụ email không có ở giao diện ngoài ⇒ cờ cross_section_gap, remediation S-8.4", async () => {
    seed(smallSpine())
    const exec = executorOf([
      {
        level: "yellow",
        rule_id: "cross_section_gap",
        section_id: "fixed:1",
        quote: "sends receipts through the email service",
        message: "The non-functional requirements mention an email service but the external interfaces do not list it."
      }
    ])
    const result = await runAiReview(PROJECT, USER, "consistency", { executor: exec })
    expect(result.opened).toHaveLength(1)
    expect(openFlags()[0]).toMatchObject({ lens: "cross_section_gap", remediation_step: "S-8.4" })
    expect(store.transactions[0]).toMatchObject({ step_id: "S-8.4", reason: "S-8.4 Rà nhất quán" })
  })

  it("cross_section_gap về con số được phép không có quote; có quote bịa thì bỏ; lens của S-9.2 không dùng được ở S-8.4", async () => {
    seed(smallSpine())
    const exec = executorOf([
      { level: "yellow", rule_id: "cross_section_gap", section_id: "fixed:1", message: "The text says seven feature groups but only 1 exists." },
      { level: "yellow", rule_id: "cross_section_gap", section_id: "fixed:1", quote: "not in the document at all", message: "Invented." },
      { ...conflict, rule_id: "requirement_conflict" }
    ])
    const result = await runAiReview(PROJECT, USER, "consistency", { executor: exec })
    expect(result.opened).toHaveLength(1)
    expect(result.dropped_unquoted).toBe(1)
  })

  it("chạy S-8.4 không đóng cờ ai_review của S-9.2", async () => {
    const spine = smallSpine()
    spine.flags = [flagOf({ id: "FL001" })]
    seed(spine)
    await runAiReview(PROJECT, USER, "consistency", { executor: executorOf([]) })
    expect((store.record!.flags as Flag[])[0].resolved_at).toBeNull()
  })

  it("term_drift: cờ mở với lens term_drift", async () => {
    seed(smallSpine())
    const exec = executorOf([
      { level: "yellow", rule_id: "term_drift", section_id: "function:FN12", target_id: "FN12", quote: "Guest cancels a booking.", message: "Name drift." }
    ])
    await runAiReview(PROJECT, USER, "consistency", { executor: exec })
    expect(openFlags()[0].lens).toBe("term_drift")
  })

  it("env CONSISTENCY_LLM_ENABLED tắt ⇒ skipped", async () => {
    seed(smallSpine())
    env.CONSISTENCY_LLM_ENABLED = false
    const exec = executorOf([])
    expect((await runAiReview(PROJECT, USER, "consistency", { executor: exec })).skipped).toBe(true)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe("buildReviewBatches (hàm thuần)", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const big = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

  it("(7) fixture 19 màn ⇒ nhiều lô, ≤ trần, mọi function có mặt đúng một lần, mỗi lô một lần gọi model", async () => {
    const batches = buildReviewBatches(big, "quality")
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.length).toBeLessThanOrEqual(AI_REVIEW_MAX_BATCHES)
    const text = batches.map((b) => JSON.stringify(b.projection))
    for (const fn of big.functions) expect(text.filter((t) => t.includes(`"id":"${fn.id}"`)).length, fn.id).toBeGreaterThanOrEqual(1)
    for (const f of big.features) expect(batches.filter((b) => f.id && b.section_ids.includes(`feature:${f.id}`))).toHaveLength(1)
    expect(Object.keys(batches[0].projection)).toContain("common")
    expect(estimateReviewBatches(big, "quality")).toBe(batches.length)

    store.record = { projectId: PROJECT, ...structuredClone(big), spine_version: 3 }
    store.transactions = []
    const exec = executorOf([])
    const result = await runAiReview(PROJECT, USER, "quality", { executor: exec })
    expect(exec).toHaveBeenCalledTimes(batches.length)
    expect(result.batches).toBe(batches.length)
  })

  it("quá trần lô ⇒ gom khối cuối vào lô thứ 6, không bỏ khối nào", () => {
    const spine = createEmptySpine({ name: "Huge" })
    const filler = "x".repeat(23_000)
    spine.features = Array.from({ length: 9 }, (_, i) => ({ id: `F${i + 1}`, name: `Feature ${i + 1}`, order: i }))
    spine.functions = spine.features.map(
      (f, i) =>
        ({ id: `FN${i + 1}`, screen_id: null, feature_id: f.id, order: 0, name: `Fn ${i + 1}`, trigger: "t", description: filler, normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }) as never
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const batches = buildReviewBatches(spine, "consistency")
    expect(batches).toHaveLength(AI_REVIEW_MAX_BATCHES)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    const keys = batches.flatMap((b) => Object.keys(b.projection))
    expect(keys).toEqual(["common", ...spine.features.map((f) => `feature:${f.id}`)])
  })

  it("Spine rỗng ⇒ đúng một lô (khối chung)", () => {
    expect(buildReviewBatches(createEmptySpine({ name: "P" }), "quality")).toHaveLength(1)
    expect(estimateReviewBatches(createEmptySpine({ name: "P" }), "consistency")).toBe(1)
  })
})

describe("humanizeReviewMessage", () => {
  it("vi: tên trường và mã con thành chữ thường / mã cha", () => {
    const out = humanizeReviewMessage("`function_ids` chỉ có 1 mục; waiver hết hạn khi spine_version đổi; xem FN006-V2.", "vi")
    expect(out).toContain("danh sách chức năng")
    expect(out).toContain("phiên bản tài liệu")
    expect(out).toContain("FN006")
    expect(out).not.toMatch(/function_ids|spine_version|FN006-V2|`/)
  })

  it("en: dùng từ điển tiếng Anh", () => {
    const out = humanizeReviewMessage("function_ids is short and spine_version changed at FN029-V1", "en")
    expect(out).toBe("function list is short and document version changed at FN029")
  })

  it("token lạ giữ nguyên, có cảnh báo", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(humanizeReviewMessage("trường foo_bar sai", "vi")).toBe("trường foo_bar sai")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("cờ ghi ra đã được làm sạch, cờ có token lạ vẫn mở", async () => {
    seed(smallSpine())
    const exec = executorOf([
      { ...conflict, message: "Cancel Booking: function_ids và spine_version lệch ở FN006-V2." },
      { ...conflict, message: "Cancel Booking có trường foo_bar lạ.", target_id: null, section_id: "fixed:1" }
    ])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await runAiReview(PROJECT, USER, "quality", { executor: exec })
    warn.mockRestore()
    const msgs = openFlags().map((f) => f.message)
    expect(msgs.some((m) => m.includes("danh sách chức năng") && m.includes("phiên bản tài liệu") && m.includes("FN006") && !m.includes("FN006-V2"))).toBe(true)
    expect(msgs.some((m) => m.includes("foo_bar"))).toBe(true)
  })
})
