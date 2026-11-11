/**
 * Layout + kế hoạch step theo template người dùng (mode 1 v2 — FLF-183; plan v2 §5, D2/D6). Hàm thuần.
 * - Layout: thứ tự + tiêu đề các mục của file upload. Heading mở một section FPT mới ⇒ giữ section đó; heading con
 *   cùng section với mục bao nó ⇒ không thành mục riêng (nội dung đã trích vào section FPT); heading không khớp section
 *   FPT nào, hoặc lặp một section FPT đã gặp ở chỗ khác ⇒ **mục riêng** `custom:<id>`, khối bên dưới giữ nguyên văn.
 * - Kế hoạch step: mẫu FPT **không bắt buộc** (FLF-312 — bản xuất theo template người dùng upload, bỏ D6). Step sở hữu
 *   section có nội dung ⇒ `applied`; file có đầu mục mà chưa trích được dữ liệu ⇒ `enabled` (chạy được, tắt được); file
 *   không có đầu mục ⇒ `hidden` như Brief (B-*) và S-1.x — bật nếu muốn AI soạn thêm. Step không sở hữu section
 *   (S-8.2, S-8.4, S-9.x) luôn chạy.
 * - Seed: op đặt `steps[]` (accepted / pending / skipped), vòng S-5 theo màn, `progress` — áp sau lô thực thể của finalize.
 */

import { loadStepRegistry, loopKeys, orderedSteps, type PhaseId } from "../pipeline/step-registry.js"
import { sectionHasData } from "../spine/deterministic-check.js"
import { FEATURE_OWNER_STEPS, FIXED_OWNER_STEPS } from "../spine/section-registry.js"
import type { Op } from "../spine/op.types.js"
import type { CustomBlock, CustomSection, OriginalDiagram, Spine, StepState } from "../spine/spine.types.js"
import type { DocBlockKind, MentionEntity } from "./import.constants.js"
import {
  isSegmentedSection,
  printableIn,
  PROJECT_SEGMENT_FIELDS,
  sectionItemKeys,
  segmentHash,
  segmentItemHashes,
  segmentItemKey,
  type SectionSegments,
  type SegmentMention,
  type SegmentPart
} from "../spine/segment-hash.js"
import { idKey } from "./extracted-entities.js"
import { scanCodeMentions, scanNameMentions, type NamedEntity } from "./mentions.js"
import { UNMAPPED_SECTION } from "./import.constants.js"
import { targetsOf } from "./extract-targets.js"
import { isInstructionText, isRealText, tableBodyHasRealText } from "../../shared/utils/instruction-text.js"
import { withSlotParents } from "./content-slots.js"
import type { LayoutEntry, StepPlanItem } from "./template-profile.model.js"
import type { FunctionOriginalBlock } from "../render/function-original.js"

export const CUSTOM_SECTION_PREFIX = "custom:"
export const customSectionKey = (id: string): string => `${CUSTOM_SECTION_PREFIX}${id}`

/**
 * Section chủ của một **phần nối** (mục riêng tiêu đề rỗng): mục gần nhất phía trước có cấp nhỏ hơn — đúng mục mà
 * assemble gộp khối của phần nối vào (xem `render/layout-sections.ts`). Không tìm được ⇒ null.
 */
export const continuationOwnerSection = (layout: readonly LayoutEntry[], sectionId: string): string | null => {
  const at = layout.findIndex((e) => e.section_id === sectionId)
  if (at < 0) return null
  for (let i = at - 1; i >= 0; i--) if (layout[i].level < layout[at].level) return layout[i].section_id
  return null
}
const customId = (n: number): string => `CS${String(n).padStart(2, "0")}`
const clampLevel = (level: number | null): number => Math.min(9, Math.max(1, level ?? 1))

/** Section do step feature sở hữu — đại diện mọi `feature:*` trong kế hoạch. */
export const FEATURE_SECTIONS = "feature:*"

/** Block tối thiểu (DocBlock đã lưu, theo thứ tự tài liệu). */
export interface LayoutBlock {
  block_id: string
  kind: DocBlockKind
  level: number | null
  text: string
  /** Section của block sau finalize (heading gần nhất phía trên), `null` nếu nhóm / không khớp. */
  section_id: string | null
  rows?: string[][] | null
  /** Part ảnh trong file gốc (phase 5, T3) — mục riêng giữ lại để render nhúng ảnh gốc. */
  image_ref?: string | null
  /** Ảnh là sơ đồ I-4 đọc được (§4.13) — giữ nguyên hình của người dùng, đánh dấu để ẩn PlantUML cùng loại. */
  diagram?: OriginalDiagram | null
  /** FLF-362: nhãn số Word tự đánh của heading — layout giữ lại để hiển thị / in đúng số của file. */
  number_label?: string | null
}

/**
 * Heading lặp lại một section FPT đã gặp (mẫu IEEE: Reliability + Availability ⇒ 4.2.2) — mục riêng `custom_id` cùng các
 * khối nằm dưới nó. Finalize dùng khối để biết phần tử Spine nào trích từ heading này (`sectionSlices`).
 */
export interface LayoutSlice {
  custom_id: string
  section_id: string
  block_ids: string[]
}

/**
 * Đoạn của một mục FPT `fixed:*` theo thứ tự file (FLF-366): `original` = dãy khối không trích được, giữ ở phần nối
 * `custom_id` (một dãy một phần nối); `spine` = một khối đã trích (khối gốc giữ để in nguyên văn).
 */
export type LayoutSegmentPart =
  | { kind: "original"; custom_id: string }
  | { kind: "spine"; block_ids: string[]; blocks: CustomBlock[] }
  /** Heading con của mục (cấp theo file) — giữ đúng kiểu heading khi in, không vào Spine. */
  | { kind: "heading"; text: string; level: number }

export interface LayoutSegment {
  section_id: string
  parts: LayoutSegmentPart[]
}

export interface LayoutResult {
  layout: LayoutEntry[]
  customSections: CustomSection[]
  slices: LayoutSlice[]
  /** FLF-366: đoạn của từng mục FPT `fixed:*` có trong file (kể cả mục chỉ có heading). */
  segments: LayoutSegment[]
  /** FLF-378 (`templateOnly`): mọi khối dưới heading của mẫu, theo mục (`section_id` của layout) — nguồn của `template_context`. */
  contextBlocks: { section_id: string; block: CustomBlock }[]
}

const toCustomBlock = (b: LayoutBlock): CustomBlock | null => {
  const text = b.text.trim()
  switch (b.kind) {
    case "table":
      return { kind: "table", text: "", rows: b.rows ?? [], image_ref: null }
    case "image":
      return { kind: "image", text, rows: null, image_ref: b.image_ref ?? null, ...(b.diagram ? { diagram: b.diagram } : {}) }
    case "list_item":
      return text ? { kind: "list_item", text, rows: null, image_ref: null } : null
    case "paragraph":
    case "caption":
    case "unsupported":
      return text ? { kind: "paragraph", text, rows: null, image_ref: null } : null
    default:
      // ô / hàng bảng đã nằm trong khối bảng
      return null
  }
}

/**
 * Layout + mục riêng từ block đã lưu và bảng heading → section (id thật sau finalize).
 * `unmappedBlockIds` (I-4 báo không trích được) và mọi khối dưới heading nhóm (`group:*`, không trích) ⇒ **phần nối**
 * của section: mục riêng tiêu đề rỗng, cấp = cấp section + 1, đứng sau section trong layout — assemble gộp khối của nó
 * vào đầu section đó (FLF-184), để render từ Spine không mất văn xuôi của file gốc.
 * FLF-366: mục FPT `fixed:*` được **chia đoạn** theo thứ tự file — mỗi dãy khối không trích được (kể cả heading con của
 * mục, thành đoạn chữ) là một phần nối riêng, mỗi khối đã trích là một đoạn `spine`; bản in đi qua các đoạn theo thứ tự
 * gốc thay vì gộp phần nối lên đầu mục.
 */
export const buildLayout = (
  blocks: LayoutBlock[],
  headingSections: ReadonlyMap<string, string>,
  unmappedBlockIds: ReadonlySet<string> = new Set(),
  /**
   * FLF-366: chia đoạn mục FPT. Tắt cho mẫu bắt buộc (`template_intent = fixed`, chế độ 3): file upload là mẫu để điền
   * (bản xuất điền vào chính file đó — FLF-371), không phải SRS cần in nguyên văn.
   */
  options: {
    segment?: boolean
    /**
     * FLF-378 (luồng C — dự án mới theo mẫu bắt buộc): file là **mẫu**, không phải dữ liệu. Mục riêng không giữ nguyên văn
     * (chữ ví dụ / hướng dẫn không lọt vào bản in); mọi khối được gom vào `contextBlocks` theo mục.
     */
    templateOnly?: boolean
  } = {}
): LayoutResult => {
  const segmentOn = options.segment ?? true
  const templateOnly = options.templateOnly === true
  const contextBlocks: LayoutResult["contextBlocks"] = []
  const layout: LayoutEntry[] = []
  const customSections: CustomSection[] = []
  const slices: LayoutSlice[] = []
  /** Heading lặp đang mở — gom khối để biết phần tử nào trích từ heading này. */
  let slice: LayoutSlice | null = null
  const seen = new Set<string>()
  const stack: { level: number; section: string; entry: LayoutEntry }[] = []
  /** Mục riêng đang nhận nguyên văn mọi khối. */
  let current: CustomSection | null = null
  /**
   * Mục riêng của heading lặp lại một section FPT có trích (FLF-252 — mẫu IEEE: Reliability + Availability ⇒ 4.2.2): nội dung
   * đã trích vào Spine, mục này chỉ giữ nguyên văn phần không trích được (văn xuôi I-4 báo, ảnh) — không in hai lần. Phần tử
   * trích từ chính heading này in dưới nó (`sectionSlices`), không dồn lên lần đầu của section.
   */
  let currentRepeats = false
  /** Section FPT / nhóm đang mở — khối không trích được thành phần nối của nó. */
  let owner: LayoutEntry | null = null
  const continuations = new Map<LayoutEntry, CustomSection>()
  /** FLF-366: đoạn của mục FPT `fixed:*` đang mở. */
  const segments: LayoutSegment[] = []
  const segmentOf = new Map<LayoutEntry, LayoutSegment>()

  const newCustom = (heading: string, level: number): CustomSection => {
    const section: CustomSection = { id: customId(customSections.length + 1), heading, level, blocks: [], source: "import" }
    customSections.push(section)
    return section
  }
  const continuationOf = (entry: LayoutEntry): CustomSection => {
    let section = continuations.get(entry)
    if (!section) {
      section = newCustom("", clampLevel(entry.level + 1))
      continuations.set(entry, section)
      layout.push({ order: layout.length, heading_text: "", level: section.level, section_id: customSectionKey(section.id) })
    }
    return section
  }
  /** Phần nối của dãy nguyên văn đang mở trong mục chia đoạn — khối đã trích chen giữa ⇒ dãy sau là phần nối mới. */
  const runOf = (entry: LayoutEntry, segment: LayoutSegment): CustomSection => {
    const last = segment.parts[segment.parts.length - 1]
    if (last?.kind === "original") return customSections.find((c) => c.id === last.custom_id)!
    const section = newCustom("", clampLevel(entry.level + 1))
    layout.push({ order: layout.length, heading_text: "", level: section.level, section_id: customSectionKey(section.id) })
    segment.parts.push({ kind: "original", custom_id: section.id })
    return section
  }

  for (const b of blocks) {
    if (b.kind === "heading" && b.level !== null) {
      while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop()
      const enclosing = stack[stack.length - 1] ?? null
      const mapped = headingSections.get(b.block_id) ?? UNMAPPED_SECTION
      const heading = b.text.trim()
      if (mapped !== UNMAPPED_SECTION && mapped === enclosing?.section) {
        // heading con của chính section đó — nội dung đã trích vào section FPT; khối sau nó lại thuộc section đó
        stack.push({ level: b.level, section: mapped, entry: enclosing.entry })
        current = null
        slice = null
        owner = enclosing.entry
        // FLF-378: mục con của mẫu (1.1 Purpose dưới 1 Product Overview) ⇒ ngữ cảnh mẫu ghi tên mục con để bước soạn thấy cấu trúc
        if (templateOnly && heading) {
          const label = b.number_label?.trim()
          contextBlocks.push({ section_id: mapped, block: { kind: "paragraph", text: `[Sub-section: ${label && !heading.startsWith(label) ? `${label} ${heading}` : heading}]`, rows: null, image_ref: null } })
        }
        // Mục chia đoạn: heading con ("External Systems") là chữ của file ⇒ đoạn `heading` đúng chỗ, giữ cấp của file;
        // số Word tự đánh (FLF-362) ghép lại vào chữ như file hiển thị
        const segment = segmentOf.get(owner)
        if (segment && heading) {
          const label = b.number_label?.trim()
          segment.parts.push({ kind: "heading", text: label && !heading.startsWith(label) ? `${label} ${heading}` : heading, level: clampLevel(b.level) })
        }
        continue
      }
      let section: string
      if (mapped !== UNMAPPED_SECTION && !seen.has(mapped)) {
        section = mapped
        seen.add(mapped)
        current = null
        slice = null
      } else {
        current = newCustom(heading, clampLevel(b.level))
        currentRepeats = mapped !== UNMAPPED_SECTION && !mapped.startsWith("group:")
        section = customSectionKey(current.id)
        slice = currentRepeats ? { custom_id: current.id, section_id: mapped, block_ids: [b.block_id] } : null
        if (slice) slices.push(slice)
      }
      const entry: LayoutEntry = {
        order: layout.length,
        heading_text: heading,
        level: clampLevel(b.level),
        section_id: section,
        ...(b.number_label ? { number_label: b.number_label } : {})
      }
      layout.push(entry)
      stack.push({ level: b.level, section, entry })
      owner = current ? null : entry
      if (owner && segmentOn && isSegmentedSection(section)) {
        const segment: LayoutSegment = { section_id: section, parts: [] }
        segments.push(segment)
        segmentOf.set(entry, segment)
      }
      continue
    }
    slice?.block_ids.push(b.block_id)
    const block = toCustomBlock(b)
    if (!block) continue
    if (templateOnly) {
      const sectionId = current ? customSectionKey(current.id) : owner?.section_id
      if (sectionId) contextBlocks.push({ section_id: sectionId, block })
      // Hướng dẫn trọn đoạn dưới mục FPT vẫn ghi ở layout entry (FLF-364); còn lại không thành nguyên văn của mục
      if (!current && owner && !owner.section_id.startsWith("group:") && (block.kind === "paragraph" || block.kind === "list_item") && isInstructionText(block.text)) {
        owner.template_guidance = [...(owner.template_guidance ?? []), block.text]
      }
      continue
    }
    // FLF-364 (câu 10): chữ hướng dẫn trọn đoạn dưới mục FPT / phần nhỏ ⇒ giữ nguyên văn ở layout entry (in khi mục trống),
    // không thành phần nối (in cả khi mục đã có dữ liệu)
    if (!current && owner && !owner.section_id.startsWith("group:") && (block.kind === "paragraph" || block.kind === "list_item") && isInstructionText(block.text)) {
      owner.template_guidance = [...(owner.template_guidance ?? []), block.text]
      continue
    }
    const segment = owner && !current ? segmentOf.get(owner) : undefined
    if (current) {
      if (!currentRepeats || unmappedBlockIds.has(b.block_id)) current.blocks.push(block)
    } else if (owner && segment) {
      if (unmappedBlockIds.has(b.block_id)) runOf(owner, segment).blocks.push(block)
      else segment.parts.push({ kind: "spine", block_ids: [b.block_id], blocks: [block] })
    } else if (owner && (owner.section_id.startsWith("group:") || unmappedBlockIds.has(b.block_id))) continuationOf(owner).blocks.push(block)
  }
  return { layout, customSections, slices, segments, contextBlocks }
}

/** Phần tử Spine đã trích (finalize): khoá `entity` + `id` + khối nguồn. */
export interface SlicedEntity {
  entity: string
  id: string | null
  source_block_ids: Iterable<string>
}

/** Phần tử Spine (`nfrs:NFR-03`) in dưới heading lặp `custom_id` thay vì ở lần đầu của section. */
export interface SectionSlice {
  custom_id: string
  section_id: string
  items: string[]
}

export const sliceItemKey = (entity: string, id: string): string => `${entity}:${id}`

/**
 * Chia phần tử của section FPT cho các heading lặp của nó (mẫu IEEE: Reliability + Availability ⇒ 4.2.2): phần tử thuộc
 * heading chứa **quá nửa** khối nguồn của nó. Còn lại (kể cả phần tử thêm sau qua change request) in ở lần đầu của section
 * như trước. Section không có mảng phần tử có id (Product Overview) ⇒ không chia.
 */
export const sectionSlices = (slices: readonly LayoutSlice[], entities: readonly SlicedEntity[]): SectionSlice[] => {
  const out = slices.map((s) => ({ custom_id: s.custom_id, section_id: s.section_id, items: [] as string[] }))
  const owners = new Map<string, number>()
  slices.forEach((s, i) => s.block_ids.forEach((b) => owners.set(b, i)))
  for (const e of entities) {
    if (!e.id) continue
    const sources = [...new Set(e.source_block_ids)]
    const counts = new Map<number, number>()
    for (const b of sources) {
      const at = owners.get(b)
      if (at !== undefined) counts.set(at, (counts.get(at) ?? 0) + 1)
    }
    for (const [at, n] of counts) {
      if (n * 2 > sources.length && targetsOf(slices[at].section_id).includes(e.entity)) out[at].items.push(sliceItemKey(e.entity, e.id))
    }
  }
  return out.filter((s) => s.items.length)
}

/** Mảng Spine của phần tử nhắc tới trong văn xuôi (`mentions.ts`). */
const MENTION_ARRAY: Readonly<Record<MentionEntity, string>> = {
  use_case: "use_cases",
  function: "functions",
  nfr: "nfrs",
  business_rule: "business_rules",
  screen: "screens",
  actor: "actors",
  entity: "entities",
  feature: "features"
}

const blockText = (blocks: readonly CustomBlock[]): string =>
  blocks.map((b) => (b.kind === "table" ? (b.rows ?? []).map((r) => r.join(" ")).join("\n") : b.text)).join("\n")

/** Tên / mã phần tử Spine mà văn xuôi nhắc tới, kèm tên lúc import (cờ vàng khi phần tử đổi tên / bị xoá — FLF-366). */
export const textMentions = (text: string, spine: Spine, names: readonly NamedEntity[]): SegmentMention[] => {
  const out = new Map<string, SegmentMention>()
  // FLF-361: mã trong chữ (`UC-01`) so lỏng với id Spine giữ dạng tài liệu (`UC01`) — ghi id thật của Spine
  const idOf = (array: string, id: string): string | null =>
    ((spine as unknown as Record<string, unknown>)[array] as { id?: string }[] | undefined)?.find((x) => typeof x.id === "string" && idKey(x.id) === idKey(id))?.id ?? null
  for (const m of scanCodeMentions(text)) {
    const array = MENTION_ARRAY[m.entity]
    const id = idOf(array, m.id)
    if (id) out.set(`${array}[id=${id}]`, { path: `${array}[id=${id}]`, array, id, name: null })
  }
  for (const m of scanNameMentions(text, [...names])) {
    const array = MENTION_ARRAY[m.entity]
    const name = names.find((n) => n.entity === m.entity && n.id === m.id)?.name ?? null
    out.set(`${array}[id=${m.id}]`, { path: `${array}[id=${m.id}]`, array, id: m.id, name })
  }
  return [...out.values()]
}

/** Nguồn của từng field `project` in ở mục 1 (`project.vision`…) — phần tử `project:<field>` của đoạn. */
export const projectFieldEntities = (fields: readonly { path: string; source_block_ids: readonly string[] }[]): SlicedEntity[] => {
  const sources = new Map<string, Set<string>>()
  for (const f of fields) {
    const m = /^project\.([a-z_]+)/.exec(f.path)
    if (!m || !(PROJECT_SEGMENT_FIELDS as readonly string[]).includes(m[1])) continue
    const set = sources.get(m[1]) ?? new Set<string>()
    f.source_block_ids.forEach((b) => set.add(b))
    sources.set(m[1], set)
  }
  return [...sources].map(([field, set]) => ({ entity: "project", id: field, source_block_ids: set }))
}

/**
 * Đoạn của từng mục FPT (FLF-366) cho `TemplateProfile.section_segments`: phần tử Spine thuộc đoạn `spine` chứa nhiều khối
 * nguồn của nó nhất (chỉ phần tử mục đó in ra), dấu của đoạn, sơ đồ gốc + tên / mã nhắc tới trong khối nguyên văn, và dấu
 * mọi phần tử mục in ra lúc import (`known`). `spine` = Spine sau lô thực thể import (trước khi có CR nào).
 */
export const sectionSegments = (
  segments: readonly LayoutSegment[],
  customSections: readonly CustomSection[],
  entities: readonly SlicedEntity[],
  spine: Spine,
  names: readonly NamedEntity[] = []
): SectionSegments[] => {
  const customById = new Map(customSections.map((c) => [c.id, c]))
  return segments.map((seg): SectionSegments => {
    const partOf = new Map<string, number>()
    seg.parts.forEach((p, i) => (p.kind === "spine" ? p.block_ids.forEach((b) => partOf.set(b, i)) : undefined))
    const items = seg.parts.map(() => [] as string[])
    for (const e of entities) {
      if (!e.id) continue
      const key = segmentItemKey(e.entity, e.id)
      if (!printableIn(spine, seg.section_id, key)) continue
      const counts = new Map<number, number>()
      for (const b of new Set(e.source_block_ids)) {
        const at = partOf.get(b)
        if (at !== undefined) counts.set(at, (counts.get(at) ?? 0) + 1)
      }
      const best = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
      if (best && !items[best[0]].includes(key)) items[best[0]].push(key)
    }
    const parts = seg.parts.map((p, i): SegmentPart => {
      if (p.kind === "heading") return p
      if (p.kind === "original") {
        const blocks = customById.get(p.custom_id)?.blocks ?? []
        const diagrams = blocks.flatMap((b) => (b.kind === "image" && b.image_ref && b.diagram ? [{ image_ref: b.image_ref, kind: b.diagram.kind, ...(b.diagram.owner_id ? { owner_id: b.diagram.owner_id } : {}) }] : []))
        return { kind: "original", custom_id: p.custom_id, diagrams, mentions: textMentions(blockText(blocks), spine, names) }
      }
      return { kind: "spine", items: items[i], source_hash: segmentHash(spine, items[i]), blocks: p.blocks, mentions: textMentions(blockText(p.blocks), spine, names) }
    })
    return { section_id: seg.section_id, parts, known: segmentItemHashes(spine, sectionItemKeys(spine, seg.section_id)) }
  })
}

/**
 * Nguyên văn từng mục chức năng của file (FLF-252 — in theo file gốc): mọi khối dưới heading chức năng, đúng thứ tự —
 * nhãn ("Function Trigger", "Normal Case"…), gạch đầu dòng, bảng, ảnh màn hình. Bản in dùng nguyên văn này khi chức năng
 * chưa bị change request sửa, thay cho khung dựng lại từ Spine (khung đó mất dòng Interface / Data, còn nhãn trôi nổi tuỳ
 * AI giữ đoạn nào).
 * FLF-361: chỉ bỏ heading **mở** mục (heading đầu tiên của mục — đã là tiêu đề mục); heading con ("Function trigger",
 * "Screen layout"…) giữ kiểu heading, cấp tương đối heading mở (trước đây mọi heading map vào mục đều bị bỏ ⇒ bản 0.1 mất
 * 4 tiêu đề con ở mọi mục chức năng).
 */
export const functionOriginals = (blocks: readonly LayoutBlock[], headingSections: ReadonlyMap<string, string>): Map<string, FunctionOriginalBlock[]> => {
  const out = new Map<string, FunctionOriginalBlock[]>()
  const openerLevel = new Map<string, number>()
  for (const b of blocks) {
    const section = b.section_id
    if (!section?.startsWith("function:")) continue
    if (b.kind === "heading" && headingSections.get(b.block_id) === section && !openerLevel.has(section)) {
      openerLevel.set(section, b.level ?? 0)
      continue
    }
    let block: FunctionOriginalBlock | null
    if (b.kind === "heading") {
      const text = b.text.trim()
      const base = openerLevel.get(section)
      block = text ? { kind: "heading", text, level: Math.max(1, b.level !== null && base !== undefined ? b.level - base : 1) } : null
    } else block = toCustomBlock(b)
    if (!block) continue
    out.set(section, [...(out.get(section) ?? []), block])
  }
  return out
}

/**
 * Khối có nội dung thật: ảnh; bảng có ô chữ thật **ngoài hàng tiêu đề cột** (bảng mẫu chỉ có "ID | Requirement" + hàng
 * `[FR-xxx]` là bảng trống); đoạn chữ không phải chữ hướng dẫn của mẫu (`[Describe …]`, "Mục này mô tả…" — business-flow 1.3).
 * Mẫu trống chỉ còn chữ hướng dẫn ⇒ không có nội dung (FLF-278 trên FLF-336).
 */
const hasRealContent = (b: { kind: string; text: string; rows?: string[][] | null; image_ref?: string | null }): boolean =>
  b.kind === "image" ? true : b.kind === "table" ? (b.rows ? tableBodyHasRealText(b.rows) : isRealText(b.text)) : isRealText(b.text)

/** Section có nội dung thật (khối không phải heading) — mục "chỉ có heading" hoặc chỉ có chữ hướng dẫn coi như thiếu. */
export const sectionsWithContent = (blocks: LayoutBlock[]): Set<string> => {
  const out = new Set<string>()
  for (const b of blocks) {
    if (!b.section_id || b.kind === "heading" || b.kind === "table_cell" || b.kind === "table_row") continue
    if (hasRealContent(b)) out.add(b.section_id)
  }
  return out
}

/**
 * FLF-379: heading lặp lại một mục FPT đã có heading trước (mẫu: "Reliability" rồi "3.3.4 Tính sẵn sàng" cùng mục) thành mục
 * riêng; nội dung đã trích vào Spine nên mục riêng không giữ khối ⇒ trước đây I-5 coi là trống ("Sẽ soạn"). Xét khối thật
 * nằm dưới chính heading đó (`LayoutSlice.block_ids`).
 */
export const repeatSectionsWithContent = (slices: readonly LayoutSlice[], blocks: readonly LayoutBlock[]): Set<string> => {
  const real = new Set(
    blocks.filter((b) => b.kind !== "heading" && b.kind !== "table_cell" && b.kind !== "table_row" && hasRealContent(b)).map((b) => b.block_id)
  )
  return new Set(slices.filter((s) => s.block_ids.some((id) => real.has(id))).map((s) => customSectionKey(s.custom_id)))
}

/**
 * Mục riêng (`custom:<id>`, heading mẫu không map vào mục FlintFlow) có nội dung thật. Khối dưới heading không map mang
 * `section_id = null` nên `sectionsWithContent` không thấy — trước đây mục riêng có chữ vẫn bị I-5 coi là `missing`.
 */
export const customSectionsWithContent = (sections: readonly CustomSection[]): Set<string> =>
  new Set(sections.filter((c) => c.blocks.some((b) => hasRealContent({ ...b, image_ref: b.image_ref }))).map((c) => `custom:${c.id}`))

/** Section FPT do step sở hữu (không tính function — vòng S-5 theo màn). */
export const sectionsOwnedBy = (stepId: string): string[] => [
  ...Object.entries(FIXED_OWNER_STEPS)
    .filter(([, steps]) => steps.includes(stepId))
    .map(([section]) => section),
  ...(FEATURE_OWNER_STEPS.includes(stepId) ? [FEATURE_SECTIONS] : [])
]

/** Mục suy dẫn: hệ thống tự điền (Record of Changes từ lịch sử CR) — không bao giờ "Thiếu". */
const DERIVED_SECTIONS: ReadonlySet<string> = new Set(["fixed:I"])

const isHiddenPhase = (phase: PhaseId): boolean => phase.startsWith("B-") || phase === "S-1"

const matches = (section: string, pool: Iterable<string>): boolean => {
  if (section !== FEATURE_SECTIONS) return [...pool].includes(section)
  return [...pool].some((s) => s.startsWith("feature:"))
}

/**
 * Kế hoạch step (không gồm vòng S-5 — xem `seedStepOps`).
 * `spine`: Spine **sau khi đã nạp dữ liệu trích được**. Mục nào luật cờ soi được thì "đã có nội dung" tính theo
 * **dữ liệu Spine**, không theo chữ trong file: file có đầu mục "Screen Authorization" nhưng I-4 không trích ra
 * role/permission nào ⇒ Spine trống ⇒ cờ đỏ `section_empty`. Trước đây chỗ này chỉ nhìn block của file nên step
 * được đánh `accepted` ngay từ import, người dùng thấy "đã chốt" mà cờ đỏ vẫn treo (gặp thật 2026-09-20).
 * Mục ngoài bảng luật (mục riêng, feature…) vẫn theo file như cũ.
 */
export interface StepPlanOptions {
  /**
   * FLF-378 (luồng C — dự án mới theo mẫu bắt buộc): id bước (không mang `@màn`) sở hữu các mục của mẫu. Có ⇒ file là mẫu,
   * không phải dữ liệu: bước sở hữu mục mẫu luôn `enabled` (chờ soạn), không bao giờ `applied` vì chữ ví dụ của mẫu; bước
   * không sở hữu mục nào của mẫu ⇒ `hidden`.
   */
  draftOwners?: ReadonlySet<string>
}

export const buildStepPlan = (layout: LayoutEntry[], content: ReadonlySet<string>, spine?: Spine, opts: StepPlanOptions = {}): StepPlanItem[] =>
  loadStepRegistry()
    .filter((s) => s.kind !== "loop")
    .map((s): StepPlanItem => {
      if (isHiddenPhase(s.phase)) {
        return { step_id: s.id, state: "hidden", section_ids: [], reason: "Không sinh đầu mục - bật nếu muốn AI phân tích lại ý tưởng" }
      }
      const owned = sectionsOwnedBy(s.id)
      if (!owned.length) return { step_id: s.id, state: "applied", section_ids: [], reason: "Bước ghép / kiểm tra tài liệu - luôn chạy" }
      if (owned.every((sec) => DERIVED_SECTIONS.has(sec))) {
        return { step_id: s.id, state: "applied", section_ids: owned, reason: "Mục tự sinh từ lịch sử thay đổi" }
      }
      if (opts.draftOwners) {
        return opts.draftOwners.has(s.id)
          ? { step_id: s.id, state: "enabled", section_ids: owned, reason: "Mục của mẫu bắt buộc - FlintFlow soạn" }
          : { step_id: s.id, state: "hidden", section_ids: owned, reason: "Mẫu không có mục này" }
      }
      const hasContent = owned.some((sec) => {
        const inSpine = spine ? sectionHasData(spine, sec) : null
        return inSpine === null ? matches(sec, content) : inSpine
      })
      if (hasContent) return { step_id: s.id, state: "applied", section_ids: owned, reason: "Có trong file, đã có nội dung" }
      // Mục FPT có mặt qua các phần nhỏ của nó (`slot:*`, FLF-278) cũng tính là có đầu mục
      const inLayout = owned.some((sec) => matches(sec, withSlotParents(layout.map((l) => l.section_id))))
      const inFile = owned.some((sec) => matches(sec, content))
      if (inFile || inLayout) {
        const reason = inFile ? "Đầu mục có trong file nhưng chưa trích được dữ liệu nào - chạy step nếu muốn AI soạn" : "Đầu mục có trong file nhưng trống - chạy step nếu muốn AI soạn"
        return { step_id: s.id, state: "enabled", section_ids: owned, reason }
      }
      return { step_id: s.id, state: "hidden", section_ids: owned, reason: "File không có đầu mục này - bật nếu muốn AI soạn thêm" }
    })

/** Trạng thái step khởi đầu theo kế hoạch: ẩn ⇒ skipped; `applied` có section (đã có nội dung) ⇒ accepted; còn lại ⇒ pending. */
const initialStatus = (item: StepPlanItem): StepState["status"] => {
  if (item.state === "hidden") return "skipped"
  if (item.state === "applied" && item.section_ids.length) return "accepted"
  return "pending"
}

export interface SeedOptions {
  /** Seq cuối của lô thực thể import — step accepted nhận `last_seq` này để section không bị coi là stale. */
  firstSeq: number | null
  lastSeq: number | null
  at: string
  /** FLF-378: như `StepPlanOptions.draftOwners` — vòng S-5 chờ soạn (bước mẫu sở hữu mục mẫu) hoặc bỏ qua, không `accepted`. */
  draftOwners?: ReadonlySet<string>
}

/**
 * Op seed `steps[]` + `progress` cho Spine vừa import (steps[] rỗng). Vòng S-5: màn có function ⇒ 5 step accepted;
 * màn không function đã là `placeholder` (spine-builder) nên bị bỏ qua.
 */
export const seedStepOps = (spine: Spine, plan: StepPlanItem[], opts: SeedOptions): Op[] => {
  const accepted = (id: string): StepState => ({ id, status: "accepted", first_seq: opts.firstSeq, last_seq: opts.lastSeq, accepted_at: opts.at })
  const steps: StepState[] = plan.map((item) => {
    const status = initialStatus(item)
    return status === "accepted" ? accepted(item.step_id) : { id: item.step_id, status, first_seq: null, last_seq: null, accepted_at: null }
  })
  const withFunctions = new Set(spine.functions.map((f) => f.screen_id ?? "nonscreen"))
  const loopTemplates = loadStepRegistry().filter((s) => s.kind === "loop")
  for (const key of loopKeys(spine)) {
    if (!withFunctions.has(key)) continue
    for (const t of loopTemplates) {
      const id = `${t.id}@${key}`
      if (!opts.draftOwners) steps.push(accepted(id))
      else steps.push({ id, status: opts.draftOwners.has(t.id) ? "pending" : "skipped", first_seq: null, last_seq: null, accepted_at: null })
    }
  }

  const probe = { ...spine, steps }
  const placeholders = new Set(spine.screens.filter((s) => s.detail_status === "placeholder").map((s) => s.id))
  const next = orderedSteps(probe).find((st) => {
    if (st.loop !== null && placeholders.has(st.loop)) return false
    const status = steps.find((s) => s.id === st.id)?.status ?? "pending"
    return status !== "accepted" && status !== "skipped"
  })
  return [
    ...steps.map((value): Op => ({ op: "add", path: "steps[]", value })),
    { op: "set", path: "progress.current_phase", value: next?.phase ?? null },
    { op: "set", path: "progress.current_step", value: next?.id ?? null }
  ]
}

/** Op thêm mục riêng vào Spine. */
export const customSectionOps = (sections: CustomSection[]): Op[] => sections.map((value): Op => ({ op: "add", path: "custom_sections[]", value }))
