/**
 * Bug #1 (FLF-447 test) — file `.docx` đã lưu của version mẫu cố định ghi trước bản sửa (binding thiếu `section_segments`,
 * bảng NFR không cột ID / ưu tiên in "must") vẫn sai, và So sánh phiên bản đọc đúng các file đó (`fileBlocksOfVersion`). Script
 * in lại `file_ref` (và `clean_file_ref` khi nó trỏ cùng file) của từng version từ snapshot Spine của chính version + binding đã
 * chốt, bằng cùng đường `renderVersionFile` như lúc ghi version.
 *
 * Cách dùng:
 *   npm run migrate:rerender-version-files -- --project <projectId>                     # dry-run (mặc định): chỉ liệt kê
 *   npm run migrate:rerender-version-files -- --project <projectId> --versions 0.2,1.0  # giới hạn version
 *   npm run migrate:rerender-version-files -- --project <projectId> --apply             # in lại + ghi ref mới
 *
 * - Bỏ qua bản `imported` (0.1 = bản import, đã đúng) trừ khi nêu trong `--versions`; bỏ version không có binding mẫu cố định
 *   hoặc không có snapshot hợp lệ.
 * - Không đụng Spine (chỉ ghi field file của `DocVersion`); file cũ giữ trong kho (không xoá) để quay lại được.
 * - `tracked_file_ref` (bản Track Changes) không dựng lại — nó so với file version trước, dựng riêng.
 */

import mongoose from "mongoose"
import { pathToFileURL } from "node:url"
import { env } from "../config/env.js"
import { DocVersion, type IDocVersion } from "../modules/doc-version/doc-version.model.js"
import { docFileStore } from "../modules/doc-version/doc-file.store.js"
import { renderVersionFile } from "../modules/doc-version/render-version.js"
import { Project } from "../modules/project/project.model.js"
import { loadBaselineSpine } from "../modules/render/assemble.service.js"
import { spineSchema } from "../modules/spine/spine.schema.js"

export interface RerenderArgs {
  projectId: string | null
  versions: string[] | null
  apply: boolean
}

/** Hàm thuần: đọc tham số dòng lệnh. */
export const parseRerenderArgs = (argv: readonly string[]): RerenderArgs => {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null
  }
  const versions = value("--versions")
  return {
    projectId: value("--project"),
    versions: versions ? versions.split(",").map((v) => v.trim()).filter(Boolean) : null,
    apply: argv.includes("--apply")
  }
}

type VersionRow = Pick<IDocVersion, "version" | "kind" | "template_source" | "spine_snapshot" | "baseline_ref">

/** Hàm thuần: version nào in lại, version nào bỏ và vì sao. */
export const planRerender = (
  versions: readonly VersionRow[],
  only: readonly string[] | null
): { rerender: string[]; skipped: { version: string; reason: string }[] } => {
  const rerender: string[] = []
  const skipped: { version: string; reason: string }[] = []
  for (const v of versions) {
    if (only && !only.includes(v.version)) continue
    if (!only && v.kind === "imported") skipped.push({ version: v.version, reason: "bản import (0.1) - nêu trong --versions nếu cần" })
    else if (!v.template_source) skipped.push({ version: v.version, reason: "không có binding mẫu cố định" })
    else if (!v.spine_snapshot && !v.baseline_ref) skipped.push({ version: v.version, reason: "không có snapshot Spine" })
    else rerender.push(v.version)
  }
  return { rerender, skipped }
}

/** Giá trị `flintflow_source` của stamp theo loại version (như lúc ghi). */
export const stampSourceOf = (kind: string): string => (kind === "imported" ? "import" : kind)

const main = async (): Promise<void> => {
  const args = parseRerenderArgs(process.argv.slice(2))
  if (!args.projectId || !mongoose.isValidObjectId(args.projectId)) {
    console.error("Thiếu / sai --project <projectId>")
    process.exit(1)
  }
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${args.apply ? "" : " (dry-run: không ghi, thêm --apply để ghi)"}`)
  try {
    const projectId = args.projectId
    const projectName = (await Project.findById(projectId, { name: 1 }).lean())?.name ?? "SRS"
    const versions = (await DocVersion.find({ projectId }).sort({ createdAt: 1 }).lean()) as unknown as IDocVersion[]
    const plan = planRerender(versions, args.versions)
    for (const s of plan.skipped) console.log(`- bỏ ${s.version}: ${s.reason}`)
    for (const name of plan.rerender) {
      const v = versions.find((x) => x.version === name)!
      const segments = v.template_source?.section_segments
      console.log(`- ${args.apply ? "in lại" : "sẽ in lại"} ${v.version} (${v.kind}); đoạn nguyên văn trong binding: ${segments === undefined ? "chưa có (mượn profile nếu cùng file nguồn)" : segments.length}`)
      if (!args.apply) continue
      const snapshot = v.spine_snapshot ?? (v.baseline_ref ? await loadBaselineSpine(projectId, v.baseline_ref) : null)
      const parsed = spineSchema.safeParse(snapshot)
      if (!parsed.success) {
        console.warn(`  ! ${v.version}: snapshot không hợp lệ - bỏ qua`)
        continue
      }
      const rendered = await renderVersionFile(projectId, projectName, parsed.data, {
        version: v.version,
        stampSource: stampSourceOf(v.kind),
        templateSource: v.template_source,
        recordChanges: v.record_snapshot ?? [],
        versionCreatedAt: v.createdAt
      })
      const ref = await docFileStore().save(rendered, { projectId, kind: "version", name: v.version })
      const sameClean = !!v.clean_file_ref && v.clean_file_ref === v.file_ref
      await DocVersion.updateOne({ _id: v._id }, { $set: { file_ref: ref, ...(sameClean ? { clean_file_ref: ref } : {}), fixed_render_cache: null } })
      console.log(`  ✓ ${v.version}: file_ref ${v.file_ref} ⇒ ${ref}${sameClean ? " (cả clean_file_ref)" : ""}`)
    }
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
