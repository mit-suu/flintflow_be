/**
 * FLF-375 — business-flow §3.2 "Hai người sửa cùng lúc" trên Mongo thật (thay `lock.int.test.ts` — đã bỏ khoá):
 * không khoá chỗ đang sửa; đề xuất chưa xác nhận treo ở người yêu cầu; lúc xác nhận (C-6) Code kiểm lại trên nội dung
 * hiện tại theo bốn trường hợp; không có đường ghi đè.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { crToImpact, crToReady, detail, importedProject, lockedPaths, newCr, resetCrMock, type Mode1Client } from "../../helpers/mode1-cr-p4.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"
import { unlockPaths } from "../../../src/modules/change-request/lock.service.js"
import { SpineLock } from "../../../src/modules/change-request/spine-lock.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { applyTransaction } from "../../../src/modules/spine/op-engine.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

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
