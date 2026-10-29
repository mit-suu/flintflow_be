/**
 * translation.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Tra lớp bản dịch + trạng thái (FLF-265 §2.3). KHÔNG gọi model — `GET /translations/status` (và phase 3 render)
 * Viewer gọi được, không được tiêu credit.
 * - `resolveTranslations`: đơn vị ⇒ chữ dịch theo hash chữ gốc, MỘT truy vấn `$in`. Không có / lệch hình dạng ⇒ thiếu.
 * - `translationStatus`: đếm + ước tính số lô / credit cho phần thiếu (BR-01: ước tính trước khi dịch).
 */

import type { UserLocale } from "../../shared/i18n/locale.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { getActionCost } from "../../shared/ai/credit-reservation.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import { documentLanguageOf, sourceLanguageOf, type DocumentLanguageProject } from "../project/document-language.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { Spine } from "../spine/spine.types.js"
import * as repository from "./translation.repository.js"
import { fitTranslation, hashSource, translationUnits, type TranslationUnit, type UnitValue } from "./translation-units.js"

// ─── ngôn ngữ ────────────────────────────────────────────────────

export interface ProjectLanguages {
  /** Ngôn ngữ tài liệu (xem trước + .docx). */
  locale: UserLocale
  /** Ngôn ngữ chữ trong Spine. */
  source: UserLocale
}

/**
 * Ngôn ngữ tài liệu và ngôn ngữ gốc của dự án. Mode 1 đọc `TemplateProfile.language` (cả hai cùng ngôn ngữ file ⇒
 * không có gì để dịch — mode 1 ngoài phạm vi bản đầu, D3); mode 2 không truy vấn thêm.
 */
export const projectLanguages = async (projectId: string, project: DocumentLanguageProject): Promise<ProjectLanguages> => {
  const profileLanguage =
    project.mode === "import" ? ((await TemplateProfile.findOne({ projectId }, { language: 1 }).lean()) as { language?: string } | null)?.language : undefined
  return { locale: documentLanguageOf(project, profileLanguage), source: sourceLanguageOf(project, profileLanguage) }
}

/** Dự án mode 1 import thật (đường layout, không có lớp bản dịch) — khác dự án chuyển từ mode 2 (FLF-318). */
const isRealImport = (project: DocumentLanguageProject): boolean => project.mode === "import" && project.converted_from !== "fpt"

/**
 * FLF-334 B — ngôn ngữ đích của một lượt dịch / ước tính: `requested` (query / body) hoặc ngôn ngữ tài liệu. Dự án mode 1
 * import thật (đường layout) không dịch ⇒ hỏi ngôn ngữ khác ngôn ngữ tài liệu là 409 `DOCUMENT_LANGUAGE_UNAVAILABLE`,
 * không lặng lẽ trả lời theo ngôn ngữ tài liệu.
 */
export const targetLocale = (project: DocumentLanguageProject, languages: ProjectLanguages, requested?: UserLocale): UserLocale => {
  if (!requested || requested === languages.locale) return languages.locale
  if (isRealImport(project)) throw documentLanguageUnavailable()
  return requested
}

/**
 * FLF-334 B — Spine mà #26 / #27 đếm và dịch: mặc định Spine hiện tại; có đích snapshot (`baseline_id` / `version`) ⇒
 * snapshot đó (`translation-target.ts`), để "Dịch nốt" xoá đúng phần mà lượt tải kiểm. `null` ⇒ chưa có gì để dịch.
 */
export type SpineLoader = () => Promise<Spine | null>

const currentSpine: (projectId: string) => SpineLoader = (projectId) => () => spineRepository.get(projectId)

export interface TranslationScope {
  /** Ngôn ngữ đích; không truyền ⇒ ngôn ngữ tài liệu. */
  locale?: UserLocale
  /** Spine cần đếm / dịch; không truyền ⇒ Spine hiện tại. Chỉ gọi khi ngôn ngữ đích ≠ ngôn ngữ gốc. */
  loadSpine?: SpineLoader
}

/** Ngôn ngữ đích + gốc của một lượt #26 / #27 (ném 409 cho dự án import thật hỏi ngôn ngữ khác). */
export const resolveScopeLanguages = async (
  projectId: string,
  project: DocumentLanguageProject,
  scope: TranslationScope
): Promise<{ locale: UserLocale; source: UserLocale; loadSpine: SpineLoader }> => {
  const languages = await projectLanguages(projectId, project)
  return { locale: targetLocale(project, languages, scope.locale), source: languages.source, loadSpine: scope.loadSpine ?? currentSpine(projectId) }
}

// ─── tra cứu ─────────────────────────────────────────────────────

export interface ResolvedTranslations {
  /** key đơn vị ⇒ chữ dịch (chỉ đơn vị đã dịch). */
  map: Map<string, UnitValue>
  total: number
  translated: number
  missing: number
  /** Đơn vị chưa có bản dịch cho hash hiện tại — đầu vào của dịch theo lô. */
  missingUnits: TranslationUnit[]
}

/** Bản lưu dùng được cho đơn vị: cùng luật với lúc ghi (`fitTranslation`) — hash trùng mà lệch hình dạng chỉ có ở dữ liệu hỏng. */
const fits = (value: UnitValue, text: UnitValue): boolean => fitTranslation(value, text) !== null

export const resolveTranslations = async (projectId: string, locale: UserLocale, units: TranslationUnit[]): Promise<ResolvedTranslations> => {
  const hashes = units.map((unit) => hashSource(unit.value))
  const stored = await repository.findByHashes(projectId, locale, hashes)
  const map = new Map<string, UnitValue>()
  const missingUnits: TranslationUnit[] = []
  units.forEach((unit, index) => {
    const hit = stored.get(hashes[index])
    if (hit && fits(unit.value, hit.text)) map.set(unit.key, hit.text)
    else missingUnits.push(unit)
  })
  return { map, total: units.length, translated: map.size, missing: missingUnits.length, missingUnits }
}

// ─── chia lô ─────────────────────────────────────────────────────

/** Lô ~40 đơn vị hoặc ~6k ký tự (Q3: 2 credit / lô). */
export const BATCH_MAX_UNITS = 40
export const BATCH_MAX_CHARS = 6000

export interface BatchItem {
  /** Key của đơn vị đầu tiên mang hash này — model trả lại đúng key. */
  key: string
  sourceHash: string
  text: UnitValue
}

/** Đơn vị thiếu gộp theo hash: chữ giống nhau chỉ dịch một lần. */
export const uniqueBatchItems = (units: TranslationUnit[]): BatchItem[] => {
  const seen = new Map<string, BatchItem>()
  for (const unit of units) {
    const sourceHash = hashSource(unit.value)
    if (!seen.has(sourceHash)) seen.set(sourceHash, { key: unit.key, sourceHash, text: unit.value })
  }
  return [...seen.values()]
}

const sizeOf = (item: BatchItem): number => JSON.stringify(item.text).length

/** Chia theo thứ tự; đơn vị một mình đã quá `maxChars` vẫn thành một lô riêng. */
export const splitBatches = (items: BatchItem[], maxUnits = BATCH_MAX_UNITS, maxChars = BATCH_MAX_CHARS): BatchItem[][] => {
  const batches: BatchItem[][] = []
  let current: BatchItem[] = []
  let chars = 0
  for (const item of items) {
    const size = sizeOf(item)
    if (current.length > 0 && (current.length >= maxUnits || chars + size > maxChars)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(item)
    chars += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

// ─── trạng thái ──────────────────────────────────────────────────

export interface TranslationStatus {
  locale: UserLocale
  source_locale: UserLocale
  total: number
  missing: number
  batches: number
  estimated_credits: number
}

/**
 * `GET /projects/:id/translations/status?locale=&baseline_id=|version=` — ngôn ngữ đích = ngôn ngữ gốc ⇒ `total: 0`. Không
 * gọi model. `scope` (FLF-334 B) không truyền ⇒ ngôn ngữ tài liệu trên Spine hiện tại (như trước).
 */
export const translationStatus = async (projectId: string, project: DocumentLanguageProject, scope: TranslationScope = {}): Promise<TranslationStatus> => {
  const { locale, source, loadSpine } = await resolveScopeLanguages(projectId, project, scope)
  const empty: TranslationStatus = { locale, source_locale: source, total: 0, missing: 0, batches: 0, estimated_credits: 0 }
  if (locale === source) return empty

  const spine = await loadSpine()
  if (!spine) return empty
  const resolved = await resolveTranslations(projectId, locale, translationUnits(spine))
  const batches = splitBatches(uniqueBatchItems(resolved.missingUnits)).length
  const cost = batches > 0 ? await getActionCost(ActionType.TRANSLATE_DOCUMENT) : 0
  return { ...empty, total: resolved.total, missing: resolved.missing, batches, estimated_credits: batches * cost }
}

// ─── tải file theo ngôn ngữ khác (FLF-334 B) ─────────────────────

export const TRANSLATION_INCOMPLETE = "TRANSLATION_INCOMPLETE"
export const DOCUMENT_LANGUAGE_UNAVAILABLE = "DOCUMENT_LANGUAGE_UNAVAILABLE"

/** Đủ bản dịch của một Spine (bản nháp hoặc snapshot baseline) sang `locale` — đầu vào của 409 `TRANSLATION_INCOMPLETE`. */
export interface TranslationCompleteness {
  locale: UserLocale
  missing: number
  total: number
}

export const translationCompleteness = async (projectId: string, locale: UserLocale, spine: Spine): Promise<TranslationCompleteness> => {
  const resolved = await resolveTranslations(projectId, locale, translationUnits(spine))
  return { locale, missing: resolved.missing, total: resolved.total }
}

/** Còn đơn vị chưa dịch ⇒ 409 `TRANSLATION_INCOMPLETE` `{ locale, missing, total }` — không bao giờ in chữ gốc thay chỗ thiếu. */
export const assertTranslationComplete = async (projectId: string, locale: UserLocale, spine: Spine): Promise<void> => {
  const completeness = await translationCompleteness(projectId, locale, spine)
  if (completeness.missing === 0) return
  throw new ApiError(
    409,
    `Tài liệu còn ${completeness.missing} đoạn chưa dịch sang ${locale === "vi" ? "tiếng Việt" : "tiếng Anh"} nên chưa tải được bản này. Hãy dịch nốt rồi tải lại.`,
    TRANSLATION_INCOMPLETE,
    { ...completeness }
  )
}

/** 409 `DOCUMENT_LANGUAGE_UNAVAILABLE` — bản này chưa tải được theo ngôn ngữ khác (mode 1 import thật, bản nháp CR). */
export const documentLanguageUnavailable = (): ApiError =>
  new ApiError(409, "Bản này chưa tải được theo ngôn ngữ khác — chỉ tải được theo ngôn ngữ tài liệu của dự án.", DOCUMENT_LANGUAGE_UNAVAILABLE)
