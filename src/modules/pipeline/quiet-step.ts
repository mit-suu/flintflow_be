/**
 * quiet-step.ts
 * ─────────────────────────────────────────────────────────────────
 * "Bước yên lặng" — `02-reduce-stops-plan.md` R1 (FLF-208).
 *
 * Dự án 7 màn ở lượt test có **91 điểm dừng**: mỗi bước một cổng chốt, kể cả những bước không hỏi gì và
 * không ghi gì (S-5.1 dời con trỏ, S-5.3 không có wireframe, S-8.3). Bấm Accept 91 lần biến việc duyệt
 * thành phản xạ, và khi tới bước thật sự cần đọc thì user đã hết kiên nhẫn.
 *
 * Bước được tự Accept khi thoả **đủ** các điều kiện dưới đây. Mỗi điều kiện tương ứng với một thứ user
 * lẽ ra phải nhìn: cờ đỏ mới, giả định trái điều đã chốt, lỗi vẽ hình, và những bước mà quyết
 * định luôn là của người (`ALWAYS_GATE`).
 *
 * Mọi lượt tự Accept đều phát sự kiện `auto_accepted`, ghi vào `changes[]` như một lần accept thường, và
 * mở lại được bằng Revision — "tự động" ở đây nghĩa là *không hỏi*, không phải *không xem lại được*.
 */

import type { ReviewMode, Spine } from "../spine/spine.types.js"
import { activeDecisions, SYSTEM_NAME_STEP } from "./decisions.service.js"

/**
 * Bước mà quyết định luôn thuộc về người, dù có yên lặng đến đâu:
 * - `B-0.1` ý tưởng, nền tảng và mức độ quan trọng — mọi thứ sau đó dựa vào nó (tên hệ thống hỏi muộn hơn, ở B-2.3);
 * - `S-1.1` dựng tầm nhìn và mục tiêu tiếng Anh cho SRS từ Brief — user soát bản EN cạnh bản của mình;
 * - `S-4.1` chốt N (số màn) và khung function — sai ở đây là đi lại cả pha S-5;
 * - `S-9.4` xếp ưu tiên MoSCoW — một quyết định kinh doanh;
 * - `S-9.5` ký baseline.
 */
export const ALWAYS_GATE: ReadonlySet<string> = new Set(["B-0.1", "S-1.1", "S-4.1", "S-9.4", "S-9.5"])

/**
 * FLF-337 — **bảng cổng cứng** duy nhất (business-flow §1.2 "Cổng cứng — mức nào cũng dừng"): các mốc chốt `ALWAYS_GATE` +
 * Approve Brief `B-2.3`; cộng với điều kiện trong lượt: AI cần hỏi (`answer_needed` đã dừng sẵn), cờ đỏ mới, xoá nội dung,
 * lỗi vẽ sơ đồ, giả định trái điều đã chốt. Cổng cứng ngoài lượt chạy (xác nhận credit trước khi chạy hàng loạt — FLF-332;
 * tài liệu đi ra ngoài: gửi duyệt / ký / gửi gói / phát hành) nằm ở endpoint tương ứng. Ở mức `milestones` mọi bước khác tự
 * qua — kể cả bước cuối giai đoạn.
 */
export const HARD_GATE_STEPS: ReadonlySet<string> = new Set([...ALWAYS_GATE, "B-2.3"])

/** Lý do dừng riêng của từng bước `ALWAYS_GATE` — cổng B-0.1 là nơi user chốt ý tưởng (FLF-221). */
const ALWAYS_GATE_REASON: Readonly<Record<string, string>> = Object.freeze({
  "B-0.1": "Chốt ý tưởng - duyệt để AI đi tiếp, hoặc nhắn điều cần sửa",
  "S-1.1": "Soát bản tiếng Anh của tầm nhìn và mục tiêu trước khi đưa vào tài liệu"
})

export interface QuietInput {
  /** Id template (không có `@màn`). */
  templateId: string
  reviewMode: ReviewMode
  /**
   * Bước có hỏi user câu nào trong lượt này không (đã phát `answer_needed` trong lượt `runStep` của chính bước, kể cả khi
   * user đã trả lời ngay trong lượt). Có hỏi ⇒ không tự qua ở mọi mức duyệt (FLF-449).
   */
  asked: boolean
  /** Cờ đỏ tăng thêm sau bước (dương ⇒ có cờ đỏ mới). */
  redDelta: number
  /** Giả định mới sinh trong bước. */
  newAssumptions: readonly { id: string; text: string; text_vi?: string }[]
  /** Có sơ đồ nào vẽ lỗi trong bước không. */
  renderFailed: boolean
  /** Bước là cổng chốt của cả phase (hoặc của một màn trong vòng S-5) — luôn dừng để user xem tổng. */
  phaseTerminal: boolean
  /**
   * Field duy nhất của bước đã được chốt ở bước trước (B-0.2/B-0.3 sau B-0.1): bước không gọi model, không ghi gì —
   * không có gì để duyệt, kể cả khi nó là bước cuối giai đoạn.
   */
  settledEarlier?: boolean
  /** FLF-337: bước có xoá nội dung (`summary[].kind === "remove"`) — cổng cứng ở mọi mức. */
  contentRemoved?: boolean
  /** FLF-337: section bước này chạm (`summary[].section_id`) — so với `project.skip_confirm_sections`. */
  touchedSections?: readonly string[]
  /**
   * FLF-432 (FLF-413 #8): mục bước này nuôi mà chạy xong vẫn trống (`gate_ready.empty_sections`, cùng hàm với luật
   * `section_empty`). Bước soạn chưa ghi được gì cho mục của nó (lượt chỉ trao đổi) thì không được tự qua sang bước sau.
   */
  emptySections?: readonly { section_id: string }[]
  spine: Spine
}

export interface QuietVerdict {
  quiet: boolean
  /** Lý do bằng tiếng Việt: hiện ở nhật ký khi tự Accept, hoặc giải thích vì sao vẫn dừng. */
  reason_vi: string
}

const HAS_DIGIT = /[0-9]/

/**
 * Giả định có trái với một quyết định đã chốt không. So thô theo chủ đề: giả định nhắc tới chủ đề đã chốt
 * mà KHÔNG nhắc lại giá trị đã chốt thì coi là mâu thuẫn (AS28 "uptime 99.5%" trong khi sổ ghi 99%).
 *
 * Chỉ so quyết định mang SỐ (99%, 50.000đ, 15 phút) và chỉ khi giả định cũng nêu một con số: hai chuỗi chữ khác nhau
 * chưa chắc mâu thuẫn ("Web" vs "Ứng dụng web cho nhân viên"), còn giả định không nêu con số nào thì không thể "khác
 * số". Trước đây so chữ thô làm cổng báo "N giả định trái với điều bạn đã chốt" khi chẳng có gì trái.
 */
export const conflictsWithLedger = (statement: string | { text: string; text_vi?: string }, spine: Spine): boolean => {
  const { text: raw, text_vi: rawVi } = typeof statement === "string" ? { text: statement, text_vi: undefined } : statement
  const text = raw.toLowerCase()
  const textVi = (rawVi ?? "").toLowerCase()
  if (!HAS_DIGIT.test(text)) return false
  for (const decision of activeDecisions(spine).values()) {
    const answer = decision.answer.trim().toLowerCase()
    if (answer === "" || !HAS_DIGIT.test(answer)) continue
    const topicWords = decision.topic_key.split("_").filter((w) => w.length >= 4)
    if (topicWords.length === 0 || !topicWords.some((word) => text.includes(word))) continue
    // Giá trị đã chốt có trong bản tiếng Anh HOẶC bản tiếng Việt của giả định ⇒ không mâu thuẫn
    if (!text.includes(answer) && !textVi.includes(answer)) return true
  }
  return false
}

/** Điều kiện cổng cứng chung của bước và của bản sửa qua chat (xem `hardGateOf`). */
export interface HardGateInput {
  /** Cờ đỏ tăng thêm (dương ⇒ có cờ đỏ mới). */
  redDelta: number
  /** Có xoá nội dung đã có. */
  contentRemoved?: boolean
  /** Có sơ đồ vẽ lỗi. */
  renderFailed?: boolean
  /** Giả định mới sinh trong lượt. */
  newAssumptions: readonly { id: string; text: string; text_vi?: string }[]
  spine: Spine
}

export type HardGate =
  | { kind: "red_flags"; count: number }
  | { kind: "content_removed" }
  | { kind: "render_failed" }
  | { kind: "assumption_conflict"; count: number }

/**
 * Lõi dùng chung: bốn điều kiện cổng cứng ở MỌI mức duyệt (FLF-337) — cờ đỏ mới, xoá nội dung, lỗi vẽ, giả định trái điều đã
 * chốt. Bước (`isQuietStep`) và bản sửa qua chat (`chatEditVerdict`) cùng đọc hàm này để hai nơi không lệch luật.
 */
export const hardGateOf = (input: HardGateInput): HardGate | null => {
  if (input.redDelta > 0) return { kind: "red_flags", count: input.redDelta }
  if (input.contentRemoved) return { kind: "content_removed" }
  if (input.renderFailed) return { kind: "render_failed" }
  const conflicting = input.newAssumptions.filter((a) => conflictsWithLedger(a, input.spine))
  if (conflicting.length > 0) return { kind: "assumption_conflict", count: conflicting.length }
  return null
}

/** Lý do dừng của bước theo cổng cứng. */
const stepHardGateReason = (gate: HardGate): string => {
  switch (gate.kind) {
    case "red_flags":
      return `Bước mở thêm ${gate.count} cờ đỏ`
    case "content_removed":
      return "Bước xoá nội dung đã có"
    case "render_failed":
      return "Có sơ đồ vẽ lỗi"
    case "assumption_conflict":
      return `${gate.count} giả định trái với điều bạn đã chốt`
  }
}

/** Mọi section lượt chạm đều nằm trong `project.skip_confirm_sections` ("Chấp nhận, không hỏi lại phần này"). */
export const touchesOnlySkippedSections = (touched: readonly string[], spine: Spine): boolean => {
  const skip = new Set(spine.project?.skip_confirm_sections ?? [])
  return touched.length > 0 && skip.size > 0 && touched.every((id) => skip.has(id))
}

/** Bước này có được tự Accept không, và vì sao. */
export const isQuietStep = (input: QuietInput): QuietVerdict => {
  if (ALWAYS_GATE.has(input.templateId)) return { quiet: false, reason_vi: ALWAYS_GATE_REASON[input.templateId] ?? "Bước này luôn cần bạn quyết" }
  // Mọi bước: dừng ở mọi bước — trừ bước chỉ chạm phần đã chọn "không hỏi lại" (FLF-337, xét ở dưới)
  const touchedOnlySkipped = touchesOnlySkippedSections(input.touchedSections ?? [], input.spine)
  if (input.reviewMode === "strict" && !touchedOnlySkipped) return { quiet: false, reason_vi: "Chế độ duyệt chặt: dừng ở mọi bước" }
  if (input.settledEarlier) return { quiet: true, reason_vi: "Đã chốt ở bước trước - không cần hỏi lại" }
  // Chưa có tên hệ thống thì B-2.3 phải hỏi tên (FLF-232) — không bao giờ tự Accept qua nó, dù chế độ duyệt nào
  if (input.templateId === SYSTEM_NAME_STEP && (input.spine.project?.system_name ?? null) === null) {
    return { quiet: false, reason_vi: "Cần chốt tên hệ thống trước khi mở phần tiếp theo" }
  }
  // FLF-449 (03-can-chot #1, BF §1.2 "Step tự qua khi không hỏi gì"): bước đã hỏi user trong lượt thì không tự qua, ở MỌI
  // mức duyệt, kể cả khi chỉ chạm phần "không hỏi lại" (AI cần hỏi là cổng cứng). Thay luật FLF-220 cũ cho bước có hỏi qua
  // im ở "Cuối giai đoạn" / "Chỉ ở mốc chốt".
  if (input.asked) return { quiet: false, reason_vi: "Bước đã hỏi bạn - xem lại nội dung vừa soạn từ câu trả lời" }
  // FLF-337: bốn điều kiện tự qua áp ở MỌI mức — cờ đỏ mới, xoá nội dung, lỗi vẽ, giả định trái điều đã chốt là cổng cứng
  const hard = hardGateOf(input)
  if (hard) return { quiet: false, reason_vi: stepHardGateReason(hard) }
  // FLF-432 (FLF-413 #8): S-7.3 chỉ trao đổi mà `messages` vẫn rỗng ⇒ dừng ở cổng, không tự nhảy sang S-7.4
  if ((input.emptySections ?? []).length > 0) return { quiet: false, reason_vi: "Bước chưa ghi được nội dung cho mục nó phụ trách" }
  // FLF-337 "Chấp nhận, không hỏi lại phần này": bước chỉ chạm các section đã tắt hỏi ⇒ tự qua ở mọi mức (kể cả Mọi bước)
  if (touchesOnlySkippedSections(input.touchedSections ?? [], input.spine)) {
    return { quiet: true, reason_vi: "Chỉ chạm phần bạn đã chọn không hỏi lại" }
  }
  if (input.reviewMode === "milestones") {
    // Chỉ ở mốc chốt: Approve Brief là cổng cứng dù hệ thống đã có tên; mọi bước khác (kể cả cuối giai đoạn) tự qua
    if (input.templateId === SYSTEM_NAME_STEP) return { quiet: false, reason_vi: "Duyệt Brief - mốc chốt" }
    return { quiet: true, reason_vi: "Chỉ ở mốc chốt: bước này tự qua" }
  }
  if (input.phaseTerminal) return { quiet: false, reason_vi: "Cổng chốt cuối giai đoạn" }
  // "Cuối giai đoạn" (`fast`, và `balanced` cũ xử lý như `fast` — FLF-220): giả định mới không mâu thuẫn
  // được gom lên cổng chốt cuối phase, không dừng giữa phase.
  return { quiet: true, reason_vi: "Bước không có gì cần bạn quyết" }
}

export interface ChatEditInput extends HardGateInput {
  reviewMode: ReviewMode
  /** Section sở hữu mà bản sửa chạm tới. */
  touchedSections: readonly string[]
  /** AI cảnh báo yêu cầu không hợp lý, hoặc còn câu cần hỏi: cổng cứng ở mọi mức. */
  needsPerson: boolean
}

/**
 * Bản sửa qua chat TRƯỚC baseline có được tự ghi sau xem trước không (business-flow nguyên tắc 6, §1.2). Cùng cổng cứng với
 * bước (`hardGateOf`) cộng cảnh báo / câu hỏi của AI; "Không hỏi lại" tự ghi ở mọi mức; còn lại chỉ mức *Mọi bước* (`strict`)
 * hiện thẻ xác nhận. Không có "cuối giai đoạn" trong chat nên `balanced` / `fast` / `milestones` giống nhau. Sau baseline đi
 * đường change request, hàm này không được gọi.
 */
export const chatEditVerdict = (input: ChatEditInput): QuietVerdict => {
  if (input.needsPerson) return { quiet: false, reason_vi: "AI cần bạn quyết trước khi ghi" }
  const hard = hardGateOf(input)
  if (hard) {
    const reason: Record<HardGate["kind"], string> = {
      red_flags: `Thay đổi này mở thêm ${hard.kind === "red_flags" ? hard.count : 0} cờ đỏ chặn baseline`,
      content_removed: "Thay đổi này xoá nội dung đã có",
      render_failed: "Có sơ đồ vẽ lỗi",
      assumption_conflict: "Có giả định trái với điều bạn đã chốt"
    }
    return { quiet: false, reason_vi: reason[hard.kind] }
  }
  if (touchesOnlySkippedSections(input.touchedSections, input.spine)) return { quiet: true, reason_vi: "Chỉ chạm phần bạn đã chọn không hỏi lại" }
  if (input.reviewMode === "strict") return { quiet: false, reason_vi: "Mức duyệt Mọi bước: bạn xác nhận từng thay đổi" }
  return { quiet: true, reason_vi: "Mức duyệt hiện tại cho phép tự ghi thay đổi không có rủi ro" }
}
