import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  LOCK_TTL_MS,
  acquireRun,
  activeRunCount,
  cancelRun,
  clearRuns,
  finishRun,
  getActiveRun,
  getRunState,
  isStepRunning,
  registerAbort,
  resetMemoryRuns,
  touchRun
} from "./run-state.service.js"
import { ApiError } from "../../shared/utils/api-error.js"

const PROJECT = "6ab24325bb1ddd00ca2a403d"
const STEP = "S-5.4@S03"

// Không nối Mongo ⇒ service dùng kho trong bộ nhớ với đúng ngữ nghĩa (xem run-state.service.ts).
beforeEach(() => {
  resetMemoryRuns()
  vi.useRealTimers()
})

describe("khoá step (BUG-05)", () => {
  it("lượt thứ hai khi lượt đầu còn sống ⇒ 409 kèm giờ bắt đầu", async () => {
    await acquireRun(PROJECT, STEP, { by: "u1" })
    const err = await acquireRun(PROJECT, STEP, { by: "u2" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).statusCode).toBe(409)
    expect((err as ApiError).code).toBe("STEP_NOT_RUNNABLE")
    expect((err as ApiError).message).toContain("bắt đầu")
  })

  it("lượt cũ mất heartbeat quá TTL ⇒ lượt mới chiếm lại được, không phải chờ 15 phút", async () => {
    const first = await acquireRun(PROJECT, STEP, { by: "u1" })
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + LOCK_TTL_MS + 1000))
    const second = await acquireRun(PROJECT, STEP, { by: "u2" })
    expect(second.run_id).not.toBe(first.run_id)
    // Lượt cũ không còn là chủ khoá ⇒ mọi cập nhật của nó rơi vào hư không
    expect(await touchRun(PROJECT, STEP, first.run_id, { stage: "draft" })).toBe(false)
  })

  it("kết thúc lượt là nhả khoá ngay, kể cả khi dừng ở gate", async () => {
    const run = await acquireRun(PROJECT, STEP)
    await finishRun(PROJECT, STEP, run.run_id, "gate")
    expect(await isStepRunning(PROJECT, STEP)).toBe(false)
    await expect(acquireRun(PROJECT, STEP)).resolves.toMatchObject({ status: "running" })
  })
})

describe("khôi phục trạng thái (BUG-07)", () => {
  it("giữ stage, câu hỏi và gate payload để dựng lại sau reload", async () => {
    const run = await acquireRun(PROJECT, STEP, { sessionId: "sess" })
    await touchRun(PROJECT, STEP, run.run_id, {
      status: "waiting_answer",
      stage: "ask",
      detail_vi: "Chờ bạn trả lời 3 câu",
      questions: [{ id: "Q1", text: "Tên hệ thống?" }],
      appendEvent: { type: "answer_needed" }
    })
    const waiting = await getRunState(PROJECT, STEP)
    expect(waiting).toMatchObject({ status: "waiting_answer", stage: "ask", detail_vi: "Chờ bạn trả lời 3 câu" })
    expect(waiting?.questions).toHaveLength(1)
    expect(waiting?.events).toHaveLength(1)

    await touchRun(PROJECT, STEP, run.run_id, { status: "gate", stage: "gate", questions: null, gate_payload: { type: "gate_ready", actions: ["accept"] } })
    const atGate = await getRunState(PROJECT, STEP)
    expect(atGate?.questions).toBeNull()
    expect(atGate?.gate_payload).toMatchObject({ type: "gate_ready" })
  })

  it("lượt còn sống của dự án tìm được để khôi phục pill chạy nền", async () => {
    await acquireRun(PROJECT, "S-3.1")
    const active = await getActiveRun(PROJECT)
    expect(active?.step_id).toBe("S-3.1")

    await finishRun(PROJECT, "S-3.1", active!.run_id, "done")
    expect(await getActiveRun(PROJECT)).toBeNull()
  })
})

describe("huỷ lượt", () => {
  it("abort lượt đang chạy, nhả khoá và dọn AbortController", async () => {
    const run = await acquireRun(PROJECT, STEP)
    const controller = new AbortController()
    registerAbort(run.run_id, controller)
    expect(activeRunCount()).toBe(1)

    const result = await cancelRun(PROJECT, STEP)
    expect(result).toMatchObject({ cancelled: true, run_id: run.run_id })
    expect(controller.signal.aborted).toBe(true)
    expect(activeRunCount()).toBe(0)
    expect(await isStepRunning(PROJECT, STEP)).toBe(false)
    await expect(acquireRun(PROJECT, STEP)).resolves.toMatchObject({ status: "running" })
  })

  it("huỷ khi không có lượt nào ⇒ cancelled = false", async () => {
    expect(await cancelRun(PROJECT, "S-1.1")).toEqual({ cancelled: false, run_id: null })
  })

  it("huỷ nhầm run_id của lượt cũ ⇒ không đụng lượt đang chạy", async () => {
    const run = await acquireRun(PROJECT, STEP)
    expect(await cancelRun(PROJECT, STEP, "run-cu")).toEqual({ cancelled: false, run_id: run.run_id })
    expect(await isStepRunning(PROJECT, STEP)).toBe(true)
    await clearRuns(PROJECT)
    expect(await getRunState(PROJECT, STEP)).toBeNull()
  })
})
