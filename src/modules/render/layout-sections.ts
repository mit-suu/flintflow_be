/**
 * layout-sections.ts
 * ─────────────────────────────────────────────────────────────────
 * Mode 1 v2 (FLF-184, plan v2 §6 — D1): dựng `RenderedSection[]` theo **layout của file người dùng upload**
 * (`TemplateProfile.layout`) thay cho thứ tự + số hiệu cứng của mẫu FPT (`assemble.service.ts` `buildNumberMap`/
 * `GROUP_HEADINGS`). Nội dung từng section FPT vẫn lấy từ Spine qua `renderSection`; chỉ đổi thứ tự, tiêu đề, cấp,
 * số hiệu. Hàm thuần — không đọc DB.
 *
 * - Mục của layout giữ đúng thứ tự + tiêu đề gốc (bỏ số gõ tay ở đầu, số hiệu đánh lại theo cấp).
 * - `group:*` (heading nhóm) ⇒ chỉ heading. `custom:<id>` ⇒ nguyên văn từ `custom_sections[]`; mục riêng có tiêu đề
 *   rỗng là **phần nối** (văn xuôi I-4 không trích được, khối dưới heading nhóm) của section gần nhất phía trước có cấp
 *   nhỏ hơn nó ⇒ khối của nó chèn vào đầu section đó.
 * - Section FPT có trong Spine mà layout không có (đầu mục thiếu — D6, step bật thêm, feature/function mới tạo) ⇒
 *   chèn cạnh mục anh em cùng nhóm mẫu FPT đã có trong file (sau anh em đứng trước — kể cả mục con của nó — hoặc trước
 *   anh em đứng sau), nhóm chưa có mục nào mà file có heading nhóm (`group:*`) ⇒ mục con đầu tiên của heading đó; còn
 *   lại ⇒ sau section FPT gần nhất đứng trước theo thứ tự mẫu; tiêu đề FPT theo
 *   ngôn ngữ tài liệu. Function mới của feature chưa có function nào ⇒ mục con của feature đó.
 * - Mục trong layout mà Spine không còn (feature/function/mục riêng đã xoá) ⇒ bỏ.
 * - Số hiệu: đếm theo cấp (cấp nhảy quá 1 được kéo về cấp kế tiếp). File gõ số tay ở phần lớn heading thì heading
 *   không gõ số (vd "Phụ lục A") giữ không số, như bản gốc.
 * - **Phần** (nợ T14): heading gõ số La Mã mà mục con đầu tiên đánh số lại từ đầu (`II. Software Requirement
 *   Specification` › `1 Product Overview`, `2.1 Actors`) ⇒ giữ nhãn La Mã gốc, không chiếm một cấp số; mục con đánh
 *   số lại từ 1 trong phần đó. Trước đây `II.` bị coi là chương 1 ⇒ `3.1.2` thành `1.3.1.2`, tham chiếu chéo trỏ sai.
 *   La Mã dùng làm chính số chương (`I. Introduction` › `1.1 Purpose`) vẫn đánh số như cũ.
 */

import { listSections, type SectionDef } from "../spine/section-registry.js"
import type { SectionStateView } from "../spine/section-status.js"
import type { CustomBlock, CustomSection, Spine } from "../spine/spine.types.js"
import type { Block, InlineRun, RenderedSection, TableCell } from "./rendered-document.types.js"
import { defaultSectionTitle, renderSection, type SectionRenderContext } from "./section-renderer.js"

/** Một mục layout (cùng hình `LayoutEntry` của `import/template-profile.model.ts`). */
export interface TemplateLayoutEntry {
  order: number
  heading_text: string
  level: number
  section_id: string
}

export interface TemplateLayout {
  layout: readonly TemplateLayoutEntry[]
  language: string
}

const CUSTOM_PREFIX = "custom:"
const GROUP_PREFIX = "group:"
const MAX_LEVEL = 6

/** Số gõ tay ở đầu heading (`1.2 Scope`, `IV. NFR`) — cùng mẫu `import/text-similarity.ts` `splitHeadingNumber`. */
const TYPED_NUMBER = /^\s*((?:\d{1,2}\.)*\d{1,2}|[IVX]{1,4})\.?[\s ]+(.*)$/

const splitTypedNumber = (text: string): { typed: boolean; title: string; label: string } => {
  const m = TYPED_NUMBER.exec(text)
  return m && m[2].trim() ? { typed: true, title: m[2].trim(), label: m[1] } : { typed: false, title: text.trim(), label: "" }
}

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10 }
/** `IV` ⇒ 4; không phải số La Mã ⇒ `null`. */
export const romanValue = (label: string): number | null => {
  if (!/^[IVX]+$/.test(label)) return null
  let total = 0
  for (let i = 0; i < label.length; i++) {
    const v = ROMAN[label[i]]
    const next = ROMAN[label[i + 1]] ?? 0
    total += v < next ? -v : v
  }
  return total
}

type EntryKind = "fpt" | "group" | "custom" | "continuation"

interface Placed {
  section_id: string
  kind: EntryKind
  title: string
  level: number
  /** Mục lấy từ layout (không phải mục FPT chèn thêm). */
  fromLayout: boolean
  /** Heading gốc có số gõ tay. */
  typed: boolean
  /** Số gõ tay nguyên văn (`2.1`, `II`) — rỗng nếu không gõ số. */
  label?: string
}

// ─── mục riêng ⇒ block ─────────────────────────────────────────────

const runs = (text: string): InlineRun[] => [{ text }]

const customTable = (rows: string[][]): Block | null => {
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim()))
  if (!nonEmpty.length) return null
  const width = Math.max(...nonEmpty.map((r) => r.length))
  const pad = (r: string[]): TableCell[] => Array.from({ length: width }, (_, i) => runs(r[i] ?? ""))
  const [header, ...body] = nonEmpty
  return { type: "table", header: pad(header), rows: body.map(pad) }
}

/** Khối nguyên văn: đoạn · danh sách (gộp dòng liền nhau) · bảng · ảnh (chưa đọc nhị phân ảnh — V5 ⇒ dòng chú thích). */
export const customBlocks = (blocks: readonly CustomBlock[]): Block[] => {
  const out: Block[] = []
  for (const b of blocks) {
    switch (b.kind) {
      case "paragraph":
        if (b.text.trim()) out.push({ type: "paragraph", runs: runs(b.text) })
        break
      case "list_item": {
        if (!b.text.trim()) break
        const last = out[out.length - 1]
        if (last?.type === "bullet_list") last.items.push(runs(b.text))
        else out.push({ type: "bullet_list", items: [runs(b.text)] })
        break
      }
      case "table": {
        const table = customTable(b.rows ?? [])
        if (table) out.push(table)
        break
      }
      case "image":
        out.push({ type: "paragraph", runs: [{ text: b.text.trim() ? `[Image: ${b.text.trim()}]` : "[Image]", italic: true }] })
        break
    }
  }
  return out
}

// ─── xếp chỗ ───────────────────────────────────────────────────────

const clampLevel = (level: number): number => Math.min(9, Math.max(1, Math.round(level)))

/** Mục layout còn dùng được + mục FPT chèn thêm, theo thứ tự tài liệu. */
export const placeSections = (spine: Spine, template: TemplateLayout): Placed[] => {
  const defs = listSections(spine).filter((d) => d.id !== "fixed:I")
  const defById = new Map(defs.map((d) => [d.id, d]))
  const customById = new Map(spine.custom_sections.map((c) => [c.id, c]))
  const placed: Placed[] = []
  const used = new Set<string>()

  for (const entry of [...template.layout].sort((a, b) => a.order - b.order)) {
    const id = entry.section_id
    if (used.has(id)) continue
    const { typed, title, label } = splitTypedNumber(entry.heading_text)
    const level = clampLevel(entry.level)
    if (id.startsWith(GROUP_PREFIX)) {
      placed.push({ section_id: id, kind: "group", title: title || id, level, fromLayout: true, typed, label })
    } else if (id.startsWith(CUSTOM_PREFIX)) {
      const custom = customById.get(id.slice(CUSTOM_PREFIX.length))
      if (!custom) continue
      const heading = custom.heading.trim()
      placed.push({
        section_id: id,
        kind: heading ? "custom" : "continuation",
        title: heading ? splitTypedNumber(heading).title : "",
        level: clampLevel(custom.level),
        fromLayout: true,
        typed: heading ? splitTypedNumber(heading).typed : false,
        label: heading ? splitTypedNumber(heading).label : ""
      })
    } else if (defById.has(id)) {
      placed.push({ section_id: id, kind: "fpt", title: title || defaultSectionTitle(spine, id, template.language), level, fromLayout: true, typed, label })
    } else {
      continue
    }
    used.add(id)
  }

  // Mục riêng thêm tay (chat) chưa có trong layout ⇒ cuối tài liệu
  for (const c of spine.custom_sections) {
    const id = `${CUSTOM_PREFIX}${c.id}`
    if (used.has(id)) continue
    used.add(id)
    const heading = c.heading.trim()
    placed.push({ section_id: id, kind: "custom", title: heading || id, level: clampLevel(c.level), fromLayout: false, typed: false })
  }

  // Section FPT thiếu trong layout ⇒ chèn cạnh mục anh em cùng nhóm mẫu FPT (sau anh em đứng trước, không có thì trước
  // anh em đứng sau); nhóm chưa có mục nào ⇒ sau section FPT gần nhất đứng trước theo thứ tự mẫu
  defs.forEach((def, i) => {
    if (used.has(def.id)) return
    const sibling = (d: SectionDef) => def.parent !== undefined && d.parent === def.parent && used.has(d.id)
    const before = defs.slice(0, i).reverse()
    const anchor = before.find(sibling) ?? null
    const next = anchor ? null : (defs.slice(i + 1).find(sibling) ?? null)
    const group = anchor || next || !def.parent ? null : `${GROUP_PREFIX}${def.parent}`
    const groupAt = group ? placed.findIndex((p) => p.section_id === group) : -1
    if (groupAt >= 0) {
      // Mục con đầu tiên của heading nhóm (sau phần nối của nhóm để phần nối vẫn gộp vào nhóm)
      let at = groupAt + 1
      while (at < placed.length && placed[at].kind === "continuation") at++
      const title = defaultSectionTitle(spine, def.id, template.language)
      placed.splice(at, 0, { section_id: def.id, kind: "fpt", title, level: clampLevel(placed[groupAt].level + 1), fromLayout: false, typed: false })
    } else {
      placed.splice(...insertionPoint(placed, def, { after: anchor ?? (next ? null : (before.find((d) => used.has(d.id)) ?? null)), before: next }, template, spine))
    }
    used.add(def.id)
  })
  return placed
}

const insertionPoint = (
  placed: Placed[],
  def: SectionDef,
  anchor: { after: SectionDef | null; before: SectionDef | null },
  template: TemplateLayout,
  spine: Spine
): [number, number, Placed] => {
  const title = defaultSectionTitle(spine, def.id, template.language)
  const make = (level: number): Placed => ({ section_id: def.id, kind: "fpt", title, level: clampLevel(level), fromLayout: false, typed: false })
  if (anchor.before) {
    const at = placed.findIndex((p) => p.section_id === anchor.before!.id)
    return [at, 0, make(placed[at].level)]
  }
  if (!anchor.after) return [0, 0, make(1)]
  const at = placed.findIndex((p) => p.section_id === anchor.after!.id)
  const prev = placed[at]
  // Function mới của feature chưa có function nào trong file ⇒ mục con của feature; còn lại ⇒ cùng cấp mục đứng trước
  const level = def.parent === anchor.after.id ? prev.level + 1 : prev.level
  let end = at + 1
  while (end < placed.length && placed[end].level > prev.level) end++
  return [end, 0, make(level)]
}

// ─── số hiệu ───────────────────────────────────────────────────────

interface Numbered extends Placed {
  number: string
  renderLevel: number
}

/**
 * Heading La Mã là **phần** (T14) khi mục con gõ số đầu tiên của nó đánh số lại: số chương của mục con khác số của phần
 * (`II.` › `1 …`). La Mã làm chính số chương (`I.` › `1.1 …`) thì không phải phần.
 */
const isPart = (placed: readonly Placed[], i: number): boolean => {
  const p = placed[i]
  const value = p.fromLayout && p.typed && p.label ? romanValue(p.label) : null
  if (value === null) return false
  for (let j = i + 1; j < placed.length && placed[j].level > p.level; j++) {
    const child = placed[j]
    if (!child.fromLayout || !child.typed || !child.label || romanValue(child.label) !== null) continue
    return Number(child.label.split(".")[0]) !== value
  }
  return false
}

/** Đánh số theo cấp; phần nối không có số (gộp vào section trước); phần La Mã giữ nhãn gốc, không chiếm cấp số. */
export const numberSections = (placed: readonly Placed[]): Numbered[] => {
  const headings = placed.filter((p) => p.kind !== "continuation" && p.fromLayout)
  const typedFile = headings.length > 0 && headings.filter((p) => p.typed).length * 2 >= headings.length
  const counters: number[] = []
  let depth = 0
  /** Cấp của phần đang mở (0 = không trong phần nào): mục bên trong đánh số như thể phần không tồn tại. */
  let partLevel = 0
  return placed.map((p, i): Numbered => {
    if (p.kind === "continuation") return { ...p, number: "", renderLevel: Math.min(MAX_LEVEL, p.level) }
    if (partLevel && p.level <= partLevel) partLevel = 0
    if (isPart(placed, i)) {
      partLevel = p.level
      counters.length = 0
      depth = 0
      return { ...p, number: p.label ?? "", renderLevel: Math.min(MAX_LEVEL, p.level) }
    }
    const level = partLevel ? p.level - partLevel : p.level
    if (typedFile && p.fromLayout && !p.typed) return { ...p, number: "", renderLevel: Math.min(MAX_LEVEL, p.level) }
    depth = Math.min(level, depth + 1)
    counters.length = depth
    counters[depth - 1] = (counters[depth - 1] ?? 0) + 1
    return { ...p, number: counters.slice(0, depth).join("."), renderLevel: Math.min(MAX_LEVEL, depth + partLevel) }
  })
}

// ─── dựng section ──────────────────────────────────────────────────

const shiftHeadings = (blocks: Block[], delta: number): Block[] =>
  delta === 0 ? blocks : blocks.map((b) => (b.type === "heading" ? { ...b, level: Math.min(MAX_LEVEL, Math.max(1, b.level + delta)) } : b))

export interface LayoutSectionsOptions {
  partial?: boolean
  diagramPng: (diagramId: string) => string | undefined
}

export interface LayoutSectionsResult {
  sections: RenderedSection[]
  /** Khoá logic → số hiệu hiển thị (phụ lục cờ, trỏ chéo). */
  numbers: Map<string, string>
  /** Khoá logic → tiêu đề hiển thị (phụ lục cờ cho section `custom:*`). */
  titles: Map<string, string>
}

export const buildLayoutSections = (
  spine: Spine,
  template: TemplateLayout,
  states: SectionStateView[],
  opts: LayoutSectionsOptions
): LayoutSectionsResult => {
  const numbered = numberSections(placeSections(spine, template))
  const numbers = new Map(numbered.filter((n) => n.number).map((n) => [n.section_id, n.number]))
  const titles = new Map(numbered.filter((n) => n.title).map((n) => [n.section_id, n.title]))
  const stateById = new Map(states.map((s) => [s.id, s]))
  const customById = new Map<string, CustomSection>(spine.custom_sections.map((c) => [`${CUSTOM_PREFIX}${c.id}`, c]))

  const out: RenderedSection[] = []
  /** Cấp layout (chưa chuẩn hoá) của từng section trong `out` — tìm section chủ của phần nối. */
  const levels: number[] = []
  const push = (section: RenderedSection, level: number) => {
    out.push(section)
    levels.push(level)
  }
  for (const n of numbered) {
    const base = { id: n.section_id, number: n.number, heading: n.title, level: n.renderLevel }
    if (n.kind === "group") {
      push({ ...base, blocks: [] }, n.level)
      continue
    }
    if (n.kind === "custom" || n.kind === "continuation") {
      const blocks = customBlocks(customById.get(n.section_id)?.blocks ?? [])
      if (n.kind === "continuation") {
        // Chủ = section gần nhất phía trước có cấp nhỏ hơn (phần nối có cấp = cấp chủ + 1, xem import/step-plan.ts)
        let owner = levels.length - 1
        while (owner >= 0 && levels[owner] >= n.level) owner--
        const target = out[owner >= 0 ? owner : out.length - 1]
        if (target) {
          target.blocks = [...blocks, ...target.blocks]
          continue
        }
      }
      push({ ...base, heading: base.heading || "—", blocks }, n.level)
      continue
    }
    const state = stateById.get(n.section_id)
    const ctx: SectionRenderContext = {
      number: n.number,
      diagramPng: opts.diagramPng,
      numberOf: (id) => numbers.get(id),
      language: template.language,
      ...(state?.status !== undefined ? { status: state.status } : {}),
      ...(state?.awaiting_reaccept !== undefined ? { awaiting_reaccept: state.awaiting_reaccept } : {})
    }
    const section = renderSection(spine, n.section_id, ctx)
    if (opts.partial && section.blocks.length === 0) continue
    push({ ...section, heading: n.title, level: n.renderLevel, blocks: shiftHeadings(section.blocks, n.renderLevel - section.level) }, n.level)
  }
  return { sections: out, numbers, titles }
}
