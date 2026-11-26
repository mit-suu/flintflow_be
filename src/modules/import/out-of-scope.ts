/**
 * out-of-scope.ts - FLF-455, business-flow nguyên tắc 4 và §3.1 dòng I-4.
 *
 * Section **Ngoài phạm vi** = nội dung không thuộc SRS theo ISO/IEC/IEEE 29148 (vd dự toán chi phí), áp cho mọi chế độ. Phân loại
 * theo loại nội dung, không theo "mục không có trong mẫu chuẩn FlintFlow":
 * - section có chữ: I-4 phân loại từng khối (`content_types`, `in_scope`); mọi khối được phân loại đều ngoài 29148 và AI không
 *   rút ra phần tử nào ⇒ cả section ngoài phạm vi;
 * - section còn trống (chỉ có heading): chưa có nội dung để đọc nên xét theo heading (BF §3.1 dòng I-4).
 * Hàm thuần.
 */

import type { IExtractionDraft } from "./extraction-draft.model.js"

/** Độ tin tối thiểu để tin một phân loại của AI (dưới ngưỡng ⇒ coi như chưa phân loại, section ở lại trong phạm vi). */
export const OUT_OF_SCOPE_MIN_CONFIDENCE = 0.6

/**
 * Heading của mục trống thuộc loại nội dung rõ ràng ngoài SRS (chi phí, ngân sách, báo giá). Danh sách ngắn có chủ ý: mục trống
 * không rõ loại thì không đoán, vẫn là mục của đích (mẫu của người dùng).
 */
const NON_SRS_HEADINGS: readonly RegExp[] = [
  /dự\s*toán/iu,
  /chi\s*phí/iu,
  /ngân\s*sách/iu,
  /báo\s*giá/iu,
  /(?<![a-z])cost\s+(estimat\w*|breakdown|analysis)/iu,
  /(?<![a-z])budget(ing)?(?![a-z])/iu,
  /(?<![a-z])(price\s+quot\w*|quotation|pricing)/iu
]

const stripNumber = (heading: string): string => heading.trim().replace(/^[\dIVXivx]+(\.[\dIVXivx]+)*\.?\s+/, "")

/** Heading của mục còn trống cho thấy nội dung ngoài SRS theo 29148. */
export const isOutOfScopeHeading = (heading: string): boolean => {
  const title = stripNumber(heading)
  return !!title && NON_SRS_HEADINGS.some((re) => re.test(title))
}

type DraftScope = Pick<IExtractionDraft, "section_id" | "fields" | "content_types">

/**
 * Section có chữ mà I-4 xếp ngoài 29148: có phân loại tin cậy, mọi phân loại tin cậy đều `in_scope: false`, và AI không rút ra
 * phần tử nào (có phần tử ⇒ nội dung có phần thuộc SRS, giữ trong phạm vi).
 */
export const draftOutOfScope = (draft: Pick<IExtractionDraft, "fields" | "content_types">): boolean => {
  const trusted = (draft.content_types ?? []).filter((c) => c.confidence >= OUT_OF_SCOPE_MIN_CONFIDENCE)
  return trusted.length > 0 && trusted.every((c) => !c.in_scope) && (draft.fields ?? []).length === 0
}

/**
 * Id mục (đã đổi sang id của layout qua `toLayoutId`) mà kết quả I-4 xếp ngoài phạm vi. Chỉ mục riêng của file (`custom:*`): mục
 * FlintFlow khớp theo tên mà nội dung lạc loại đi đường "tên đúng, nội dung sai" (bước 1.6), không tự thành Ngoài phạm vi.
 */
export const outOfScopeSectionIds = (drafts: readonly DraftScope[], toLayoutId: (sectionId: string) => string): Set<string> =>
  new Set(drafts.filter(draftOutOfScope).map((d) => toLayoutId(d.section_id)).filter((id) => id.startsWith("custom:")))
