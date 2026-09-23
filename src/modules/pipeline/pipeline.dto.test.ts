import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import {
  PIPELINE_ERROR_STATUS,
  STEP_EVENT_TYPES,
  changesRequestSchema,
  gateRequestSchema,
  stepEventSchema,
  waiveRequestSchema
} from "./pipeline.dto.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTRACT = fs.readFileSync(path.resolve(__dirname, "../../../docs/api/pipeline-contract.md"), "utf8")

describe("pipeline.dto", () => {
  it("changes: đúng một trong ops / instruction; không nhận op hệ thống", () => {
    const op = { op: "set", path: "actors[id=A01].name", value: "X" }
    expect(changesRequestSchema.safeParse({ base_version: 1, ops: [op] }).success).toBe(true)
    expect(changesRequestSchema.safeParse({ base_version: 1, instruction: "Đổi tên actor" }).success).toBe(true)
    expect(changesRequestSchema.safeParse({ base_version: 1 }).success).toBe(false)
    expect(changesRequestSchema.safeParse({ base_version: 1, ops: [op], instruction: "x" }).success).toBe(false)
    expect(changesRequestSchema.safeParse({ base_version: 1, ops: [{ op: "migrate", path: "$", value: {} }] }).success).toBe(false)
    expect(changesRequestSchema.safeParse({ ops: [op] }).success).toBe(false)
  })

  it("gate: revision/accept_as_is bắt buộc note", () => {
    expect(gateRequestSchema.safeParse({ session_id: "s1", action: "accept", base_version: 3 }).success).toBe(true)
    expect(gateRequestSchema.safeParse({ session_id: "s1", action: "accept_as_is", base_version: 3 }).success).toBe(false)
    expect(gateRequestSchema.safeParse({ session_id: "s1", action: "revision", note: "Thiếu actor", base_version: 3 }).success).toBe(true)
  })

  it("gate: session_id bắt buộc (contract-change 2026-09-15)", () => {
    expect(gateRequestSchema.safeParse({ action: "accept", base_version: 3 }).success).toBe(false)
  })

  it("waive: lý do ≥ 20 ký tự", () => {
    expect(waiveRequestSchema.safeParse({ reason: "quá ngắn" }).success).toBe(false)
    expect(waiveRequestSchema.safeParse({ reason: "Khách hàng chấp nhận rủi ro này" }).success).toBe(true)
  })

  it("SSE: đủ 16 loại sự kiện, parse theo discriminator", () => {
    // 9 sự kiện gốc + 7 sự kiện FLF-198 (stage, heartbeat, answer_received, draft_retry, auto_accepted,
    // phase_progress, phase_gate)
    expect(STEP_EVENT_TYPES).toHaveLength(16)
    expect(stepEventSchema.safeParse({ type: "stage", step_id: "S-5.4@S03", stage: "draft", label_vi: "AI đang soạn nội dung", batch: { i: 1, n: 2 } }).success).toBe(true)
    expect(stepEventSchema.safeParse({ type: "heartbeat", step_id: "S-5.4@S03", stage: "draft", elapsed_ms: 12000 }).success).toBe(true)
    expect(stepEventSchema.safeParse({ type: "answer_received", step_id: "S-3.1", count: 3 }).success).toBe(true)
    expect(stepEventSchema.safeParse({ type: "draft_retry", step_id: "S-3.1", attempt: 2, max: 3, reason_vi: "kết quả thiếu trường" }).success).toBe(true)
    expect(stepEventSchema.safeParse({ type: "stage", step_id: "S-3.1", stage: "unknown", label_vi: "x" }).success).toBe(false)
    const gateReady = { type: "gate_ready", step_id: "S-3.1", actions: ["accept"], regenerate_used: 0, calls_used: 2, spine_version: 7, wrote_ops: true, empty_sections: [] }
    expect(stepEventSchema.safeParse(gateReady).success).toBe(true)
    expect(
      stepEventSchema.safeParse({ ...gateReady, wrote_ops: false, empty_sections: [{ section_id: "fixed:5.2", title: "Common Requirements" }] }).success
    ).toBe(true)
    // L11/L11b: ba field này bắt buộc — thiếu là FE mất đường biết version cuối và lô op rỗng
    for (const missing of ["spine_version", "wrote_ops", "empty_sections"] as const) {
      const { [missing]: _omitted, ...without } = gateReady
      expect(stepEventSchema.safeParse(without).success, missing).toBe(false)
    }
    expect(stepEventSchema.safeParse({ type: "error", step_id: "S-3.1", code: "CALL_LIMIT", message: "x", retryable: false }).success).toBe(true)
    expect(stepEventSchema.safeParse({ type: "unknown", step_id: "S-3.1" }).success).toBe(false)
  })

  it("contract doc liệt kê mọi mã lỗi và mọi sự kiện SSE", () => {
    for (const code of Object.keys(PIPELINE_ERROR_STATUS)) expect(CONTRACT, code).toContain(`\`${code}\``)
    for (const type of STEP_EVENT_TYPES) expect(CONTRACT, type).toContain(`\`${type}\``)
  })
})
