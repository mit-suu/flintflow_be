/**
 * section-renderer.ts
 * ─────────────────────────────────────────────────────────────────
 * S-8.2 Document Assembly: dựng nội dung MỘT section (bảng §4 srs-spine.md,
 * Product-Brief-to-SRS-Phases.md §6.3) thành `RenderedSection` (hợp đồng đóng băng
 * `rendered-document.types.ts`). Hàm ở đây thuần (không đọc DB, không async): số hiệu,
 * trạng thái (T09) và ảnh PNG (base64, đã tải sẵn từ diagram file store T10) do
 * `assemble.service.ts` tính/tải trước rồi truyền vào qua `SectionRenderContext` — nhờ vậy
 * test không cần GridFS/Mongo, chỉ cần tiêm một `Map` hoặc hàm giả.
 *
 * `fixed:I` (Record of Changes) KHÔNG đi qua `renderSection`: hợp đồng `RenderedDocument`
 * có field riêng `recordOfChanges: RocRow[]` (không phải `Block[]`) và `docx-writer.ts` render
 * nó từ field đó, không từ `sections[]`. `buildRecordOfChanges` ở cuối file dựng field đó
 * từ `changes[]`, gộp theo `txn` (S-8.3).
 */

import { FIXED_SECTIONS } from "../spine/section-registry.js"
import { screenFlowTitleOf } from "../diagram/renderers/screen-flow.renderer.js"
import { describeInterface } from "./interface-description.js"
import type { Change, DiagramKind, Nfr, NfrCategory, Spine } from "../spine/spine.types.js"

/**
 * T15 review T5: `fixed:I` không cần `before`/`value` (chỉ mô tả A/M/D + ngày/người/lý do) — caller
 * (`assemble.service.ts`) đọc `Change` model trực tiếp với projection nhẹ này thay vì
 * `spine.repository.listChanges` (tải cả `before`/`value`, nặng không cần thiết cho §I).
 */
export type ChangeRecordRow = Pick<Change, "txn" | "at" | "by" | "reason" | "op" | "step_id"> & { path?: string }
import type {
  Block,
  BulletListBlock,
  HeadingBlock,
  InlineRun,
  ImageBlock,
  NumberedListBlock,
  ParagraphBlock,
  RenderedSection,
  RenderedSectionStatus,
  RocChangeType,
  RocRow,
  TableBlock,
  TableCell
} from "./rendered-document.types.js"

const FIXED_TITLES = new Map(FIXED_SECTIONS.map((s) => [s.id, s.title_en]))
const FIXED_LEVELS = new Map(FIXED_SECTIONS.map((s) => [s.id, s.level]))

// ─── block builders ──────────────────────────────────────────────

const p = (text: string): ParagraphBlock => ({ type: "paragraph", runs: [{ text }] })
const labeled = (label: string, text: string): ParagraphBlock => ({
  type: "paragraph",
  runs: [{ text: `${label}: `, bold: true }, { text }]
})
const heading = (text: string, level: number): HeadingBlock => ({ type: "heading", level, text })
const bulletList = (items: string[]): BulletListBlock => ({ type: "bullet_list", items: items.map((text) => [{ text }]) })
const numberedList = (items: string[]): NumberedListBlock => ({ type: "numbered_list", items: items.map((text) => [{ text }]) })
const cell = (text: string): TableCell => [{ text }]
const tableBlock = (header: string[], rows: string[][]): TableBlock => ({
  type: "table",
  header: header.map(cell),
  rows: rows.map((row) => row.map(cell))
})
const image = (png: string, caption: string): ImageBlock => ({ type: "image", png, caption })

// ─── nhãn cố định theo ngôn ngữ tài liệu (mode 1 v2 — FLF-184) ───

/**
 * Tiêu đề cột bảng, heading con, chú thích hình mà renderer tự sinh. Mặc định tiếng Anh (mode 2); tài liệu import
 * tiếng Việt (`TemplateProfile.language = "vi"`) dùng bản dịch dưới — nội dung Spine giữ nguyên, chỉ đổi nhãn.
 */
const VI_LABELS: Readonly<Record<string, string>> = {
  ID: "Mã",
  Name: "Tên",
  Kind: "Loại",
  Description: "Mô tả",
  Actors: "Tác nhân",
  Screen: "Màn hình",
  Type: "Kiểu",
  Feature: "Chức năng",
  Trigger: "Kích hoạt",
  Entity: "Thực thể",
  Relations: "Quan hệ",
  Statement: "Yêu cầu",
  Metric: "Chỉ số",
  Threshold: "Ngưỡng",
  Priority: "Ưu tiên",
  Category: "Nhóm",
  Code: "Mã",
  Text: "Nội dung",
  Functions: "Chức năng",
  Term: "Thuật ngữ",
  Native: "Tiếng Việt",
  Definition: "Định nghĩa",
  Goals: "Mục tiêu",
  "Release 1.0 Scope": "Phạm vi phát hành 1.0",
  "In Scope": "Trong phạm vi",
  "Out of Scope": "Ngoài phạm vi",
  "High-Level Business Rules": "Quy tắc nghiệp vụ tổng quát",
  "External Systems": "Hệ thống bên ngoài",
  "Normal Flow": "Luồng chính",
  "Abnormal Flow": "Luồng ngoại lệ",
  Validations: "Kiểm tra dữ liệu",
  "Business Rules": "Quy tắc nghiệp vụ",
  Screens: "Màn hình",
  "Figure — System Context Diagram": "Hình — Sơ đồ ngữ cảnh hệ thống",
  "Use Case Diagram": "Sơ đồ use case",
  "Screens Flow Diagram": "Sơ đồ luồng màn hình",
  "Screens flow for": "Luồng màn hình của",
  "Entity Relationship Diagram": "Sơ đồ quan hệ thực thể",
  "Screen Layout": "Bố cục màn hình"
}

/** Tiêu đề section FPT tiếng Việt — dùng khi assemble chèn mục FPT mà file người dùng không có. */
const VI_SECTION_TITLES: Readonly<Record<string, string>> = {
  "fixed:1": "Tổng quan sản phẩm",
  "fixed:2.1": "Tác nhân",
  "fixed:2.2.1": "Sơ đồ use case",
  "fixed:2.2.2": "Đặc tả use case",
  "fixed:3.1.1": "Luồng màn hình",
  "fixed:3.1.2": "Mô tả màn hình",
  "fixed:3.1.3": "Phân quyền màn hình",
  "fixed:3.1.4": "Chức năng không có màn hình",
  "fixed:3.1.5": "Sơ đồ quan hệ thực thể",
  "fixed:4.1": "Giao tiếp hệ thống ngoài",
  "fixed:4.2.1": "Tính khả dụng",
  "fixed:4.2.2": "Độ tin cậy",
  "fixed:4.2.3": "Hiệu năng",
  "fixed:4.2.4": "Thuộc tính đặc thù",
  "fixed:5.1": "Quy tắc nghiệp vụ",
  "fixed:5.2": "Yêu cầu chung",
  "fixed:5.3": "Danh sách thông báo",
  "fixed:5.4": "Yêu cầu khác",
  "fixed:5.5": "Thuật ngữ"
}

const isVietnamese = (language: string | undefined): boolean => !!language && language.toLowerCase().startsWith("vi")

/** Nhãn cố định theo ngôn ngữ — thiếu bản dịch ⇒ giữ tiếng Anh. */
export const labelFor = (language: string | undefined, text: string): string => (isVietnamese(language) ? (VI_LABELS[text] ?? text) : text)

/** Tiêu đề mặc định của section FPT theo ngôn ngữ (feature/function: tên phần tử). */
export const defaultSectionTitle = (spine: Spine, sectionId: string, language?: string): string =>
  (isVietnamese(language) ? VI_SECTION_TITLES[sectionId] : undefined) ?? headingAndLevel(spine, sectionId).heading

/** Chú thích hình: dịch phần đầu (`Use Case Diagram (1/2)`, `Screen Layout — Login`), giữ phần sau. */
const localizeCaption = (language: string | undefined, caption: string): string => {
  const prefix = Object.keys(VI_LABELS).find((k) => caption === k || caption.startsWith(`${k} `))
  return prefix ? `${labelFor(language, prefix)}${caption.slice(prefix.length)}` : caption
}

/**
 * Dịch nhãn do renderer tự sinh trong khối đã dựng: tiêu đề cột, heading con, nhãn in đậm `Trigger: `, chú thích hình.
 * Làm sau khi dựng để các hàm dựng nội dung giữ nguyên (mode 2 không đổi) — ô dữ liệu Spine không bị đụng.
 */
const localizeBlocks = (blocks: Block[], language: string | undefined): Block[] => {
  if (!isVietnamese(language)) return blocks
  const run = (r: InlineRun): InlineRun => ({ ...r, text: labelFor(language, r.text) })
  return blocks.map((b): Block => {
    switch (b.type) {
      case "heading":
        return { ...b, text: labelFor(language, b.text) }
      case "table":
        return { ...b, header: b.header.map((c) => c.map(run)) }
      case "image":
        return b.caption === undefined ? b : { ...b, caption: localizeCaption(language, b.caption) }
      case "paragraph": {
        const [first, ...rest] = b.runs
        const label = first?.bold ? /^(.+): $/.exec(first.text) : null
        if (label) return { ...b, runs: [{ ...first, text: `${labelFor(language, label[1])}: ` }, ...rest] }
        const screens = !first?.bold && first ? /^Screens: /.exec(first.text) : null
        return screens ? { ...b, runs: [{ ...first, text: `${labelFor(language, "Screens")}: ${first.text.slice(screens[0].length)}` }, ...rest] } : b
      }
      default:
        return b
    }
  })
}

// ─── context tiêm từ assemble.service ────────────────────────────

export interface SectionRenderContext {
  /** Số hiệu hiển thị của chính section này, đã tính lúc assemble (§6.3). */
  number: string
  status?: RenderedSectionStatus
  awaiting_reaccept?: boolean
  /**
   * Ô `png` cho diagram id — assemble thật tiêm tham chiếu `diagram-ref:<id>` (phân giải thành PNG thật hoặc
   * placeholder lúc trả về, xem `assemble.service.ts`); test có thể tiêm thẳng base64. `undefined` ⇒ bỏ ảnh.
   */
  diagramPng: (diagramId: string) => string | undefined
  /** Số hiệu của section khác (khoá logic → số hiển thị) — dùng khi cần trỏ chéo, cấm số cứng. */
  numberOf: (logicalSectionId: string) => string | undefined
  /** Ngôn ngữ nhãn cố định (`TemplateProfile.language` của tài liệu import); không có ⇒ tiếng Anh. */
  language?: string
  /**
   * Khung mục §3.x.y. `"fpt"` (chỉ tài liệu theo mẫu FPT — `assemble.service#buildSections`): Function trigger ·
   * Function description · Screen layout · Function details. Không đặt (mode 1 import theo layout file người dùng)
   * ⇒ khung cũ Trigger · Description · Normal/Abnormal Flow · Validations · Business Rules.
   */
  functionLayout?: "fpt"
}

// ─── heading/level của section ────────────────────────────────────

const headingAndLevel = (spine: Spine, sectionId: string): { heading: string; level: number } => {
  if (sectionId.startsWith("feature:")) {
    const feature = spine.features.find((f) => f.id === sectionId.slice("feature:".length))
    return { heading: feature?.name ?? sectionId, level: 2 }
  }
  if (sectionId.startsWith("function:")) {
    const fn = spine.functions.find((f) => f.id === sectionId.slice("function:".length))
    return { heading: fn?.name ?? sectionId, level: 3 }
  }
  const title = FIXED_TITLES.get(sectionId)
  const level = FIXED_LEVELS.get(sectionId)
  if (title === undefined || level === undefined) throw new Error(`section-renderer: unknown section id "${sectionId}"`)
  return { heading: title, level }
}

/** Tiêu đề của một section — dùng ở `assemble.service.ts` để dán nhãn cờ (`FlagRow.section`). */
export function sectionHeadingOf(spine: Spine, sectionId: string): string {
  return headingAndLevel(spine, sectionId).heading
}

// ─── ảnh diagram ─────────────────────────────────────────────────

const diagramImages = (
  spine: Spine,
  kind: DiagramKind,
  ownerId: string | undefined,
  ctx: SectionRenderContext,
  captionBase: string,
  /** Chú thích riêng từng hình (vd. tiêu đề sơ đồ theo actor); `null` ⇒ dùng `captionBase`. */
  captionOf: (d: Spine["diagrams"][number]) => string | null = () => null
): ImageBlock[] => {
  const parts = spine.diagrams.filter(
    (d) => d.kind === kind && d.render_status === "ok" && (ownerId === undefined || d.owner_id === ownerId)
  )
  const out: ImageBlock[] = []
  parts.forEach((d, i) => {
    const png = ctx.diagramPng(d.id)
    if (png) out.push(image(png, captionOf(d) ?? (parts.length > 1 ? `${captionBase} (${i + 1}/${parts.length})` : captionBase)))
  })
  return out
}

// ─── fixed:1 Product Overview ─────────────────────────────────────

const productOverview = (spine: Spine, ctx: SectionRenderContext): Block[] => {
  const { project } = spine
  const blocks: Block[] = []
  if (project.vision) blocks.push(p(project.vision))
  if (project.goals.length > 0) blocks.push(heading("Goals", 2), bulletList(project.goals))
  if (project.release_scope.in.length > 0 || project.release_scope.out.length > 0) {
    blocks.push(heading("Release 1.0 Scope", 2))
    if (project.release_scope.in.length > 0) blocks.push(heading("In Scope", 3), bulletList(project.release_scope.in))
    if (project.release_scope.out.length > 0) blocks.push(heading("Out of Scope", 3), bulletList(project.release_scope.out))
  }
  const highRules = spine.business_rules.filter((r) => r.tier === "high")
  if (highRules.length > 0) blocks.push(heading("High-Level Business Rules", 2), bulletList(highRules.map((r) => r.statement)))
  const nonHuman = spine.actors.filter((a) => a.kind !== "human")
  if (nonHuman.length > 0) {
    blocks.push(heading("External Systems", 2), bulletList(nonHuman.map((a) => `${a.name} (${a.kind}) — ${a.description}`)))
  }
  blocks.push(...diagramImages(spine, "context", undefined, ctx, "Figure — System Context Diagram"))
  return blocks
}

// ─── §2 User Requirements ──────────────────────────────────────────

const actorsTable = (spine: Spine): Block[] =>
  spine.actors.length === 0
    ? []
    : [tableBlock(["ID", "Name", "Kind", "Description"], spine.actors.map((a) => [a.id, a.name, a.kind, a.description]))]

const useCaseDiagram = (spine: Spine, ctx: SectionRenderContext): Block[] =>
  diagramImages(spine, "usecase", undefined, ctx, "Use Case Diagram")

const useCaseTable = (spine: Spine): Block[] => {
  if (spine.use_cases.length === 0) return []
  // Id không phân giải được thì in id: bảng không ném lỗi khi Spine có id chết, đó là việc của
  // cờ đỏ `dead_reference`.
  const nameOf = (list: readonly { id: string; name: string }[]) => (id: string) => list.find((x) => x.id === id)?.name ?? id
  const actorName = nameOf(spine.actors)
  const useCaseName = nameOf(spine.use_cases)
  // Bốn cột đầu lấy nguyên văn mẫu FPT §2.2.2; Includes/Extends là phần mở rộng.
  return [
    tableBlock(
      ["ID", "Use Case", "Actors", "Use Case Description", "Includes", "Extends"],
      spine.use_cases.map((uc) => [
        uc.id,
        uc.name,
        uc.actor_ids.map(actorName).join(", "),
        uc.description,
        uc.includes.map(useCaseName).join(", "),
        uc.extends.map(useCaseName).join(", ")
      ])
    )
  ]
}

// ─── §3.1 System Functional Overview (section cố định) ────────────

// Chỉ còn sơ đồ luồng màn — bảng Screen | Type | Flows To đã bỏ khỏi cả bản draft lẫn baseline
/** Sơ đồ tách theo actor mang tiêu đề `Screens flow for <actor>` — dùng luôn làm chú thích ảnh. */
const flowTitle = (d: Spine["diagrams"][number]): string | null => screenFlowTitleOf(d.puml)

const screensFlow = (spine: Spine, ctx: SectionRenderContext): Block[] =>
  diagramImages(spine, "screen_flow", undefined, ctx, "Screens Flow Diagram", flowTitle)

const screenDescriptions = (spine: Spine, ctx: SectionRenderContext): Block[] => {
  if (spine.screens.length === 0) return []
  return [
    tableBlock(
      ["Feature", "Screen", "Description"],
      spine.screens.map((s) => {
        const feature = spine.features.find((f) => f.id === s.feature_id)
        const number = ctx.numberOf(`feature:${s.feature_id}`)
        const featureLabel = feature ? (number ? `${number} ${feature.name}` : feature.name) : s.feature_id
        return [featureLabel, s.name, s.description]
      })
    )
  ]
}

/**
 * T15 review T9: ma trận màn × vai trò — cột = mỗi role, hàng = mỗi screen, ô = action của
 * (screen, role) gộp lại ("—" khi không có quyền nào). Trước đây mỗi permission một dòng
 * (Screen | Role | Action) — không phải "ma trận" như Phases §6.3 yêu cầu.
 */
const screenAuthorization = (spine: Spine): Block[] => {
  if (spine.permissions.length === 0) return []
  const actionsOf = (screenId: string, roleId: string): string =>
    spine.permissions
      .filter((p) => p.screen_id === screenId && p.role_id === roleId)
      .map((p) => p.action)
      .join(", ") || "—"
  return [
    tableBlock(
      ["Screen", ...spine.roles.map((r) => r.name)],
      spine.screens.map((s) => [s.name, ...spine.roles.map((r) => actionsOf(s.id, r.id))])
    )
  ]
}

const nonScreenFunctions = (spine: Spine): Block[] => {
  const fns = spine.functions.filter((f) => f.screen_id === null)
  if (fns.length === 0) return []
  return [tableBlock(["Name", "Trigger", "Description"], fns.map((f) => [f.name, f.trigger, f.description]))]
}

const erd = (spine: Spine, ctx: SectionRenderContext): Block[] => {
  const blocks: Block[] = diagramImages(spine, "erd", undefined, ctx, "Entity Relationship Diagram")
  if (spine.entities.length > 0) {
    const entityName = (id: string) => spine.entities.find((e) => e.id === id)?.name ?? id
    blocks.push(tableBlock(["Entity", "Description", "Relations"], spine.entities.map((e) => [e.name, e.description, e.relations.map(entityName).join(", ")])))
  }
  return blocks
}

// ─── feature / function (§3.x, §3.x.y) ────────────────────────────

/** §3.x: mẫu FPT chỉ có tiêu đề (nội dung nằm ở các §3.x.y); mode 1 giữ dòng liệt kê màn như cũ. */
const featureOverview = (spine: Spine, featureId: string, ctx: SectionRenderContext): Block[] => {
  if (ctx.functionLayout === "fpt") return []
  const screens = spine.screens.filter((s) => s.feature_id === featureId)
  return screens.length === 0 ? [] : [p(`Screens: ${screens.map((s) => s.name).join(", ")}`)]
}

/** Mục con trống của §3.x.y mẫu FPT: giữ đủ khung mục như template, không bịa nội dung. */
const NA = "N/A"

const unique = (items: string[]): string[] => [...new Set(items.filter((x) => x.trim().length > 0))]

/**
 * Đường vào màn của function theo Screens Flow: BFS theo `flow_to` từ màn vào (không pop-up, không có cạnh tới;
 * không có thì màn `queue_order` thấp nhất) — `Login > Project Dashboard > Project Workspace`. Không tới được ⇒ tên màn.
 */
const navigationPath = (spine: Spine, screenId: string): string => {
  const byId = new Map(spine.screens.map((s) => [s.id, s]))
  const target = byId.get(screenId)
  if (!target) return NA
  const targeted = new Set(spine.screens.flatMap((s) => s.flow_to.filter((t) => t !== s.id)))
  const byOrder = [...spine.screens].sort((a, b) => (a.queue_order ?? Number.MAX_SAFE_INTEGER) - (b.queue_order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
  const entries = byOrder.filter((s) => !s.is_popup && !targeted.has(s.id))
  const starts = entries.length > 0 ? entries : byOrder.slice(0, 1)
  const previous = new Map<string, string | null>(starts.map((s) => [s.id, null]))
  const queue = starts.map((s) => s.id)
  for (let i = 0; i < queue.length && !previous.has(screenId); i++) {
    for (const next of byId.get(queue[i])?.flow_to ?? []) {
      if (previous.has(next) || !byId.has(next)) continue
      previous.set(next, queue[i])
      queue.push(next)
    }
  }
  if (!previous.has(screenId)) return target.name
  const path: string[] = []
  for (let id: string | null = screenId; id !== null; id = previous.get(id) ?? null) path.unshift(byId.get(id)!.name)
  return path.join(" > ")
}

/**
 * Actor tương tác trực tiếp: actor người (`kind: human`) của các use case chứa function. Không use case nào nối tới
 * function ⇒ actor người của các vai trò có quyền trên màn. Actor system/time (cổng thanh toán, LLM, lịch) không tính.
 */
const directActors = (spine: Spine, fn: Spine["functions"][number]): string => {
  const human = (id: string | null) => spine.actors.find((a) => a.id === id && a.kind === "human")?.name ?? ""
  const fromUseCases = unique(spine.use_cases.filter((uc) => uc.function_ids.includes(fn.id)).flatMap((uc) => uc.actor_ids.map(human)))
  if (fromUseCases.length > 0) return fromUseCases.join(", ")
  const fromRoles = unique(
    spine.permissions
      .filter((perm) => fn.screen_id !== null && perm.screen_id === fn.screen_id)
      .map((perm) => human(spine.roles.find((r) => r.id === perm.role_id)?.actor_id ?? null))
  )
  return fromRoles.length > 0 ? fromRoles.join(", ") : NA
}

/** Entity được nhắc tên trong nội dung function (không có liên kết function ↔ entity trong Spine). */
const dataOf = (spine: Spine, fn: Spine["functions"][number]): string => {
  const text = [fn.name, fn.trigger, fn.description, ...fn.normal, ...fn.abnormal, ...fn.validations.map((v) => v.statement)].join(" ").toLowerCase()
  const escape = (name: string) => name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const named = spine.entities.filter((e) => e.name.trim() && new RegExp(`\\b${escape(e.name)}s?\\b`).test(text)).map((e) => e.name)
  return named.length > 0 ? named.join(", ") : NA
}

/**
 * Nhóm mục con dạng danh sách gạch đầu dòng `• Nhãn: giá trị`. Mục nhiều dòng (các bước, nhiều validation) ⇒
 * `• Nhãn:` rồi danh sách đánh số ngay dưới; rỗng ⇒ `N/A`.
 */
type SubItem = { label: string; value: string } | { label: string; steps: string[] }

const subItems = (items: SubItem[]): Block[] => {
  const out: Block[] = []
  let bullets: InlineRun[][] = []
  const flush = () => {
    if (bullets.length > 0) out.push({ type: "bullet_list", items: bullets })
    bullets = []
  }
  for (const item of items) {
    const label: InlineRun = { text: `${item.label}: `, bold: true }
    if ("value" in item) {
      bullets.push([label, { text: item.value.trim() || NA }])
    } else if (item.steps.length === 0) {
      bullets.push([label, { text: NA }])
    } else if (item.steps.length === 1) {
      bullets.push([label, { text: item.steps[0] }])
    } else {
      bullets.push([label])
      flush()
      out.push(numberedList(item.steps))
    }
  }
  flush()
  return out
}

/**
 * §3.x.y theo template FPT: Function trigger (Navigation path, Timing frequency) · Function description
 * (Actors / Roles, Purpose, Interface, Data processing) · Screen layout · Function details (Data, Validation,
 * Business rules, Normal case, Abnormal case). Mọi mục dựng từ dữ liệu có sẵn; thiếu ⇒ `N/A`.
 */
const fptFunctionDetail = (spine: Spine, functionId: string, ctx: SectionRenderContext): Block[] => {
  const fn = spine.functions.find((f) => f.id === functionId)
  if (!fn) return []
  const screen = fn.screen_id ? spine.screens.find((s) => s.id === fn.screen_id) : undefined

  const rules = unique([
    ...fn.validations.filter((v) => v.kind === "business").map((v) => v.statement),
    ...fn.business_rule_ids.map((id) => spine.business_rules.find((r) => r.id === id)?.statement ?? "")
  ])
  const layout =
    screen && screen.primary_function_id === fn.id
      ? diagramImages(spine, "screen_layout", screen.id, ctx, `Screen Layout — ${screen.name}`)
      : []

  return [
    heading("Function trigger", 4),
    ...subItems([
      { label: "Navigation path", value: screen ? navigationPath(spine, screen.id) : NA },
      { label: "Timing frequency", value: fn.trigger }
    ]),
    heading("Function description", 4),
    ...subItems([
      { label: "Actors / Roles", value: directActors(spine, fn) },
      { label: "Purpose", value: fn.description },
      { label: "Interface", value: (screen && describeInterface(spine, screen)) || NA },
      { label: "Data processing", steps: fn.normal.filter((step) => /^(the )?system\b/i.test(step.trim())) }
    ]),
    heading("Screen layout", 4),
    ...(layout.length > 0 ? layout : [p(NA)]),
    heading("Function details", 4),
    ...subItems([
      { label: "Data", value: dataOf(spine, fn) },
      { label: "Validation", steps: fn.validations.filter((v) => v.kind !== "business").map((v) => v.statement) },
      { label: "Business rules", steps: rules },
      { label: "Normal case", steps: fn.normal },
      { label: "Abnormal case", steps: fn.abnormal }
    ])
  ]
}

/** Khung cũ — tài liệu mode 1 (import) giữ nguyên format như trước FLF-214. */
const legacyFunctionDetail = (spine: Spine, functionId: string, ctx: SectionRenderContext): Block[] => {
  const fn = spine.functions.find((f) => f.id === functionId)
  if (!fn) return []
  const blocks: Block[] = []
  if (fn.trigger) blocks.push(labeled("Trigger", fn.trigger))
  if (fn.description) blocks.push(labeled("Description", fn.description))
  if (fn.normal.length > 0) blocks.push(heading("Normal Flow", 4), numberedList(fn.normal))
  if (fn.abnormal.length > 0) blocks.push(heading("Abnormal Flow", 4), numberedList(fn.abnormal))
  if (fn.validations.length > 0) blocks.push(heading("Validations", 4), bulletList(fn.validations.map((v) => `[${v.kind}] ${v.statement}`)))
  const rules = fn.business_rule_ids
    .map((id) => spine.business_rules.find((r) => r.id === id))
    .filter((r): r is Spine["business_rules"][number] => r !== undefined)
  if (rules.length > 0) blocks.push(heading("Business Rules", 4), bulletList(rules.map((r) => r.statement)))

  const owningScreen = fn.screen_id ? spine.screens.find((s) => s.id === fn.screen_id) : undefined
  if (owningScreen && owningScreen.primary_function_id === fn.id) {
    blocks.push(...diagramImages(spine, "screen_layout", owningScreen.id, ctx, `Screen Layout — ${owningScreen.name}`))
  }
  return blocks
}

const functionDetail = (spine: Spine, functionId: string, ctx: SectionRenderContext): Block[] =>
  ctx.functionLayout === "fpt" ? fptFunctionDetail(spine, functionId, ctx) : legacyFunctionDetail(spine, functionId, ctx)

// ─── §4 Non-Functional Requirements ────────────────────────────────

const nfrStatement = (n: Nfr): string => (n.metric && n.threshold ? `${n.statement} (${n.metric}: ${n.threshold})` : n.statement)

const nfrList = (spine: Spine, category: NfrCategory): Block[] => {
  const items = spine.nfrs.filter((n) => n.category === category)
  return items.length === 0 ? [] : [bulletList(items.map(nfrStatement))]
}

const nfrTable = (spine: Spine, category: NfrCategory): Block[] => {
  const items = spine.nfrs.filter((n) => n.category === category)
  if (items.length === 0) return []
  return [tableBlock(["Statement", "Metric", "Threshold", "Priority"], items.map((n) => [n.statement, n.metric ?? "", n.threshold ?? "", n.priority ?? ""]))]
}

// ─── §5 Requirement Appendix ────────────────────────────────────────

const businessRulesDetail = (spine: Spine): Block[] => {
  const items = spine.business_rules.filter((r) => r.tier === "detail")
  return items.length === 0 ? [] : [bulletList(items.map((r) => r.statement))]
}

const commonRequirements = (spine: Spine): Block[] =>
  spine.common_requirements.length === 0 ? [] : [tableBlock(["Category", "Statement"], spine.common_requirements.map((c) => [c.category, c.statement]))]

const messagesList = (spine: Spine): Block[] => {
  if (spine.messages.length === 0) return []
  const fnName = (id: string) => spine.functions.find((f) => f.id === id)?.name ?? id
  return [tableBlock(["Code", "Text", "Functions"], spine.messages.map((m) => [m.code, m.text, m.function_ids.map(fnName).join(", ")]))]
}

const otherRequirements = (spine: Spine): Block[] =>
  spine.other_requirements.length === 0 ? [] : [tableBlock(["Kind", "Statement"], spine.other_requirements.map((o) => [o.kind, o.statement]))]

const glossaryTable = (spine: Spine): Block[] =>
  spine.glossary.length === 0 ? [] : [tableBlock(["Term", "Native", "Definition"], spine.glossary.map((g) => [g.term, g.term_native ?? "", g.definition]))]

// ─── dispatch ────────────────────────────────────────────────────

const blocksFor = (spine: Spine, sectionId: string, ctx: SectionRenderContext): Block[] => {
  switch (sectionId) {
    case "fixed:1":
      return productOverview(spine, ctx)
    case "fixed:2.1":
      return actorsTable(spine)
    case "fixed:2.2.1":
      return useCaseDiagram(spine, ctx)
    case "fixed:2.2.2":
      return useCaseTable(spine)
    case "fixed:3.1.1":
      return screensFlow(spine, ctx)
    case "fixed:3.1.2":
      return screenDescriptions(spine, ctx)
    case "fixed:3.1.3":
      return screenAuthorization(spine)
    case "fixed:3.1.4":
      return nonScreenFunctions(spine)
    case "fixed:3.1.5":
      return erd(spine, ctx)
    case "fixed:4.1":
      return nfrList(spine, "interface")
    case "fixed:4.2.1":
      return nfrTable(spine, "usability")
    case "fixed:4.2.2":
      return nfrTable(spine, "reliability")
    case "fixed:4.2.3":
      return nfrTable(spine, "performance")
    case "fixed:4.2.4":
      return nfrTable(spine, "other")
    case "fixed:5.1":
      return businessRulesDetail(spine)
    case "fixed:5.2":
      return commonRequirements(spine)
    case "fixed:5.3":
      return messagesList(spine)
    case "fixed:5.4":
      return otherRequirements(spine)
    case "fixed:5.5":
      return glossaryTable(spine)
    default:
      if (sectionId.startsWith("feature:")) return featureOverview(spine, sectionId.slice("feature:".length), ctx)
      if (sectionId.startsWith("function:")) return functionDetail(spine, sectionId.slice("function:".length), ctx)
      throw new Error(`section-renderer: unknown section id "${sectionId}"`)
  }
}

/** Dựng một `RenderedSection` — mọi id trừ `fixed:I` (xem đầu file). */
export function renderSection(spine: Spine, sectionId: string, ctx: SectionRenderContext): RenderedSection {
  const { heading: title, level } = headingAndLevel(spine, sectionId)
  const section: RenderedSection = {
    id: sectionId,
    number: ctx.number,
    heading: title,
    level,
    blocks: localizeBlocks(blocksFor(spine, sectionId, ctx), ctx.language)
  }
  if (ctx.status !== undefined) section.status = ctx.status
  if (ctx.awaiting_reaccept !== undefined) section.awaiting_reaccept = ctx.awaiting_reaccept
  return section
}

// ─── fixed:I Record of Changes (S-8.3) ─────────────────────────────

const changeTypeOf = (ops: Set<string>): RocChangeType => {
  if (ops.size === 1 && ops.has("add")) return "A"
  if (ops.size === 1 && ops.has("remove")) return "D"
  return "M"
}

/**
 * §I: gộp `changes[]` theo `txn` — một dòng mỗi transaction (ngày, người ghi, lý do).
 *
 * `version` (T15 review T7): mỗi txn của op-engine tăng `spine_version` đúng 1 (`saveWithVersion`:
 * `newVersion = baseVersion + 1`), và Spine mới bắt đầu ở `spine_version = 1` (`createEmptySpine`).
 * Nên sau txn thứ `k` (1-based theo thứ tự xuất hiện/`seq`), `spine_version = k + 1`. `changes` ở
 * đây có `i` 0-based (thứ tự xuất hiện trong mảng, đã sort theo `seq` từ nguồn) ⇒ `k = i + 1` ⇒
 * `spine_version = i + 2` ⇒ `version: "v0.<i+2>"`. Dòng cuối vì vậy khớp đúng `v0.<spine_version>`
 * của chính `RenderedDocument` được ghép ngay sau txn cuối — kiểm bằng `assemble.service.ts`
 * `version: v0.${record.spine_version}`.
 *
 * `resolveInCharge` (T7): `by` lưu trong `changes[]` là userId thô (hoặc `"system"`) — caller truyền
 * hàm tra `User.name`/email theo lô để hiển thị tên thay vì id; mặc định giữ nguyên `by` (test thuần
 * không cần DB).
 */
/**
 * Lý do do MÁY ghi trong lúc chạy quy trình. §I là lịch sử tài liệu cho người đọc, không phải nhật ký của
 * runner: lượt test xuất ra 425 dòng mà phần lớn là "step-runner: elicit turn" (BUG-15).
 */
const INTERNAL_REASON =
  /^(step-runner:|gate:|resume:|Revert seq|Hoà giải: chờ chấp nhận lại|Phỏng vấn đầu giai đoạn|Chốt |confirmed_at do server đặt|Mở cờ |Waiver |Đóng cờ )/

/** Câu do máy sinh → tiếng Anh; câu do user viết giữ nguyên (đó là lời của chính họ). */
const ENGLISH_DESCRIPTION: readonly { re: RegExp; to: (m: RegExpExecArray) => string }[] = [
  { re: /^Ký baseline (.+)$/, to: (m) => `Baseline ${m[1]} signed` },
  { re: /^Baseline (.+)$/, to: (m) => `Baseline ${m[1]} signed` },
  { re: /^Hoà giải section stale$/, to: () => "Stale sections reconciled" },
  { re: /^Hoà giải: user xác nhận nội dung không đổi$/, to: () => "Reviewed: content still correct" },
  { re: /^sửa sau baseline$/, to: () => "Edited after baseline" }
]

const toEnglish = (description: string): string => {
  for (const rule of ENGLISH_DESCRIPTION) {
    const match = rule.re.exec(description)
    if (match) return rule.to(match)
  }
  return description
}

const isBaselineTxn = (group: readonly ChangeRecordRow[]): boolean => group.some((c) => (c.path ?? "").startsWith("baselines["))

/**
 * §I giữ lại **quyết định của người** và **các mốc baseline**; bỏ sổ sách của runner.
 * Một lô chỉ được giữ khi nó chạm `baselines[]`, hoặc mang ít nhất một `reason` do người viết
 * (yêu cầu sửa, lệnh sửa qua chat, lý do waive).
 */
export const keepInRecordOfChanges = (group: readonly ChangeRecordRow[]): boolean => {
  if (isBaselineTxn(group)) return true
  return group.some((c) => c.reason !== null && c.reason.trim() !== "" && !INTERNAL_REASON.test(c.reason))
}

export function buildRecordOfChanges(changes: ChangeRecordRow[], resolveInCharge: (by: string) => string = (by) => by): RocRow[] {
  const order: string[] = []
  const groups = new Map<string, ChangeRecordRow[]>()
  for (const change of changes) {
    const list = groups.get(change.txn)
    if (list) list.push(change)
    else {
      groups.set(change.txn, [change])
      order.push(change.txn)
    }
  }
  return order.flatMap((txn, i) => {
    const group = groups.get(txn) as ChangeRecordRow[]
    if (!keepInRecordOfChanges(group)) return []
    const first = group[0]
    const reasons = [...new Set(group.map((c) => c.reason).filter((r): r is string => !!r && !INTERNAL_REASON.test(r)))]
    const description = reasons.length > 0 ? reasons.map(toEnglish).join("; ") : isBaselineTxn(group) ? "Baseline signed" : "Document updated"
    return [
      {
        date: first.at.slice(0, 10),
        version: `v0.${i + 2}`,
        change_type: changeTypeOf(new Set(group.map((c) => c.op))),
        in_charge: resolveInCharge(first.by),
        description
      }
    ]
  })
}

