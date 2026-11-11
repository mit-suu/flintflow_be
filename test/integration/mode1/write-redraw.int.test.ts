/**
 * C-7 (3.14) — hai nhánh phụ của mode 1 v3 mà test chính không đi qua được (không có PlantUML trong test):
 * - Vẽ lại hình sau khi ghi Spine: có hình đổi ⇒ file version minor được in lại (bản sạch + bản có đánh dấu mới, file cũ
 *   bị dọn).
 * - Dựng bản có đánh dấu lỗi ⇒ CR vẫn ghi, version chỉ có bản sạch (`tracked_file_ref = null`).
 * - FLF-387: CR thêm màn ⇒ wireframe màn mới vẽ bằng model dưới tên user ghi CR, không phải mã CR.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

const flags = vi.hoisted(() => ({ redraw: false, trackedFails: false, newScreens: null as string[] | null }))

vi.mock("../../../src/modules/diagram/diagram.service.js", async (orig) => {
  const real = await orig<typeof import("../../../src/modules/diagram/diagram.service.js")>()
  return {
    ...real,
    renderAllIfAvailable: vi.fn(async () => (flags.redraw ? { spine_version: 0, diagrams: [], rendered: ["D01"], removed: [] } : null)),
    renderChangedIfAvailable: vi.fn(async () => null)
  }
})

// FLF-387: giả lập lô CR có thêm màn (dựng lô op thêm màn thật cần cả luồng propose của model)
vi.mock("../../../src/modules/spine/use-case-propagation.js", async (orig) => {
  const real = await orig<typeof import("../../../src/modules/spine/use-case-propagation.js")>()
  return { ...real, addedScreenIds: vi.fn((...args: Parameters<typeof real.addedScreenIds>) => flags.newScreens ?? real.addedScreenIds(...args)) }
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

import { crToReady, detail, importedProject, resetCrMock } from "../../helpers/mode1-cr-p4.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { docFileStore } from "../../../src/modules/doc-version/doc-file.store.js"
import { renderChangedIfAvailable } from "../../../src/modules/diagram/diagram.service.js"

beforeEach(() => {
  resetCrMock()
  flags.redraw = false
  flags.trackedFails = false
  flags.newScreens = null
  vi.mocked(renderChangedIfAvailable).mockClear()
})

/** FLF-330: BA xác nhận (`submit`) là ghi ngay. */
const approveAll = async (c: Awaited<ReturnType<typeof importedProject>>["c"], cr: string, _groups: { group_id: string }[]) => detail(await c.post(`${cr}/submit`))

const exists = async (ref: string | null | undefined): Promise<boolean> => {
  if (!ref) return false
  try {
    await docFileStore().load(ref)
    return true
  } catch {
    return false
  }
}

describe("C-7 mode 1 v3 - vẽ lại hình, bản có đánh dấu lỗi", () => {
  it("có hình vẽ lại ⇒ in lại file version (bản sạch + bản có đánh dấu mới), file cũ bị dọn", async () => {
    const { c, projectId } = await importedProject()
    const { cr, verified: submitted } = await crToReady(c)
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
    const v = (await DocVersion.findOne({ projectId, version: "0.2" }).lean())!
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
    const { cr, verified: submitted } = await crToReady(c)
    flags.trackedFails = true
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const written = await approveAll(c, cr, submitted.groups)
    expect(written.change_request).toMatchObject({ status: "written", result_doc_version: "0.2" })
    const v = (await DocVersion.findOne({ projectId, version: "0.2" }).lean())!
    expect(v.tracked_file_ref).toBeNull()
    expect(await exists(v.file_ref)).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dựng bản có đánh dấu"), expect.anything())
    warn.mockRestore()
  })

  it("FLF-387: CR thêm màn ⇒ vẽ wireframe màn mới bằng model dưới tên user ghi CR (không phải mã CR)", async () => {
    const { c, projectId, seeded } = await importedProject()
    const { cr, crId, verified: submitted } = await crToReady(c)
    flags.newScreens = ["SCR-NEW"]

    const written = await approveAll(c, cr, submitted.groups)
    expect(written.change_request.status).toBe("written")
    expect(renderChangedIfAvailable).toHaveBeenCalledTimes(1)
    expect(renderChangedIfAvailable).toHaveBeenCalledWith(
      projectId,
      ["SCR-NEW"],
      expect.objectContaining({ by: crId, userId: seeded.userId, deps: { drawLayout: expect.any(Function) } })
    )
  })
})
