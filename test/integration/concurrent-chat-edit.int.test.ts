/**
 * P12 — business-flow §3.2 "Hai người sửa cùng lúc" cho **sửa qua chat trước baseline** (chốt câu 8): ai xác nhận trước ghi
 * trước; người xác nhận sau được kiểm lại theo nội dung từng chỗ thay vì 409 theo `spine_version` cả tài liệu (T5).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import request from "supertest"

vi.mock("../../src/shared/ai/providers/llm.router.js", async () => (await import("../helpers/mock-llm.js")).mockLlmRouterModule())

import app from "../../src/app.js"
import { authAs, seedFixture, type SeededFixture } from "../setup.js"
import { mockOverrides, resetMockLlm } from "../helpers/mock-llm.js"
import { User } from "../../src/modules/user/user.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { Change } from "../../src/modules/spine/change.model.js"

beforeEach(() => resetMockLlm())

const as = (projectId: string, token: string) => {
  const base = `/api/v1/projects/${projectId}`
  const auth = { Authorization: `Bearer ${token}` }
  return {
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body),
    del: (suffix: string) => request(app).delete(`${base}${suffix}`).set(auth),
    get: (suffix: string) => request(app).get(`${base}${suffix}`).set(auth)
  }
}

/** Tuấn Anh (Lead của fixture) + Bình (Analyst cùng org). */
const twoPeople = async () => {
  const seeded: SeededFixture = await seedFixture("full")
  const email = `binh-${Date.now()}@flintflow.test`
  const binh = await User.create({ email, name: "Bình", password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: seeded.orgId, userId: binh._id, role: "analyst" })
  return { seeded, tuan: as(seeded.projectId, seeded.token), binh: as(seeded.projectId, await authAs({ _id: binh._id, email, orgId: seeded.orgId })) }
}

const G01 = "glossary[id=G01].definition"
const INSTRUCTION = "Sửa định nghĩa SRS trong thuật ngữ"

/** Mỗi người gõ một lệnh ⇒ bản xem trước của người đó (model giả trả đúng lô op). */
const previewOf = async (who: ReturnType<typeof as>, version: number, ops: object[]) => {
  mockOverrides.next = () => JSON.stringify({ ops })
  const res = await who.post("/changes/preview", { base_version: version, instruction: INSTRUCTION })
  expect(res.status, JSON.stringify(res.body.error)).toBe(200)
  return res.body.data as { preview_id: string; base_version: number }
}

describe("sửa qua chat trước baseline — xác nhận sau người kia", () => {
  it("người kia sửa mục khác ⇒ người sau vẫn áp được (không 409)", async () => {
    const { seeded, tuan, binh } = await twoPeople()
    const mine = await previewOf(tuan, seeded.spineVersion, [{ op: "set", path: G01, value: "Tài liệu đặc tả yêu cầu phần mềm." }])
    const theirs = await previewOf(binh, seeded.spineVersion, [{ op: "set", path: "actors[id=A01].name", value: "Chủ sân" }])
    expect((await binh.post("/changes", { instruction: INSTRUCTION, base_version: seeded.spineVersion, preview_id: theirs.preview_id })).status).toBe(200)

    const res = await tuan.post("/changes", { instruction: INSTRUCTION, base_version: seeded.spineVersion, preview_id: mine.preview_id })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data.spine.glossary.find((g: { id: string }) => g.id === "G01").definition).toBe("Tài liệu đặc tả yêu cầu phần mềm.")
    expect(res.body.data.spine.actors.find((a: { id: string }) => a.id === "A01").name).toBe("Chủ sân")
  })

  it("người kia sửa giống đề xuất ⇒ không ghi lần hai, meta.already_applied nêu tên người đó", async () => {
    const { seeded, tuan, binh } = await twoPeople()
    const op = { op: "set", path: G01, value: "Tài liệu đặc tả yêu cầu phần mềm." }
    const mine = await previewOf(tuan, seeded.spineVersion, [op])
    const theirs = await previewOf(binh, seeded.spineVersion, [op])
    await binh.post("/changes", { instruction: INSTRUCTION, base_version: seeded.spineVersion, preview_id: theirs.preview_id })
    const before = await Change.countDocuments({ projectId: seeded.projectId })

    const res = await tuan.post("/changes", { instruction: INSTRUCTION, base_version: seeded.spineVersion, preview_id: mine.preview_id, session_id: seeded.sessionId })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data.txn).toBeNull()
    expect(res.body.meta.already_applied).toEqual([expect.objectContaining({ changed_by: "Bình", section_id: "fixed:5.5" })])
    expect(await Change.countDocuments({ projectId: seeded.projectId })).toBe(before)
  })

  it("người kia sửa đúng chữ ⇒ 409 kèm ①②③ (Bình, giờ); Bỏ yêu cầu xoá bản xem trước; AI soạn lại trên nội dung mới thì áp được", async () => {
    const { seeded, tuan, binh } = await twoPeople()
    const mine = await previewOf(tuan, seeded.spineVersion, [{ op: "set", path: G01, value: "Bản đặc tả yêu cầu phần mềm (SRS)." }])
    const theirs = await previewOf(binh, seeded.spineVersion, [{ op: "set", path: G01, value: "Tài liệu đặc tả yêu cầu." }])
    await binh.post("/changes", { instruction: INSTRUCTION, base_version: seeded.spineVersion, preview_id: theirs.preview_id })

    const res = await tuan.post("/changes", { instruction: INSTRUCTION, base_version: seeded.spineVersion, preview_id: mine.preview_id })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("SPINE_VERSION_CONFLICT")
    expect(res.body.meta.conflicts).toEqual([
      expect.objectContaining({ current: "Tài liệu đặc tả yêu cầu.", proposal: "Bản đặc tả yêu cầu phần mềm (SRS).", changed_by: "Bình", changed_at: expect.any(String) })
    ])
    expect(res.body.meta.preview_id).toBe(mine.preview_id)

    // Bỏ yêu cầu: bản xem trước còn trong kho ⇒ xoá được, không tốn credit
    const dropped = await tuan.del(`/changes/preview/${mine.preview_id}`)
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(200)
    expect(dropped.body.data).toEqual({ discarded: true })

    // AI soạn lại trên nội dung hiện tại (base_version cũ cũng được — xem trước dựng trên Spine hiện tại) ⇒ áp được
    const redraft = await previewOf(tuan, seeded.spineVersion, [{ op: "set", path: G01, value: "Tài liệu đặc tả yêu cầu (SRS)." }])
    const ok = await tuan.post("/changes", { instruction: INSTRUCTION, base_version: redraft.base_version, preview_id: redraft.preview_id })
    expect(ok.status, JSON.stringify(ok.body.error)).toBe(200)
  })
})
