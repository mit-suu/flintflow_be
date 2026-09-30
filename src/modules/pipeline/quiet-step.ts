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

/** Lý do dừng riêng của từng bước `ALWAYS_GATE` — cổng B-0.1 là nơi user chốt ý tưởng (FLF-221). */
const ALWAYS_GATE_REASON: Readonly<Record<string, string>> = Object.freeze({
  "B-0.1": "Chốt ý tưởng — duyệt để AI đi tiếp, hoặc nhắn điều cần sửa",
  "S-1.1": "Soát bản tiếng Anh của tầm nhìn và mục tiêu trước khi đưa vào tài liệu"
})

export interface QuietInput {
  /** Id template (không có `@màn`). */
  templateId: string
  reviewMode: ReviewMode
  /** Bước có hỏi user câu nào trong lượt này không. */
  asked: boolean
  /** Cờ đỏ tăng thêm sau bước (dương ⇒ có cờ đỏ mới). */
  redDelta: number
  /** Giả định mới sinh trong bước. */
  newAssumptions: readonly { id: string; text: string }[]
  /** Có sơ đồ nào vẽ lỗi trong bước không. */
  renderFailed: boolean
  /** Bước là cổng chốt của cả phase (hoặc của một màn trong vòng S-5) — luôn dừng để user xem tổng. */
  phaseTerminal: boolean
  /**
   * Field duy nhất của bước đã được chốt ở bước trước (B-0.2/B-0.3 sau B-0.1): bước không gọi model, không ghi gì —
   * không có gì để duyệt, kể cả khi nó là bước cuối giai đoạn.
   */
  settledEarlier?: boolean
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
export const conflictsWithLedger = (statement: string, spine: Spine): boolean => {
  const text = statement.toLowerCase()
  if (!HAS_DIGIT.test(text)) return false
  for (const decision of activeDecisions(spine).values()) {
    const answer = decision.answer.trim().toLowerCase()
    if (answer === "" || !HAS_DIGIT.test(answer)) continue
    const topicWords = decision.topic_key.split("_").filter((w) => w.length >= 4)
    if (topicWords.length === 0 || !topicWords.some((word) => text.includes(word))) continue
    if (!text.includes(answer)) return true
  }
  return false
}

/** Bước này có được tự Accept không, và vì sao. */
export const isQuietStep = (input: QuietInput): QuietVerdict => {
  if (input.reviewMode === "strict") return { quiet: false, reason_vi: "Chế độ duyệt chặt: dừng ở mọi bước" }
  if (ALWAYS_GATE.has(input.templateId)) return { quiet: false, reason_vi: ALWAYS_GATE_REASON[input.templateId] ?? "Bước này luôn cần bạn quyết" }
  if (input.settledEarlier) return { quiet: true, reason_vi: "Đã chốt ở bước trước — không cần hỏi lại" }
  // Chưa có tên hệ thống thì B-2.3 phải hỏi tên (FLF-232) — không bao giờ tự Accept qua nó, dù chế độ duyệt nào
  if (input.templateId === SYSTEM_NAME_STEP && (input.spine.project?.system_name ?? null) === null) {
    return { quiet: false, reason_vi: "Cần chốt tên hệ thống trước khi mở phần tiếp theo" }
  }
  if (input.phaseTerminal) return { quiet: false, reason_vi: "Cổng chốt cuối giai đoạn" }
  // FLF-220: bước có hỏi thì user đã trả lời ngay trong lượt chạy — ở "Cuối giai đoạn" điều đó không đòi
  // thêm một cổng giữa giai đoạn; nội dung vẫn gom lên cổng chốt cuối phase.
  if (input.redDelta > 0) return { quiet: false, reason_vi: `Bước mở thêm ${input.redDelta} cờ đỏ` }
  if (input.renderFailed) return { quiet: false, reason_vi: "Có sơ đồ vẽ lỗi" }

  const conflicting = input.newAssumptions.filter((a) => conflictsWithLedger(a.text, input.spine))
  if (conflicting.length > 0) {
    return { quiet: false, reason_vi: `${conflicting.length} giả định trái với điều bạn đã chốt` }
  }
  // "Cuối giai đoạn" (`fast`, và `balanced` cũ xử lý như `fast` — FLF-220): giả định mới không mâu thuẫn
  // được gom lên cổng chốt cuối phase, không dừng giữa phase.
  return { quiet: true, reason_vi: "Bước không có gì cần bạn quyết" }
}
