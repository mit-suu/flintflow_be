/** Gọi step runner qua HTTP (T22): run (SSE) + gate, gom event và mã lỗi dù lỗi trả JSON hay event `error`. */
import request from "supertest"
import type { Express } from "express"
import { parseSse, type SeededFixture } from "../setup.js"
import { orderedSteps } from "../../src/modules/pipeline/step-registry.js"

export interface RunOutcome {
  status: number
  events: Array<Record<string, unknown> & { type: string }>
  /** `error.code` của JSON (lỗi trước khi mở luồng) hoặc của event `error` trong luồng. */
  errorCode: string | null
}

export const runStepHttp = async (
  app: Express,
  seeded: SeededFixture,
  stepId: string,
  baseVersion: number,
  sessionId = seeded.sessionId
): Promise<RunOutcome> => {
  const res = await request(app)
    .post(`/api/v1/projects/${seeded.projectId}/steps/${stepId}/run`)
    .set("Authorization", `Bearer ${seeded.token}`)
    .send({ session_id: sessionId, base_version: baseVersion })
  const isSse = String(res.headers["content-type"] ?? "").startsWith("text/event-stream")
  const events = (isSse ? parseSse(res.text ?? "") : []) as RunOutcome["events"]
  const errorEvent = events.find((e) => e.type === "error")
  return {
    status: res.status,
    events,
    errorCode: isSse
      ? ((errorEvent?.code as string | undefined) ?? null)
      : ((res.body?.error?.code as string | undefined) ?? null)
  }
}

export const gateHttp = (app: Express, seeded: SeededFixture, stepId: string, baseVersion: number, action = "accept") =>
  request(app)
    .post(`/api/v1/projects/${seeded.projectId}/steps/${stepId}/gate`)
    .set("Authorization", `Bearer ${seeded.token}`)
    .send({ session_id: seeded.sessionId, action, base_version: baseVersion })

export const spineVersionOf = async (app: Express, seeded: SeededFixture): Promise<number> => {
  const res = await request(app)
    .get(`/api/v1/projects/${seeded.projectId}/spine`)
    .set("Authorization", `Bearer ${seeded.token}`)
  return res.body.data.spine_version as number
}

/**
 * Dùng trong `seedFixture.mutate`: đánh dấu accepted mọi step đứng trước `stepId` và đặt con trỏ tiến độ vào
 * `stepId`. `targets` (tuỳ chọn): chỉ chạy đúng các step này — mọi step khác tới hết step cuối của `targets`
 * cũng accepted sẵn (cùng cách `stepsBeforeTarget` trong s2-s3.e2e.test.ts, T14), để `nextStep()` đi đúng chuỗi.
 */
export const startAt = (stepId: string, targets?: readonly string[]) => (spine: Record<string, unknown>) => {
  const all = orderedSteps({ screens: [], functions: [] })
  const idx = all.findIndex((s) => s.id === stepId)
  if (idx < 0) throw new Error(`Step ${stepId} không có trong registry`)
  const target = new Set(targets ?? [])
  const lastIdx = targets?.length ? all.findIndex((s) => s.id === targets[targets.length - 1]) : idx - 1
  spine.steps = all
    .slice(0, Math.max(idx - 1, lastIdx) + 1)
    .filter((s) => (targets ? !target.has(s.id) : true))
    .map((s) => ({ id: s.id, status: "accepted", first_seq: 1, last_seq: 1, accepted_at: "2026-01-01T00:00:00.000Z" }))
  const progress = spine.progress as Record<string, unknown>
  progress.current_phase = all[idx].phase
  progress.current_step = stepId
}
