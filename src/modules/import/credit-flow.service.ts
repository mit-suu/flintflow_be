/**
 * Flow 4 (credit) cho mode 1 (BPMN 4.2, BR-01, BR-08):
 * - **4.2 báo nạp**: một bước AI (I-4, I-1.11, C-2, C-4, C-5) dừng vì hết credit ⇒ thông báo cho mọi Lead của tổ chức
 *   (nếu dự án cũ chưa gắn tổ chức ⇒ người tạo dự án).
 * - **Không tự chạy tiếp khi nạp xong**: khi ví được nạp (thanh toán / admin cộng), `topup-request.service.ts` thông báo
 *   để thành viên thực hiện tự mở lại dự án và bấm tiếp tục.
 */

import { notify } from "../notification/notification.service.js"
import { Project } from "../project/project.model.js"
import { quotedSectionLabel } from "../spine/human-labels.js"
import { Membership } from "../organization/membership.model.js"
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

/**
 * 4.2: báo nạp credit — bước `stepId` đang dừng. Side effect: lỗi chỉ ghi log.
 *
 * task-26: ví là của TỔ CHỨC và chỉ Lead được nạp (BPMN 4.2 "Notify Lead to top up", lane "Lead (billing)") ⇒ dự án
 * thuộc tổ chức thì báo mọi Lead của tổ chức đó, không báo người tạo dự án (có thể là Analyst, không nạp được).
 * Dự án chưa gắn tổ chức (dữ liệu trước migration) ⇒ vẫn báo người tạo như trước.
 */
export const notifyTopUpNeeded = async (projectId: string, stepId: string): Promise<void> => {
  try {
    const project = (await Project.findById(projectId, { userId: 1, name: 1, organizationId: 1 }).lean()) as {
      userId?: unknown
      name?: string
      organizationId?: unknown
    } | null
    if (!project) return
    const organizationId = project.organizationId ? String(project.organizationId) : null
    const recipients = organizationId
      ? (await Membership.find({ organizationId, role: "lead" }).select("userId").lean()).map((m) => String(m.userId))
      : project.userId
        ? [String(project.userId)]
        : []
    const lookupHeading = await headingLookup(projectId)
    const sectionHeading = stepId.startsWith("I-4:") ? lookupHeading(stepId.slice("I-4:".length)) : null
    const step = describeStep(stepId, lookupHeading)
    for (const recipient of recipients) {
      await notify(recipient, {
        type: TOPUP_NEEDED,
        title: "Hết credit - bước AI đang dừng",
        body: `Dự án "${project.name ?? projectId}" dừng ở ${step} vì không đủ credit. Nạp thêm để chạy tiếp - sau khi nạp thêm credit, thành viên thực hiện mở lại dự án và bấm tiếp tục.`,
        link: "/home/billing",
        ...(organizationId ? { organizationId } : {}),
        meta: {
          project_id: projectId,
          project_name: project.name ?? projectId,
          step_id: stepId,
          ...(sectionHeading ? { section_heading: sectionHeading } : {})
        }
      })
    }
  } catch (err) {
    console.warn(`[credit-flow] không gửi được thông báo nạp credit (project ${projectId}):`, err)
  }
}
