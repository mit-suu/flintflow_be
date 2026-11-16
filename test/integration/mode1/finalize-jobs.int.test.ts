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
import { runExtraction } from "../../../src/modules/import/extract.service.js"
import { isFinalizeRunning, waitForFinalize } from "../../../src/modules/import/finalize-jobs.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { DocBlock } from "../../../src/modules/import/doc-block.model.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { docFileStore, setDocFileStore, type DocFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { Baseline } from "../../../src/modules/spine/baseline.model.js"
import { CreditWallet } from "../../../src/modules/credits/credit-wallet.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { env } from "../../../src/config/env.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

/**
 * Upload ⇒ I-4 gọi thẳng service (không qua job nên không có job finalize nối tiếp — FLF-343) ⇒ import ở `baselining`
 * chưa có mốc: như job nối tiếp chưa kịp bật, hoặc bản ghi cũ chờ bấm tạo baseline.
 */
const atBaselining = async () => {
  const seeded = await seedFixture("minimal")
  const projectId = await createMode1Project(seeded)
  const c = mode1Api(seeded, projectId)
  const id = (await c.upload(await makeSrsDocx())).body.data.import.id as string
  const run = await runExtraction(projectId, seeded.userId, id)
  expect(run.doc.status).toBe("baselining")
  return { seeded, projectId, c, id }
}

/** Store file bọc store thật: lần lưu file `version` thứ `nth` (bản render 0.1) ném lỗi — lỗi sau khi Spine đã đổi. */
const failingVersionSave = (nth: number): (() => void) => {
  const real = docFileStore()
  let saves = 0
  const store = new Proxy(real, {
    get(target, prop) {
      if (prop === "save") {
        return async (...args: Parameters<DocFileStore["save"]>) => {
          if (args[1].kind === "version" && ++saves === nth) throw new Error("render bản 0.1 hỏng (test)")
          return target.save(...args)
        }
      }
      const value = Reflect.get(target, prop) as unknown
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
    }
  })
  return setDocFileStore(store)
}

/**
 * FLF-391: lần lưu file `version` thứ `nth` (bản render 0.1) treo tới khi `release()` — mô phỏng finalize đứng giữa chừng
 * mà job vẫn nằm trong queue. `reached` resolve khi lượt lưu đó bắt đầu treo.
 */
const hangingVersionSave = (nth: number) => {
  const real = docFileStore()
  let saves = 0
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let reach!: () => void
  const reached = new Promise<void>((r) => (reach = r))
  const store = new Proxy(real, {
    get(target, prop) {
      if (prop === "save") {
        return async (...args: Parameters<DocFileStore["save"]>) => {
          if (args[1].kind === "version" && ++saves === nth) {
            reach()
            await gate
          }
          return target.save(...args)
        }
      }
      const value = Reflect.get(target, prop) as unknown
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
    }
  })
  return { restore: setDocFileStore(store), reached, release }
}

/** Đặt tạm một giá trị env (đọc lúc chạy) rồi trả hàm hoàn lại. */
const withEnv = (patch: Partial<Pick<typeof env, "FINALIZE_IDLE_TIMEOUT_MS" | "FINALIZE_STALE_MS">>): (() => void) => {
  const old = { FINALIZE_IDLE_TIMEOUT_MS: env.FINALIZE_IDLE_TIMEOUT_MS, FINALIZE_STALE_MS: env.FINALIZE_STALE_MS }
  Object.assign(env, patch)
  return () => Object.assign(env, old)
}

/** Mỗi lần lưu file `version` chậm `ms` — lần chạy chậm nhưng vẫn tiến qua từng bước. */
const slowVersionSave = (ms: number): (() => void) => {
  const real = docFileStore()
  const store = new Proxy(real, {
    get(target, prop) {
      if (prop === "save") {
        return async (...args: Parameters<DocFileStore["save"]>) => {
          if (args[1].kind === "version") await new Promise((r) => setTimeout(r, ms))
          return target.save(...args)
        }
      }
      const value = Reflect.get(target, prop) as unknown
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
    }
  })
  return setDocFileStore(store)
}

/** Lượt chạy bị bỏ lại chạy tiếp tới `guard` kế tiếp rồi dừng — chờ nó chạy hết phần còn lại. */
const settle = () => new Promise((r) => setTimeout(r, 300))

const dataOf = async (projectId: string) => {
  const s = (await spineRepository.get(projectId))!
  return { actors: s.actors, use_cases: s.use_cases, functions: s.functions, steps: s.steps, baselines: s.baselines, diagrams: s.diagrams }
}

describe("finalize chạy nền - trả ngay, kiểm điều kiện ngay", () => {
  it("trả ngay baselining (baseline/flags null); lỗi base_version / trạng thái vẫn 4xx ngay; xong job ⇒ gap_review", async () => {
    const { c, id } = await atBaselining()
    const conflict = await c.post("/import/finalize", { import_id: id, base_version: 999 })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe("SPINE_VERSION_CONFLICT")
    expect(await isFinalizeRunning(id)).toBe(false)
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

describe("finalize chạy nền - lỗi giữa chừng, job mất", () => {
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
    // trạng thái nhất quán: dữ liệu Spine, heading, block về như trước finalize; không còn bản 0.1 / snapshot dở
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

  it("FLF-343: baselining chưa có mốc, không job ⇒ GET đặt resume_later, resume ⇒ finalize một mạch; job mất ở checking ⇒ resume_later", async () => {
    const { c, id, seeded } = await atBaselining()
    expect((await c.get("/import")).body.data.import).toMatchObject({ status: "baselining", paused: { reason: "resume_later" } })

    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 0 } })
    expect((await c.finalizeAndWait(id, {}, "/import/resume")).view?.import).toMatchObject({ status: "checking", paused: { reason: "credits" } })
    // job 1.11 bị mất giữa chừng (đã bỏ paused, tiến trình không còn job)
    await ImportedDocument.updateOne({ _id: id }, { $set: { paused: null } })
    expect((await c.get("/import")).body.data.import).toMatchObject({ status: "checking", paused: { reason: "resume_later" } })

    await CreditWallet.updateOne({ userId: seeded.userId }, { $set: { balance: 100 } })
    expect((await c.finalizeAndWait(id, {}, "/import/resume")).view?.import).toMatchObject({ status: "gap_review", paused: null })
  })
})

describe("FLF-391 finalize treo / kẹt — không bao giờ treo im lặng", () => {
  it("job đứng im quá FINALIZE_IDLE_TIMEOUT_MS ⇒ hoàn về mốc + paused resume_later; lượt treo chạy tiếp không ghi gì; resume ⇒ gap_review", async () => {
    const { c, id, projectId } = await atBaselining()
    const before = await dataOf(projectId)
    const hang = hangingVersionSave(2)
    const restoreEnv = withEnv({ FINALIZE_IDLE_TIMEOUT_MS: 1_500 })
    let timedOut
    try {
      timedOut = await c.finalizeAndWait(id)
      expect(timedOut.view?.import).toMatchObject({ status: "baselining", paused: { reason: "resume_later" } })
      expect(await dataOf(projectId)).toEqual(before)
      expect(await DocVersion.countDocuments({ projectId })).toBe(0)
      // lượt treo được thả: dừng ở bước kế tiếp (đã quá giờ), không tạo baseline / bản 0.1, không đổi trạng thái
      hang.release()
      await settle()
    } finally {
      hang.restore()
      restoreEnv()
    }
    expect((await ImportedDocument.findById(id).lean())).toMatchObject({ status: "baselining", paused: { reason: "resume_later" } })
    expect(await DocVersion.countDocuments({ projectId })).toBe(0)
    expect(await Baseline.countDocuments({ projectId })).toBe(0)

    const resumed = await c.finalizeAndWait(id, {}, "/import/resume")
    expect(resumed.view?.import).toMatchObject({ status: "gap_review", paused: null })
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
    const doc = (await ImportedDocument.findById(id).lean())!
    expect(doc.finalize_run_id).toEqual(expect.any(String))
    expect(doc.finalize_heartbeat_at).toBeInstanceOf(Date)
  })

  it("job còn trong queue mà hết nhịp tim ⇒ GET /import đặt resume_later; resume gỡ khoá, chạy lần mới; lần cũ thả ra không ghi đè", async () => {
    const { c, id, projectId } = await atBaselining()
    const hang = hangingVersionSave(2)
    try {
      const res = await c.post("/import/finalize", { import_id: id, base_version: await c.spineVersion() })
      expect(res.status).toBe(200)
      await hang.reached
      // còn sống: job có trong queue, nhịp tim mới ⇒ không đụng
      expect((await c.get("/import")).body.data.import).toMatchObject({ status: "baselining", paused: null })

      // nhịp tim ngừng (tiến trình đứng): lùi quá FINALIZE_STALE_MS
      await ImportedDocument.updateOne({ _id: id }, { $set: { finalize_heartbeat_at: new Date(Date.now() - env.FINALIZE_STALE_MS - 1_000) } }, { timestamps: false })
      expect(await isFinalizeRunning(id)).toBe(true)
      expect((await c.get("/import")).body.data.import).toMatchObject({ status: "baselining", paused: { reason: "resume_later" } })

      const resumed = await c.finalizeAndWait(id, {}, "/import/resume")
      expect(resumed.res.body.data.import).toMatchObject({ status: "baselining", paused: null })
      expect(resumed.view?.import).toMatchObject({ status: "gap_review", paused: null })

      // lần cũ chạy tiếp: thấy đã bị thay ⇒ dừng, không bản 0.1 / baseline thứ hai, không dừng hộ lần mới
      hang.release()
      await settle()
    } finally {
      hang.restore()
    }
    expect((await ImportedDocument.findById(id).lean())).toMatchObject({ status: "gap_review", paused: null })
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
    expect(await Baseline.countDocuments({ projectId })).toBe(1)
    expect((await spineRepository.get(projectId))!.baselines).toHaveLength(1)
  })

  it("bản ghi cũ kẹt baselining trước khi có nhịp tim (job vẫn giữ key) ⇒ dựa lần cập nhật cuối: quá ngưỡng ⇒ resume_later", async () => {
    const { c, id } = await atBaselining()
    const hang = hangingVersionSave(2)
    try {
      await c.post("/import/finalize", { import_id: id, base_version: await c.spineVersion() })
      await hang.reached
      await ImportedDocument.updateOne({ _id: id }, { $set: { finalize_heartbeat_at: null, updatedAt: new Date(Date.now() - env.FINALIZE_STALE_MS - 1_000) } }, { timestamps: false })
      expect((await c.get("/import")).body.data.import).toMatchObject({ status: "baselining", paused: { reason: "resume_later" } })
    } finally {
      hang.release()
      hang.restore()
      await settle()
    }
  })
})

describe("FLF-391 giới hạn tính theo lúc đứng im, không theo tổng", () => {
  it("lần chạy chậm mà vẫn tiến (tổng > FINALIZE_IDLE_TIMEOUT_MS, mỗi khoảng đứng im < ngưỡng) ⇒ không bị cắt, tới gap_review", async () => {
    const { c, id, projectId } = await atBaselining()
    const restoreStore = slowVersionSave(1_000)
    const restoreEnv = withEnv({ FINALIZE_IDLE_TIMEOUT_MS: 1_500 })
    const started = Date.now()
    let done
    try {
      done = await c.finalizeAndWait(id)
    } finally {
      restoreStore()
      restoreEnv()
    }
    expect(Date.now() - started).toBeGreaterThan(1_500)
    expect(done.view?.import).toMatchObject({ status: "gap_review", paused: null })
    expect(await DocVersion.countDocuments({ projectId })).toBe(1)
  })
})
