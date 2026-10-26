/**
 * auto-pass.service.ts — FLF-337 "Chưa xem" (xem `auto-pass.model.ts`).
 *
 * `recordAutoPass` gọi ở mọi chỗ AI tự qua: bước im trong `phases/:phase/run` và lượt lẻ (`phase-runner`), CR tự ghi ở mức
 * "Chỉ ở mốc chốt" (`verify.service`). Ghi lỗi chỉ log — không được làm gãy lượt chạy vì một dòng sổ.
 */

import mongoose from "mongoose"
import { AutoPass } from "./auto-pass.model.js"
import { getStep, isRegisteredStep } from "./step-registry.js"

export interface AutoPassedItem {
  id: string
  step_id: string
  label_vi: string
  reason_vi: string
  at: string
  seen: boolean
}

export interface AutoPassedList {
  total: number
  unseen: number
  items: AutoPassedItem[]
}

const asObjectId = (projectId: string): mongoose.Types.ObjectId => new mongoose.Types.ObjectId(projectId)

/** Nhãn mặc định: tên bước trong registry; id lạ (CR) thì nơi gọi truyền `label_vi`. */
const labelOf = (stepId: string, label?: string): string => label ?? (isRegisteredStep(stepId) ? getStep(stepId).label_vi : stepId)

export const recordAutoPass = async (projectId: string, stepId: string, reasonVi: string, label?: string): Promise<void> => {
  if (!mongoose.isValidObjectId(projectId) || mongoose.connection.readyState !== 1) return
  try {
    await AutoPass.create({ projectId: asObjectId(projectId), step_id: stepId, label_vi: labelOf(stepId, label), reason_vi: reasonVi, at: new Date(), seen_by: [] })
  } catch (err) {
    console.warn("[auto-pass] không ghi được sổ thay đổi tự qua:", err)
  }
}

/** Mới nhất trước; `seen` theo người gọi. Giới hạn 200 dòng gần nhất — đủ cho một dự án, không phình response. */
export const listAutoPassed = async (projectId: string, userId: string): Promise<AutoPassedList> => {
  const docs = await AutoPass.find({ projectId: asObjectId(projectId) }).sort({ at: -1 }).limit(200).lean()
  const items = docs.map((d) => ({
    id: String(d._id),
    step_id: d.step_id,
    label_vi: d.label_vi,
    reason_vi: d.reason_vi,
    at: new Date(d.at).toISOString(),
    seen: (d.seen_by ?? []).includes(userId)
  }))
  return { total: items.length, unseen: items.filter((i) => !i.seen).length, items }
}

/** `ids` rỗng / thiếu ⇒ tất cả của dự án. Trả số còn chưa xem. */
export const markAutoPassedSeen = async (projectId: string, userId: string, ids: readonly string[] = []): Promise<number> => {
  const filter: Record<string, unknown> = { projectId: asObjectId(projectId) }
  if (ids.length) filter._id = { $in: ids.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id)) }
  await AutoPass.updateMany(filter, { $addToSet: { seen_by: userId } })
  return AutoPass.countDocuments({ projectId: asObjectId(projectId), seen_by: { $ne: userId } })
}
