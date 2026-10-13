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

/** `GET /projects/:id/translations/status` — ngôn ngữ tài liệu = ngôn ngữ gốc ⇒ `total: 0`. Không gọi model. */
export const translationStatus = async (projectId: string, project: DocumentLanguageProject): Promise<TranslationStatus> => {
  const { locale, source } = await projectLanguages(projectId, project)
  const empty: TranslationStatus = { locale, source_locale: source, total: 0, missing: 0, batches: 0, estimated_credits: 0 }
  if (locale === source) return empty

  const spine = await spineRepository.get(projectId)
  if (!spine) return empty
  const resolved = await resolveTranslations(projectId, locale, translationUnits(spine))
  const batches = splitBatches(uniqueBatchItems(resolved.missingUnits)).length
  const cost = batches > 0 ? await getActionCost(ActionType.TRANSLATE_DOCUMENT) : 0
  return { ...empty, total: resolved.total, missing: resolved.missing, batches, estimated_credits: batches * cost }
}
