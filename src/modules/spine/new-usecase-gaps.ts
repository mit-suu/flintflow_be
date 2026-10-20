/**
 * FLF-298: lô sửa thêm use case mới chỉ ghi vào §2.2 — sửa qua chat không tự lan (apply-change-op "No auto-propagation"),
 * nên use case chưa có chức năng thì cũng chưa có màn hình, dòng phân quyền §3.1.3 hay mô tả chức năng. Code báo ngay ở
 * bản xem trước (không gọi model) để author biết còn phải yêu cầu thêm gì trước khi gửi duyệt.
 */

import type { Spine } from "./spine.types.js"
import { byLanguage, type ReplyLanguage } from "../../shared/i18n/reply-language.js"

type Parts = Pick<Spine, "use_cases" | "functions">

export interface NewUseCaseGap {
  use_case_id: string
  name: string
  /** `no_function`: chưa gắn chức năng nào. `no_screen`: có chức năng nhưng không chức năng nào thuộc màn hình. */
  kind: "no_function" | "no_screen"
}

export const newUseCaseGaps = (before: Parts, after: Parts): NewUseCaseGap[] => {
  const existing = new Set(before.use_cases.map((u) => u.id))
  const screenOf = new Map(after.functions.map((f) => [f.id, f.screen_id]))
  return after.use_cases
    .filter((u) => !existing.has(u.id))
    .flatMap((u): NewUseCaseGap[] => {
      if (u.function_ids.length === 0) return [{ use_case_id: u.id, name: u.name, kind: "no_function" }]
      const onScreen = u.function_ids.some((id) => (screenOf.get(id) ?? null) !== null)
      return onScreen ? [] : [{ use_case_id: u.id, name: u.name, kind: "no_screen" }]
    })
}

export const newUseCaseGapNote = (gaps: readonly NewUseCaseGap[], language: ReplyLanguage = "vi"): string | null => {
  if (gaps.length === 0) return null
  return gaps
    .map((g) =>
      g.kind === "no_function"
        ? byLanguage(language, {
            vi: `Use case mới "${g.name}" chưa gắn chức năng nào nên chưa có màn hình, phân quyền màn hình (§3.1.3) hay mô tả chức năng. Hãy yêu cầu thêm màn hình/chức năng cho use case này.`,
            en: `New use case "${g.name}" has no function yet, so it has no screen, screen authorization (§3.1.3) or function description. Ask to add a screen/function for it.`
          })
        : byLanguage(language, {
            vi: `Use case mới "${g.name}" chưa có màn hình nào trong luồng màn hình (§3.1.1). Hãy yêu cầu thêm màn hình nếu use case cần giao diện.`,
            en: `New use case "${g.name}" has no screen in the screens flow (§3.1.1). Ask to add one if it needs a UI.`
          })
    )
    .join("\n")
}
