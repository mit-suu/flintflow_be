/**
 * flag-target.ts
 * ─────────────────────────────────────────────────────────────────
 * FLF-428 — "Sửa trong chat" từ một cờ (AC-38.2, UC-38 bước 5 "sau mỗi lần sửa, Code kiểm lại và đóng cờ đã hết").
 *
 * FE điền sẵn câu lệnh `Trong <mục>: sửa vấn đề "<message của cờ>"`. Không đổi hợp đồng request (`pipeline.dto.ts` đóng băng):
 * BE tự nhận ra cờ đang mở mà câu lệnh nhắm tới — câu chứa nguyên văn `message`, hoặc chứa mã phần tử của cờ — rồi
 *   1. đưa cờ + gợi ý sửa theo luật vào projection cho model (model biết phải ghi field nào, không chỉ viết thêm vào statement);
 *   2. lô chưa đóng được cờ ⇒ thành một "problem" cho lượt thử lại duy nhất;
 *   3. sau khi áp, cờ vẫn mở ⇒ câu trả lời nói rõ thay vì chỉ "Đã áp dụng".
 * Hàm thuần (trừ `runDeterministicCheck`, cũng thuần).
 */

import { runDeterministicCheck } from "./deterministic-check.js"
import type { Flag, Spine } from "./spine.types.js"

export interface TargetFlag {
  rule_id: string
  /** Mã phần tử bị cờ (`NFR-12`), đã bóc khỏi đường dẫn `nfrs[id=NFR-12]` nếu có. */
  target_id: string
  message: string
  fix_hint?: string
}

/** `nfrs[id=NFR-12]` / `NFR-12` ⇒ `NFR-12`; đường dẫn lồng (`use_cases[id=UC01].actor_ids[=A08]`) ⇒ id đầu. */
export const bareTargetId = (target: string): string => /\[id=([^\]]+)\]/.exec(target)?.[1] ?? target

/** Gợi ý sửa theo luật — chỉ những luật mà model hay sửa sai chỗ. Tiếng Anh: đi vào prompt. */
const FIX_HINTS: Readonly<Record<string, (targetId: string) => string>> = {
  nfr_missing_number: (id) =>
    `Set nfrs[id=${id}].kind = "quantitative", nfrs[id=${id}].metric (short measure, e.g. "Oversold orders per month") and nfrs[id=${id}].threshold (number + unit, e.g. "0", "<= 2 s"). Do NOT append the measure to statement — the flag reads metric and threshold only.`
}

/** Cờ chưa đóng (`resolved_at` trống; dữ liệu cũ có thể thiếu field). */
const isOpen = (f: Flag): boolean => f.resolved_at == null

/** Cờ đang mở mà câu lệnh nhắm tới (theo nguyên văn message, hoặc mã phần tử đứng riêng). */
export const targetFlagsOf = (spine: Pick<Spine, "flags">, instruction: string | null | undefined): TargetFlag[] => {
  const text = (instruction ?? "").toLowerCase()
  if (!text.trim()) return []
  const out: TargetFlag[] = []
  for (const f of spine.flags ?? []) {
    if (!isOpen(f) || !f.target_id) continue
    const id = bareTargetId(f.target_id)
    const byMessage = f.message.length > 0 && text.includes(f.message.toLowerCase())
    const byId = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(id.toLowerCase())}($|[^a-z0-9-])`).test(text)
    if (!byMessage && !byId) continue
    if (out.some((t) => t.rule_id === f.rule_id && t.target_id === id)) continue
    const hint = FIX_HINTS[f.rule_id]?.(id)
    out.push({ rule_id: f.rule_id, target_id: id, message: f.message, ...(hint ? { fix_hint: hint } : {}) })
  }
  return out
}

/** Cờ đích còn mở trên Spine sau lô (chạy luật tất định, cổng step mở — chỉ so luật + phần tử). */
export const unresolvedAfter = (targets: readonly TargetFlag[], after: Spine): TargetFlag[] => {
  if (targets.length === 0) return []
  const candidates = runDeterministicCheck(after, [], { atBaseline: true })
  return targets.filter((t) => candidates.some((c) => c.rule_id === t.rule_id && c.target_id !== null && c.target_id !== undefined && bareTargetId(c.target_id) === t.target_id))
}

/** Cờ đích còn mở theo `flags[]` đã tính lại (sau khi ghi). */
export const stillOpenIn = (targets: readonly TargetFlag[], spine: Pick<Spine, "flags">): TargetFlag[] =>
  targets.filter((t) => (spine.flags ?? []).some((f) => isOpen(f) && f.rule_id === t.rule_id && !!f.target_id && bareTargetId(f.target_id) === t.target_id))

/** Câu "problem" cho lượt thử lại khi lô không đóng được cờ đích. */
export const unresolvedProblemText = (t: TargetFlag): string =>
  `The batch does not close the flag the user asked to fix (${t.rule_id} on ${t.target_id}: "${t.message}").${t.fix_hint ? ` ${t.fix_hint}` : ""}`

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
