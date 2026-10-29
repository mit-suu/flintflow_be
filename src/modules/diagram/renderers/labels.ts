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
  /** Tiêu đề một phần sơ đồ use case khi phải tách nhiều hình — `groups` là tên actor chính của phần. */
  useCasesTitle: (groups: string) => string
  /** Nhóm use case không có actor nào. */
  otherGroup: string
  /** Tiêu đề sơ đồ luồng màn của một actor — `section-renderer` dùng lại làm chú thích ảnh. */
  screensFlowTitle: (actorName: string) => string
  /** Dòng phụ dưới tên màn pop-up có tab. */
  popup: string
  noScreens: string
  noEntities: string
  /** Động từ trong hình thoi ERD khi quan hệ chưa có `relation_verbs`. */
  relationVerb: string
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
    otherGroup: "Other",
    screensFlowTitle: (actorName) => `Screens flow for ${actorName}`,
    popup: "(pop-up)",
    noScreens: "No screens yet",
    noEntities: "No entities yet",
    relationVerb: "has",
    functionColumn: "Function",
    descriptionColumn: "Description",
    noFunctions: "No functions yet"
  },
  vi: {
    system: "Hệ thống",
    defaultIn: { human: "dữ liệu người dùng nhập", system: "phản hồi dịch vụ", time: "kích hoạt theo lịch" },
    defaultOut: { human: "kết quả xử lý", system: "yêu cầu dịch vụ", time: "trạng thái tác vụ" },
    useCasesTitle: (groups) => `Sơ đồ use case — ${groups}`,
    otherGroup: "Khác",
    screensFlowTitle: (actorName) => `Luồng màn hình của ${actorName}`,
    popup: "(pop-up)",
    noScreens: "Chưa có màn hình",
    noEntities: "Chưa có thực thể",
    relationVerb: "có",
    functionColumn: "Chức năng",
    descriptionColumn: "Mô tả",
    noFunctions: "Chưa có chức năng"
  }
}

/** Nhãn theo ngôn ngữ tài liệu (`vi`, `vi-VN`…); thiếu / lạ ⇒ tiếng Anh. */
export const diagramLabelsFor = (language?: string): DiagramLabels =>
  language?.toLowerCase().startsWith("vi") ? DIAGRAM_LABELS.vi : DIAGRAM_LABELS.en
