/**
 * Khoá phần tử Spine cho change request (nút 3.5 — mode 1 v2, FLF-186): một phần tử (`actors[id=A01]`, `project`,
 * `custom_sections[id=CS02]`…) chỉ một CR giữ. Unique `(projectId, path)` là chốt nguyên tử — hai CR giành cùng
 * path thì một bên nhận lỗi trùng khoá. Thay `DocBlock.locked_by_cr` của bản theo block (P2).
 */

import mongoose, { Schema, Document } from "mongoose"

export interface ISpineLock extends Document {
  projectId: mongoose.Types.ObjectId
  path: string
  cr_id: string
  createdAt: Date
}

const spineLockSchema = new Schema<ISpineLock>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    path: { type: String, required: true },
    cr_id: { type: String, required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

spineLockSchema.index({ projectId: 1, path: 1 }, { unique: true })
spineLockSchema.index({ projectId: 1, cr_id: 1 })

export const SpineLock = mongoose.model<ISpineLock>("SpineLock", spineLockSchema)
