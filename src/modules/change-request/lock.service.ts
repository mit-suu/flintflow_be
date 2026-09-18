/**
 * Khoá block cho CR (nút 3.5). FLF-171, plan §6 2E.
 * Khoá = `DocBlock.locked_by_cr` trên version tài liệu mới nhất. Khoá nguyên tử theo kiểu "giành rồi trả":
 * `updateMany({locked_by_cr: null})` rồi đếm; thiếu block nào (CR khác đang giữ) ⇒ trả lại phần vừa giành và
 * báo `409 BLOCK_LOCKED` kèm CR đang giữ. Hai CR giành chồng nhau cùng lúc ⇒ cả hai trả lại, không kẹt khoá.
 * Khoá giữ nguyên khi CR `paused`; mở khi ghi xong / group bị từ chối / đóng / huỷ.
 */

import mongoose from "mongoose"
import { DocBlock } from "../import/doc-block.model.js"
import { Mode1Error } from "../import/mode1.errors.js"

export const lockBlocks = async (projectId: string | mongoose.Types.ObjectId, docVersion: string, crId: string, blockIds: string[]): Promise<void> => {
  const ids = [...new Set(blockIds)]
  if (!ids.length) return
  const already = await DocBlock.find({ projectId, doc_version: docVersion, block_id: { $in: ids }, locked_by_cr: crId }).distinct("block_id")
  const wanted = ids.filter((id) => !already.includes(id))
  if (!wanted.length) return
  const res = await DocBlock.updateMany({ projectId, doc_version: docVersion, block_id: { $in: wanted }, locked_by_cr: null }, { $set: { locked_by_cr: crId } })
  if (res.modifiedCount === wanted.length) return

  const mine = await DocBlock.find({ projectId, doc_version: docVersion, block_id: { $in: wanted }, locked_by_cr: crId }).distinct("block_id")
  const conflicts = await DocBlock.find({ projectId, doc_version: docVersion, block_id: { $in: wanted }, locked_by_cr: { $nin: [null, crId] } })
    .select("block_id locked_by_cr")
    .lean()
  await DocBlock.updateMany({ projectId, doc_version: docVersion, block_id: { $in: mine }, locked_by_cr: crId }, { $set: { locked_by_cr: null } })
  const locked = conflicts.map((b) => ({ block_id: b.block_id, cr_id: b.locked_by_cr! }))
  const first = locked[0]
  throw new Mode1Error(
    "BLOCK_LOCKED",
    first ? `Block ${first.block_id} đang được ${first.cr_id} sửa` : "Block đang được change request khác sửa",
    { locked }
  )
}

/** Mở khoá block của CR (mọi version); `blockIds` rỗng/không truyền ⇒ mở hết. */
export const unlockBlocks = async (projectId: string | mongoose.Types.ObjectId, crId: string, blockIds?: string[]): Promise<void> => {
  const filter: Record<string, unknown> = { projectId, locked_by_cr: crId }
  if (blockIds) filter.block_id = { $in: blockIds }
  await DocBlock.updateMany(filter, { $set: { locked_by_cr: null } })
}
