/**
 * FLF-395 — tách mẫu tổ chức cũ thành họ mẫu + bản 1.
 *
 * Cách dùng (BACKUP DB TRƯỚC: `mongodump --uri "$MONGO_URI" --out backup-<ngày>`):
 *   npx tsx src/scripts/migrate-org-template-versions.ts --dry-run   # chỉ đếm, không ghi
 *   npx tsx src/scripts/migrate-org-template-versions.ts
 *
 * Việc làm:
 *  1. `org_templates` còn file + mapping trên họ ⇒ tạo `org_template_versions` bản 1 đã đăng (đọc lại file để có `table_map`,
 *     `language`; mapping giữ nguyên như BA đã xác nhận), đánh dấu họ đã tách (`version_seq`). Field cũ trên họ giữ nguyên để bản
 *     deploy cũ còn đọc được nếu phải rollback (`materializeLegacyVersion`).
 *  2. `importeddocuments` có `org_template_id` mà chưa có `org_template_version` ⇒ `1`.
 *  3. Project có lần import gần nhất từ mẫu tổ chức mà chưa có `template_ref` ⇒ gắn (template_id, bản của lần import đó).
 * Chạy lại an toàn: mỗi bước chỉ khớp bản ghi chưa làm. Mẫu nào đọc file lỗi ⇒ log, giữ nguyên, chạy tiếp mẫu khác.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { ImportedDocument } from "../modules/import/imported-document.model.js"
import { OrgTemplate, OrgTemplateVersion } from "../modules/import/org-library.model.js"
import { materializeLegacyVersion } from "../modules/import/org-template-versions.service.js"
import { Project } from "../modules/project/project.model.js"

export interface ImportRow {
  projectId: string
  org_template_id: string
  org_template_version: number | null
  createdAt: Date
}

/** Lần import mới nhất của mỗi project quyết định mẫu project đang theo (bản trống ⇒ 1). */
export const projectRefsFromImports = (rows: readonly ImportRow[]): Map<string, { template_id: string; version: number }> => {
  const latest = new Map<string, ImportRow>()
  for (const r of rows) {
    const prev = latest.get(r.projectId)
    if (!prev || r.createdAt > prev.createdAt) latest.set(r.projectId, r)
  }
  return new Map([...latest].map(([p, r]) => [p, { template_id: r.org_template_id, version: r.org_template_version ?? 1 }]))
}

const LEGACY_FAMILY = { file_ref: { $exists: true, $ne: null }, headings: { $exists: true }, $or: [{ version_seq: 0 }, { version_seq: { $exists: false } }] }

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run")
  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${dryRun ? " (dry-run: không ghi)" : ""}`)
  try {
    // 1. họ mẫu cũ ⇒ bản 1
    const legacy = await OrgTemplate.find(LEGACY_FAMILY)
    let made = 0
    let failed = 0
    for (const t of legacy) {
      if (dryRun) continue
      try {
        if (await materializeLegacyVersion(t)) made++
      } catch (err) {
        failed++
        console.error(`org_templates ${String(t._id)}: đọc file lỗi, giữ nguyên —`, err instanceof Error ? err.message : err)
      }
    }
    console.log(`org_templates: ${dryRun ? `sẽ tách ${legacy.length}` : `đã tách ${made}, lỗi ${failed}`} họ mẫu cũ`)

    // 2. import cũ ⇒ bản 1 (chỉ khi bản 1 tồn tại)
    const withV1 = (await OrgTemplateVersion.find({ version: 1 }).select("template_id").lean()).map((v) => v.template_id)
    const importFilter = { org_template_id: { $in: withV1 }, $or: [{ org_template_version: null }, { org_template_version: { $exists: false } }] }
    if (dryRun) console.log(`importeddocuments: sẽ gắn bản 1 cho ${await ImportedDocument.countDocuments(importFilter)} lần import`)
    else console.log(`importeddocuments: đã gắn bản 1 cho ${(await ImportedDocument.updateMany(importFilter, { $set: { org_template_version: 1 } })).modifiedCount} lần import`)

    // 3. project ⇒ template_ref theo lần import gần nhất
    const rows = await ImportedDocument.find({ org_template_id: { $ne: null } }).select("projectId org_template_id org_template_version createdAt").lean()
    const refs = projectRefsFromImports(
      rows.map((r) => ({ projectId: String(r.projectId), org_template_id: String(r.org_template_id), org_template_version: r.org_template_version ?? null, createdAt: r.createdAt }))
    )
    const existingVersions = new Set(
      (await OrgTemplateVersion.find({ template_id: { $in: [...new Set([...refs.values()].map((r) => r.template_id))] } }).select("template_id version").lean()).map(
        (v) => `${String(v.template_id)}@${v.version}`
      )
    )
    let bound = 0
    for (const [projectId, ref] of refs) {
      if (!existingVersions.has(`${ref.template_id}@${ref.version}`)) continue
      if (dryRun) {
        bound += await Project.countDocuments({ _id: projectId, template_ref: null })
        continue
      }
      const r = await Project.updateOne({ _id: projectId, template_ref: null }, { $set: { template_ref: { template_id: ref.template_id, version: ref.version } } })
      bound += r.modifiedCount
    }
    console.log(`projects: ${dryRun ? "sẽ gắn" : "đã gắn"} template_ref cho ${bound} dự án`)
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
