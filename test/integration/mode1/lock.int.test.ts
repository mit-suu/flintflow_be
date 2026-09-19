/**
 * Khoá block cho CR (`lock.service.ts`, nút 3.5) trên Mongo thật. FLF-172, plan §8.3.
 * Ca chính: khoá nguyên tử; CR thứ hai chạm block ⇒ BLOCK_LOCKED; giữ khoá khi paused; mở khi cancel/close/write.
 * Thêm: khoá lại block đã giữ là no-op, giành chồng đồng thời không kẹt khoá, PATCH vị trí mất khoá ⇒ BLOCK_LOCKED.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { PERF_TARGETS, crToImpact, crToReview, detail, importedProject, lockedBlocks, newCr, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose } from "../../helpers/mode1.js"
import { lockBlocks, unlockBlocks } from "../../../src/modules/change-request/lock.service.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { Mode1Error } from "../../../src/modules/import/mode1.errors.js"

beforeEach(() => resetCrMock())

const V = "0.0"

describe("lockBlocks — nguyên tử", () => {
  it("khoá hết block yêu cầu; gọi lại (kể cả trùng id) là no-op; danh sách rỗng là no-op", async () => {
    const { projectId } = await importedProject()
    await lockBlocks(projectId, V, "CR-001", ["B0002", "B0039", "B0039"])
    expect(await lockedBlocks(projectId, "CR-001")).toEqual(["B0002", "B0039"])
    await lockBlocks(projectId, V, "CR-001", ["B0002", "B0039"])
    await lockBlocks(projectId, V, "CR-001", [])
    expect(await lockedBlocks(projectId, "CR-001")).toEqual(["B0002", "B0039"])
    // mở rộng: giữ phần đã có, giành thêm phần mới
    await lockBlocks(projectId, V, "CR-001", ["B0039", "B0041"])
    expect(await lockedBlocks(projectId, "CR-001")).toEqual(["B0002", "B0039", "B0041"])
  })

  it("chồng một phần với CR khác ⇒ 409 BLOCK_LOCKED kèm CR đang giữ; trả lại phần vừa giành (không khoá nửa vời)", async () => {
    const { projectId } = await importedProject()
    await lockBlocks(projectId, V, "CR-001", ["B0039"])
    await lockBlocks(projectId, V, "CR-002", ["B0002"])
    const err = await lockBlocks(projectId, V, "CR-002", ["B0038", "B0039", "B0041"]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Mode1Error)
    expect(err).toMatchObject({ code: "BLOCK_LOCKED", statusCode: 409, meta: { locked: [{ block_id: "B0039", cr_id: "CR-001" }] } })
    expect((err as Error).message).toContain("CR-001")
    // B0038, B0041 vừa giành đã được trả; khoá cũ B0002 của CR-002 còn nguyên
    expect(await lockedBlocks(projectId, "CR-002")).toEqual(["B0002"])
    expect(await lockedBlocks(projectId, "CR-001")).toEqual(["B0039"])
  })

  it("block không tồn tại trong version ⇒ BLOCK_LOCKED không kèm CR giữ, không giữ gì", async () => {
    const { projectId } = await importedProject()
    await expect(lockBlocks(projectId, V, "CR-001", ["B0002", "B9999"])).rejects.toMatchObject({ code: "BLOCK_LOCKED", meta: { locked: [] } })
    expect(await lockedBlocks(projectId, "CR-001")).toEqual([])
  })

  it("hai CR giành chồng nhau cùng lúc ⇒ mỗi CR giữ đủ hoặc không giữ gì; block chung chỉ một CR giữ", async () => {
    const { projectId } = await importedProject()
    const a = ["B0038", "B0039", "B0041", "B0002"]
    const b = ["B0041", "B0039", "B0014", "B0020"]
    for (let round = 0; round < 5; round++) {
      await Promise.allSettled([lockBlocks(projectId, V, "CR-A", a), lockBlocks(projectId, V, "CR-B", b)])
      const heldA = await lockedBlocks(projectId, "CR-A")
      const heldB = await lockedBlocks(projectId, "CR-B")
      expect([[], [...a].sort()]).toContainEqual(heldA)
      expect([[], [...b].sort()]).toContainEqual(heldB)
      expect(heldA.length && heldB.length).toBe(0)
      await unlockBlocks(projectId, "CR-A")
      await unlockBlocks(projectId, "CR-B")
    }
  })

  it("unlockBlocks: mở một phần theo id, rồi mở hết; không đụng khoá CR khác", async () => {
    const { projectId } = await importedProject()
    await lockBlocks(projectId, V, "CR-001", ["B0002", "B0038", "B0039"])
    await lockBlocks(projectId, V, "CR-002", ["B0041"])
    await unlockBlocks(projectId, "CR-001", ["B0038", "B0041"])
    expect(await lockedBlocks(projectId, "CR-001")).toEqual(["B0002", "B0039"])
    await unlockBlocks(projectId, "CR-001")
    expect(await lockedBlocks(projectId, "CR-001")).toEqual([])
    expect(await lockedBlocks(projectId, "CR-002")).toEqual(["B0041"])
  })
})

describe("khoá theo vòng đời CR", () => {
  it("CR thứ hai chạm block đang khoá ⇒ 409 BLOCK_LOCKED, không ghi vị trí; CR đầu giữ nguyên khoá", async () => {
    const { c, projectId } = await importedProject()
    const first = await crToImpact(c)
    const before = await lockedBlocks(projectId, first.crId)
    const second = await newCr(c, "Tighter performance", "Also about the 2 seconds response time.")
    detail(await c.post(`/change-requests/${second}/clarify`))
    const res = await c.post(`/change-requests/${second}/impact`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("BLOCK_LOCKED")
    expect(res.body.meta.locked.map((l: { cr_id: string }) => l.cr_id)).toContain("CR-001")
    expect(detail(await c.get(`/change-requests/${second}`)).locations).toEqual([])
    expect(await lockedBlocks(projectId, second)).toEqual([])
    expect(await lockedBlocks(projectId, first.crId)).toEqual(before)
  })

  it("CR paused (hết credit ở C-4) vẫn giữ khoá; CR khác vẫn bị chặn", async () => {
    const { c, projectId, seeded } = await importedProject()
    const { crId, cr } = await crToImpact(c)
    const held = await lockedBlocks(projectId, crId)
    const { CreditWallet } = await import("../../../src/modules/credits/credit-wallet.model.js")
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })
    const paused = detail(await c.post(`${cr}/propose`))
    expect(paused.change_request.paused?.reason).toBe("credits")
    expect(await lockedBlocks(projectId, crId)).toEqual(held)
    await expect(lockBlocks(projectId, V, "CR-009", [held[0]])).rejects.toMatchObject({ code: "BLOCK_LOCKED" })
  })

  it("huỷ ⇒ mở hết khoá", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToImpact(c)
    detail(await c.post(`${cr}/cancel`, { reason: "Trùng với CR khác" }))
    expect(await lockedBlocks(projectId, crId)).toEqual([])
  })

  it("đóng (mọi group bị từ chối rồi close) ⇒ mở hết khoá, kể cả vị trí not_related", async () => {
    // thêm từ khoá chạm "5.9 Team Notes" ⇒ vị trí not_related (không vào group nào)
    resetCrMock((p) => fakeCrClarify({ ...PERF_TARGETS, keywords: [...PERF_TARGETS.keywords, "Internal notes"] })(p) ?? fakeCrPropose(p))
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    for (const g of submitted.groups) {
      detail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "rejected", reason: "Ngoài phạm vi bản 1.0", base_version: await c.spineVersion() }))
    }
    // vị trí not_related (không vào group nào) vẫn còn khoá tới khi đóng
    expect(await lockedBlocks(projectId, crId)).toEqual(["B0048"])
    const closed = detail(await c.post(`${cr}/close`, { reason: "Khách hàng bỏ yêu cầu" }))
    expect(closed.change_request.status).toBe("rejected")
    expect(await lockedBlocks(projectId, crId)).toEqual([])
  })

  it("ghi (write) ⇒ mở hết khoá ở mọi version", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    for (const g of submitted.groups) detail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", base_version: await c.spineVersion() }))
    expect(detail(await c.get(cr)).change_request.status).toBe("written")
    expect(await lockedBlocks(projectId, crId)).toEqual([])
    expect(await DocBlock.countDocuments({ projectId, locked_by_cr: { $ne: null } })).toBe(0)
  })

  it("PATCH vị trí khi block không còn do CR giữ ⇒ 409 BLOCK_LOCKED (kèm CR đang giữ nếu có)", async () => {
    const { c, projectId } = await importedProject()
    const { cr, impact } = await crToImpact(c)
    const [l1, l2] = impact.locations
    await DocBlock.updateOne({ projectId, doc_version: V, block_id: l1.block_id }, { $set: { locked_by_cr: null } })
    const free = await c.patch(`${cr}/locations/${l1.location_id}`, { conclusion: "not_related", reason: "Không liên quan" })
    expect(free.status).toBe(409)
    expect(free.body.error.code).toBe("BLOCK_LOCKED")
    expect(free.body.meta.locked).toEqual([])
    await DocBlock.updateOne({ projectId, doc_version: V, block_id: l2.block_id }, { $set: { locked_by_cr: "CR-777" } })
    const taken = await c.patch(`${cr}/locations/${l2.location_id}`, { conclusion: "not_related", reason: "Không liên quan" })
    expect(taken.status).toBe(409)
    expect(taken.body.meta.locked).toEqual([{ block_id: l2.block_id, cr_id: "CR-777" }])
  })
})
