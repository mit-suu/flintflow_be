/**
 * Hồ sơ luật cờ của mode 1 — cấu hình một chỗ (plan §6 2C, P0 báo cáo §3.1). FLF-171.
 * Spine mode 1 là chỉ mục trích từ tài liệu có sẵn: không có step, SRS thật thường thiếu mảng, viết tiếng Việt…
 * - Loại: luật gắn với quy trình sinh của mode 2 hoặc bắn hàng loạt vô nghĩa.
 * - Hạ đỏ ⇒ vàng: thiếu số đo là "gap" để báo, không phải lỗi kỹ thuật chặn release.
 * - Mode 1 v2 (D6, FLF-183): `section_empty` **giữ đỏ** — mọi đầu mục mẫu FPT là cốt lõi, thiếu nội dung thì chặn
 *   sign-off baseline v1 tới khi chạy step (AI soạn) hoặc viết tay; cờ tự đóng khi section có dữ liệu.
 * Giữ nguyên: `dead_reference`, `render_error`, `diagram_stale`, `unconfirmed_assumption` (đỏ) và các luật
 * cardinality vàng còn lại.
 */

import type { RuleProfile } from "../spine/deterministic-check.js"

export const MODE1_RULE_PROFILE: RuleProfile = Object.freeze({
  exclude: new Set([
    // mảng rỗng đưa vào gap report dạng "section thiếu", không chặn baseline v0 / release
    "array_empty",
    "section_stale_at_baseline",
    "section_awaiting_reaccept",
    "screen_pending_at_baseline",
    // SRS tiếng Việt là hợp lệ ở mode 1
    "non_english_content",
    // tài liệu hiếm liên kết UC ↔ function
    "usecase_no_function",
    // U1/U4/U5/U6 gắn chính tả tiếng Anh ⇒ bắn gần như mọi use case của một SRS tiếng Việt,
    // vốn hợp lệ ở mode 1. Luật ngữ nghĩa (usecase_name_semantic) vẫn chạy.
    "usecase_name_style",
    // tên hệ thống lấy từ bìa tài liệu khách — không đòi chốt tên tiếng Anh riêng
    "system_name_missing"
  ]),
  // `release.service.ts` lọc cờ đỏ KHÔNG trừ `waived_by_user`, nên để nguyên đỏ thì một SRS nhập
  // có vòng include/extend sẽ không bao giờ release được và waive cũng vô ích.
  downgrade: new Set(["nfr_missing_number", "usecase_relation_invalid"]),
  // FLF-213: mode 2 chỉ soi mục trống khi bước sở hữu đã chốt (đang ở S-3 thì §4.x trống là đúng kế
  // hoạch). Mode 1 không có "chưa tới lượt": cả tài liệu vào một lượt, `steps[]` suy ra từ chính file
  // (đầu mục thiếu ⇒ `pending`), nên gác theo step sẽ giấu đúng những mục D6 cần báo là gap.
  skipOwnerStepGate: true
})

/** Rule id của cờ vàng do AI đặt ở mode 1 (không bị recompute tất định đóng — `MODEL_OWNED_RULES`). */
export const IMPORT_SEMANTIC_RULE = "import_semantic"
export const CR_CONSISTENCY_RULE = "cr_consistency"
