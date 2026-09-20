/**
 * Khoá phần tử Spine cho CR (`lock.service.ts`, nút 3.5) trên Mongo thật. Mode 1 v2 (FLF-186): khoá theo path.
 * Ca chính: khoá nguyên tử; CR thứ hai chạm phần tử ⇒ PATH_LOCKED; giữ khoá khi paused; mở khi cancel/close/write.
 * Thêm: khoá lại path đã giữ là no-op, giành chồng đồng thời không kẹt khoá, PATCH vị trí mất khoá ⇒ PATH_LOCKED.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { PERF_TARGETS, crToImpact, crToReview, detail, importedProject, lockedPaths, newCr, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { fakeCrClarify, fakeCrPropose } from "../../helpers/mode1.js"
import { lockPaths, unlockPaths } from "../../../src/modules/change-request/lock.service.js"
import { SpineLock } from "../../../src/modules/change-request/spine-lock.model.js"
import { Mode1Error } from "../../../src/modules/import/mode1.errors.js"

beforeEach(() => resetCrMock())

const A = "actors[id=A01]"
const B = "use_cases[id=UC-01]"
const C = "nfrs[id=NFR-01]"
const D = "business_rules[id=BR-01]"

/** Thêm từ khoá chạm mô tả actor Learner ⇒ có vị trí not_related. */
const withUnrelated = () => resetCrMock((p) => fakeCrClarify({ ...PERF_TARGETS, keywords: [...PERF_TARGETS.keywords, "enrolls"] })(p) ?? fakeCrPropose(p))

describe("lockPaths — nguyên tử", () => {
  it("khoá hết path yêu cầu; gọi lại (kể cả trùng) là no-op; danh sách rỗng là no-op; mở rộng giữ phần đã có", async () => {
    const { projectId } = await importedProject()
    await lockPaths(projectId, "CR-001", [A, C, C])
    expect(await lockedPaths(projectId, "CR-001")).toEqual([A, C].sort())
    await lockPaths(projectId, "CR-001", [A, C])
    await lockPaths(projectId, "CR-001", [])
    await lockPaths(projectId, "CR-001", [C, D])
    expect(await lockedPaths(projectId, "CR-001")).toEqual([A, C, D].sort())
  })

  it("chồng một phần với CR khác ⇒ 409 PATH_LOCKED kèm CR đang giữ; trả lại phần vừa giành (không khoá nửa vời)", async () => {
    const { projectId } = await importedProject()
    await lockPaths(projectId, "CR-001", [C])
    await lockPaths(projectId, "CR-002", [A])
    const err = await lockPaths(projectId, "CR-002", [B, C, D]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Mode1Error)
    expect(err).toMatchObject({ code: "PATH_LOCKED", statusCode: 409, meta: { locked: [{ path: C, cr_id: "CR-001" }] } })
    expect((err as Error).message).toContain("CR-001")
    expect(await lockedPaths(projectId, "CR-002")).toEqual([A])
    expect(await lockedPaths(projectId, "CR-001")).toEqual([C])
  })

  it("hai CR giành chồng nhau cùng lúc ⇒ mỗi CR giữ đủ hoặc không giữ gì; path chung chỉ một CR giữ", async () => {
    const { projectId } = await importedProject()
    const a = [A, B, C]
    const b = [C, B, D]
    for (let round = 0; round < 5; round++) {
      await Promise.allSettled([lockPaths(projectId, "CR-A", a), lockPaths(projectId, "CR-B", b)])
      const heldA = await lockedPaths(projectId, "CR-A")
      const heldB = await lockedPaths(projectId, "CR-B")
      expect([[], [...a].sort()]).toContainEqual(heldA)
      expect([[], [...b].sort()]).toContainEqual(heldB)
      expect(heldA.length && heldB.length).toBe(0)
      await unlockPaths(projectId, "CR-A")
      await unlockPaths(projectId, "CR-B")
    }
  })

  it("unlockPaths: mở một phần, rồi mở hết; không đụng khoá CR khác", async () => {
    const { projectId } = await importedProject()
    await lockPaths(projectId, "CR-001", [A, B, C])
    await lockPaths(projectId, "CR-002", [D])
    await unlockPaths(projectId, "CR-001", [B, D])
    expect(await lockedPaths(projectId, "CR-001")).toEqual([A, C].sort())
    await unlockPaths(projectId, "CR-001")
    expect(await lockedPaths(projectId, "CR-001")).toEqual([])
    expect(await lockedPaths(projectId, "CR-002")).toEqual([D])
  })
})

describe("khoá theo vòng đời CR", () => {
  it("CR thứ hai chạm phần tử đang khoá ⇒ 409 PATH_LOCKED, không ghi vị trí; CR đầu giữ nguyên khoá", async () => {
    const { c, projectId } = await importedProject()
    const first = await crToImpact(c)
    const before = await lockedPaths(projectId, first.crId)
    expect(before).toContain(C)
    const second = await newCr(c, "Tighter performance", "Also about the 2 seconds response time.")
    detail(await c.post(`/change-requests/${second}/clarify`))
    const res = await c.post(`/change-requests/${second}/impact`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("PATH_LOCKED")
    expect(res.body.meta.locked.map((l: { cr_id: string }) => l.cr_id)).toContain("CR-001")
    expect(detail(await c.get(`/change-requests/${second}`)).locations).toEqual([])
    expect(await lockedPaths(projectId, second)).toEqual([])
    expect(await lockedPaths(projectId, first.crId)).toEqual(before)
  })

  it("CR paused (hết credit ở C-4) vẫn giữ khoá; CR khác vẫn bị chặn", async () => {
    const { c, projectId, seeded } = await importedProject()
    const { crId, cr } = await crToImpact(c)
    const held = await lockedPaths(projectId, crId)
    const { CreditWallet } = await import("../../../src/modules/credits/credit-wallet.model.js")
    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })
    const paused = detail(await c.post(`${cr}/propose`))
    expect(paused.change_request.paused?.reason).toBe("credits")
    expect(await lockedPaths(projectId, crId)).toEqual(held)
    await expect(lockPaths(projectId, "CR-009", [held[0]])).rejects.toMatchObject({ code: "PATH_LOCKED" })
  })

  it("huỷ ⇒ mở hết khoá", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr } = await crToImpact(c)
    detail(await c.post(`${cr}/cancel`, { reason: "Trùng với CR khác" }))
    expect(await lockedPaths(projectId, crId)).toEqual([])
  })

  it("đóng (mọi group bị từ chối rồi close) ⇒ mở hết khoá, kể cả vị trí not_related", async () => {
    withUnrelated()
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    const unrelated = submitted.locations.filter((l) => l.conclusion === "not_related").map((l) => l.path)
    expect(unrelated.length).toBeGreaterThan(0)
    for (const g of submitted.groups) {
      detail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "rejected", reason: "Ngoài phạm vi bản 1.0", base_version: await c.spineVersion() }))
    }
    // vị trí not_related (không vào group nào) vẫn còn khoá tới khi đóng
    expect(await lockedPaths(projectId, crId)).toEqual(unrelated.sort())
    const closed = detail(await c.post(`${cr}/close`, { reason: "Khách hàng bỏ yêu cầu" }))
    expect(closed.change_request.status).toBe("rejected")
    expect(await lockedPaths(projectId, crId)).toEqual([])
  })

  it("ghi (write) ⇒ mở hết khoá", async () => {
    const { c, projectId } = await importedProject()
    const { crId, cr, submitted } = await crToReview(c)
    for (const g of submitted.groups) detail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", base_version: await c.spineVersion() }))
    expect(detail(await c.get(cr)).change_request.status).toBe("written")
    expect(await lockedPaths(projectId, crId)).toEqual([])
    expect(await SpineLock.countDocuments({ projectId })).toBe(0)
  })

  it("PATCH vị trí khi phần tử không còn do CR giữ ⇒ 409 PATH_LOCKED (kèm CR đang giữ nếu có)", async () => {
    withUnrelated()
    const { c, projectId } = await importedProject()
    const { cr, impact } = await crToImpact(c)
    const [l1, l2] = impact.locations
    await SpineLock.deleteOne({ projectId, path: l1.path })
    const free = await c.patch(`${cr}/locations/${l1.location_id}`, { conclusion: "not_related", reason: "Không liên quan" })
    expect(free.status).toBe(409)
    expect(free.body.error.code).toBe("PATH_LOCKED")
    expect(free.body.meta.locked).toEqual([])
    await SpineLock.updateOne({ projectId, path: l2.path }, { $set: { cr_id: "CR-777" } })
    const taken = await c.patch(`${cr}/locations/${l2.location_id}`, { conclusion: "not_related", reason: "Không liên quan" })
    expect(taken.status).toBe(409)
    expect(taken.body.meta.locked).toEqual([{ path: l2.path, cr_id: "CR-777" }])
  })
})
