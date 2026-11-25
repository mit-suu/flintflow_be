/**
 * Khoá nội dung khi chờ Lead duyệt (business-flow §2, C-7): bản nộp baseline và gói duyệt cùng nằm ở `baseline_submission`.
 * Lúc đang chờ: chạy step / giai đoạn, trả lời câu hỏi, hành động cổng, chạy tiếp dự án, kết luận comment "đã sửa" (mở lại
 * step) đều trả 409 `DRAFT_LOCKED`. Kết luận "giữ nguyên" không ghi nội dung nên vẫn được; "giữ nguyên" cũng không mở lại step.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())

import request from "supertest"
import app from "../../src/app.js"
import { seedFixture, type SeededFixture } from "../setup.js"
import { resetMockLlm } from "../helpers/mock-llm.js"
import { Spine } from "../../src/modules/spine/spine.model.js"
import * as spineRepository from "../../src/modules/spine/spine.repository.js"

beforeEach(() => resetMockLlm())

const api = (seeded: SeededFixture) => {
  const base = `/api/v1/projects/${seeded.projectId}`
  const auth = { Authorization: `Bearer ${seeded.token}` }
  return {
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth),
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body)
  }
}

const setPending = async (seeded: SeededFixture, pending: boolean) => {
  const head = (await spineRepository.get(seeded.projectId))!
  const submission = pending
    ? { status: "pending", submitted_by: seeded.userId, submitted_at: new Date().toISOString(), spine_version: head.spine_version, decided_by: null, decided_at: null, reason: null, rejection_comment_ids: [] }
    : null
  await Spine.updateOne({ projectId: seeded.projectId }, { $set: { baseline_submission: submission } })
  spineRepository.clearReadCache()
}

/** Section có comment ghim được + step sở hữu đã accepted (để thấy mở lại hay không). */
const commentOn = async (c: ReturnType<typeof api>, text: string) => {
  const doc = await c.get("/document")
  expect(doc.status, JSON.stringify(doc.body.error)).toBe(200)
  const sections = doc.body.data.sections as Array<{ id: string; blocks: unknown[] }>
  const section = sections.find((s) => !s.id.startsWith("group:") && s.blocks.length > 0)!
  const created = await c.post("/comments", { version: { source: "draft" }, anchor: { section_id: section.id }, text })
  expect(created.status, JSON.stringify(created.body.error)).toBe(201)
  return { commentId: created.body.data.comment_id as string, stepIds: created.body.data.step_ids as string[] }
}

const stepStatus = async (seeded: SeededFixture, stepId: string) => (await spineRepository.get(seeded.projectId))!.steps.find((s) => s.id === stepId)?.status

describe("khoá nội dung khi chờ Lead duyệt", () => {
  it("chạy step / giai đoạn, trả lời, cổng, chạy tiếp dự án ⇒ 409 DRAFT_LOCKED; hết chờ ⇒ không còn bị khoá", async () => {
    const seeded = await seedFixture("full")
    const c = api(seeded)
    const accepted = (await spineRepository.get(seeded.projectId))!.steps.find((s) => s.status === "accepted")!.id
    await setPending(seeded, true)
    const version = (await spineRepository.get(seeded.projectId))!.spine_version

    const calls = [
      c.post(`/steps/${accepted}/run`, { session_id: seeded.sessionId, base_version: version, reopen: true }),
      c.post(`/phases/P1/run`, { session_id: seeded.sessionId, base_version: version }),
      c.post(`/steps/${accepted}/answer`, { session_id: seeded.sessionId, answers: [], message: "tiếp" }),
      c.post(`/steps/${accepted}/gate`, { session_id: seeded.sessionId, action: "revision", note: "sửa lại", base_version: version }),
      c.post(`/resume`)
    ]
    for (const res of await Promise.all(calls)) {
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error.code).toBe("DRAFT_LOCKED")
    }
    // Không ghi gì vào Spine
    expect((await spineRepository.get(seeded.projectId))!.spine_version).toBe(version)

    await setPending(seeded, false)
    const free = await c.post(`/steps/${accepted}/gate`, { session_id: seeded.sessionId, action: "revision", note: "sửa lại", base_version: version })
    expect(free.body.error?.code).not.toBe("DRAFT_LOCKED")
  })

  it("cài đặt cách vẽ sơ đồ (ký pháp ERD, mức Sequence Diagram, theme màn) khi chờ Lead ⇒ 409 DRAFT_LOCKED", async () => {
    const seeded = await seedFixture("full")
    const auth = { Authorization: `Bearer ${seeded.token}` }
    const base = `/api/v1/projects/${seeded.projectId}`
    await setPending(seeded, true)
    const calls = [
      request(app).patch(`${base}/erd-notation`).set(auth).send({ erdNotation: "crowsfoot" }),
      request(app).patch(`${base}/sequence-level`).set(auth).send({ sequenceLevel: "component" }),
      request(app).patch(`${base}/screen-theme`).set(auth).send({ primaryColor: "#336699" })
    ]
    for (const res of await Promise.all(calls)) {
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error.code).toBe("DRAFT_LOCKED")
    }
    await setPending(seeded, false)
    const ok = await request(app).patch(`${base}/erd-notation`).set(auth).send({ erdNotation: "crowsfoot" })
    expect(ok.status, JSON.stringify(ok.body.error)).toBe(200)
  })

  it("comment: 'đã sửa' bị khoá khi chờ Lead, mở lại step khi không chờ; 'giữ nguyên' không mở lại step và không bị khoá", async () => {
    const seeded = await seedFixture("full")
    const c = api(seeded)

    const kept = await commentOn(c, "Câu này nên giữ")
    const owner = kept.stepIds[0]
    await setPending(seeded, true)
    const keptRes = await c.post(`/comments/${kept.commentId}/resolve`, { kind: "kept", reason: "Đúng theo yêu cầu khách" })
    expect(keptRes.status, JSON.stringify(keptRes.body.error)).toBe(200)
    if (owner) expect(await stepStatus(seeded, owner)).toBe("accepted")

    await setPending(seeded, false)
    const fixed = await commentOn(c, "Cần sửa lại vai trò")
    await setPending(seeded, true)
    const locked = await c.post(`/comments/${fixed.commentId}/resolve`, { kind: "fixed" })
    expect(locked.status).toBe(409)
    expect(locked.body.error.code).toBe("DRAFT_LOCKED")
    // Bị từ chối thì comment vẫn mở
    const stillOpen = (await c.get("/comments?status=all")).body.data.find((x: { comment_id: string }) => x.comment_id === fixed.commentId)
    expect(stillOpen.status).toBe("open")

    await setPending(seeded, false)
    const ok = await c.post(`/comments/${fixed.commentId}/resolve`, { kind: "fixed" })
    expect(ok.status, JSON.stringify(ok.body.error)).toBe(200)
    if (fixed.stepIds[0]) expect(await stepStatus(seeded, fixed.stepIds[0])).toBe("revision_requested")
  })
})
