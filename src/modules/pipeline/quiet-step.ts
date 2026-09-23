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
 * lẽ ra phải nhìn: câu hỏi, cờ đỏ mới, giả định trái điều đã chốt, lỗi vẽ hình, và những bước mà quyết
 * định luôn là của người (`ALWAYS_GATE`).
 *
 * Mọi lượt tự Accept đều phát sự kiện `auto_accepted`, ghi vào `changes[]` như một lần accept thường, và
 * mở lại được bằng Revision — "tự động" ở đây nghĩa là *không hỏi*, không phải *không xem lại được*.
 */

import type { ReviewMode, Spine } from "../spine/spine.types.js"
import { activeDecisions } from "./decisions.service.js"

/**
 * Bước mà quyết định luôn thuộc về người, dù có yên lặng đến đâu:
 * - `B-0.1` ý tưởng và tên hệ thống — mọi thứ sau đó dựa vào nó;
 * - `S-4.1` chốt N (số màn) và khung function — sai ở đây là đi lại cả pha S-5;
 * - `S-9.4` xếp ưu tiên MoSCoW — một quyết định kinh doanh;
 * - `S-9.5` ký baseline.
 */
export const ALWAYS_GATE: ReadonlySet<string> = new Set(["B-0.1", "S-4.1", "S-9.4", "S-9.5"])

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
  spine: Spine
}

export interface QuietVerdict {
  quiet: boolean
  /** Lý do bằng tiếng Việt: hiện ở nhật ký khi tự Accept, hoặc giải thích vì sao vẫn dừng. */
  reason_vi: string
}

/**
 * Giả định có trái với một quyết định đã chốt không. So thô theo chủ đề: giả định nhắc tới chủ đề đã chốt
 * mà KHÔNG nhắc lại giá trị đã chốt thì coi là mâu thuẫn (AS28 "uptime 99.5%" trong khi sổ ghi 99%).
 * Nhận nhầm chỉ làm bước đó dừng lại hỏi người — hướng sai an toàn.
 */
export const conflictsWithLedger = (statement: string, spine: Spine): boolean => {
  const text = statement.toLowerCase()
  for (const decision of activeDecisions(spine).values()) {
    const topicWords = decision.topic_key.split("_").filter((w) => w.length >= 4)
    if (topicWords.length === 0 || !topicWords.some((word) => text.includes(word))) continue
    const answer = decision.answer.trim().toLowerCase()
    if (answer !== "" && !text.includes(answer)) return true
  }
  return false
}

/** Bước này có được tự Accept không, và vì sao. */
export const isQuietStep = (input: QuietInput): QuietVerdict => {
  if (input.reviewMode === "strict") return { quiet: false, reason_vi: "Chế độ duyệt chặt: dừng ở mọi bước" }
  if (ALWAYS_GATE.has(input.templateId)) return { quiet: false, reason_vi: "Bước này luôn cần bạn quyết" }
  if (input.phaseTerminal) return { quiet: false, reason_vi: "Cổng chốt cuối giai đoạn" }
  if (input.asked) return { quiet: false, reason_vi: "Bước có câu hỏi cho bạn" }
  if (input.redDelta > 0) return { quiet: false, reason_vi: `Bước mở thêm ${input.redDelta} cờ đỏ` }
  if (input.renderFailed) return { quiet: false, reason_vi: "Có sơ đồ vẽ lỗi" }

  const conflicting = input.newAssumptions.filter((a) => conflictsWithLedger(a.text, input.spine))
  if (conflicting.length > 0) {
    return { quiet: false, reason_vi: `${conflicting.length} giả định trái với điều bạn đã chốt` }
  }
  // Chế độ Nhanh: giả định mới không mâu thuẫn được gom lại ở cổng chốt cuối phase
  if (input.reviewMode === "balanced" && input.newAssumptions.length > 0) {
    return { quiet: false, reason_vi: `${input.newAssumptions.length} giả định mới cần bạn xem` }
  }
  return { quiet: true, reason_vi: "Bước không có gì cần bạn quyết" }
}
