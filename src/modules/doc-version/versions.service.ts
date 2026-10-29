/**
 * Đọc version tài liệu mode 1 qua API (UC-54 xem theo block, UC-55 so sánh, UC-57 tải về). FLF-171, plan §6 2F.
 * Mode 1 v2 (FLF-186): version là bản render từ Spine — block (#13) và so sánh (#15) đọc từ file của version, khớp theo
 * text (file render không mang bookmark neo); không còn Track Changes theo block.
 * Tải bản draft ⇒ file có Track Changes + watermark DRAFT (G8, chỉ bản tải về, không sửa file lưu),
 * tên theo `versionFileName` (FLF-334, `…_v1.0+CR-002_DRAFT.docx`) + stamp có release gốc / CR mới nhất; bản release ⇒ bản sạch (accept-all) trừ khi xin `variant=tracked`.
 */

import { DocxPackage, addDraftWatermark, readStamp, writeStamp, type OoxmlBlock } from "../docx-ooxml/index.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { UserLocale } from "../../shared/i18n/locale.js"
import { CONVERT_STAMP_SOURCE } from "../import/convert-from-fpt.service.js"
import type { DocumentLanguageProject } from "../project/document-language.js"
import { loadBaselineSpine } from "../render/assemble.service.js"
import { assertTranslationComplete, documentLanguageUnavailable, projectLanguages } from "../translation/translation.service.js"
import { renderVersionFile } from "./render-version.js"
import type { DocBlockDto } from "../import/import.dto.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { toIso } from "../import/mode1.http.js"
import { diffBlockLists } from "./block-diff.js"
import { docFileStore } from "./doc-file.store.js"
import type { CompareResponse, DocVersionDto } from "./doc-version.dto.js"
import type { IDocVersion } from "./doc-version.model.js"
import { fileBlocksOfVersion, listDocVersions, requireDocVersion } from "./doc-version.service.js"
import { versionFileName, versionLineage, type VersionLineage } from "./versioning.js"

/** FLF-334 B: version tải được theo ngôn ngữ còn lại — có snapshot baseline và dự án chuyển từ mode 2. */
const otherLanguageAvailable = (v: Pick<IDocVersion, "baseline_ref">, project: DocumentLanguageProject): boolean =>
  !!v.baseline_ref && project.converted_from === "fpt"

/** `project` bắt buộc: thiếu thì `other_language_available` lặng lẽ sai thành `false`. */
export const toVersionDto = (v: IDocVersion, project: DocumentLanguageProject): DocVersionDto => ({
  version: v.version,
  kind: v.kind,
  based_on: v.based_on ?? null,
  cr_ids: [...v.cr_ids],
  baseline_id: v.baseline_ref ?? null,
  has_clean_file: !!v.clean_file_ref,
  has_tracked_file: !!v.tracked_file_ref,
  has_original_file: !!v.original_ref,
  other_language_available: otherLanguageAvailable(v, project),
  created_by: String(v.created_by),
  created_at: toIso(v.createdAt)!
})

export const listVersions = async (projectId: string, project: DocumentLanguageProject): Promise<DocVersionDto[]> =>
  (await listDocVersions(projectId)).map((v) => toVersionDto(v, project))

const blockId = (i: number): string => `B${String(i + 1).padStart(4, "0")}`

/** Block của file version theo thứ tự tài liệu (id theo thứ tự đọc — chỉ để hiển thị, không phải neo). */
export const versionBlocks = async (projectId: string, version: string): Promise<DocBlockDto[]> => {
  const v = await requireDocVersion(projectId, version)
  return (await fileBlocksOfVersion(v)).map((b, i) => ({
    block_id: blockId(i),
    doc_version: v.version,
    kind: b.kind,
    level: b.level ?? null,
    heading_path: [...b.heading_path],
    text: b.text,
    section_id: null,
    mentions: [],
    editable: false,
    locked_by_cr: null
  }))
}

export interface DownloadFile {
  filename: string
  data: Buffer
}

/**
 * Stamp của bản tải về (FLF-334): stamp gốc trong file (project/version/source) + release gốc, CR mới nhất, loại bản.
 * Chỉ ghi lên buffer tải về — file lưu không đổi; file không có stamp (bản cũ hỏng) ⇒ ghi stamp mới từ version.
 */
const stampDownload = async (pkg: DocxPackage, projectId: string, v: IDocVersion, lineage: VersionLineage): Promise<void> => {
  const current = await readStamp(pkg)
  await writeStamp(pkg, {
    project_id: current?.project_id ?? projectId,
    version: current?.version ?? v.version,
    source: current?.source ?? v.kind,
    base_version: lineage.base,
    latest_cr: lineage.latestCr,
    kind: lineage.release ? "release" : "draft"
  })
}

/**
 * FLF-334 B: `lang` = ngôn ngữ của file (không truyền / trùng ngôn ngữ tài liệu ⇒ như trước). Có `lang` thì BẮT BUỘC có
 * `project` (đọc ngôn ngữ tài liệu) — kiểu chặn lúc biên dịch, không để `lang` bị bỏ qua lặng lẽ.
 */
export type DownloadLanguageOptions = { project?: DocumentLanguageProject; lang?: undefined } | { project: DocumentLanguageProject; lang: UserLocale }

export const downloadVersion = async (
  projectId: string,
  projectName: string,
  version: string,
  variant: "auto" | "tracked" | "original",
  options: DownloadLanguageOptions = {}
): Promise<DownloadFile> => {
  const v = await requireDocVersion(projectId, version)
  const languages = options.lang && options.project ? await projectLanguages(projectId, options.project) : null
  const otherLanguage = !!languages && options.lang !== languages.locale
  if (otherLanguage && variant !== "auto") {
    throw new ApiError(400, "Bản có đánh dấu và file gốc chỉ tải được theo ngôn ngữ tài liệu của dự án.", "VALIDATION_ERROR")
  }
  const lineage = versionLineage(await listDocVersions(projectId), v.version)
  const name = (opts: { tracked?: boolean; original?: boolean; language?: string } = {}) =>
    versionFileName({ name: projectName, release: lineage.release, base: lineage.base, latestCr: lineage.latestCr, ...opts })
  if (otherLanguage) {
    // Chỉ version có snapshot baseline của dự án chuyển từ mode 2 — import thật (đường layout) / bản nháp CR chưa hỗ trợ
    if (!options.project || !otherLanguageAvailable(v, options.project)) throw documentLanguageUnavailable()
    const locale = options.lang!
    const spine = await loadBaselineSpine(projectId, v.baseline_ref!)
    if (locale !== languages!.source) await assertTranslationComplete(projectId, locale, spine)
    // Dựng mỗi lần, không ghi GridFS: file lưu của version giữ ngôn ngữ tài liệu
    const rendered = await renderVersionFile(projectId, projectName, spine, {
      version: v.version,
      stampSource: v.kind === "release" ? "release" : CONVERT_STAMP_SOURCE,
      languages: { locale, source: languages!.source }
    })
    const pkg = await DocxPackage.load(rendered)
    await stampDownload(pkg, projectId, v, lineage)
    if (!lineage.release) await addDraftWatermark(pkg)
    return { filename: name({ language: locale }), data: await pkg.toBuffer() }
  }
  if (variant === "original") {
    // Bản gốc người dùng upload (có stamp) — không watermark, không đổi byte (preflight/re-upload đọc lại y như lúc upload)
    if (!v.original_ref) throw new Mode1Error("DOC_VERSION_NOT_FOUND", "Phiên bản này không có file gốc để tải về.")
    return { filename: name({ original: true }), data: await docFileStore().load(v.original_ref) }
  }
  const release = lineage.release
  // BPMN 3.14 (mode 1 v3): bản có đánh dấu của CR là file riêng; version không có (0.0, dựng lỗi) ⇒ bản render như cũ
  const clean = release && variant === "auto" && !!v.clean_file_ref
  const tracked = variant === "tracked" && !!v.tracked_file_ref
  const ref = clean ? v.clean_file_ref! : tracked ? v.tracked_file_ref! : v.file_ref
  const pkg = await DocxPackage.load(await docFileStore().load(ref))
  await stampDownload(pkg, projectId, v, lineage)
  if (!release) await addDraftWatermark(pkg)
  return { filename: name({ tracked }), data: await pkg.toBuffer() }
}

export const compareVersions = async (projectId: string, from: string, to: string): Promise<CompareResponse> => {
  const [va, vb] = await Promise.all([requireDocVersion(projectId, from), requireDocVersion(projectId, to)])
  const [a, b] = await Promise.all([fileBlocksOfVersion(va), fileBlocksOfVersion(vb)])
  const lite = (x: OoxmlBlock[]) => x.map((blk) => ({ block_id: null, para_id: blk.para_id, text: blk.text, text_hash: blk.text_hash }))
  const { blocks, summary } = diffBlockLists(lite(a), lite(b))
  return { from, to, summary, blocks }
}
