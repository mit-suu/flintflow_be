/**
 * Khoá phần tử Spine cho CR (nút 3.5). Mode 1 v2 (FLF-186): khoá theo **path phần tử** (`SpineLock`) thay block docx.
 * Giành rồi trả: chèn từng path (unique `(projectId, path)`); path nào CR khác đang giữ ⇒ trả lại phần vừa giành và
 * báo `409 PATH_LOCKED` kèm CR đang giữ. Khoá giữ nguyên khi CR `paused`; mở khi ghi xong / group bị từ chối / đóng / huỷ.
 */

import mongoose from "mongoose"
import { Mode1Error } from "../import/mode1.errors.js"
import { pathLabel } from "../spine/human-labels.js"
import { SpineLock } from "./spine-lock.model.js"

const isDuplicateKey = (err: unknown): boolean => typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000

export interface PathLock {
  path: string
  cr_id: string
}

export const pathLocked = (locked: PathLock[]): Mode1Error => {
  const first = locked[0]
  return new Mode1Error("PATH_LOCKED", first ? `${pathLabel(first.path)} đang được ${first.cr_id} sửa` : "Phần tử đang được change request khác sửa", { locked })
}

export const lockPaths = async (projectId: string | mongoose.Types.ObjectId, crId: string, paths: string[]): Promise<void> => {
  const wanted = [...new Set(paths)]
  if (!wanted.length) return
  const mine = new Set<string>(await SpineLock.find({ projectId, cr_id: crId, path: { $in: wanted } }).distinct("path"))
  const acquired: string[] = []
  const conflicts: string[] = []
  for (const path of wanted.filter((p) => !mine.has(p))) {
    try {
      await SpineLock.create({ projectId, path, cr_id: crId })
      acquired.push(path)
    } catch (err) {
      if (!isDuplicateKey(err)) throw err
      conflicts.push(path)
    }
  }
  if (!conflicts.length) return
  await SpineLock.deleteMany({ projectId, cr_id: crId, path: { $in: acquired } })
  const holders = await SpineLock.find({ projectId, path: { $in: conflicts } }).select("path cr_id").lean()
  throw pathLocked(holders.map((h) => ({ path: h.path, cr_id: h.cr_id })))
}

/** Mở khoá path của CR; không truyền `paths` ⇒ mở hết. */
export const unlockPaths = async (projectId: string | mongoose.Types.ObjectId, crId: string, paths?: string[]): Promise<void> => {
  const filter: Record<string, unknown> = { projectId, cr_id: crId }
  if (paths) filter.path = { $in: paths }
  await SpineLock.deleteMany(filter)
}

/** path ⇒ CR đang giữ khoá. */
export const locksOf = async (projectId: string | mongoose.Types.ObjectId, paths: string[]): Promise<Map<string, string>> => {
  const rows = await SpineLock.find({ projectId, path: { $in: [...new Set(paths)] } }).select("path cr_id").lean()
  return new Map(rows.map((r) => [r.path, r.cr_id]))
}
