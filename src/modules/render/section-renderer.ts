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
import type { Change, DiagramKind, Nfr, NfrCategory, Spine } from "../spine/spine.types.js"

/**
 * T15 review T5: `fixed:I` không cần `before`/`value` (chỉ mô tả A/M/D + ngày/người/lý do) — caller
 * (`assemble.service.ts`) đọc `Change` model trực tiếp với projection nhẹ này thay vì
 * `spine.repository.listChanges` (tải cả `before`/`value`, nặng không cần thiết cho §I).
 */
export type ChangeRecordRow = Pick<Change, "txn" | "at" | "by" | "reason" | "op" | "step_id">
import type {
  Block,
  BulletListBlock,
  HeadingBlock,
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
  captionBase: string
): ImageBlock[] => {
  const parts = spine.diagrams.filter(
    (d) => d.kind === kind && d.render_status === "ok" && (ownerId === undefined || d.owner_id === ownerId)
  )
  const out: ImageBlock[] = []
  parts.forEach((d, i) => {
    const png = ctx.diagramPng(d.id)
    if (png) out.push(image(png, parts.length > 1 ? `${captionBase} (${i + 1}/${parts.length})` : captionBase))
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
  const actorName = (id: string) => spine.actors.find((a) => a.id === id)?.name ?? id
  return [
    tableBlock(
      ["ID", "Name", "Actors", "Description", "Include / Extend"],
      spine.use_cases.map((uc) => [
        uc.id,
        uc.name,
        uc.actor_ids.map(actorName).join(", "),
        uc.description,
        [
          uc.includes.length > 0 ? `include: ${uc.includes.join(", ")}` : "",
          uc.extends.length > 0 ? `extend: ${uc.extends.join(", ")}` : ""
        ]
          .filter(Boolean)
          .join("; ")
      ])
    )
  ]
}

// ─── §3.1 System Functional Overview (section cố định) ────────────

const screensFlow = (spine: Spine, ctx: SectionRenderContext): Block[] => {
  const blocks: Block[] = diagramImages(spine, "screen_flow", undefined, ctx, "Screens Flow Diagram")
  if (spine.screens.length > 0) {
    blocks.push(
      tableBlock(
        ["Screen", "Type", "Flows To"],
        spine.screens.map((s) => [
          s.name,
          s.is_popup ? "Popup" : s.tabs.length > 0 ? `Tabbed (${s.tabs.join(", ")})` : "Full page",
          s.flow_to.map((id) => spine.screens.find((x) => x.id === id)?.name ?? id).join(", ")
        ])
      )
    )
  }
  return blocks
}

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

const featureOverview = (spine: Spine, featureId: string): Block[] => {
  const screens = spine.screens.filter((s) => s.feature_id === featureId)
  return screens.length === 0 ? [] : [p(`Screens: ${screens.map((s) => s.name).join(", ")}`)]
}

const functionDetail = (spine: Spine, functionId: string, ctx: SectionRenderContext): Block[] => {
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
      if (sectionId.startsWith("feature:")) return featureOverview(spine, sectionId.slice("feature:".length))
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
    blocks: blocksFor(spine, sectionId, ctx)
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
  return order.map((txn, i) => {
    const group = groups.get(txn) as ChangeRecordRow[]
    const first = group[0]
    const reasons = [...new Set(group.map((c) => c.reason).filter((r): r is string => !!r))]
    return {
      date: first.at.slice(0, 10),
      version: `v0.${i + 2}`,
      change_type: changeTypeOf(new Set(group.map((c) => c.op))),
      in_charge: resolveInCharge(first.by),
      description: reasons.length > 0 ? reasons.join("; ") : first.step_id ? `Step ${first.step_id}` : "Spine updated"
    }
  })
}

