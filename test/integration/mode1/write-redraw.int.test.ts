/**
 * C-7 (3.14) — hai nhánh phụ của mode 1 v3 mà test chính không đi qua được (không có PlantUML trong test):
 * - Vẽ lại hình sau khi ghi Spine: có hình đổi ⇒ file version minor được in lại (bản sạch + bản có đánh dấu mới, file cũ
 *   bị dọn).
 * - Dựng bản có đánh dấu lỗi ⇒ CR vẫn ghi, version chỉ có bản sạch (`tracked_file_ref = null`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

const flags = vi.hoisted(() => ({ redraw: false, trackedFails: false }))

vi.mock("../../../src/modules/diagram/diagram.service.js", async (orig) => {
  const real = await orig<typeof import("../../../src/modules/diagram/diagram.service.js")>()
  return {
    ...real,
    renderAllIfAvailable: vi.fn(async () => (flags.redraw ? { spine_version: 0, diagrams: [], rendered: ["D01"], removed: [] } : null))
  }
})

vi.mock("../../../src/modules/doc-version/tracked-version.js", async (orig) => {
  const real = await orig<typeof import("../../../src/modules/doc-version/tracked-version.js")>()
  return {
    ...real,
    buildTrackedDocx: vi.fn(async (...args: Parameters<typeof real.buildTrackedDocx>) => {
      if (flags.trackedFails) throw new Error("OOXML hỏng")
      return real.buildTrackedDocx(...args)
    })
  }
})

import { crToReview, detail, importedProject, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"

beforeEach(() => {
  resetCrMock()
  flags.redraw = false
  flags.trackedFails = false
})

const approveAll = async (c: Awaited<ReturnType<typeof importedProject>>["c"], cr: string, groups: { group_id: string }[]) => {
  let last = null as ReturnType<typeof detail> | null
  for (const g of groups) last = detail(await c.post(`${cr}/groups/${g.group_id}/decision`, { decision: "approved", reason: "Đúng yêu cầu của khách", base_version: await c.spineVersion() }))
  return last!
}

const exists = async (ref: string | null | undefined): Promise<boolean> => {
  if (!ref) return false
  try {
    await docFileStore().load(ref)
    return true
  } catch {
    return false
  }
}

describe("C-7 mode 1 v3 — vẽ lại hình, bản có đánh dấu lỗi", () => {
  it("có hình vẽ lại ⇒ in lại file version (bản sạch + bản có đánh dấu mới), file cũ bị dọn", async () => {
    const { c, projectId } = await importedProject()
    const { cr, submitted } = await crToReview(c)
    const store = docFileStore()
    const saved: string[] = []
    const origSave = store.save.bind(store)
    vi.spyOn(store, "save").mockImplementation(async (...args: Parameters<typeof store.save>) => {
      const ref = await origSave(...args)
      saved.push(ref)
      return ref
    })
    flags.redraw = true

    const written = await approveAll(c, cr, submitted.groups)
    expect(written.change_request.status).toBe("written")
    const v = (await DocVersion.findOne({ projectId, version: "0.1" }).lean())!
    // lượt đầu: bản sạch + bản có đánh dấu; vẽ lại: in lại cả hai
    expect(saved).toHaveLength(4)
    expect(v.file_ref).toBe(saved[2])
    expect(v.tracked_file_ref).toBe(saved[3])
    expect(await exists(saved[0])).toBe(false)
    expect(await exists(saved[1])).toBe(false)
    expect(await exists(v.file_ref)).toBe(true)
    expect(await exists(v.tracked_file_ref)).toBe(true)
  })

  it("dựng bản có đánh dấu lỗi ⇒ CR vẫn ghi, version chỉ có bản sạch", async () => {
    const { c, projectId } = await importedProject()
    const { cr, submitted } = await crToReview(c)
    flags.trackedFails = true
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const written = await approveAll(c, cr, submitted.groups)
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.1" })
    const v = (await DocVersion.findOne({ projectId, version: "0.1" }).lean())!
    expect(v.tracked_file_ref).toBeNull()
    expect(await exists(v.file_ref)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dựng bản có đánh dấu"), expect.anything())
    warn.mockRestore()
  })
})
