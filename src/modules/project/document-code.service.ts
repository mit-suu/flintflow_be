/**
 * Số tài liệu `docCode` (FLF-292) — phần `D<n>` của mã đoạn. Tài liệu upload trước FLF-292 chưa có số: gán bù theo thứ
 * tự upload, nối sau số lớn nhất đang có. Số đã gán không bao giờ đổi, kể cả khi tài liệu khác bị xoá — nguồn đã lưu
 * (`D2-P05`) phải còn trỏ đúng tài liệu.
 */

import type mongoose from "mongoose"
import { ProjectDocument } from "./project-document.model.js"

export const assignDocCodes = async (projectId: string | mongoose.Types.ObjectId): Promise<void> => {
  const docs = await ProjectDocument.find({ projectId }).select("_id docCode createdAt").sort({ createdAt: 1, _id: 1 }).lean()
  let max = docs.reduce((m, d) => Math.max(m, d.docCode ?? 0), 0)
  for (const doc of docs) {
    if (doc.docCode) continue
    max += 1
    // Lọc `docCode: null` để lượt gán chạy song song không ghi đè số đã gán
    await ProjectDocument.updateOne({ _id: doc._id, docCode: null }, { $set: { docCode: max } })
  }
}
