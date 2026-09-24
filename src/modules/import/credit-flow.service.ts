/**
 * Flow 4 (credit) cho mode 1 v3 (BPMN 4.2 + 4.5 ⇒ 4.1):
 * - **4.2 báo nạp**: một bước AI (I-4, 1.11, C-2, C-4, C-5, 3.9) dừng vì hết credit ⇒ thông báo cho chủ project — người
 *   đang giữ vai Lead theo G1 (BE chưa có tổ chức / vai trò — plan `mode1-v3/phase-4` 4.4).
 * - **4.5 ⇒ 4.1 chạy tiếp**: thanh toán thành công ⇒ mọi bước mode 1 của người đó đang dừng vì hết credit được chạy tiếp
 *   (giữ credit lại từ đầu). Chạy nền, lần lượt, lỗi chỉ ghi log — bước nào vẫn thiếu credit thì lại dừng + báo như cũ.
 * Bước dừng vì lỗi AI (`resume_later`) không tự chạy lại: đó là lựa chọn "để sau" của người dùng (Flow 5).
 */

import { notify } from "../notification/notification.service.js"
import { Project } from "../project/project.model.js"
import { ChangeRequest } from "../change-request/change-request.model.js"
import { quotedSectionLabel } from "../spine/human-labels.js"
import { ImportedDocument } from "./imported-document.model.js"
import { TemplateProfile } from "./template-profile.model.js"

export const TOPUP_NEEDED = "credit_topup_needed"

/**
 * Tên bước cho câu thông báo — không in mã step (`I-4:fixed:5.5`, `C-4:CR-001`). `headingOf` tra tiêu đề mục trong file
 * người dùng (khoá section của I-4); không có ⇒ nhãn mục chung. Mã lạ ⇒ "một bước AI".
 */
export const describeStep = (stepId: string, headingOf: (sectionId: string) => string | null = () => null): string => {
  const at = stepId.indexOf(":")
  const code = at >= 0 ? stepId.slice(0, at) : stepId
  const key = at >= 0 ? stepId.slice(at + 1) : ""
  if (code === "I-4" && key) {
    const heading = headingOf(key)
    return `bước trích dữ liệu mục ${heading ? `"${heading}"` : quotedSectionLabel(key)}`
  }
  if (code === "I-1.11") return "bước AI kiểm tra nội dung tài liệu vừa nhập"
  if (code === "C-2") return `bước AI làm rõ yêu cầu của ${key}`
  if (code === "C-4") return `bước AI đề xuất sửa của ${key}`
  if (code === "C-5") return `bước AI kiểm tra đề xuất của ${key}`
  return "một bước AI"
}

const headingLookup = async (projectId: string): Promise<(sectionId: string) => string | null> => {
  try {
    const profile = (await TemplateProfile.findOne({ projectId }, { heading_map: 1 }).lean()) as { heading_map?: { section_id: string | null; heading_text: string }[] } | null
    const map = new Map((profile?.heading_map ?? []).filter((h) => h.section_id && h.heading_text.trim()).map((h) => [h.section_id as string, h.heading_text.trim()]))
    return (id) => map.get(id) ?? null
  } catch {
    return () => null
  }
}

/** 4.2: báo chủ project nạp credit — bước `stepId` đang dừng. Side effect: lỗi chỉ ghi log. */
export const notifyTopUpNeeded = async (projectId: string, stepId: string): Promise<void> => {
  try {
    const project = (await Project.findById(projectId, { userId: 1, name: 1 }).lean()) as { userId?: unknown; name?: string } | null
    if (!project?.userId) return
    await notify(String(project.userId), {
      type: TOPUP_NEEDED,
      title: "Hết credit — bước AI đang dừng",
      body: `Dự án "${project.name ?? projectId}" dừng ở ${describeStep(stepId, await headingLookup(projectId))} vì không đủ credit. Nạp thêm để chạy tiếp — sau khi thanh toán thành công, bước sẽ tự chạy lại.`,
      link: "/home/billing",
      meta: { project_id: projectId, step_id: stepId }
    })
  } catch (err) {
    console.warn(`[credit-flow] không gửi được thông báo nạp credit (project ${projectId}):`, err)
  }
}

export interface ResumeDeps {
  resumeExtraction: (projectId: string, userId: string, importId: string) => Promise<unknown>
  resumeCheck: (importId: string, userId: string) => Promise<unknown>
  resumeCr: (projectId: string, crId: string, userId: string) => Promise<unknown>
}

const defaultDeps = async (): Promise<ResumeDeps> => {
  // Nạp muộn: tránh vòng import billing ⇄ import ⇄ change-request lúc khởi động
  const [{ startExtraction }, { resumeCheck }, clarify, propose, verify] = await Promise.all([
    import("./extract-jobs.js"),
    import("./finalize.service.js"),
    import("../change-request/clarify.service.js"),
    import("../change-request/propose.service.js"),
    import("../change-request/verify.service.js")
  ])
  return {
    resumeExtraction: startExtraction,
    resumeCheck: async (importId, userId) => {
      const doc = await ImportedDocument.findById(importId)
      if (doc) await resumeCheck(doc, userId)
    },
    resumeCr: async (projectId, crId, userId) => {
      const cr = await ChangeRequest.findOne({ projectId, cr_id: crId })
      if (!cr) return
      if (cr.status === "clarifying") return clarify.runClarify(cr, userId)
      if (cr.status === "proposing") return propose.runPropose(cr, userId)
      if (cr.status === "verifying") return verify.runVerify(cr, userId)
    }
  }
}

/**
 * 4.5 ⇒ 4.1: chạy tiếp mọi bước mode 1 dừng vì hết credit trong các project của `userId`. Trả số bước đã thử chạy lại.
 */
export const resumeAfterTopUp = async (userId: string, deps?: ResumeDeps): Promise<number> => {
  const d = deps ?? (await defaultDeps())
  const projects = (await Project.find({ userId, mode: "import" }, { _id: 1 }).lean()).map((p) => p._id)
  if (!projects.length) return 0
  let resumed = 0
  const run = async (label: string, fn: () => Promise<unknown>) => {
    resumed++
    try {
      await fn()
    } catch (err) {
      console.warn(`[credit-flow] chạy tiếp ${label} sau khi nạp credit lỗi:`, err)
    }
  }
  const imports = await ImportedDocument.find({ projectId: { $in: projects }, "paused.reason": "credits", status: { $in: ["extracting", "checking"] } })
  for (const doc of imports) {
    const id = String(doc._id)
    if (doc.status === "extracting") await run(`I-4 ${id}`, () => d.resumeExtraction(String(doc.projectId), userId, id))
    else await run(`1.11–1.12 ${id}`, () => d.resumeCheck(id, userId))
  }
  const crs = await ChangeRequest.find({ projectId: { $in: projects }, "paused.reason": "credits", status: { $in: ["clarifying", "proposing", "verifying"] } })
  for (const cr of crs) await run(cr.cr_id, () => d.resumeCr(String(cr.projectId), cr.cr_id, userId))
  return resumed
}
