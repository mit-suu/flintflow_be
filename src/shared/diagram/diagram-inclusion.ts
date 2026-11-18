/**
 * FLF-441 — dự án có cần Class Diagram / Sequence Diagram không. Lựa chọn nằm ở Project (`classDiagram` / `sequenceDiagram`,
 * boolean, ngoài Spine) như ký pháp ERD; renderer nhận qua `RenderContext`. Field thiếu = chưa hỏi ⇒ vẫn vẽ (như trước).
 * `false` ⇒ không vẽ loại đó (hình đã có bị gỡ ở lượt vẽ kế tiếp) và không in vào tài liệu.
 */

export type OptionalDiagramKind = "class" | "sequence"

export interface DiagramInclusionState {
  classDiagram?: unknown
  sequenceDiagram?: unknown
}

const FIELD: Readonly<Record<OptionalDiagramKind, keyof DiagramInclusionState>> = Object.freeze({ class: "classDiagram", sequence: "sequenceDiagram" })

export const inclusionField = (kind: OptionalDiagramKind): keyof DiagramInclusionState => FIELD[kind]

/** Có vẽ loại này không — chỉ `false` mới bỏ. */
export const diagramIncluded = (project: DiagramInclusionState | null | undefined, kind: OptionalDiagramKind): boolean =>
  project?.[FIELD[kind]] !== false

/** Người dùng đã trả lời chưa (chat hoặc cài đặt dự án). */
export const diagramInclusionChosen = (project: DiagramInclusionState | null | undefined, kind: OptionalDiagramKind): boolean =>
  typeof project?.[FIELD[kind]] === "boolean"

/**
 * FLF-441: State Machine Diagram chỉ thuộc mẫu IEEE 29148 — mẫu FPT (mặc định khi tạo SRS mới, không tải mẫu) không có.
 * Họ mẫu đọc từ hồ sơ mẫu của dự án (`TemplateProfile.template_family`); thiếu ⇒ FPT.
 */
export const IEEE_TEMPLATE_FAMILIES: readonly string[] = ["ieee29148", "mixed"]

export const stateMachineAllowed = (templateFamily: string | null | undefined): boolean =>
  typeof templateFamily === "string" && IEEE_TEMPLATE_FAMILIES.includes(templateFamily)

/** Loại sơ đồ bị dự án tắt — `renderDiagrams` không vẽ (và gỡ hình cũ). */
export const excludedDiagramKind = (context: { classDiagram?: boolean; sequenceDiagram?: boolean; stateMachine?: boolean }, kind: string): boolean =>
  (kind === "class" && context.classDiagram === false) ||
  (kind === "sequence" && context.sequenceDiagram === false) ||
  (kind === "state_machine" && context.stateMachine === false)
