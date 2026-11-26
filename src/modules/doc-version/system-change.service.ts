/**
 * Thay đổi hệ thống thành bản nháp (FLF-466, BF §2 "Thay đổi hệ thống", §3.7, §3.1). Đổi mẫu, hoàn tác đổi mẫu, vẽ lại / dùng ảnh gốc
 * của màn sau baseline không đổi ý nghĩa nội dung nên không phải CR, nhưng vẫn ghi vào bản nháp: một `DocVersion` kind
 * `system_change` mang số phụ kế tiếp, hiện thành dòng riêng trong Gói duyệt, không sinh dòng Record of Changes.
 *
 * `recordSystemChange` idempotent theo `ref`: gọi lại (phục hồi sau sập, bước apply chạy lại) không sinh version thứ hai. Cấp số qua
 * `withVersionSlot`. Chưa có baseline (chưa có DocVersion nào) ⇒ không ghi gì, trả `null`.
 * Bản Track Changes: tác giả = tên người thực hiện (BF C-6); chính sách so sánh do caller chọn (đổi mẫu: chỉ so nội dung, có dịch: không dựng).
 */

import { listChangesForRecord } from "../render/assemble.service.js"
import { Project } from "../project/project.model.js"
import { stripRecord } from "../import/check.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { User } from "../user/user.model.js"
import { docFileStore } from "./doc-file.store.js"
import { DocVersion, type IDocVersion } from "./doc-version.model.js"
import type { SystemChangeInfo } from "./doc-version.constants.js"
import { latestDocVersion } from "./doc-version.service.js"
import type { TrackedPolicy } from "./migration-tracked-policy.js"
import { renderVersionFile } from "./render-version.js"
import { captureTemplateSourceBinding } from "./template-source-binding.js"
import { buildTrackedDocx } from "./tracked-version.js"
import { withVersionSlot } from "./version-allocator.js"

export interface RecordSystemChangeOptions {
  /** So sánh với version trước cho bản Track Changes; mặc định `normal`. */
  tracked?: TrackedPolicy
  /** Thời điểm ghi (test). */
  now?: Date
}

/** Tên người thực hiện cho tác giả Track Changes; không tra được ⇒ nhãn chung. */
export const authorNameOf = async (userId: string): Promise<string> => {
  try {
    const user = (await User.findById(userId, { name: 1, email: 1 }).lean()) as { name?: string; email?: string } | null
    return user?.name?.trim() || user?.email || "FlintFlow"
  } catch {
    return "FlintFlow"
  }
}

export const findSystemChange = (projectId: string, ref: string): Promise<IDocVersion | null> => DocVersion.findOne({ projectId, "system_change.ref": ref })

/** Dự án đã có baseline (version đầu tiên): trước đó đổi mẫu / vẽ lại màn không phải thay đổi hệ thống. */
export const hasBaselineVersion = async (projectId: string): Promise<boolean> => (await latestDocVersion(projectId)) !== null

export const recordSystemChange = async (projectId: string, userId: string, info: SystemChangeInfo, options: RecordSystemChangeOptions = {}): Promise<IDocVersion | null> => {
  const existing = await findSystemChange(projectId, info.ref)
  if (existing) return existing
  if (!(await hasBaselineVersion(projectId))) return null

  return withVersionSlot(projectId, "minor", async ({ latest, next }) => {
    // Có thể một lượt khác vừa ghi chính ref này trong lúc ta chờ khoá
    const raced = await findSystemChange(projectId, info.ref)
    if (raced) return raced
    const record = await spineRepository.get(projectId)
    if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
    const spine = stripRecord(record)
    const projectName = (await Project.findById(projectId, { name: 1 }).lean())?.name ?? "SRS"
    const templateSource = await captureTemplateSourceBinding(projectId)
    const recordSnapshot = templateSource ? await listChangesForRecord(projectId) : null
    const buffer = await renderVersionFile(projectId, projectName, spine, {
      version: next,
      stampSource: "system_change",
      templateSource,
      ...(recordSnapshot ? { recordChanges: recordSnapshot } : {})
    })
    const fileRef = await docFileStore().save(buffer, { projectId, kind: "version", name: next })
    let trackedRef: string | null = null
    try {
      const policy = options.tracked ?? "normal"
      if (policy !== "none") {
        try {
          const out = await buildTrackedDocx(await docFileStore().load(latest.file_ref), buffer, { author: await authorNameOf(userId), date: options.now ?? new Date() }, [], { contentOnly: policy === "content_only" })
          trackedRef = await docFileStore().save(out.data, { projectId, kind: "version", name: `${next}_tracked` })
        } catch (err) {
          console.warn(`[system-change] ${info.ref}: dựng bản có đánh dấu của ${next} lỗi - chỉ còn bản sạch`, err)
        }
      }
      return await DocVersion.create({
        projectId,
        version: next,
        kind: "system_change",
        file_ref: fileRef,
        tracked_file_ref: trackedRef,
        based_on: latest.version,
        cr_ids: [],
        baseline_ref: null,
        system_change: info,
        template_source: templateSource,
        record_snapshot: recordSnapshot,
        spine_snapshot: spine,
        created_by: userId
      })
    } catch (err) {
      await docFileStore().remove(fileRef).catch(() => undefined)
      if (trackedRef) await docFileStore().remove(trackedRef).catch(() => undefined)
      throw err
    }
  })
}
