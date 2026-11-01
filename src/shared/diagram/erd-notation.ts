/**
 * Ký pháp ERD của một dự án (§3.1.5). Mỗi tài liệu dùng đúng một ký pháp; lựa chọn nằm ở `Project.erdNotation`, KHÔNG
 * nằm trong Spine — renderer là hàm thuần của Spine nên nhận ký pháp qua `RenderContext`, và hash sơ đồ (`erd`) gồm
 * ký pháp để đổi ký pháp ⇒ `diagram_stale` ⇒ vẽ lại.
 */

export const ERD_NOTATIONS = ["chen", "crowsfoot", "idef1x"] as const
export type ErdNotation = (typeof ERD_NOTATIONS)[number]

/** Dự án cũ chưa có field. */
export const DEFAULT_ERD_NOTATION: ErdNotation = "chen"

/** Dữ liệu ngoài Spine mà renderer / hash sơ đồ cần thêm. Thiếu field ⇒ mặc định. */
export interface RenderContext {
  erdNotation?: ErdNotation
}

export const toErdNotation = (value: unknown): ErdNotation | null =>
  typeof value === "string" && (ERD_NOTATIONS as readonly string[]).includes(value) ? (value as ErdNotation) : null

/** Ký pháp hiệu lực của dự án — field thiếu / lạ ⇒ `chen`. */
export const erdNotationOf = (project: { erdNotation?: unknown } | null | undefined): ErdNotation =>
  toErdNotation(project?.erdNotation) ?? DEFAULT_ERD_NOTATION
