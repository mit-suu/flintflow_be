/**
 * FLF-479 (12b-1): lượt soạn có ngôn ngữ tài liệu khác ngôn ngữ Spine mà model không trả `localized` cho chữ nó vừa
 * viết ⇒ phần đó thành "chưa dịch" mà người dùng không hay. Lỗi **mềm** như `useCaseWiringErrors`: gửi lại model kèm
 * lỗi; lượt cuối thì nhận lô (banner "N mục chưa dịch" là lưới cuối). Tự dịch phần thiếu: xem plan fix #12 (12b-2, chưa chốt).
 */
import type { LocalizedEntry } from "../../shared/ai/response-parser.js"
import type { Op } from "../spine/op.types.js"
import { localizedUnitsOf } from "../translation/capture.service.js"
import { needsTranslation, unitsOfValue } from "../translation/translation-units.js"
import type { ValidationError } from "./op-validator.js"

const carriesText = (op: Op): boolean => (op.op === "set" || op.op === "add") && op.value !== undefined

/**
 * Với mỗi op chữ: đơn vị là câu (≥ 3 từ, tên ngắn giữ tiếng Anh là bình thường) mà `localized` không có bản dịch thật
 * (thiếu hẳn, hoặc model chép nguyên câu Anh) ⇒ một lỗi `localized_missing` cho path của op.
 */
export const localizedMissingErrors = (ops: readonly Op[], localized: readonly LocalizedEntry[] | undefined): ValidationError[] => {
  const provided = new Set(localizedUnitsOf(ops, localized ?? []).map((unit) => unit.sourceHash))
  const errors: ValidationError[] = []
  ops.forEach((op, index) => {
    if (!carriesText(op)) return
    const missing = unitsOfValue(op.path, op.value, op.value).filter((unit) => needsTranslation(unit.source) && !provided.has(unit.sourceHash))
    if (missing.length === 0) return
    errors.push({
      rule: "localized_missing",
      path: op.path,
      op_index: index,
      message: `Thiếu bản dịch sang ngôn ngữ tài liệu cho ${op.path}: thêm mục {"path":"${op.path}","value":<cùng hình dạng với value của op, viết bằng ngôn ngữ tài liệu>} vào \`localized\``
    })
  })
  return errors
}
