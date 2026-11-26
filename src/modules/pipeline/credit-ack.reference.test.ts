import { beforeEach, describe, expect, it, vi } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine, StepStatus } from "../spine/spine.types.js"
import { creditAckBlocks, referenceAckDue } from "./credit-ack.js"

const mocks = vi.hoisted(() => ({
  mode: "fpt" as string,
  pending: { documents: 2, credits: 6 },
  summarize: vi.fn(async () => undefined),
  applied: [] as { ops: { path: string; value: unknown }[] }[],
  record: null as unknown
}))

vi.mock("../spine/spine.repository.js", async (orig) => ({
  ...(await orig<typeof import("../spine/spine.repository.js")>()),
  get: vi.fn(async () => mocks.record)
}))
vi.mock("../spine/op-engine.js", () => ({
  applyTransaction: vi.fn(async (_id: string, txn: { ops: { path: string; value: unknown }[] }) => {
    mocks.applied.push(txn)
    return { spine_version: 9 }
  })
}))
vi.mock("../project/project.model.js", async (orig) => ({
  ...(await orig<typeof import("../project/project.model.js")>()),
  Project: { findById: () => ({ select: () => ({ lean: async () => ({ mode: mocks.mode }) }) }) }
}))
vi.mock("../project/project-document.service.js", () => ({
  pendingSummaryCredits: async () => mocks.pending,
  summarizePendingAtStart: mocks.summarize
}))

const { acknowledgeCredit, enforceCreditAck } = await import("./credit-ack.service.js")

const step = (id: string, status: StepStatus) => ({ id, status, first_seq: null, last_seq: null, accepted_at: null })
const freshSpine = (): Spine => createEmptySpine({ name: "P" })

beforeEach(() => {
  mocks.mode = "fpt"
  mocks.pending = { documents: 2, credits: 6 }
  mocks.summarize.mockClear()
  mocks.applied = []
  mocks.record = null
})

describe("referenceAckDue (FLF-458, không SRS)", () => {
  const spine = freshSpine()
  it("không SRS + có tài liệu chờ + B-0 chưa bắt đầu ⇒ báo", () => expect(referenceAckDue(spine, "B-0.1", "fpt", 2)).toBe(true))
  it("có SRS (import) ⇒ không báo lần hai, đã cộng ở màn đọc khung", () => expect(referenceAckDue(spine, "B-0.1", "import", 2)).toBe(false))
  it("không có tài liệu chờ ⇒ không báo", () => expect(referenceAckDue(spine, "B-0.1", "fpt", 0)).toBe(false))
  it("step ngoài B-0 ⇒ không báo", () => expect(referenceAckDue(spine, "B-1.1", "fpt", 2)).toBe(false))
  it("B-0 đã bắt đầu (đính kèm giữa chừng có thẻ riêng) ⇒ không báo", () => {
    const started = { ...freshSpine(), steps: [step("B-0.1", "accepted")] } as Spine
    expect(referenceAckDue(started, "B-0.2", "fpt", 2)).toBe(false)
  })
  it("lần báo chặn mọi step tới khi xác nhận", () => {
    const ack = { scope: "reference_documents" as const, credits: 6, documents: 2, created_at: "2026-11-26T00:00:00.000Z" }
    expect(creditAckBlocks(ack, "B-0.1")).toBe(true)
  })
})

describe("enforceCreditAck + acknowledgeCredit cho tài liệu tham khảo", () => {
  it("chưa xác nhận: B-0 bị chặn 409, ghi lần báo kèm credit, KHÔNG đọc tài liệu (không trừ credit)", async () => {
    mocks.record = { ...freshSpine(), projectId: "p1", spine_version: 3 }
    await expect(enforceCreditAck("p1", freshSpine(), "B-0.1", "u1")).rejects.toMatchObject({ statusCode: 409, code: "CREDIT_ACK_REQUIRED" })
    expect(mocks.applied).toHaveLength(1)
    expect(mocks.applied[0]!.ops[0]).toMatchObject({ path: "progress.credit_ack_required", value: { scope: "reference_documents", credits: 6, documents: 2 } })
    expect(mocks.summarize).not.toHaveBeenCalled()
  })

  it("xác nhận rồi: đọc tài liệu (lúc này mới trừ credit) và gỡ chặn", async () => {
    const spine = freshSpine()
    spine.progress = { ...spine.progress, credit_ack_required: { scope: "reference_documents", credits: 6, documents: 2, created_at: "2026-11-26T00:00:00.000Z" } }
    mocks.record = { ...spine, projectId: "p1", spine_version: 4 }
    await expect(acknowledgeCredit("p1", "u1")).resolves.toMatchObject({ scope: "reference_documents", credits: 6 })
    expect(mocks.summarize).toHaveBeenCalledWith("p1", "u1")
    expect(mocks.applied[0]!.ops[0]).toMatchObject({ path: "progress.credit_ack_required", value: null })
  })

  it("hết credit khi đọc ⇒ lỗi nổi lên, lần báo giữ nguyên (không gỡ chặn)", async () => {
    const spine = freshSpine()
    spine.progress = { ...spine.progress, credit_ack_required: { scope: "reference_documents", credits: 6, documents: 2, created_at: "2026-11-26T00:00:00.000Z" } }
    mocks.record = { ...spine, projectId: "p1", spine_version: 4 }
    mocks.summarize.mockRejectedValueOnce(Object.assign(new Error("no credit"), { code: "INSUFFICIENT_CREDIT" }))
    await expect(acknowledgeCredit("p1", "u1")).rejects.toMatchObject({ code: "INSUFFICIENT_CREDIT" })
    expect(mocks.applied).toHaveLength(0)
  })

  it("có SRS (mode import): B-0 không báo lần hai, chạy thẳng", async () => {
    mocks.mode = "import"
    await expect(enforceCreditAck("p1", freshSpine(), "B-0.1", "u1")).resolves.toBeUndefined()
    expect(mocks.applied).toHaveLength(0)
  })

  it("không có tài liệu chờ ⇒ chạy thẳng", async () => {
    mocks.pending = { documents: 0, credits: 0 }
    await expect(enforceCreditAck("p1", freshSpine(), "B-0.1", "u1")).resolves.toBeUndefined()
  })
})
