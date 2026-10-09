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
 * từ `changes[]`, gộp theo ngày + giai đoạn quy trình (S-8.3).
 */

import { FIXED_SECTIONS } from "../spine/section-registry.js"
import { screenFlowTitle, screenFlowTitleOf } from "../diagram/renderers/screen-flow.renderer.js"
import { label as diagramLabel } from "../diagram/renderers/common.js"
import { DEFAULT_RELATION_VERB, relationVerb } from "../diagram/renderers/erd.renderer.js"
import { describeInterface } from "./interface-description.js"
import { loadStepRegistry } from "../pipeline/step-registry.js"
import {
  MACHINE_DESCRIPTIONS,
  VI_FPT_LABELS,
  VI_LABELS,
  VI_PHASE_LABELS,
  VI_SECTION_TITLES,
  enumLabel,
  fptLabelFor,
  isVietnamese,
  labelFor,
  recordTextFor,
  sentencesFor
} from "./labels.js"
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

// ─── nhãn cố định theo ngôn ngữ tài liệu (mode 1 v2 — FLF-184; mẫu FPT — FLF-265) ───

// Bảng nhãn nằm ở `labels.ts`; xuất lại `labelFor` cho chỗ đang import từ đây
export { labelFor }

/** Tiêu đề mặc định của section FPT theo ngôn ngữ (feature/function: tên phần tử). */
export const defaultSectionTitle = (spine: Spine, sectionId: string, language?: string): string =>
  (isVietnamese(language) ? VI_SECTION_TITLES[sectionId] : undefined) ?? headingAndLevel(spine, sectionId).heading

/** Chú thích hình: dịch phần đầu (`Use Case Diagram (1/2)`, `Screen Layout — Login`), giữ phần sau. */
const localizeCaption = (language: string | undefined, caption: string): string => {
  const prefix = Object.keys(VI_LABELS).find((k) => caption === k || caption.startsWith(`${k} `))
  return prefix ? `${labelFor(language, prefix)}${caption.slice(prefix.length)}` : caption
}

/** Khoá nhãn FPT dài trước: `Use Case Diagram` thắng `Use Case`, `Entity Relationship Diagram` thắng `Entity`. */
const FPT_CAPTION_KEYS = Object.keys(VI_FPT_LABELS).sort((a, b) => b.length - a.length)

const localizeFptCaption = (language: string | undefined, caption: string): string => {
  const prefix = FPT_CAPTION_KEYS.find((k) => caption === k || caption.startsWith(`${k} `))
  return prefix ? `${fptLabelFor(language, prefix)}${caption.slice(prefix.length)}` : caption
}

/**
 * Ngôn ngữ cho các nhãn mới của FLF-265 (enum, câu ghép, `N/A`, khung §3.x.y, nhãn mục con, tiêu đề mục cố định).
 * Chỉ tài liệu mẫu FPT (`functionLayout: "fpt"`, đường `assemble.service#buildSections`) dùng; đường layout mode 1
 * (`layout-sections.ts`) không đặt `functionLayout` ⇒ `undefined` ⇒ nhãn như cũ, bản in mode 1 không đổi.
 */
const fptLanguage = (ctx: SectionRenderContext): string | undefined => (ctx.functionLayout === "fpt" ? ctx.language : undefined)

/**
 * Bảng có tiêu đề cột lấy từ Spine (ma trận phân quyền §3.1.3: cột = tên vai trò) — mẫu FPT đã dịch cột cố định lúc
 * dựng, `localizeBlocks` bỏ qua để tên vai trò trùng khoá nhãn (`Actor`, `Data`…) không bị dịch. Mode 1 giữ như cũ.
 */
const SPINE_HEADER_TABLES = new WeakSet<TableBlock>()

/** Nhãn đậm `Label: ` ở run đầu (đoạn `labeled`, item mục con FPT) ⇒ dịch nhãn, giữ phần sau. */
const localizeBoldLabel = (runs: InlineRun[], translate: (text: string) => string): InlineRun[] | null => {
  const [first, ...rest] = runs
  const label = first?.bold ? /^(.+): $/.exec(first.text) : null
  return label ? [{ ...first, text: `${translate(label[1])}: ` }, ...rest] : null
}

/**
 * Dịch nhãn do renderer tự sinh trong khối đã dựng: tiêu đề cột, heading con, nhãn in đậm `Trigger: `, chú thích hình.
 * Làm sau khi dựng để các hàm dựng nội dung giữ nguyên (mode 2 không đổi) — ô dữ liệu Spine không bị đụng.
 * `fpt` (FLF-265, chỉ mẫu FPT): bảng nhãn đầy đủ + nhãn đậm trong item danh sách (mục con §3.x.y); không bật ⇒ y như
 * bản mode 1 cũ.
 */
const localizeBlocks = (blocks: Block[], language: string | undefined, fpt = false): Block[] => {
  if (!isVietnamese(language)) return blocks
  const label = (text: string) => (fpt ? fptLabelFor(language, text) : labelFor(language, text))
  const run = (r: InlineRun): InlineRun => ({ ...r, text: label(r.text) })
  return blocks.map((b): Block => {
    switch (b.type) {
      case "heading":
        return { ...b, text: label(b.text) }
      case "table":
        return fpt && SPINE_HEADER_TABLES.has(b) ? b : { ...b, header: b.header.map((c) => c.map(run)) }
      case "image":
        return b.caption === undefined ? b : { ...b, caption: fpt ? localizeFptCaption(language, b.caption) : localizeCaption(language, b.caption) }
      case "paragraph": {
        const [first, ...rest] = b.runs
        const labelled = localizeBoldLabel(b.runs, label)
        if (labelled) return { ...b, runs: labelled }
        const screens = !first?.bold && first ? /^Screens: /.exec(first.text) : null
        return screens ? { ...b, runs: [{ ...first, text: `${label("Screens")}: ${first.text.slice(screens[0].length)}` }, ...rest] } : b
      }
      case "bullet_list":
      case "numbered_list":
        return fpt ? { ...b, items: b.items.map((item) => localizeBoldLabel(item, label) ?? item) } : b
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
  /**
   * FLF-252 — tài liệu nhập có bảng Non-Screen Functions: chức năng in ở bảng 3.1.4 (đúng các dòng bảng của file + chức
   * năng không màn thêm sau), theo cột của mẫu FPT. Không đặt ⇒ mọi chức năng không màn, cột cũ.
   */
  nonScreenFunctionIds?: ReadonlySet<string>
  /**
   * FLF-265 D11 — Spine GỐC khi `spine` truyền vào `renderSection` là bản xem đã dịch (`localized-spine.ts`). Logic dựa
   * chữ Anh hoặc so chuỗi giữa các field (lọc "Data processing", dò tên entity, tên actor trong tiêu đề sơ đồ luồng màn,
   * gộp câu / tên trùng, dòng tên màn trong wireframe) quyết trên bản gốc rồi in chữ dịch ở cùng vị trí — cùng dòng như
   * bản tiếng Anh. Không đặt ⇒ y như trước.
   */
  canonical?: Spine
}

/**
 * Phần tử cùng id trong `list` (bản gốc ⇔ bản xem đã dịch). Không có `list` (không dựng từ bản dịch) ⇒ chính phần tử đó,
 * không tra gì thêm — đường hôm nay giữ nguyên byte.
 */
const sameId = <T extends { id: string }>(list: readonly T[] | undefined, item: T): T =>
  list ? (list.find((x) => x.id === item.id) ?? item) : item

/** Giữ phần tử của `items` mà phần tử cùng chỉ số của `source` (chữ gốc, cùng độ dài) thoả `keep`. */
const keepWhere = (items: readonly string[], source: readonly string[], keep: (text: string) => boolean): string[] =>
  items.filter((item, i) => keep(source[i] ?? item))

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
    const lang = fptLanguage(ctx)
    const say = sentencesFor(lang)
    blocks.push(heading("External Systems", 2), bulletList(nonHuman.map((a) => say.externalSystem(a.name, enumLabel(lang, "actor_kind", a.kind), a.description))))
  }
  blocks.push(...diagramImages(spine, "context", undefined, ctx, "Figure — System Context Diagram"))
  return blocks
}

// ─── §2 User Requirements ──────────────────────────────────────────

const actorsTable = (spine: Spine, ctx: SectionRenderContext): Block[] =>
  spine.actors.length === 0
    ? []
    : [
        tableBlock(
          ["ID", "Name", "Kind", "Description"],
          spine.actors.map((a) => [a.id, a.name, enumLabel(fptLanguage(ctx), "actor_kind", a.kind), a.description])
        )
      ]

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
const flowTitle =
  (spine: Spine, ctx: SectionRenderContext) =>
  (d: Spine["diagrams"][number]): string | null => {
    const title = screenFlowTitleOf(d.puml)
    if (title === null || !ctx.canonical) return title
    // FLF-265: sơ đồ giữ tiếng Anh (D13) nên tiêu đề mang tên actor GỐC (đã qua `label` của renderer) — khớp actor gốc
    // theo tiêu đề, in tên đã dịch cùng id (`localizeFptCaption` dịch tiếp phần đầu). Không khớp (hình vẽ trước khi đổi
    // tên actor) ⇒ giữ tiêu đề trong hình
    const actor = ctx.canonical.actors.find((a) => a.kind === "human" && diagramLabel(screenFlowTitle(a.name)) === title)
    const shown = actor && spine.actors.find((a) => a.id === actor.id)
    return shown ? diagramLabel(screenFlowTitle(shown.name)) : title
  }

const screensFlow = (spine: Spine, ctx: SectionRenderContext): Block[] =>
  diagramImages(spine, "screen_flow", undefined, ctx, "Screens Flow Diagram", flowTitle(spine, ctx))

const screenDescriptions = (spine: Spine, ctx: SectionRenderContext): Block[] => {
  if (spine.screens.length === 0) return []
  return [
    tableBlock(
      ["Feature", "Screen", "Description"],
      spine.screens.map((s) => {
        const feature = spine.features.find((f) => f.id === s.feature_id)
        const number = ctx.numberOf(`feature:${s.feature_id}`)
        const featureLabel = feature ? sentencesFor(fptLanguage(ctx)).featureLabel(number, feature.name) : s.feature_id
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
const screenAuthorization = (spine: Spine, ctx: SectionRenderContext): Block[] => {
  // Có vai trò mà chưa phân quyền màn nào (2026-09-24: CR thêm vai trò trước) ⇒ vẫn hiện danh sách vai trò, không để
  // mục trống như chưa làm gì — ma trận toàn "—" thì đọc thành "không ai được vào màn nào", sai nghĩa
  if (spine.permissions.length === 0) {
    if (spine.roles.length === 0) return []
    const actorName = (id: string | null) => spine.actors.find((a) => a.id === id)?.name ?? "—"
    return [tableBlock(["Role", "Actor"], spine.roles.map((r) => [r.name, actorName(r.actor_id)]))]
  }
  const actionsOf = (screenId: string, roleId: string): string =>
    spine.permissions
      .filter((p) => p.screen_id === screenId && p.role_id === roleId)
      .map((p) => enumLabel(fptLanguage(ctx), "permission_action", p.action))
      .join(", ") || "—"
  const matrix = tableBlock(
    [fptLabelFor(fptLanguage(ctx), "Screen"), ...spine.roles.map((r) => r.name)],
    spine.screens.map((s) => [s.name, ...spine.roles.map((r) => actionsOf(s.id, r.id))])
  )
  SPINE_HEADER_TABLES.add(matrix)
  return [matrix]
}

const nonScreenFunctions = (spine: Spine, ctx: SectionRenderContext): Block[] => {
  const listed = ctx.nonScreenFunctionIds
  if (listed) {
    // FLF-252: tài liệu nhập — đúng các dòng bảng 3.1.4 của file, cột như mẫu FPT (# · Feature · System Function · Description)
    const fns = spine.functions.filter((f) => listed.has(f.id))
    if (fns.length === 0) return []
    const featureName = (id: string) => spine.features.find((f) => f.id === id)?.name ?? id
    return [tableBlock(["#", "Feature", "System Function", "Description"], fns.map((f, i) => [String(i + 1), featureName(f.feature_id), f.name, f.description]))]
  }
  const fns = spine.functions.filter((f) => f.screen_id === null)
  if (fns.length === 0) return []
  return [tableBlock(["Name", "Trigger", "Description"], fns.map((f) => [f.name, f.trigger, f.description]))]
}

const erd = (spine: Spine, ctx: SectionRenderContext): Block[] => {
  const blocks: Block[] = diagramImages(spine, "erd", undefined, ctx, "Entity Relationship Diagram")
  if (spine.entities.length > 0) {
    const entityName = (id: string) => spine.entities.find((e) => e.id === id)?.name ?? id
    const lang = fptLanguage(ctx)
    // Động từ do người viết đặt là nội dung Spine — chỉ động từ mặc định (`has`) được dịch
    const verbOf = (e: Spine["entities"][number], id: string) => {
      const verb = relationVerb(e, id)
      return verb === DEFAULT_RELATION_VERB ? fptLabelFor(lang, verb) : verb
    }
    const relations = (e: Spine["entities"][number]) =>
      e.relations.map((id) => sentencesFor(lang).relation(verbOf(e, id), entityName(id), e.relation_optional?.includes(id) ?? false)).join(", ")
    blocks.push(tableBlock(["Entity", "Description", "Relations"], spine.entities.map((e) => [e.name, e.description, relations(e)])))
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

/**
 * Bỏ rỗng + gộp trùng, giữ lần đầu. `source` (FLF-265) = chữ gốc cùng chỉ số: gộp theo chữ gốc, in phần tử của `items` —
 * hai câu Anh khác nhau mà dịch ra trùng nhau vẫn là hai dòng như bản tiếng Anh. Không truyền ⇒ gộp trên chính `items`.
 */
const unique = (items: readonly string[], source: readonly string[] = items): string[] => {
  const seen = new Set<string>()
  return items.filter((item, i) => {
    const key = source[i] ?? item
    if (key.trim().length === 0 || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Đường vào màn của function theo Screens Flow: BFS theo `flow_to` từ màn vào (không pop-up, không có cạnh tới;
 * không có thì màn `queue_order` thấp nhất) — `Login > Project Dashboard > Project Workspace`. Không tới được ⇒ tên màn.
 */
const navigationPath = (spine: Spine, screenId: string, na = NA): string => {
  const byId = new Map(spine.screens.map((s) => [s.id, s]))
  const target = byId.get(screenId)
  if (!target) return na
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
 * `canonical` (FLF-265): gộp tên trùng theo tên gốc, in tên của `spine` (bản xem đã dịch).
 */
const directActors = (spine: Spine, fn: Spine["functions"][number], na = NA, canonical: Spine = spine): string => {
  const humanIn = (s: Spine) => (id: string | null) => s.actors.find((a) => a.id === id && a.kind === "human")?.name ?? ""
  const names = (actorIds: (string | null)[]) => unique(actorIds.map(humanIn(spine)), actorIds.map(humanIn(canonical)))
  const fromUseCases = names(spine.use_cases.filter((uc) => uc.function_ids.includes(fn.id)).flatMap((uc) => uc.actor_ids))
  if (fromUseCases.length > 0) return fromUseCases.join(", ")
  const fromRoles = names(
    spine.permissions
      .filter((perm) => fn.screen_id !== null && perm.screen_id === fn.screen_id)
      .map((perm) => spine.roles.find((r) => r.id === perm.role_id)?.actor_id ?? null)
  )
  return fromRoles.length > 0 ? fromRoles.join(", ") : na
}

/**
 * Entity được nhắc tên trong nội dung function (không có liên kết function ↔ entity trong Spine). `canonical` (FLF-265):
 * dò tên entity GỐC trong chữ GỐC của function — bản dịch không còn chữ Anh để khớp — rồi in tên đã dịch cùng id.
 */
const dataOf = (spine: Spine, fn: Spine["functions"][number], na = NA, canonical?: Spine): string => {
  const source = sameId(canonical?.functions, fn)
  const text = [source.name, source.trigger, source.description, ...source.normal, ...source.abnormal, ...source.validations.map((v) => v.statement)].join(" ").toLowerCase()
  const escape = (name: string) => name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const named = (canonical ?? spine).entities
    .filter((e) => e.name.trim() && new RegExp(`\\b${escape(e.name)}s?\\b`).test(text))
    .map((e) => sameId(canonical ? spine.entities : undefined, e).name)
  return named.length > 0 ? named.join(", ") : na
}

/** Câu "Business rules" của function: validation nghiệp vụ + business rule đã liên kết (id chết ⇒ rỗng, `unique` bỏ). */
const ruleStatements = (spine: Spine, fn: Spine["functions"][number]): string[] => [
  ...fn.validations.filter((v) => v.kind === "business").map((v) => v.statement),
  ...fn.business_rule_ids.map((id) => spine.business_rules.find((r) => r.id === id)?.statement ?? "")
]

/** Bước hệ thống tự làm trong luồng chính — mục "Data processing" (lọc trên chữ Anh của Spine). */
const SYSTEM_STEP = /^(the )?system\b/i

/**
 * Nhóm mục con dạng danh sách gạch đầu dòng `• Nhãn: giá trị`. Mục nhiều dòng (các bước, nhiều validation) ⇒
 * `• Nhãn:` rồi danh sách đánh số ngay dưới; rỗng ⇒ `N/A`.
 */
type SubItem = { label: string; value: string } | { label: string; steps: string[] }

const subItems = (items: SubItem[], na = NA): Block[] => {
  const out: Block[] = []
  let bullets: InlineRun[][] = []
  const flush = () => {
    if (bullets.length > 0) out.push({ type: "bullet_list", items: bullets })
    bullets = []
  }
  for (const item of items) {
    const label: InlineRun = { text: `${item.label}: `, bold: true }
    if ("value" in item) {
      bullets.push([label, { text: item.value.trim() || na }])
    } else if (item.steps.length === 0) {
      bullets.push([label, { text: na }])
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
  const lang = fptLanguage(ctx)
  const na = fptLabelFor(lang, NA)
  // FLF-265 D11: `spine` có thể là bản xem đã dịch — chọn dòng trên bản gốc (`ctx.canonical`), in chữ dịch cùng vị trí
  const { canonical } = ctx
  const source = sameId(canonical?.functions, fn)

  const rules = unique(ruleStatements(spine, fn), ruleStatements(canonical ?? spine, source))
  const layout =
    screen && screen.primary_function_id === fn.id
      ? diagramImages(spine, "screen_layout", screen.id, ctx, sentencesFor(lang).screenLayoutCaption(screen.name))
      : []

  // Nhãn heading / mục con giữ tiếng Anh ở đây — `localizeBlocks` dịch sau (bảng `VI_FPT_LABELS`)
  return [
    heading("Function trigger", 4),
    ...subItems([
      { label: "Navigation path", value: screen ? navigationPath(spine, screen.id, na) : na },
      { label: "Timing frequency", value: fn.trigger }
    ], na),
    heading("Function description", 4),
    ...subItems([
      { label: "Actors / Roles", value: directActors(spine, fn, na, canonical) },
      { label: "Purpose", value: fn.description },
      { label: "Interface", value: (screen && describeInterface(spine, screen, lang, sameId(canonical?.screens, screen).name)) || na },
      { label: "Data processing", steps: keepWhere(fn.normal, source.normal, (step) => SYSTEM_STEP.test(step.trim())) }
    ], na),
    heading("Screen layout", 4),
    ...(layout.length > 0 ? layout : [p(na)]),
    heading("Function details", 4),
    ...subItems([
      { label: "Data", value: dataOf(spine, fn, na, canonical) },
      { label: "Validation", steps: fn.validations.filter((v) => v.kind !== "business").map((v) => v.statement) },
      { label: "Business rules", steps: rules },
      { label: "Normal case", steps: fn.normal },
      { label: "Abnormal case", steps: fn.abnormal }
    ], na)
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

const nfrStatement = (n: Nfr, language?: string): string =>
  n.metric && n.threshold ? sentencesFor(language).nfrStatement(n.statement, n.metric, n.threshold) : n.statement

const nfrList = (spine: Spine, category: NfrCategory, ctx: SectionRenderContext): Block[] => {
  const items = spine.nfrs.filter((n) => n.category === category)
  return items.length === 0 ? [] : [bulletList(items.map((n) => nfrStatement(n, fptLanguage(ctx))))]
}

const nfrTable = (spine: Spine, category: NfrCategory, ctx: SectionRenderContext): Block[] => {
  const items = spine.nfrs.filter((n) => n.category === category)
  if (items.length === 0) return []
  return [tableBlock(["Statement", "Metric", "Threshold", "Priority"], items.map((n) => [n.statement, n.metric ?? "", n.threshold ?? "", n.priority ? enumLabel(fptLanguage(ctx), "priority", n.priority) : ""]))]
}

// ─── §5 Requirement Appendix ────────────────────────────────────────

const businessRulesDetail = (spine: Spine): Block[] => {
  const items = spine.business_rules.filter((r) => r.tier === "detail")
  return items.length === 0 ? [] : [bulletList(items.map((r) => r.statement))]
}

const commonRequirements = (spine: Spine, ctx: SectionRenderContext): Block[] =>
  spine.common_requirements.length === 0
    ? []
    : [tableBlock(["Category", "Statement"], spine.common_requirements.map((c) => [enumLabel(fptLanguage(ctx), "common_category", c.category), c.statement]))]

const messagesList = (spine: Spine): Block[] => {
  if (spine.messages.length === 0) return []
  const fnName = (id: string) => spine.functions.find((f) => f.id === id)?.name ?? id
  return [tableBlock(["Code", "Text", "Functions"], spine.messages.map((m) => [m.code, m.text, m.function_ids.map(fnName).join(", ")]))]
}

const otherRequirements = (spine: Spine, ctx: SectionRenderContext): Block[] =>
  spine.other_requirements.length === 0
    ? []
    : [tableBlock(["Kind", "Statement"], spine.other_requirements.map((o) => [enumLabel(fptLanguage(ctx), "other_kind", o.kind), o.statement]))]

const glossaryTable = (spine: Spine): Block[] =>
  spine.glossary.length === 0 ? [] : [tableBlock(["Term", "Native", "Definition"], spine.glossary.map((g) => [g.term, g.term_native ?? "", g.definition]))]

// ─── dispatch ────────────────────────────────────────────────────

const blocksFor = (spine: Spine, sectionId: string, ctx: SectionRenderContext): Block[] => {
  switch (sectionId) {
    case "fixed:1":
      return productOverview(spine, ctx)
    case "fixed:2.1":
      return actorsTable(spine, ctx)
    case "fixed:2.2.1":
      return useCaseDiagram(spine, ctx)
    case "fixed:2.2.2":
      return useCaseTable(spine)
    case "fixed:3.1.1":
      return screensFlow(spine, ctx)
    case "fixed:3.1.2":
      return screenDescriptions(spine, ctx)
    case "fixed:3.1.3":
      return screenAuthorization(spine, ctx)
    case "fixed:3.1.4":
      return nonScreenFunctions(spine, ctx)
    case "fixed:3.1.5":
      return erd(spine, ctx)
    case "fixed:4.1":
      return nfrList(spine, "interface", ctx)
    case "fixed:4.2.1":
      return nfrTable(spine, "usability", ctx)
    case "fixed:4.2.2":
      return nfrTable(spine, "reliability", ctx)
    case "fixed:4.2.3":
      return nfrTable(spine, "performance", ctx)
    case "fixed:4.2.4":
      return nfrTable(spine, "other", ctx)
    case "fixed:5.1":
      return businessRulesDetail(spine)
    case "fixed:5.2":
      return commonRequirements(spine, ctx)
    case "fixed:5.3":
      return messagesList(spine)
    case "fixed:5.4":
      return otherRequirements(spine, ctx)
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
  const fpt = ctx.functionLayout === "fpt"
  const section: RenderedSection = {
    id: sectionId,
    number: ctx.number,
    // Mẫu FPT tiếng Việt: tiêu đề mục cố định theo `VI_SECTION_TITLES` (mode 1 tự đặt tiêu đề theo file người dùng)
    heading: fpt ? defaultSectionTitle(spine, sectionId, ctx.language) : title,
    level,
    blocks: localizeBlocks(blocksFor(spine, sectionId, ctx), ctx.language, fpt)
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
 * Lý do do MÁY ghi trong lúc chạy quy trình. §I là lịch sử tài liệu cho người đọc, không phải nhật ký của
 * runner: lượt test xuất ra 425 dòng mà phần lớn là "step-runner: elicit turn" (BUG-15).
 * Mode 1: cờ do AI kiểm tra đặt (`AI check: ambiguity`, `AI semantic check (1.11)`) và kế hoạch step lúc import
 * cũng là sổ sách của máy — không in vào tài liệu.
 */
const INTERNAL_REASON =
  /^(step-runner:|gate:|resume:|Revert seq|Hoà giải: chờ chấp nhận lại|Phỏng vấn đầu giai đoạn|Chốt |confirmed_at do server đặt|Mở cờ |Waiver |Đóng cờ |AI check:|AI semantic check|Import: kế hoạch step)/

/**
 * Câu do máy sinh → câu theo ngôn ngữ tài liệu (mặc định tiếng Anh; bảng `MACHINE_DESCRIPTIONS` ở `labels.ts`);
 * câu do user viết giữ nguyên (đó là lời của chính họ).
 */
const toDocumentLanguage = (description: string, language?: string): string => {
  for (const rule of MACHINE_DESCRIPTIONS) {
    const match = rule.re.exec(description)
    if (match) return isVietnamese(language) ? rule.vi(match) : rule.en(match)
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

/** Một dòng gom nhiều lần sửa — mô tả giữ tối đa chừng này lý do, phần còn lại ghi số lượng. */
const MAX_REASONS_PER_ROW = 3

/** Giai đoạn của step (`S-3.2` ⇒ `S-3`, `S-5.1@S3` ⇒ `S-5`); sửa ngoài quy trình (step_id null) ⇒ "". */
const phaseKeyOf = (stepId: string | null): string => (stepId ? (/^([BS]-\d+)\./.exec(stepId)?.[1] ?? "") : "")

let phaseLabels: Map<string, string> | undefined
const phaseLabelOf = (phase: string, language?: string): string | undefined => {
  phaseLabels ??= new Map(loadStepRegistry().map((s) => [s.phase as string, s.phase_label_en]))
  const label = phaseLabels.get(phase)
  // Registry (đóng băng) chỉ có nhãn tiếng Anh — bản tiếng Việt tra bảng render, phase lạ giữ nhãn Anh
  return label !== undefined && isVietnamese(language) ? (VI_PHASE_LABELS[phase] ?? label) : label
}

/** Mã baseline (`v1.0`, `v1.2-conditional`) nằm trong lý do `Ký baseline v1.0` do baseline.service ghi. */
const BASELINE_VERSION = /\bv\d+\.\d+(?:-conditional)?\b/

const describeRow = (reasons: readonly string[], language?: string): string => {
  const shown = reasons.slice(0, MAX_REASONS_PER_ROW).join("; ")
  const more = reasons.length - MAX_REASONS_PER_ROW
  return more > 0 ? `${shown}${recordTextFor(language).more(more)}` : shown
}

/** Lý do op-engine gắn cho op cascade — đi kèm lô của user, không phải lời của user. */
const MACHINE_REASON = /^Cascade:/

/**
 * §I là lịch sử cho người đọc tài liệu, không phải nhật ký từng transaction: một ngày chat sửa vài chục lần
 * từng ra vài chục dòng/version. Nay gộp các lô được giữ (`keepInRecordOfChanges`) **liền nhau, cùng ngày, cùng
 * giai đoạn quy trình** thành một dòng, mô tả kiểu FPT `Create <giai đoạn>` (lần đầu) / `Update <giai đoạn>`
 * — không in `reason` từng op vì đó là nhật ký của model. Sau baseline mô tả là lời user (tối đa 3). Lô không gắn
 * step nhập vào dòng liền trước cùng ngày; sau baseline (không còn giai đoạn) gom theo ngày. Lô ký baseline luôn
 * là một dòng riêng.
 *
 * `version` đánh theo dòng, không theo `spine_version`: trước baseline `v0.1, v0.2…`; dòng ký lấy đúng mã
 * baseline (`v1.0`); sau đó `v1.0.1, v1.0.2…` cho tới baseline kế tiếp.
 *
 * `resolveInCharge` (T7): `by` lưu trong `changes[]` là userId thô (hoặc `"system"`) — caller truyền
 * hàm tra `User.name`/email theo lô để hiển thị tên thay vì id; mặc định giữ nguyên `by` (test thuần
 * không cần DB). Nhiều người sửa trong ngày ⇒ liệt kê tên không trùng.
 *
 * `language` (FLF-265, nội bộ): câu máy sinh + nhãn phase theo ngôn ngữ tài liệu; không truyền ⇒ tiếng Anh như trước.
 */
export function buildRecordOfChanges(
  changes: ChangeRecordRow[],
  resolveInCharge: (by: string) => string = (by) => by,
  language?: string
): RocRow[] {
  const text = recordTextFor(language)
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

  // Gom lô được giữ thành dòng: liền nhau cùng ngày + cùng giai đoạn thì dồn, baseline đứng riêng.
  const rows: { date: string; phase: string; baseline: boolean; changes: ChangeRecordRow[] }[] = []
  for (const txn of order) {
    const group = groups.get(txn) as ChangeRecordRow[]
    if (!keepInRecordOfChanges(group)) continue
    const date = group[0].at.slice(0, 10)
    const baseline = isBaselineTxn(group)
    const last = rows[rows.length - 1]
    // Lô không gắn step (xác nhận giả định ở cổng, lệnh sửa chat giữa step) thuộc giai đoạn đang chạy — không cắt nhóm
    const phase = phaseKeyOf(group[0].step_id) || (last && !last.baseline && last.date === date ? last.phase : "")
    if (!baseline && last && !last.baseline && last.date === date && last.phase === phase) last.changes.push(...group)
    else rows.push({ date, phase, baseline, changes: [...group] })
  }

  let base = "v0"
  let minor = 0
  let baselines = 0
  const seenPhases = new Set<string>()
  const describe = (row: (typeof rows)[number], reasons: readonly string[]): string => {
    if (row.baseline) return reasons.length > 0 ? describeRow(reasons, language) : text.baselineSigned
    // Dòng của quy trình: mô tả bằng giai đoạn, kiểu FPT "Create/Update <mục>" — reason từng op là của model
    const label = phaseLabelOf(row.phase, language)
    if (label) {
      const first = !seenPhases.has(row.phase)
      seenPhases.add(row.phase)
      return text.phaseRow(first, label)
    }
    // Ngoài quy trình (yêu cầu sửa sau baseline): lời của user
    return reasons.length > 0 ? describeRow(reasons, language) : text.documentUpdated
  }
  return rows.map((row) => {
    const raw = row.changes.map((c) => c.reason).filter((r): r is string => !!r && !INTERNAL_REASON.test(r) && !MACHINE_REASON.test(r))
    const reasons = [...new Set(raw.map((r) => toDocumentLanguage(r, language)))]
    let version: string
    if (row.baseline) {
      // Fallback khớp `nextBaselineVersion` (baseline.service) khi lý do không mang mã
      version = raw.map((r) => BASELINE_VERSION.exec(r)?.[0]).find((v) => v !== undefined) ?? `v1.${baselines}`
      baselines += 1
      base = version.replace(/-conditional$/, "")
      minor = 0
    } else {
      minor += 1
      version = `${base}.${minor}`
    }
    return {
      date: row.date,
      version,
      change_type: changeTypeOf(new Set(row.changes.map((c) => c.op))),
      in_charge: [...new Set(row.changes.map((c) => resolveInCharge(c.by)))].join(", "),
      description: describe(row, reasons)
    }
  })
}

