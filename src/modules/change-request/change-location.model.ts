/**
 * Một vị trí bị CR ảnh hưởng (C-3 tìm, C-4 đề xuất, C-5 kiểm). Mode 1 v2 (FLF-186): vị trí = **phần tử Spine**
 * (`path`) + section hiển thị nó, thay block của file docx. Mọi vị trí phải có `conclusion` trước khi nộp.
 * `redo_count` ≤ 2 (MAX_REDO_PER_LOCATION) rồi hỏi người dùng ("Cần bạn quyết" — gõ hướng sửa hoặc bỏ chỗ đó).
 */

import mongoose, { Schema, Document } from "mongoose"
import {
  LOCATION_CONCLUSIONS,
  LOCATION_FOUND_BY,
  LOCATION_ID_PATTERN,
  type LocationConclusion,
  type LocationFoundBy
} from "./change-request.constants.js"
import { MAX_REDO_PER_LOCATION } from "./change-request.state.js"

export interface LocationProposal {
  /**
   * Giá trị phần tử lúc đề xuất (`valueText`) — C-5/C-7 so với Spine hiện tại, lệch ⇒ CR_VALUE_CHANGED. Vị trí "thêm mới"
   * (`arr[]`, FLF-308): `"[]"` — không chép cả mảng; so bằng `base_hash`.
   */
  old_text: string
  /** FLF-308: sha256 của mảng lúc đề xuất (chỉ vị trí `arr[]`); `null`/thiếu ⇒ so `old_text` (vị trí phần tử, bản ghi cũ). */
  base_hash?: string | null
  /** Giá trị phần tử sau khi áp `spine_ops` của vị trí (chạy khô) — để người duyệt đọc; `null` khi không sửa. */
  new_text: string | null
  comment_text: string | null
  /** Op Spine (định dạng `op.types.ts`), áp ở C-7 sau khi duyệt. */
  spine_ops: unknown[]
  /** Mode 1 v3 phase 7: dữ kiện AI phải tự giả định (CR / câu trả lời / tài liệu không nói) — người duyệt cần xác nhận. */
  assumptions?: string[]
  /** FLF-375 (BF §3.2 màn 3 cột): thời điểm AI soạn đề xuất này. */
  proposed_at?: Date | null
}

export interface VerifyViolation {
  rule: string
  message: string
  path?: string
}

export interface LocationVerify {
  /** Kiểm tất định: giá trị tại path chưa đổi, op chạm đúng phần tử đã khoá, chạy khô + bất biến, không thêm cờ đỏ. */
  code_ok: boolean
  violations: VerifyViolation[]
  /** Nhận xét AI consistency — chỉ vàng, không chặn. */
  ai_flags: { rule: string; message: string }[]
  at: Date
}

/**
 * FLF-375 (business-flow §3.2 "Hai người sửa cùng lúc"): lúc xác nhận, người khác đã sửa đúng phần đề xuất định đổi ⇒
 * không ghi; giữ ba bản để người dùng so sánh 3 cột (lúc AI soạn · hiện tại · đề xuất của bạn).
 */
export interface LocationConflict {
  at_proposal_text: string
  current_text: string
  proposal_text: string | null
  /** Người đã sửa (tên, hoặc "Tên (CR-003)"). */
  changed_by: string
  changed_at: Date | null
  /** FLF-375 (BF §3.2): thời điểm AI soạn đề xuất ① — FE in "Lúc AI soạn (9:00)". */
  proposed_at: Date | null
  /** BF §3.2: yêu cầu gốc đụng thẳng phần vừa sửa ⇒ AI hỏi lại trong chat (câu hỏi + gợi ý), không tự chọn. */
  question?: { text: string; suggestions: string[] } | null
}

export interface IChangeLocation extends Document {
  projectId: mongoose.Types.ObjectId
  cr_id: string
  location_id: string
  /** Phần tử Spine: `project`, `actors[id=A01]`, `custom_sections[id=CS02]`… */
  path: string
  /** Section hiển thị phần tử (`fixed:2.1`, `function:FN01`, `custom:CS02`, `misc`). */
  section_id: string
  found_by: LocationFoundBy[]
  entity_paths: string[]
  /** Điểm `vectorSearchScore` (0..1) khi vị trí có `found_by: vector`; `null` với vị trí tìm bằng đồ thị / từ khoá. */
  vector_score: number | null
  /** Step sở hữu section (nạp skill nội dung cho C-4); `null` với mục riêng. */
  owner_step: string | null
  conclusion: LocationConclusion | null
  reason: string | null
  proposal: LocationProposal | null
  /** Người dùng đã tự quyết chỗ này (giữ nguyên / bỏ, hoặc gõ hướng sửa cho AI soạn lại) — AI không đè lên. */
  manual: boolean
  redo_count: number
  verify: LocationVerify | null
  group_id: string | null
  conflict: LocationConflict | null
}

const opts = { _id: false }

const changeLocationSchema = new Schema<IChangeLocation>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    cr_id: { type: String, required: true },
    location_id: { type: String, required: true, match: LOCATION_ID_PATTERN },
    path: { type: String, required: true },
    section_id: { type: String, required: true },
    found_by: { type: [{ type: String, enum: LOCATION_FOUND_BY }], default: [] },
    entity_paths: { type: [String], default: [] },
    vector_score: { type: Number, default: null },
    owner_step: { type: String, default: null },
    conclusion: { type: String, enum: [...LOCATION_CONCLUSIONS, null], default: null },
    reason: { type: String, default: null },
    proposal: {
      type: new Schema(
        {
          old_text: { type: String, default: "" },
          base_hash: { type: String, default: null },
          new_text: { type: String, default: null },
          comment_text: { type: String, default: null },
          spine_ops: { type: [Schema.Types.Mixed], default: [] },
          assumptions: { type: [String], default: [] },
          proposed_at: { type: Date, default: null }
        },
        opts
      ),
      default: null
    },
    manual: { type: Boolean, default: false },
    redo_count: { type: Number, default: 0, min: 0, max: MAX_REDO_PER_LOCATION },
    verify: {
      type: new Schema(
        {
          code_ok: { type: Boolean, required: true },
          violations: { type: [new Schema({ rule: String, message: String, path: String }, opts)], default: [] },
          ai_flags: { type: [new Schema({ rule: String, message: String }, opts)], default: [] },
          at: { type: Date, required: true }
        },
        opts
      ),
      default: null
    },
    group_id: { type: String, default: null },
    conflict: {
      type: new Schema(
        {
          at_proposal_text: { type: String, default: "" },
          current_text: { type: String, default: "" },
          proposal_text: { type: String, default: null },
          changed_by: { type: String, default: "" },
          changed_at: { type: Date, default: null },
          proposed_at: { type: Date, default: null },
          question: { type: new Schema({ text: { type: String, default: "" }, suggestions: { type: [String], default: [] } }, opts), default: null }
        },
        opts
      ),
      default: null
    }
  },
  { timestamps: true, minimize: false }
)

changeLocationSchema.index({ projectId: 1, cr_id: 1, location_id: 1 }, { unique: true })
// Một phần tử chỉ xuất hiện một lần trong một CR
changeLocationSchema.index({ projectId: 1, cr_id: 1, path: 1 }, { unique: true })

export const ChangeLocation = mongoose.model<IChangeLocation>("ChangeLocation", changeLocationSchema)
