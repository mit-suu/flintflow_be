/**
 * FLF-492 (BF §3.2, M4-02): tuỳ chọn "AI viết gọn" mô tả các dòng CR trong Record of Changes khi phát hành.
 *
 * Mặc định không chạy: dòng CR dùng câu dựng tất định từ thay đổi (`render/cr-record.ts`). Người phát hành bật ô chọn trong hộp
 * xác nhận ⇒ `summarizeRecordRows` gửi các dòng chưa có mô tả gọn cho model (một lượt mỗi 20 dòng, giữ credit riêng), kiểm từng
 * câu rồi lưu vào `ChangeRequest.record_summaries`. Bảng dựng sau đó đọc lại qua `assemble` (khớp loại, ngôn ngữ và
 * `changes_hash` mới dùng). Lỗi AI / hết credit / câu không hợp lệ ⇒ bỏ dòng đó, giữ câu dựng sẵn, không bao giờ ném lỗi.
 */

import { hasVietnameseMarks } from "../../shared/i18n/reply-language.js"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { getActionCost } from "../../shared/ai/credit-reservation.service.js"
import type { CrRecordSummaryOutput } from "../../shared/ai/response-parser.js"
import { ChangeRequest, type CrRecordSummary } from "../change-request/change-request.model.js"
import { withMeteredAi } from "../import/metered-ai.js"
import { crChangeItems, recordChangesHash, recordSummaryLanguage } from "../render/cr-record.js"
import { listChangesForRecord, loadTemplateLayout } from "../render/assemble.service.js"
import { crRecordUnits, type CrRecordUnit } from "../render/section-renderer.js"
import type { Spine } from "../spine/spine.types.js"
import type { TemplateSourceBinding } from "./template-source-binding.js"

/** Số dòng gửi mỗi lượt gọi model (một lượt = một lần giữ credit). */
export const RECORD_SUMMARY_BATCH = 20
/** Độ dài tối đa một câu viết gọn (khớp schema Mongo). */
const MAX_TEXT = 200

/** Ngôn ngữ chữ của Record of Changes: ngôn ngữ nhãn của mẫu cố định, không thì ngôn ngữ của file người dùng, mặc định tiếng Anh. */
export const resolveRecordLanguage = async (projectId: string, templateSource?: TemplateSourceBinding | null): Promise<"vi" | "en"> => {
  const bound = templateSource?.languages?.locale
  if (bound) return recordSummaryLanguage(bound)
  const layout = await loadTemplateLayout(projectId)
  return recordSummaryLanguage(layout?.language ?? "en")
}

const hasSummary = (existing: readonly CrRecordSummary[] | undefined, unit: CrRecordUnit, language: "vi" | "en"): boolean => {
  const hash = recordChangesHash(unit.changes)
  return !!existing?.some((s) => s.kind === unit.kind && s.language === language && s.changes_hash === hash)
}

/** Các dòng CR của gói chưa có mô tả gọn (đúng ngôn ngữ, đúng thay đổi). */
export const pendingSummaryUnits = async (
  projectId: string,
  spine: Spine,
  crIds: readonly string[],
  language: "vi" | "en"
): Promise<CrRecordUnit[]> => {
  if (crIds.length === 0) return []
  const wanted = new Set(crIds)
  const units = crRecordUnits(await listChangesForRecord(projectId), language, spine).filter((u) => wanted.has(u.cr_id))
  if (units.length === 0) return []
  const crs = (await ChangeRequest.find({ projectId, cr_id: { $in: [...wanted] } }, { cr_id: 1, record_summaries: 1 }).lean()) as { cr_id: string; record_summaries?: CrRecordSummary[] }[]
  const byCr = new Map(crs.map((c) => [c.cr_id, c.record_summaries] as const))
  return units.filter((u) => !hasSummary(byCr.get(u.cr_id), u, language))
}

/** Credit ước tính để viết gọn các dòng của gói (hiện trước trong hộp xác nhận phát hành). */
export const estimateRecordSummaryCredits = async (projectId: string, spine: Spine, crIds: readonly string[], language: "vi" | "en"): Promise<number> => {
  const units = await pendingSummaryUnits(projectId, spine, crIds, language)
  if (units.length === 0) return 0
  return Math.ceil(units.length / RECORD_SUMMARY_BATCH) * (await getActionCost(ActionType.CR_RECORD_SUMMARY))
}

/** Câu hợp lệ: không rỗng, không dài quá, đúng ngôn ngữ tài liệu, không mang tiền tố `CR-xxx:`; em dash đổi thành gạch ngang. */
export const cleanSummaryText = (raw: string, crId: string, language: "vi" | "en"): string | null => {
  let text = raw.trim().replace(/\s+/g, " ").replace(/—/g, "-")
  if (text.startsWith(`${crId}:`)) text = text.slice(crId.length + 1).trim()
  if (!text || text.length > MAX_TEXT) return null
  if (hasVietnameseMarks(text) !== (language === "vi")) return null
  return text
}

export interface RecordSummaryResult {
  /** Số dòng đã gửi đi viết gọn. */
  requested: number
  /** Số dòng được lưu. */
  saved: number
}

/**
 * Viết gọn mô tả các dòng CR của gói (`crIds`) và lưu vào từng CR. Không ném lỗi: lượt nào lỗi thì giữ câu dựng sẵn cho các dòng
 * của lượt đó.
 */
export const summarizeRecordRows = async (
  projectId: string,
  userId: string,
  spine: Spine,
  crIds: readonly string[],
  language: "vi" | "en",
  stepId: string
): Promise<RecordSummaryResult> => {
  const units = await pendingSummaryUnits(projectId, spine, crIds, language)
  const result: RecordSummaryResult = { requested: units.length, saved: 0 }
  const fresh = new Map<string, CrRecordSummary[]>()
  for (let i = 0; i < units.length; i += RECORD_SUMMARY_BATCH) {
    const batch = units.slice(i, i + RECORD_SUMMARY_BATCH)
    const rows = batch.map((u) => ({ cr_id: u.cr_id, kind: u.kind, built: u.built, changes: crChangeItems(u.changes, language, spine) }))
    try {
      const ai = await withMeteredAi<CrRecordSummaryOutput>({ projectId, userId, stepId }, ActionType.CR_RECORD_SUMMARY, {
        language: language === "vi" ? "Vietnamese" : "English",
        rows: JSON.stringify(rows)
      })
      if (!ai.ok) continue
      for (const unit of batch) {
        const row = ai.data.rows.find((r) => r.cr_id === unit.cr_id && r.kind === unit.kind)
        const text = row ? cleanSummaryText(row.text, unit.cr_id, language) : null
        if (!text) continue
        fresh.set(unit.cr_id, [...(fresh.get(unit.cr_id) ?? []), { kind: unit.kind, text, language, changes_hash: recordChangesHash(unit.changes) }])
        result.saved += 1
      }
    } catch (err) {
      console.warn(`[record-summary] ${stepId}: bỏ qua một lượt viết gọn:`, err instanceof Error ? err.message : err)
    }
  }
  for (const [crId, added] of fresh) {
    try {
      const existing = ((await ChangeRequest.findOne({ projectId, cr_id: crId }, { record_summaries: 1 }).lean()) as { record_summaries?: CrRecordSummary[] } | null)?.record_summaries ?? []
      const key = (s: CrRecordSummary): string => `${s.kind}|${s.language}|${s.changes_hash}`
      const replaced = new Set(added.map(key))
      await ChangeRequest.updateOne({ projectId, cr_id: crId }, { $set: { record_summaries: [...existing.filter((s) => !replaced.has(key(s))), ...added] } })
    } catch (err) {
      console.warn(`[record-summary] ${crId}: không lưu được mô tả gọn:`, err instanceof Error ? err.message : err)
      result.saved -= added.length
    }
  }
  return result
}
