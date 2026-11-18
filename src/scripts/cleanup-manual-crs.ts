/**
 * FLF-375: xoá change request còn dữ liệu sửa tay từ trước (vị trí `manual = true`) — business-flow nguyên tắc 6 không
 * cho sửa tay; user chốt 10/11 "dữ liệu CR cũ thì xoá CR đó đi".
 *
 *   npm run cleanup:manual-crs                 # chạy thử: chỉ in việc sẽ làm
 *   npm run cleanup:manual-crs -- --apply      # làm thật
 *   npm run cleanup:manual-crs -- --apply --project <id>   # chỉ một dự án
 *
 * CR chưa ghi ⇒ xoá CR + vị trí + nhóm + dòng khoá cũ.
 * CR đã ghi (`written`) ⇒ hoàn tác thay đổi Spine của CR (`revertChanges`, chỉ khi KHÔNG có thay đổi nào khác ghi sau
 * nó — có thì dừng, báo), xoá bản nháp CR tạo (`docversions.cr_ids` chứa CR, kèm file) và cache render, rồi xoá như trên.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { ChangeGroup } from "../modules/change-request/change-group.model.js"
import { ChangeLocation } from "../modules/change-request/change-location.model.js"
import { ChangeRequest } from "../modules/change-request/change-request.model.js"
import { SpineLock } from "../modules/change-request/spine-lock.model.js"
import { docFileStore } from "../modules/doc-version/doc-file.store.js"
import { DocVersion } from "../modules/doc-version/doc-version.model.js"
import { RenderedDocumentCache } from "../modules/render/rendered-document.model.js"
import { revertChanges } from "../modules/spine/op-engine.js"
import * as spineRepository from "../modules/spine/spine.repository.js"

interface Target {
  projectId: mongoose.Types.ObjectId
  crId: string
  status: string
}

export const findTargets = async (projectId?: string): Promise<Target[]> => {
  const match: Record<string, unknown> = { manual: true }
  if (projectId) match.projectId = new mongoose.Types.ObjectId(projectId)
  const rows = (await ChangeLocation.aggregate([{ $match: match }, { $group: { _id: { projectId: "$projectId", cr_id: "$cr_id" } } }])) as {
    _id: { projectId: mongoose.Types.ObjectId; cr_id: string }
  }[]
  const out: Target[] = []
  for (const r of rows) {
    const cr = await ChangeRequest.findOne({ projectId: r._id.projectId, cr_id: r._id.cr_id }).select("status").lean()
    if (cr) out.push({ projectId: r._id.projectId, crId: r._id.cr_id, status: cr.status })
  }
  return out
}

const removeCrDocs = async (t: Target): Promise<void> => {
  await ChangeLocation.deleteMany({ projectId: t.projectId, cr_id: t.crId })
  await ChangeGroup.deleteMany({ projectId: t.projectId, cr_id: t.crId })
  await SpineLock.deleteMany({ projectId: t.projectId, cr_id: t.crId })
  await ChangeRequest.deleteOne({ projectId: t.projectId, cr_id: t.crId })
}

/** Hoàn tác thay đổi Spine của CR đã ghi + xoá bản nháp nó tạo. Trả mô tả việc đã / sẽ làm. */
const undoWritten = async (t: Target, apply: boolean): Promise<string> => {
  const projectId = String(t.projectId)
  const all = await spineRepository.listChanges(projectId)
  const mine = all.filter((c) => c.by === t.crId)
  const lastMine = Math.max(0, ...mine.map((c) => c.seq))
  const after = all.filter((c) => c.seq > lastMine && c.by !== t.crId)
  if (after.length) throw new Error(`${t.crId}: có ${after.length} thay đổi ghi sau CR (vd ${after[0].by}) — không hoàn tác tự động được`)
  const versions = await DocVersion.find({ projectId: t.projectId, cr_ids: t.crId }).lean()
  const note = `hoàn tác ${mine.length} thay đổi Spine, xoá bản ${versions.map((v) => v.version).join(", ") || "(không có)"}`
  if (!apply) return note
  if (mine.length) {
    const record = (await spineRepository.get(projectId))!
    await revertChanges(projectId, mine, { by: "cleanup:FLF-375", base_version: record.spine_version })
  }
  for (const v of versions) {
    for (const ref of [v.file_ref, v.clean_file_ref, v.tracked_file_ref].filter((r): r is NonNullable<typeof r> => !!r)) {
      await docFileStore()
        .remove(String(ref))
        .catch(() => undefined)
    }
    await DocVersion.deleteOne({ _id: v._id })
  }
  await RenderedDocumentCache.deleteMany({ projectId: t.projectId })
  return note
}

export const cleanupManualCrs = async (options: { apply: boolean; projectId?: string }): Promise<string[]> => {
  const log: string[] = []
  for (const t of await findTargets(options.projectId)) {
    const head = `${t.projectId} ${t.crId} (${t.status})`
    try {
      const undo = t.status === "written" ? `${await undoWritten(t, options.apply)}; ` : ""
      if (options.apply) await removeCrDocs(t)
      log.push(`${options.apply ? "ĐÃ" : "SẼ"} xoá ${head}: ${undo}xoá CR + vị trí + nhóm`)
    } catch (err) {
      log.push(`BỎ QUA ${head}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!log.length) log.push("Không có CR nào còn dữ liệu sửa tay")
  return log
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  const apply = args.includes("--apply")
  const at = args.indexOf("--project")
  const projectId = at >= 0 ? args[at + 1] : undefined
  await mongoose.connect(env.MONGO_URI)
  try {
    for (const line of await cleanupManualCrs({ apply, ...(projectId ? { projectId } : {}) })) console.log(line)
    if (!apply) console.log("Chạy thử — thêm --apply để làm thật")
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
