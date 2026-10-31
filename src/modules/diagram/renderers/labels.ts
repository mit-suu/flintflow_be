/**
 * Chữ máy vẽ lên sơ đồ, theo ngôn ngữ tài liệu (FLF-265 N1).
 *
 * Mặc định tiếng Anh — đúng các chuỗi renderer in trước N1, nên hình vẽ vào Spine (`diagram.service`) không đổi byte
 * nào. Bản tiếng Việt chỉ dùng khi vẽ lại từ bản xem Spine đã dịch (`render/localized-diagrams.ts`), không bao giờ ghi
 * vào `diagrams[]`. Ký pháp UML (`<<include>>`, `<<extend>>`, `<<system>>`, `<<time>>`) giữ nguyên ở mọi ngôn ngữ.
 * Nhãn của tài liệu (bảng, heading, chú thích ảnh) ở `render/labels.ts`.
 */

import type { UserLocale } from "../../../shared/i18n/locale.js"
import type { ActorKind } from "../../spine/spine.types.js"

export interface DiagramLabels {
  /** Tên hệ thống khi project chưa có `system_name` lẫn `name`. */
  system: string
  /** Nhãn dự phòng của mũi tên sơ đồ ngữ cảnh khi actor chưa có luồng: chiều vào hệ thống, theo `kind`. */
  defaultIn: Readonly<Record<ActorKind, string>>
  /** Như `defaultIn`, chiều từ hệ thống ra actor. */
  defaultOut: Readonly<Record<ActorKind, string>>
  /** Tiêu đề một hình use case — `groups` là tên feature (hoặc actor chính khi chưa có feature) kèm `(i/n)` khi nhóm tách nhiều hình. */
  useCasesTitle: (groups: string) => string
  /** Tiêu đề hình phân cấp actor (generalization) ở §2.1. */
  actorHierarchyTitle: string
  /** Nhóm use case không có actor nào. */
  otherGroup: string
  /** Tiêu đề hình luồng màn của một feature (kèm `(i/n)` khi tách) — `<title>` của SVG, `section-renderer` dùng làm chú thích ảnh. */
  screensFlowTitle: (feature: string) => string
  /** Chữ trong stereotype `<<…>>` của màn pop-up. */
  popup: string
  /** Guard của nhánh còn lại ở decision node (in `[else]`). */
  elseGuard: string
  noEntities: string
  /** Tiêu đề hình ERD (kèm `(i/n)` khi tách) — `<title>` của SVG, `section-renderer` dùng làm chú thích ảnh. */
  erdTitle: string
  /** Động từ trong hình thoi ERD khi quan hệ chưa có `relation_verbs`. */
  relationVerb: string
  /** Tiêu đề hình class diagram (domain) của một feature (kèm `(i/n)` khi tách) — `<title>` của SVG, chú thích ảnh. */
  classTitle: (feature: string) => string
  /** Tiêu đề hình state machine (vòng đời) của một entity — `<title>` của SVG, chú thích ảnh. */
  stateMachineTitle: (entity: string) => string
  /** Bảng function — hình bố cục màn khi chưa có wireframe. */
  functionColumn: string
  descriptionColumn: string
  noFunctions: string
}

export const DIAGRAM_LABELS: Readonly<Record<UserLocale, DiagramLabels>> = {
  en: {
    system: "System",
    defaultIn: { human: "User Input", system: "Service Response", time: "Scheduled Trigger" },
    defaultOut: { human: "Processing Result", system: "Service Request", time: "Job Status" },
    useCasesTitle: (groups) => `Use Cases — ${groups}`,
    actorHierarchyTitle: "Actor Hierarchy",
    otherGroup: "Other",
    screensFlowTitle: (feature) => `Screens flow — ${feature}`,
    popup: "pop-up",
    elseGuard: "else",
    noEntities: "No entities yet",
    erdTitle: "Entity Relationship Diagram",
    relationVerb: "has",
    classTitle: (feature) => `Class Diagram — ${feature}`,
    stateMachineTitle: (entity) => `State Machine Diagram — ${entity}`,
    functionColumn: "Function",
    descriptionColumn: "Description",
    noFunctions: "No functions yet"
  },
  vi: {
    system: "Hệ thống",
    defaultIn: { human: "dữ liệu người dùng nhập", system: "phản hồi dịch vụ", time: "kích hoạt theo lịch" },
    defaultOut: { human: "kết quả xử lý", system: "yêu cầu dịch vụ", time: "trạng thái tác vụ" },
    useCasesTitle: (groups) => `Sơ đồ use case — ${groups}`,
    actorHierarchyTitle: "Phân cấp tác nhân",
    otherGroup: "Khác",
    screensFlowTitle: (feature) => `Luồng màn hình — ${feature}`,
    popup: "pop-up",
    elseGuard: "ngược lại",
    noEntities: "Chưa có thực thể",
    erdTitle: "Sơ đồ quan hệ thực thể",
    relationVerb: "có",
    classTitle: (feature) => `Sơ đồ lớp — ${feature}`,
    stateMachineTitle: (entity) => `Sơ đồ trạng thái — ${entity}`,
    functionColumn: "Chức năng",
    descriptionColumn: "Mô tả",
    noFunctions: "Chưa có chức năng"
  }
}

/** Nhãn theo ngôn ngữ tài liệu (`vi`, `vi-VN`…); thiếu / lạ ⇒ tiếng Anh. */
export const diagramLabelsFor = (language?: string): DiagramLabels =>
  language?.toLowerCase().startsWith("vi") ? DIAGRAM_LABELS.vi : DIAGRAM_LABELS.en
