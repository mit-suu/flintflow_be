/**
 * CR tạo từ một nhóm cờ ở hàng việc chờ quyết (FLF-445, business-flow §3.2 C-1). Kiểm cờ còn mở, rồi gieo đích C-3 từ
 * phần tử của từng cờ (khoá chuẩn hoá như hàng đợi FLF-443); cờ không gắn phần tử ⇒ mục của cờ. C-2 vẫn chạy, nhưng đích
 * gieo luôn giữ (`clarify.service.ts`) để CR sửa đúng chỗ bị cờ, không để model tự đoán phạm vi.
 */

import { Mode1Error } from "../import/mode1.errors.js"
import { buildIdIndex, normalizeTarget } from "../spine/pending-queue.service.js"
import { FLAG_NOT_FOUND } from "../spine/flags.service.js"
import type { Flag, Spine } from "../spine/spine.types.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { CrSeed } from "./change-request.model.js"
import { elementPathOf, isSectionTarget, listElements, sectionOfElement } from "./spine-location.js"

/** Cờ còn phải xử lý: chưa đóng, chưa "giữ nguyên", chưa bỏ qua. */
export const isOpenFlag = (flag: Flag): boolean => flag.resolved_at === null && flag.kept_reason === null && !flag.waived_by_user

/** Đích C-3 của một nhóm cờ: phần tử đã chuẩn hoá, không có thì mục của cờ. Giữ thứ tự, bỏ trùng. */
export const flagTargets = (spine: Spine, flags: readonly Flag[]): string[] => {
  const idIndex = buildIdIndex(spine)
  return [...new Set(flags.map((f) => normalizeTarget(f.target_id, idIndex) ?? f.section_id))]
}

/** Số phần tử Spine mà đích chạm thẳng tới (phần tử đích + mọi phần tử của mục đích). */
export const directLocationCount = (spine: Spine, targets: readonly string[]): number => {
  const elements = listElements(spine)
  const exists = new Set(elements.map((e) => e.path))
  const paths = new Set(targets.map(elementPathOf).filter((p): p is string => !!p && exists.has(p)))
  const sections = new Set(targets.filter(isSectionTarget))
  if (sections.size) for (const e of elements) if (sections.has(sectionOfElement(spine, e.path))) paths.add(e.path)
  return paths.size
}

/**
 * Kiểm `flag_ids` rồi trả gợi ý của CR. Id không có trong Spine của project ⇒ 404 `FLAG_NOT_FOUND`; cờ đã đóng / giữ nguyên /
 * bỏ qua ⇒ 400 `FLAG_NOT_OPEN`. Không giới hạn số phần tử: C-3 liệt kê đủ, chi phí C-4 báo trước ở chi tiết CR.
 */
export const seedFromFlags = (spine: Spine, flagIds: readonly string[]): { flagIds: string[]; seed: CrSeed } => {
  const ids = [...new Set(flagIds)]
  const byId = new Map(spine.flags.map((f) => [f.id, f]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) throw new ApiError(404, `Không tìm thấy cờ ${missing.join(", ")} trong tài liệu của dự án.`, FLAG_NOT_FOUND)
  const flags = ids.map((id) => byId.get(id)!)
  const closed = flags.filter((f) => !isOpenFlag(f)).map((f) => f.id)
  if (closed.length) {
    throw new Mode1Error("FLAG_NOT_OPEN", `Cờ ${closed.join(", ")} đã được xử lý - tải lại danh sách việc chờ quyết.`, { flag_ids: closed })
  }
  return { flagIds: ids, seed: { instruction: null, ops: [], targets: flagTargets(spine, flags) } }
}
