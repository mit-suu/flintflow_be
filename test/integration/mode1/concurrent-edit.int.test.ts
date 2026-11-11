/**
 * FLF-375 — business-flow §3.2 "Hai người sửa cùng lúc" trên Mongo thật (thay `lock.int.test.ts` — đã bỏ khoá):
 * không khoá chỗ đang sửa; đề xuất chưa xác nhận treo ở người yêu cầu; lúc xác nhận (C-6) Code kiểm lại trên nội dung
 * hiện tại theo bốn trường hợp; không có đường ghi đè.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { crToImpact, crToReady, detail, importedProject, lockedPaths, newCr, promptsOf, resetCrMock, type Mode1Client } from "../../helpers/mode1-cr-p4.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { unlockPaths } from "../../../src/modules/change-request/lock.service.js"
import { SpineLock } from "../../../src/modules/change-request/spine-lock.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { User } from "../../../src/modules/user/user.model.js"
import { Membership } from "../../../src/modules/organization/membership.model.js"
import { authAs } from "../../setup.js"
import { mode1Api } from "../../helpers/mode1.js"

beforeEach(() => resetCrMock())

const NFR = "nfrs[id=NFR-01]"

/** Người khác ghi vào bản nháp trong lúc CR này chờ xác nhận (vd CR-099 đã xác nhận trước). */
const otherWrites = async (projectId: string, ops: { op: "set"; path: string; value: unknown }[]) => {
  const spine = (await spineRepository.get(projectId))!
  await applyTransaction(projectId, { base_version: spine.spine_version, ops, by: "CR-099", reason: "CR-099: sửa trước", step_id: null })
}

const confirm = async (c: Mode1Client, cr: string) => detail(await c.post(`${cr}/submit`))
const nfrOf = (d: ReturnType<typeof detail>) => d.locations.find((l) => l.path === NFR)!

describe("không khoá chỗ đang sửa", () => {
  it("hai CR cùng chạm một phần tử đều tìm được vị trí; mỗi bên thấy bên kia có bản sửa chưa xác nhận", async () => {
    const { c, projectId } = await importedProject()
    const first = await crToReady(c)
    const second = await crToImpact(c, "Tighter performance", "Also about the 2 seconds response time.")
    expect(second.impact.locations.map((l) => l.path)).toContain(NFR)
    expect(await lockedPaths(projectId, first.crId)).toEqual([])
    expect(nfrOf(detail(await c.get(second.cr))).others_pending).toEqual([expect.objectContaining({ cr_id: first.crId })])
  })

  it("dòng khoá cũ (trước FLF-375) không chặn ai; unlockPaths vẫn dọn được", async () => {
    const { c, projectId } = await importedProject()
    await SpineLock.create({ projectId, path: NFR, cr_id: "CR-777" })
    const { impact } = await crToImpact(c)
    expect(impact.locations.map((l) => l.path)).toContain(NFR)
    await unlockPaths(projectId, "CR-777")
    expect(await SpineLock.countDocuments({ projectId })).toBe(0)
  })
})

describe("C-6 kiểm lại trên nội dung hiện tại", () => {
  it("người khác sửa đúng chữ đề xuất định đổi ⇒ không ghi gì, 'Cần bạn quyết' với so sánh 3 cột; Bỏ yêu cầu ⇒ hết xung đột", async () => {
    const { c, projectId } = await importedProject()
    const { cr } = await crToReady(c)
    const versions = await DocVersion.countDocuments({ projectId })
    await otherWrites(projectId, [{ op: "set", path: `${NFR}.threshold`, value: "3 s" }])

    const d = await confirm(c, cr)
    expect(d.change_request.status).toBe("manual_fix")
    expect(await DocVersion.countDocuments({ projectId })).toBe(versions)
    const nfr = nfrOf(d)
    expect(nfr.conflict).toMatchObject({ changed_by: "CR-099" })
    expect(nfr.conflict!.at_proposal).toContain("2 s")
    expect(nfr.conflict!.current).toContain("3 s")
    expect(nfr.conflict!.proposal).toContain("1 s")
    // Không có đường ghi đè: xác nhận lại khi chưa quyết ⇒ không cho
    expect((await c.post(`${cr}/submit`)).status).toBe(409)

    const dropped = detail(await c.patch(`${cr}/locations/${nfr.location_id}`, { conclusion: "not_related", reason: "Bỏ vì mục đã được CR-099 sửa" }))
    expect(nfrOf(dropped)).toMatchObject({ conflict: null, conclusion: "not_related" })
  })

  it("người khác đã sửa đúng như đề xuất ⇒ chỗ đó không ghi lại, báo 'đã được … sửa giống đề xuất của bạn'", async () => {
    const { c, projectId } = await importedProject()
    const { cr } = await crToReady(c)
    await otherWrites(projectId, [
      { op: "set", path: `${NFR}.threshold`, value: "1 s" },
      { op: "set", path: `${NFR}.statement`, value: "The system shall respond within 1 second for 95% of requests." }
    ])
    const d = await confirm(c, cr)
    expect(nfrOf(d)).toMatchObject({ conclusion: "not_related", reason: expect.stringContaining("sửa giống đề xuất của bạn") })
    // Sau import, chỉ CR-099 sửa NFR-01 — CR này không ghi lại lần nữa
    const changes = (await spineRepository.listChanges(projectId)).filter((ch) => ch.path.startsWith(NFR) && ch.by !== "import")
    expect(changes.map((ch) => ch.by)).toEqual(["CR-099", "CR-099"])
  })

  it("người khác sửa phần khác trong cùng chỗ ⇒ ghép rồi ghi: giữ phần họ sửa + phần đề xuất đổi", async () => {
    const { c, projectId } = await importedProject()
    const { cr } = await crToReady(c)
    await otherWrites(projectId, [{ op: "set", path: `${NFR}.metric`, value: "p95 latency" }])
    const d = await confirm(c, cr)
    expect(d.change_request.status).toBe("written")
    const nfr = (await spineRepository.get(projectId))!.nfrs.find((n) => n.id === "NFR-01")!
    expect(nfr).toMatchObject({ metric: "p95 latency", threshold: "1 s" })
  })

  it("không ai sửa ⇒ ghi như thường, không có xung đột", async () => {
    const { c } = await importedProject()
    const { cr } = await crToReady(c)
    const d = await confirm(c, cr)
    expect(d.change_request.status).toBe("written")
    expect(d.locations.every((l) => !l.conflict)).toBe(true)
    expect(await ChangeLocation.countDocuments({ conflict: { $ne: null } })).toBe(0)
  })
})

describe("đề xuất chưa xác nhận không chặn ai", () => {
  it("CR tạo sau ghi trước; CR tạo trước xác nhận sau ⇒ kiểm lại trên nội dung mới", async () => {
    const { c } = await importedProject()
    const late = await newCr(c, "Faster response time", "Response time must be 1 second instead of 2 seconds.")
    const early = await crToReady(c)
    expect((await confirm(c, early.cr)).change_request.status).toBe("written")
    expect(late).not.toBe(early.crId)
  })
})

describe("AI soạn lại trên nội dung hiện tại (BF §3.2)", () => {
  it("yêu cầu gốc đụng thẳng phần người khác vừa sửa ⇒ AI hỏi lại trong chat (không gọi model); trả lời ⇒ soạn lại, hết xung đột", async () => {
    const { c, projectId } = await importedProject()
    const { cr } = await crToReady(c)
    await otherWrites(projectId, [{ op: "set", path: `${NFR}.threshold`, value: "3 s" }])
    const nfr = nfrOf(await confirm(c, cr))
    expect(nfr.conflict?.proposed_at).toEqual(expect.any(String))
    expect(nfr.conflict?.question).toBeNull()

    const before = promptsOf("# CR Propose").length
    const asked = nfrOf(detail(await c.post(`${cr}/locations/${nfr.location_id}/owner-step-draft`, { instruction: "Áp yêu cầu gốc lên nội dung hiện tại" })))
    expect(asked.conflict?.question?.text).toContain("CR-099 vừa đổi")
    expect(asked.conflict?.question?.suggestions).toHaveLength(2)
    expect(promptsOf("# CR Propose").length).toBe(before)

    const answer = asked.conflict!.question!.suggestions[0]
    const redone = nfrOf(detail(await c.post(`${cr}/locations/${nfr.location_id}/owner-step-draft`, { instruction: answer })))
    expect(redone.conflict).toBeNull()
    expect(promptsOf("# CR Propose").length).toBe(before + 1)
    expect(promptsOf("# CR Propose").at(-1)).toContain(answer)
    // Câu trả lời thành một vòng làm rõ — bước kiểm nhất quán / làm rõ sau không hỏi lại
    const doc = (await ChangeRequest.findOne({ projectId, cr_id: cr.split("/").pop() }).lean())!
    expect(doc.clarifications.at(-1)).toMatchObject({ questions: [asked.conflict!.question!.text], answers: [answer] })
  })
})

describe("đề xuất chưa xác nhận treo ở người yêu cầu (BF §3.2)", () => {
  const joinOrg = async (orgId: string) => {
    const email = `analyst-${Date.now()}@flintflow.test`
    const user = await User.create({ email, name: "Huy", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: orgId, userId: user._id, role: "analyst" })
    return authAs({ _id: user._id, email, orgId })
  }

  it("người khác không xác nhận được CR của người này (403, nói rõ treo ở ai); tài liệu cho mọi người thấy mục nào đang có bản sửa chưa xác nhận", async () => {
    const { seeded, c, projectId } = await importedProject()
    const { cr } = await crToReady(c)
    const other = mode1Api({ ...seeded, token: await joinOrg(seeded.orgId) }, projectId)

    const res = await other.post(`${cr}/submit`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("CR_NOT_REQUESTER")
    expect(res.body.error.message).toContain("treo ở")

    const pending = await other.get("/change-requests/pending-sections")
    expect(pending.status, JSON.stringify(pending.body.error)).toBe(200)
    const sections = pending.body.data as { section_id: string; title: string; items: { cr_id: string; who: string }[] }[]
    expect(sections.length).toBeGreaterThan(0)
    expect(sections.flatMap((s) => s.items)).toContainEqual({ cr_id: "CR-001", who: "Fixture User" })
    expect(sections.every((s) => s.title && !/^[a-z_]+:/.test(s.title))).toBe(true)

    // Người yêu cầu vẫn xác nhận được như thường
    expect((await confirm(c, cr)).change_request.status).toBe("written")
  })
})
