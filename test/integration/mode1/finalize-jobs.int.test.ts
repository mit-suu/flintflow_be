/**
 * Finalize (1.10–1.12) chạy nền qua HTTP (`finalize-jobs.ts`): trả ngay `baselining`, lỗi 4xx vẫn trả ngay, gọi trùng
 * khi đang chạy = không làm gì, job lỗi giữa `baselining` ⇒ hoàn về mốc + `paused: resume_later`, resume chạy lại sạch;
 * job mất (máy chủ khởi động lại) ⇒ `GET /import` đặt `resume_later`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1, mode1Api } from "../../helpers/mode1.js"
import { seedFixture } from "../../setup.js"
import { makeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { finalizeResponseSchema, getImportResponseSchema } from "../../../src/modules/import/import.dto.js"
import { finalizeCheckpoint } from "../../../src/modules/import/finalize.service.js"
import { isFinalizeRunning, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { docFileStore, setDocFileStore, type DocFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { Baseline } from "../../../src/modules/spine/baseline.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

/** Upload ⇒ xác nhận ⇒ I-4 ⇒ xác nhận mọi field ⇒ import ở `baselining`. */
const atBaselining = async () => {
  const seeded = await seedFixture("minimal")
  const projectId = await createMode1Project(seeded)
  const c = mode1Api(seeded, projectId)
  const id = (await c.upload(await makeSrsDocx())).body.data.import.id as string
  await c.post("/import/confirm-latest", { import_id: id })
  await c.extractAndWait(id)
  expect((await c.patch("/import/fields", { import_id: id, confirm_all: true })).body.data.import.status).toBe("baselining")
  return { seeded, projectId, c, id }
}

/** Store file bọc store thật: lần lưu file `version` thứ `nth` (bản render 0.0) ném lỗi — lỗi sau khi Spine đã đổi. */
const failingVersionSave = (nth: number): (() => void) => {
  const real = docFileStore()
  let saves = 0
  const store = new Proxy(real, {
    get(target, prop) {
      if (prop === "save") {
        return async (...args: Parameters<DocFileStore["save"]>) => {
          if (args[1].kind === "version" && ++saves === nth) throw new Error("render bản 0.0 hỏng (test)")
          return target.save(...args)
        }
      }
      const value = Reflect.get(target, prop) as unknown
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
    }
  })
  return setDocFileStore(store)
}

const dataOf = async (projectId: string) => {
  const s = (await spineRepository.get(projectId))!
  return { actors: s.actors, use_cases: s.use_cases, functions: s.functions, steps: s.steps, baselines: s.baselines, diagrams: s.diagrams }
}

describe("finalize chạy nền — trả ngay, kiểm điều kiện ngay", () => {
  it("trả ngay baselining (baseline/flags null); lỗi base_version / trạng thái vẫn 4xx ngay; xong job ⇒ gap_review", async () => {
    const { c, id } = await atBaselining()
    const conflict = await c.post("/import/finalize", { import_id: id, base_version: 999 })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe("SPINE_VERSION_CONFLICT")
    expect(isFinalizeRunning(id)).toBe(false)
    expect((await ImportedDocument.findById(id).lean())?.finalize_checkpoint).toBeNull()

    const v = await c.spineVersion()
    const res = await c.post("/import/finalize", { import_id: id, base_version: v })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(finalizeResponseSchema.parse(res.body.data)).toMatchObject({ import: { status: "baselining", paused: null }, baseline: null, flags: null, spine_version: v })
    await waitForFinalize(id)
    const view = getImportResponseSchema.parse((await c.get("/import")).body.data)
    expect(view.import).toMatchObject({ status: "gap_review", paused: null })

    // đã xong ⇒ finalize lại là sai trạng thái như trước
    const again = await c.post("/import/finalize", { import_id: id, base_version: await c.spineVersion() })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe("IMPORT_INVALID_STATE")
  })

  it("hai request đồng thời ⇒ một job, một baseline; request thứ hai trả trạng thái hiện tại", async () => {
    const { c, id, projectId } = await atBaselining()
    const v = await c.spineVersion()
    const [a, b] = await Promise.all([c.post("/import/finalize", { import_id: id, base_version: v }), c.post("/import/finalize", { import_id: id, base_version: v })])
    expect([a.status, b.status]).toEqual([200, 200])
    await waitForFinalize(id)
    expect((await c.get("/import")).body.data.import.status).toBe("gap_review")
    expect(await Baseline.countDocuments({ projectId })).toBe(1)
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
  })
})

describe("finalize chạy nền — lỗi giữa chừng, job mất", () => {
  it("lỗi sau khi Spine đã đổi ⇒ hoàn về mốc + paused resume_later; resume chạy lại sạch, giữ Record of Changes đã sửa", async () => {
    const { c, id, projectId } = await atBaselining()
    const before = await dataOf(projectId)
    const headingsBefore = (await TemplateProfile.findOne({ projectId }).lean())!.heading_map.map((h) => [h.block_id, h.section_id])
    expect(headingsBefore.some(([, s]) => s.includes(":@")), "fixture có section tạm feature/function").toBe(true)
    const blocksBefore = (await DocBlock.find({ projectId }).sort({ "anchor.ordinal": 1 }).lean()).map((b) => b.section_id ?? null)
    const edited = [{ date: "01/05/2026", version: "0.1", change_type: "A" as const, in_charge: "An", description: "Bản đầu (đã sửa)" }]

    const restore = failingVersionSave(2)
    let failed
    try {
      failed = await c.finalizeAndWait(id, { record_of_changes: edited })
    } finally {
      restore()
    }
    expect(failed.res.status).toBe(200)
    expect(failed.view?.import).toMatchObject({ status: "baselining", paused: { reason: "resume_later" } })
    // trạng thái nhất quán: dữ liệu Spine, heading, block về như trước finalize; không còn bản 0.0 / snapshot dở
    expect(await dataOf(projectId)).toEqual(before)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.heading_map.map((h) => [h.block_id, h.section_id])).toEqual(headingsBefore)
    expect((await DocBlock.find({ projectId }).sort({ "anchor.ordinal": 1 }).lean()).map((b) => b.section_id ?? null)).toEqual(blocksBefore)
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
    expect(await Baseline.countDocuments({ projectId })).toBe(0)

    const resumed = await c.finalizeAndWait(id, {}, "/import/resume")
    expect(resumed.res.status, JSON.stringify(resumed.res.body.error)).toBe(200)
    expect(resumed.res.body.data.import).toMatchObject({ status: "baselining", paused: null })
    expect(resumed.view?.import).toMatchObject({ status: "gap_review", paused: null })
    const spine = (await spineRepository.get(projectId))!
    expect(spine.actors.map((a) => a.name)).toEqual(["Learner", "Admin"])
    expect(spine.baselines.map((b) => b.type)).toEqual(["imported"])
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
    expect((await TemplateProfile.findOne({ projectId }).lean())!.legacy_record_of_changes).toEqual(edited)
  })

  it("job mất ở baselining (đã có mốc, Spine dở) ⇒ GET /import đặt resume_later; resume hoàn phần dở rồi chạy lại", async () => {
    const { c, id, projectId } = await atBaselining()
    // mô phỏng máy chủ chết giữa chừng: đã ghi mốc, lô thực thể đã áp, tiến trình mới không có job
    const doc = (await ImportedDocument.findById(id))!
    doc.finalize_checkpoint = await finalizeCheckpoint(projectId, null)
    await doc.save()
    const spine = (await spineRepository.get(projectId))!
    await (
      await import("../../../src/modules/spine/op-engine.js")
    ).applyTransaction(projectId, { base_version: spine.spine_version, ops: [{ op: "add", path: "actors[]", value: { id: "A09", name: "Ghost", kind: "human", description: "" } }], by: "import", reason: "Import dở", step_id: null })

    const view = getImportResponseSchema.parse((await c.get("/import")).body.data)
    expect(view.import).toMatchObject({ status: "baselining", paused: { reason: "resume_later" } })

    const resumed = await c.finalizeAndWait(id, {}, "/import/resume")
    expect(resumed.view?.import).toMatchObject({ status: "gap_review", paused: null })
    expect((await spineRepository.get(projectId))!.actors.map((a) => a.name)).toEqual(["Learner", "Admin"])
  })

  it("job mất ở checking ⇒ resume_later; resume ở baselining chưa từng finalize ⇒ IMPORT_INVALID_STATE", async () => {
    const { c, id, seeded } = await atBaselining()
    const early = await c.post("/import/resume", { import_id: id })
    expect(early.status).toBe(409)
    expect(early.body.error.code).toBe("IMPORT_INVALID_STATE")

    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })
    expect((await c.finalizeAndWait(id)).view?.import).toMatchObject({ status: "checking", paused: { reason: "credits" } })
    // job 1.11 bị mất giữa chừng (đã bỏ paused, tiến trình không còn job)
    await ImportedDocument.updateOne({ _id: id }, { $set: { paused: null } })
    expect((await c.get("/import")).body.data.import).toMatchObject({ status: "checking", paused: { reason: "resume_later" } })

    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 100 } })
    expect((await c.finalizeAndWait(id, {}, "/import/resume")).view?.import).toMatchObject({ status: "gap_review", paused: null })
  })
})
