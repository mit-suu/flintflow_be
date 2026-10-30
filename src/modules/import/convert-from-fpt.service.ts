/**
 * FLF-318: Lead ký baseline dự án tạo SRS (`fpt`) ⇒ chuyển dự án sang mode 1 (`import`) như thể đã upload SRS và đi hết
 * wizard import: `ImportedDocument` ở thẳng `delivered`, `TemplateProfile` tối thiểu, `DocVersion 1.0` = bản render của
 * đúng snapshot Lead vừa ký. Từ đây mọi sửa nội dung đi qua change request (BR-03) — các guard mode 1 sẵn có tự chặn.
 *
 * - Version gốc **1.0** (bản đã ký, không DRAFT): CR ⇒ 1.1, 1.2…; release ⇒ 2.0 (`versioning.ts`).
 * - Render giữ mẫu FPT + ngôn ngữ tài liệu: profile KHÔNG có `layout` / `heading_map` (có `layout` thì
 *   `loadTemplateLayout` chuyển sang đường render import — mất khung §3.x.y FPT). `language` = ngôn ngữ tài liệu; chữ
 *   trong Spine vẫn `en` (`sourceLanguageOf` nhìn `converted_from`).
 * - Dùng lại baseline vừa ký: chỉ ghi `doc_version` vào bản ghi `Baseline` + `DocVersion.baseline_ref`, không gọi lại
 *   `snapshotBaseline` và không ghi Spine (một lô chạm `baselines[` sẽ thành thêm một dòng trong §I).
 * - Ký baseline và chuyển đổi KHÔNG chung transaction. Lỗi giữa chừng ⇒ dự án vẫn `fpt` đã ký, bản ghi + file đã tạo bị
 *   gỡ; gọi lại (mở dự án, script migrate) chạy lại từ đầu, không tạo trùng. `mode` đổi ở bước CUỐI.
 */

import { createHash } from "node:crypto"
import { scheduleEmbeddingSync } from "../change-request/embedding/embedding-sync.service.js"
import { docFileStore } from "../doc-version/doc-file.store.js"
import { DocVersion } from "../doc-version/doc-version.model.js"
import { renderVersionFile } from "../doc-version/render-version.js"
import { downloadFileName } from "../doc-version/versioning.js"
import { notify } from "../notification/notification.service.js"
import { Project } from "../project/project.model.js"
import { Baseline } from "../spine/baseline.model.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Baseline as BaselineEntry, Spine } from "../spine/spine.types.js"
import { spineSchema } from "../spine/spine.schema.js"
import { projectLanguages } from "../translation/translation.service.js"
import { ImportedDocument } from "./imported-document.model.js"
import { buildStepPlan } from "./step-plan.js"
import { TemplateProfile } from "./template-profile.model.js"

/** Version gốc của dự án chuyển đổi — bản Lead đã ký. */
export const CONVERTED_DOC_VERSION = "1.0"

/** `flintflow_source` của stamp + dấu nhận ra `ImportedDocument` do chuyển đổi tạo (dọn khi chạy lại). */
export const CONVERT_STAMP_SOURCE = "convert"

export interface ConvertOptions {
  /**
   * Script migrate: không gửi thông báo, không chạy nền đồng bộ embedding (script ngắt kết nối ngay sau đó — chạy
   * `npm run migrate:spine-embeddings` sau khi migrate).
   */
  quiet?: boolean
}

export interface ConvertResult {
  doc_version: string
  baseline_id: string
}

/** Baseline `generated` mới nhất (Lead ký) — dự án ký nhiều lần trước khi deploy (migrate) lấy bản cuối. */
const signedBaseline = (spine: Pick<Spine, "baselines">): BaselineEntry | null =>
  [...spine.baselines].reverse().find((b) => b.type === "generated") ?? null

/** Gỡ phần lần chuyển đổi trước bỏ dở (dự án vẫn chưa đổi mode). Profile giữ lại — vô hại với dự án `fpt`, lần sau dùng lại. */
const removeLeftovers = async (projectId: string): Promise<void> => {
  const versions = await DocVersion.find({ projectId, version: CONVERTED_DOC_VERSION, kind: "imported" }).lean()
  for (const ref of versions.map((v) => v.file_ref)) await docFileStore().remove(ref).catch(() => undefined)
  await DocVersion.deleteMany({ projectId, version: CONVERTED_DOC_VERSION, kind: "imported" })
  await ImportedDocument.deleteMany({ projectId, "stamp.source": CONVERT_STAMP_SOURCE })
}

/** Một lượt chuyển đổi mỗi dự án trong tiến trình — ký xong + mở dự án cùng lúc không chạy hai lần. */
const running = new Set<string>()

/**
 * Chuyển dự án `fpt` đã ký baseline sang mode 1. Không phải `fpt`, chưa có baseline Lead ký, đã chuyển rồi hay đang chạy
 * ở lượt khác ⇒ `null`, không làm gì. Lỗi ⇒ gỡ phần đã tạo rồi ném lại (dự án vẫn `fpt` đã ký).
 */
export const convertFromFpt = async (projectId: string, userId: string, opts: ConvertOptions = {}): Promise<ConvertResult | null> => {
  if (running.has(projectId)) return null
  running.add(projectId)
  try {
    return await convert(projectId, userId, opts)
  } finally {
    running.delete(projectId)
  }
}

const convert = async (projectId: string, userId: string, opts: ConvertOptions): Promise<ConvertResult | null> => {
  const project = await Project.findById(projectId)
  if (!project || (project.mode ?? "fpt") !== "fpt") return null
  const record = await spineRepository.get(projectId)
  const entry = record ? signedBaseline(record) : null
  if (!entry) return null
  const snapshot = await Baseline.findById(entry.snapshot_ref).lean()
  if (!snapshot) throw new Error(`[FLF-318] ${projectId}: không tìm thấy snapshot ${entry.snapshot_ref} của baseline ${entry.id}`)
  // Parse, không ép kiểu: snapshot cũ còn dạng `diagrams[].puml` (FLF-339) — schema chuyển sang `format` + `source`
  const parsed = spineSchema.safeParse(snapshot.snapshot)
  if (!parsed.success) throw new Error(`[FLF-318] ${projectId}: snapshot ${entry.snapshot_ref} của baseline ${entry.id} không phải Spine hợp lệ`)
  const spine: Spine = parsed.data

  await removeLeftovers(projectId)
  // Dự án chưa đổi mode ⇒ ngôn ngữ như mode 2: tài liệu theo dự án, chữ gốc `en`
  const languages = await projectLanguages(projectId, project)
  const buffer = await renderVersionFile(projectId, project.name, spine, { version: CONVERTED_DOC_VERSION, stampSource: CONVERT_STAMP_SOURCE, languages })
  const fileRef = await docFileStore().save(buffer, { projectId, kind: "version", name: CONVERTED_DOC_VERSION })

  try {
    const at = new Date()
    await ImportedDocument.create({
      projectId,
      file_ref: null,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      original_name: downloadFileName(project.name, CONVERTED_DOC_VERSION),
      size: buffer.length,
      preflight: { status: "accepted", issues: [] },
      stamp: { project_id: projectId, version: CONVERTED_DOC_VERSION, source: CONVERT_STAMP_SOURCE },
      confirmed_latest_at: at,
      status: "delivered",
      created_by: userId
    })
    if (!(await TemplateProfile.exists({ projectId }))) {
      await TemplateProfile.create({
        projectId,
        source: "imported",
        doc_version: CONVERTED_DOC_VERSION,
        language: languages.locale,
        template_family: "fpt",
        step_plan: buildStepPlan([], new Set(), spine)
      })
    }
    await DocVersion.create({
      projectId,
      version: CONVERTED_DOC_VERSION,
      kind: "imported",
      file_ref: fileRef,
      // Không có file upload — trỏ cùng file render thì Versions hiện hai nút tải cùng một file
      original_ref: null,
      based_on: null,
      baseline_ref: entry.id,
      created_by: userId
    })
    await Baseline.updateOne({ _id: entry.snapshot_ref }, { $set: { doc_version: CONVERTED_DOC_VERSION } })
    // Bước cuối: từ đây guard mode 1 có hiệu lực. Lọc `mode` để không đè dự án vừa bị đổi ở nơi khác.
    const switched = await Project.updateOne(
      { _id: projectId, mode: { $in: ["fpt", null] } },
      { $set: { mode: "import", import_state: "delivered", converted_from: "fpt", converted_at: at, documentLanguage: languages.locale } }
    )
    if (switched.modifiedCount !== 1) throw new Error(`[FLF-318] ${projectId}: dự án không còn ở mode fpt — huỷ chuyển đổi`)
  } catch (err) {
    await removeLeftovers(projectId)
    await docFileStore().remove(fileRef).catch(() => undefined)
    throw err
  }

  // FLF-278: dự án chế độ 3 đi Luồng 2 (`flow2.service`) còn lần import mẫu ở `drafting` ⇒ khép lại cùng bản 1.0.
  // Profile của mẫu (có `layout`) đã có từ lúc import nên bản 1.0 in theo mẫu, không tạo profile FPT tối thiểu.
  await ImportedDocument.updateMany({ projectId, status: "drafting" }, { $set: { status: "delivered" } })

  const result = { doc_version: CONVERTED_DOC_VERSION, baseline_id: entry.id }
  if (opts.quiet) return result
  scheduleEmbeddingSync(projectId)
  void notify(userId, {
    type: "project_converted",
    title: "Baseline đã chốt — dự án chuyển sang chế độ quản lý thay đổi",
    body: `Tài liệu được khoá ở phiên bản ${CONVERTED_DOC_VERSION}. Từ giờ mọi chỉnh sửa đi qua Change Request; cờ không còn bỏ qua (waive) được.`,
    link: `/projects/${projectId}`,
    meta: { projectId, ...result }
  })
  return result
}

/**
 * Ký baseline xong ⇒ chuyển đổi. Lỗi chỉ ghi log: baseline đã ký, chuyển đổi chạy lại khi mở dự án
 * (`retryPendingConversion`) hoặc qua script migrate.
 */
export const convertAfterSignOff = async (projectId: string, userId: string): Promise<ConvertResult | null> => {
  try {
    return await convertFromFpt(projectId, userId)
  } catch (err) {
    console.error(`[FLF-318] ${projectId}: ký baseline xong nhưng chuyển sang mode 1 lỗi — sẽ chạy lại khi mở dự án`, err)
    return null
  }
}

/** Dự án `fpt` đã có baseline Lead ký mà chưa chuyển (lần trước lỗi / ký trước khi deploy) — truy vấn nhẹ, không nạp Spine. */
export const needsConversion = async (project: { _id: unknown; mode?: string | null }): Promise<boolean> =>
  (project.mode ?? "fpt") === "fpt" && !!(await Baseline.exists({ projectId: String(project._id), type: "generated" }))

/** Mở dự án (`GET /projects/:id`): còn dở thì chạy lại. Lỗi chỉ ghi log — dự án vẫn mở được ở mode `fpt`. */
export const retryPendingConversion = async (project: { _id: unknown; mode?: string | null }, userId: string): Promise<boolean> => {
  if (!(await needsConversion(project))) return false
  return !!(await convertAfterSignOff(String(project._id), userId))
}
