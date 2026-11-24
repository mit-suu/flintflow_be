/**
 * option-analysis.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-449 N1: kiểu phương án dùng chung cho mọi chỗ AI đưa lựa chọn cho người dùng: thẻ hỏi của vòng Elicit (việc 14),
 * cờ nghi sai nghiệp vụ (việc 7), mục Suy ra của danh sách rút (việc 19). Mỗi phương án có ưu / nhược / rủi ro-giả định
 * ngắn bằng ngôn ngữ người dùng.
 *
 * Luật khuyến nghị (03 #3): chỉ khuyến nghị khi chắc chắn, có căn cứ rõ (tài liệu, Brief, SRS, quyết định đã chốt). Đã
 * khuyến nghị thì bắt buộc kèm `recommendation_reason`. Không chắc ⇒ các phương án ngang nhau, không khuyến nghị.
 * Khuyến nghị thiếu lý do ⇒ bỏ cờ khuyến nghị (thẻ vẫn giữ) và ghi log `[option-analysis] recommendation_dropped`.
 *
 * Cờ khuyến nghị nằm trên từng phương án (`recommended: true`) chứ không phải chỉ số trong bộ: server còn lọc / bỏ trùng /
 * cắt phương án sau khi parse (`shapeOptions`), chỉ số sẽ lệch còn cờ thì đi theo phương án. Đuôi ` (Khuyến nghị)` /
 * ` (Recommended)` trên nhãn vẫn giữ song song (FLF-220): run-state cũ, các script đo, luật khớp câu trả lời và FE cũ
 * đều đọc đuôi này. Hai dấu hiệu luôn đi cùng nhau sau `normalizeRecommendation`.
 */

import { z } from "zod"

/** Đuôi đánh dấu phương án khuyến nghị trên nhãn lựa chọn (FLF-220). */
export const RECOMMENDED_SUFFIX = /\s*\((khuyến nghị|recommended)\)\s*$/i

export const hasRecommendedSuffix = (label: string): boolean => RECOMMENDED_SUFFIX.test(label)

/** Nhãn không còn đuôi khuyến nghị. */
export const withoutRecommendedSuffix = (label: string): string => label.replace(RECOMMENDED_SUFFIX, "").trim()

/** Chữ có dấu tiếng Việt ⇒ đuôi tiếng Việt. Parser không biết ngôn ngữ lượt trả lời nên đoán theo chữ của câu hỏi. */
const VIETNAMESE_LETTER = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i

export const recommendedSuffixFor = (sample: string): string => (VIETNAMESE_LETTER.test(sample) ? " (Khuyến nghị)" : " (Recommended)")

/** Một phương án. `pros` / `cons` / `risks` thiếu nghĩa là rỗng (không lưu mảng rỗng cho gọn run-state). */
export interface OptionAnalysis {
  /** Thứ người dùng chọn, bằng ngôn ngữ người dùng. Có thể mang đuôi khuyến nghị (xem đầu file). */
  label: string
  /** Chọn phương án này được / mất gì. */
  description?: string
  /** Bản so sánh monospace (bố cục màn, cấu trúc bảng). */
  preview?: string
  /** Ưu. */
  pros?: string[]
  /** Nhược. */
  cons?: string[]
  /** Rủi ro / giả định đi kèm. */
  risks?: string[]
  /** Phương án được khuyến nghị. Chỉ có khi bộ có `recommendation_reason`. */
  recommended?: true
}

/** Căn cứ của khuyến nghị (câu trích). Hậu kiểm câu trích là việc của khối N2. */
export interface OptionEvidence {
  quote: string
  para_id?: string
  source: "document" | "brief" | "srs"
}

/** Bộ phương án: 2–4 phương án, khuyến nghị là tuỳ chọn (03 #3). */
export interface OptionSet {
  options: OptionAnalysis[]
  /** Vì sao khuyến nghị, trỏ về điều cụ thể của dự án. Có khi và chỉ khi có phương án `recommended`. */
  recommendation_reason?: string
  evidence?: OptionEvidence
}

export const MAX_ANALYSIS_ITEMS = 4
const MAX_ANALYSIS_ITEM_LENGTH = 300

/** Chuỗi model bỏ trống hoặc để `null` coi như không có. */
export const optionalModelText = z
  .string()
  .nullish()
  .transform((v) => (v == null || v.trim() === "" ? undefined : v.trim()))

/**
 * Danh sách ưu / nhược / rủi ro từ model: nhận mảng chuỗi, một chuỗi trơn hoặc `null`. Mục rỗng / không phải chuỗi bị bỏ,
 * tối đa `MAX_ANALYSIS_ITEMS` mục. Một trường thừa không được làm hỏng cả lượt hỏi.
 */
const modelAnalysisList = z
  .unknown()
  .optional()
  .transform((raw): string[] => {
    const items = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : []
    return items
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().slice(0, MAX_ANALYSIS_ITEM_LENGTH))
      .filter((item) => item !== "")
      .slice(0, MAX_ANALYSIS_ITEMS)
  })

const nonEmpty = <K extends string>(key: K, list: string[]): Partial<Record<K, string[]>> =>
  list.length > 0 ? ({ [key]: list } as Record<K, string[]>) : {}

/**
 * Phương án model trả: chuỗi trơn (prompt cũ / tin nhắn cũ) hoặc object. Đuôi khuyến nghị trên nhãn hoặc
 * `recommended: true` đều tính là khuyến nghị; còn hợp lệ hay không là việc của `normalizeRecommendation`.
 */
export const modelOptionAnalysisSchema = z.union([
  z.string().transform((label): OptionAnalysis => (hasRecommendedSuffix(label) ? { label, recommended: true } : { label })),
  z
    .object({
      label: z.string(),
      description: optionalModelText,
      preview: optionalModelText,
      pros: modelAnalysisList,
      cons: modelAnalysisList,
      risks: modelAnalysisList,
      recommended: z.boolean().nullish()
    })
    .transform(
      ({ label, description, preview, pros, cons, risks, recommended }): OptionAnalysis => ({
        label,
        ...(description ? { description } : {}),
        ...(preview ? { preview } : {}),
        ...nonEmpty("pros", pros),
        ...nonEmpty("cons", cons),
        ...nonEmpty("risks", risks),
        ...(recommended === true || hasRecommendedSuffix(label) ? { recommended: true as const } : {})
      })
    )
])

export const optionEvidenceSchema = z.object({
  quote: z.string().trim().min(1),
  para_id: z.string().optional(),
  source: z.enum(["document", "brief", "srs"])
})

/** Phương án trong hợp đồng gửi FE / lưu run-state (đã chuẩn hoá). */
export const optionAnalysisSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  preview: z.string().optional(),
  pros: z.array(z.string()).optional(),
  cons: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  recommended: z.boolean().optional()
})

export const isRecommended = (option: Pick<OptionAnalysis, "label" | "recommended">): boolean =>
  option.recommended === true || hasRecommendedSuffix(option.label)

/** Bỏ mọi dấu khuyến nghị của một phương án (cờ + đuôi). */
export const clearRecommendation = <O extends OptionAnalysis>(option: O): O => {
  if (!isRecommended(option)) return option
  const { recommended: _recommended, ...rest } = option
  return { ...rest, label: withoutRecommendedSuffix(option.label) } as O
}

/** Vì sao bỏ khuyến nghị: `missing_reason` (03 #3), `no_idea_yet` (người dùng chưa có ý tưởng, FLF-221). */
export type RecommendationDropReason = "missing_reason" | "no_idea_yet"

export interface NormalizedRecommendation<O extends OptionAnalysis> {
  options: O[]
  recommendation_reason?: string
  /** Có khuyến nghị nhưng bị bỏ vì thiếu lý do. */
  dropped?: RecommendationDropReason
}

/**
 * Áp luật khuyến nghị cho một bộ phương án:
 * - có khuyến nghị + có lý do ⇒ giữ; cờ và đuôi luôn đi cùng nhau (thiếu đuôi thì gắn theo ngôn ngữ của `sample`);
 * - có khuyến nghị mà thiếu lý do ⇒ bỏ cờ và đuôi ở mọi phương án, giữ thẻ, báo `dropped: "missing_reason"`;
 * - không có khuyến nghị ⇒ bỏ lý do (lý do không trỏ vào phương án nào).
 */
export const normalizeRecommendation = <O extends OptionAnalysis>(
  options: readonly O[],
  reason: string | undefined,
  sample = ""
): NormalizedRecommendation<O> => {
  const text = reason?.trim() ?? ""
  const anyRecommended = options.some(isRecommended)
  if (!anyRecommended) return { options: [...options] }
  if (text === "") return { options: options.map(clearRecommendation), dropped: "missing_reason" }
  const suffix = recommendedSuffixFor(`${sample} ${options.map((o) => o.label).join(" ")}`)
  return {
    options: options.map((option) =>
      isRecommended(option) ? { ...option, label: hasRecommendedSuffix(option.label) ? option.label : `${option.label.trim()}${suffix}`, recommended: true as const } : option
    ),
    recommendation_reason: text
  }
}

/** Ghi log có nhãn cố định để đếm được (thay cho metric — repo chưa có bộ đếm). */
export const logRecommendationDropped = (scope: string, reason: RecommendationDropReason, topics: readonly string[]): void => {
  if (topics.length === 0) return
  console.info(`[option-analysis] recommendation_dropped scope=${scope} reason=${reason} count=${topics.length} topics=${topics.join(",")}`)
}

/**
 * Bộ phương án model trả, cho các chỗ dùng sau (cờ nghi sai nghiệp vụ, mục Suy ra): 2–4 phương án, áp luật khuyến nghị.
 * Thẻ hỏi Elicit dùng `modelOptionAnalysisSchema` + `normalizeRecommendation` trực tiếp vì câu hỏi có hình dạng riêng.
 */
export const modelOptionSetSchema = z
  .object({
    options: z.array(modelOptionAnalysisSchema).min(2).max(4),
    recommendation_reason: optionalModelText,
    evidence: optionEvidenceSchema.nullish()
  })
  .transform(({ options, recommendation_reason, evidence }): OptionSet & { dropped?: RecommendationDropReason } => {
    const normalized = normalizeRecommendation(options, recommendation_reason)
    return {
      options: normalized.options,
      ...(normalized.recommendation_reason ? { recommendation_reason: normalized.recommendation_reason } : {}),
      ...(evidence && normalized.recommendation_reason ? { evidence } : {}),
      ...(normalized.dropped ? { dropped: normalized.dropped } : {})
    }
  })

/** Bộ phương án trong hợp đồng / Spine (đã chuẩn hoá). */
export const optionSetSchema = z.object({
  options: z.array(optionAnalysisSchema).min(2).max(4),
  recommendation_reason: z.string().optional(),
  evidence: optionEvidenceSchema.optional()
})
