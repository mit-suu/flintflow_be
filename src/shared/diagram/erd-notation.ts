/**
 * Ký pháp ERD của một dự án (§3.1.5). Mỗi tài liệu dùng đúng một ký pháp; lựa chọn nằm ở `Project.erdNotation`, KHÔNG
 * nằm trong Spine — renderer là hàm thuần của Spine nên nhận ký pháp qua `RenderContext`, và hash sơ đồ (`erd`) gồm
 * ký pháp để đổi ký pháp ⇒ `diagram_stale` ⇒ vẽ lại.
 */

import type { ScreenMockupState, ScreenTheme } from "./screen-theme.js"
import type { SequenceLevel } from "./sequence-level.js"

export const ERD_NOTATIONS = ["chen", "crowsfoot", "idef1x"] as const
export type ErdNotation = (typeof ERD_NOTATIONS)[number]

/** Dùng khi vẽ lúc dự án chưa chọn (FLF-418: field thiếu = chưa chọn, S-4.5 hỏi trong khung chat). */
export const DEFAULT_ERD_NOTATION: ErdNotation = "chen"

/** Dữ liệu ngoài Spine mà renderer / hash sơ đồ cần thêm. Thiếu field ⇒ mặc định. */
export interface RenderContext {
  erdNotation?: ErdNotation
  /** Mức Sequence Diagram (FLF-418) — thiếu ⇒ `system`. */
  sequenceLevel?: SequenceLevel
  /** Theme mockup màn (FLF-410) — thiếu ⇒ `DEFAULT_SCREEN_THEME`. */
  screenTheme?: ScreenTheme
  /** Màn import đã chọn vẽ lại ảnh gốc bằng mockup (FLF-410) — thiếu ⇒ không màn nào. */
  screenMockups?: ScreenMockupState[]
}

export const toErdNotation = (value: unknown): ErdNotation | null =>
  typeof value === "string" && (ERD_NOTATIONS as readonly string[]).includes(value) ? (value as ErdNotation) : null

/** Ký pháp hiệu lực của dự án — field thiếu / lạ ⇒ `chen`. */
export const erdNotationOf = (project: { erdNotation?: unknown } | null | undefined): ErdNotation =>
  toErdNotation(project?.erdNotation) ?? DEFAULT_ERD_NOTATION

/** Người dùng đã chọn ký pháp chưa (chat, cài đặt dự án, hoặc import đọc được từ file). Chưa ⇒ S-4.5 hỏi. */
export const erdNotationChosen = (project: { erdNotation?: unknown } | null | undefined): boolean =>
  toErdNotation(project?.erdNotation) !== null
