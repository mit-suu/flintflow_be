/**
 * chat-edit-support.ts
 * ─────────────────────────────────────────────────────────────────
 * Phần thuần của lượt sửa qua chat (`change.service.ts`), tách ra để test riêng:
 * - dự báo cờ đỏ mà bản sửa sẽ mở (Code chạy deterministic check trước / sau, không tin lời AI);
 * - kiểm luật tầng 3 + cấu trúc bảng mẫu cho mục riêng do AI soạn qua chat (mục chưa có step);
 * - giả định AI tự đoán ⇒ op ghi vào `spine.assumptions` như step làm, và câu nói giả định trong lời trả lời;
 * - nguồn mặc định của yêu cầu thêm qua chat.
 */

import { checkTableStructure, flagKey, runDeterministicCheck, vagueWordsIn, type RuleProfile } from "./deterministic-check.js"
import { ownerStepOf, sectionsOfPath } from "./section-registry.js"
import type { Op } from "./op.types.js"
import type { Spine } from "./spine.types.js"
import { byLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"

// ─── dự báo cờ đỏ ────────────────────────────────────────────────

export interface PredictedRedFlag {
  rule_id: string
  section_id: string
  target_id: string | null
  message: string
}

/**
 * Cờ sơ đồ do code vẽ lại ngay sau khi ghi (`renderAfterChange`) nên hình cũ lúc xem trước không phải lỗi của bản sửa;
 * `unconfirmed_assumption` chỉ chạy ở lượt ký baseline.
 */
const NOT_PREDICTED: ReadonlySet<string> = new Set(["render_error", "diagram_stale", "unconfirmed_assumption"])

/** Cờ đỏ MỚI mà `after` có và `before` chưa có - cùng cách `change-request/verify.service` so cờ đỏ trước / sau. */
export const predictRedFlags = (before: Spine, after: Spine, ruleProfile?: RuleProfile): PredictedRedFlag[] => {
  const options = ruleProfile ? { ruleProfile } : {}
  const known = new Set(runDeterministicCheck(before, [], options).filter((c) => c.level === "red").map(flagKey))
  return runDeterministicCheck(after, [], options)
    .filter((c) => c.level === "red" && !NOT_PREDICTED.has(c.rule_id) && !known.has(flagKey(c)))
    .map(({ rule_id, section_id, target_id, message }) => ({ rule_id, section_id, target_id, message }))
}

export const predictedRedNote = (flags: readonly PredictedRedFlag[], language: ReplyLanguage): string =>
  flags.length === 0
    ? ""
    : byLanguage(language, {
        vi: `Sửa này sẽ mở ${flags.length} vấn đề đỏ chặn baseline: ${flags.slice(0, 3).map((f) => f.message).join("; ")}${flags.length > 3 ? "; ..." : ""}.`,
        en: `This edit will open ${flags.length} red issue${flags.length === 1 ? "" : "s"} that block the baseline: ${flags.slice(0, 3).map((f) => f.message).join("; ")}${flags.length > 3 ? "; ..." : ""}.`
      })

// ─── mục riêng do AI soạn qua chat ───────────────────────────────

type CustomBlock = Spine["custom_sections"][number]["blocks"][number]

const blockText = (b: CustomBlock): string => (b.kind === "table" ? (b.rows ?? []).slice(1).map((r) => r.join(" ")).join("\n") : b.text)

const sameBlocks = (a: readonly CustomBlock[], b: readonly CustomBlock[]): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Mục riêng (heading của mẫu, không có step) mà bản sửa vừa viết lại: bảng phải giữ đúng hàng tiêu đề của bảng mẫu (bảng đã
 * có trong mục trước khi soạn), và chữ AI mới viết không được chứa từ mơ hồ (luật tầng 3 `vague_wording`) - trừ từ người dùng
 * tự gõ trong lệnh. Trả câu cho người đọc; rỗng ⇒ đạt. Mục chưa có trước đó (không có bảng mẫu để so) không xét.
 */
export const sectionDraftProblems = (before: Spine, after: Spine, instruction: string): string[] => {
  const asked = instruction.toLowerCase()
  return after.custom_sections.flatMap((section) => {
    const prev = before.custom_sections.find((c) => c.id === section.id)
    if (!prev || sameBlocks(prev.blocks, section.blocks)) return []
    const heading = section.heading.trim() || section.id
    const structure = checkTableStructure(prev.blocks, section.blocks).map((p) =>
      p.reason === "missing"
        ? `Mục "${heading}": thiếu bảng thứ ${p.table} của mẫu (cột: ${p.expected.join(", ")}) - giữ đúng bảng mẫu`
        : `Mục "${heading}": bảng thứ ${p.table} phải đúng các cột của mẫu (${p.expected.join(", ")}), đang là ${(p.actual ?? []).join(", ") || "trống"}`
    )
    const prevText = prev.blocks.map(blockText).join("\n")
    const added = section.blocks.map(blockText).filter((t) => t && !prevText.includes(t)).join("\n")
    const vague = vagueWordsIn(added).filter((w) => !asked.includes(w.toLowerCase()))
    return [
      ...structure,
      ...(vague.length > 0 ? [`Mục "${heading}": chữ soạn có từ chưa rõ nghĩa (${vague.map((w) => `"${w}"`).join(", ")}) - viết lại bằng số đo hoặc điều kiện kiểm chứng được`] : [])
    ]
  })
}

// ─── giả định ────────────────────────────────────────────────────

export interface ChatAssumption {
  path: string
  statement: string
  statement_vi?: string
  rationale?: string
}

/**
 * Giả định thành op `add assumptions[]` như step ghi (`unconfirmed`, id do server cấp, ghi cùng lô nên undo cùng lô).
 * `origin_step_id` = bước sở hữu mục mà giả định nói về, để giả định hiện đúng chỗ ở S-9.2; không tra được ⇒ S-9.1.
 */
export const assumptionOps = (spine: Spine, list: readonly ChatAssumption[]): Op[] =>
  list.map((a): Op => {
    let origin = "S-9.1"
    try {
      const owner = sectionsOfPath(spine, a.path).owner[0]
      if (owner) origin = ownerStepOf(owner, spine)
    } catch {
      // path chứa id tạm của phần tử mới (`$new1`) chưa phân giải được lúc này: giữ bước mặc định
    }
    return {
      op: "add",
      path: "assumptions[]",
      value: {
        path: a.path,
        statement: a.statement,
        ...(a.statement_vi ? { statement_vi: a.statement_vi } : {}),
        rationale: a.rationale ?? "Not stated in the request; assumed while drafting from chat.",
        origin_step_id: origin,
        status: "unconfirmed",
        confirmed_at: null
      },
      reason: "Giả định khi soạn theo yêu cầu qua chat"
    }
  })

/** Câu nói giả định thẳng trong lời trả lời, giọng BA - không tách thành hộp riêng. */
export const assumptionsNote = (list: readonly ChatAssumption[], language: ReplyLanguage): string => {
  if (list.length === 0) return ""
  const text = (a: ChatAssumption) => (language === "vi" ? (a.statement_vi ?? a.statement) : a.statement)
  return byLanguage(language, {
    vi: `Chỗ bạn chưa nói rõ nên mình tạm hiểu: ${list.map(text).join("; ")}. Sai chỗ nào bạn nhắn mình sửa lại nhé.`,
    en: `You did not say this explicitly, so I assumed: ${list.map(text).join("; ")}. Tell me if any of it is wrong and I will fix it.`
  })
}

// ─── nguồn của yêu cầu thêm qua chat ─────────────────────────────

const REQUIREMENT_ARRAYS: ReadonlySet<string> = new Set(["functions[]", "nfrs[]", "business_rules[]"])

/** Yêu cầu (chức năng, NFR, quy tắc nghiệp vụ) thêm theo lệnh của người dùng: nguồn là chính người yêu cầu, không để cờ "thiếu nguồn". */
export const stampChatSource = (ops: readonly Op[]): Op[] =>
  ops.map((op) => {
    const value = op.value as Record<string, unknown> | undefined
    if (op.op !== "add" || !REQUIREMENT_ARRAYS.has(op.path) || !value || typeof value !== "object" || Array.isArray(value)) return op
    const current = value.source_ref
    if (typeof current === "string" && current.trim()) return op
    return { ...op, value: { ...value, source_ref: "User request via chat" } }
  })
