/**
 * Mức vẽ Sequence Diagram của một dự án (FLF-418), theo cùng cách làm với ký pháp ERD (`erd-notation.ts`):
 * lựa chọn nằm ở `Project.sequenceLevel`, KHÔNG nằm trong Spine; renderer nhận qua `RenderContext`, hash sơ đồ
 * `sequence` gồm mức để đổi mức ⇒ `diagram_stale` ⇒ vẽ lại.
 *
 * - `system`: hộp đen, actor ↔ `:System` (System Sequence Diagram, `functions[].interactions`).
 * - `component`: actor → boundary (màn) → control → entity theo ký pháp Visual Paradigm (`functions[].component_interactions`).
 *
 * Field thiếu = người dùng chưa chọn (S-5.4 lần đầu sẽ hỏi trong khung chat); khi vẽ thì đọc là `system`.
 */

export const SEQUENCE_LEVELS = ["system", "component"] as const
export type SequenceLevel = (typeof SEQUENCE_LEVELS)[number]

/** Dùng khi vẽ lúc dự án chưa chọn. */
export const DEFAULT_SEQUENCE_LEVEL: SequenceLevel = "system"

export const toSequenceLevel = (value: unknown): SequenceLevel | null =>
  typeof value === "string" && (SEQUENCE_LEVELS as readonly string[]).includes(value) ? (value as SequenceLevel) : null

/** Mức hiệu lực khi vẽ — field thiếu / lạ ⇒ `system`. */
export const sequenceLevelOf = (project: { sequenceLevel?: unknown } | null | undefined): SequenceLevel =>
  toSequenceLevel(project?.sequenceLevel) ?? DEFAULT_SEQUENCE_LEVEL

/** Người dùng đã chọn mức chưa (chat, cài đặt dự án). Chưa ⇒ S-5.4 lần đầu hỏi. */
export const sequenceLevelChosen = (project: { sequenceLevel?: unknown } | null | undefined): boolean =>
  toSequenceLevel(project?.sequenceLevel) !== null
