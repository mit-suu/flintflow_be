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
 * - **Heading lặp một section FPT** (mẫu IEEE: Reliability + Availability ⇒ 4.2.2): phần tử trích từ heading lặp
 *   (`sectionSlices`) in dưới chính heading đó, trước khối nguyên văn của nó; lần đầu của section in phần còn lại.
 * - **Sơ đồ gốc** (§4.13): loại sơ đồ còn ảnh gốc của người dùng trong phần nối ⇒ không in hình PlantUML cùng loại.
 * - **Đoạn nguyên văn** (FLF-366, `sectionSegments`): mục FPT `fixed:*` có dữ liệu đoạn đi qua các đoạn theo thứ tự file —
 *   dãy nguyên văn (phần nối riêng) in tại chỗ, không gộp lên đầu mục; đoạn đã trích còn khớp dấu ⇒ in khối gốc, lệch ⇒
 *   chỉ phần tử của đoạn dựng lại từ Spine tại chỗ; ảnh sơ đồ gốc CR đã bỏ ⇒ sơ đồ FlintFlow cùng loại ngay sau dãy đó;
 *   phần tử mới / đã đổi mà không thuộc đoạn nào ⇒ cuối mục. PlantUML khác không in (bản 0.1 đủ đúng số hình của file).
 *   Project chưa có dữ liệu đoạn (import trước FLF-366) ⇒ in như cũ.
 */

import { createHash } from "node:crypto"
import { listSections, type SectionDef } from "../spine/section-registry.js"
import type { SectionStateView } from "../spine/section-status.js"
import { diagramKey, isOriginalStale, keptOriginalKinds, originalKey, originalSectionOf, ORIGINAL_DIAGRAM_SECTION, OWNER_DIAGRAM_KINDS } from "../spine/original-diagram.js"
import {
  asPrintedIn,
  homedItems,
  isVerbatim,
  SECTION_ITEM_ARRAYS,
  sectionItemKeys,
  segmentItemHashes,
  type SectionSegments
} from "../spine/segment-hash.js"
import type { CustomBlock, CustomSection, OriginalDiagram, Spine } from "../spine/spine.types.js"
import type { Block, InlineRun, RenderedSection, RocRow, TableCell } from "./rendered-document.types.js"
import { mediaId } from "./import-media.js"
import { appendToFileTables, conformBlocksToFileTable } from "./file-table.js"
import { elementOfKey, isLabelLine, refreshTailBlock } from "./element-tail.js"
import { functionFieldValues, patchFunctionOriginal, type FunctionFieldValues, type FunctionOriginalBlock } from "./function-original.js"
import { defaultSectionTitle, functionDiagramBlocks, generatedDiagramBlocks, renderContentSlot, renderSection, type SectionRenderContext } from "./section-renderer.js"
import { bindFixedTemplateSlots, isContentSlot, slotParents } from "../import/content-slots.js"
import { isInstructionText, isRealText, splitInstruction, tableBodyHasRealText, tableHasRealText } from "../../shared/utils/instruction-text.js"

/** Một mục layout (cùng hình `LayoutEntry` của `import/template-profile.model.ts`). */
export interface TemplateLayoutEntry {
  order: number
  heading_text: string
  level: number
  section_id: string
  /** FLF-362: nhãn số Word tự đánh của heading gốc ("2.1.", "II.") — không nằm trong `heading_text`. */
  number_label?: string
  /** FLF-364 (câu 10): nguyên văn chữ hướng dẫn của mẫu dưới heading — in khi mục chưa có dữ liệu. */
  template_guidance?: string[]
}

/** Restore headings omitted by old aggregate bindings, using the source as the authority. */
export const repairFixedTemplateLayout = (
  layout: readonly TemplateLayoutEntry[],
  sourceHeadings: readonly { block_id: string; heading_text: string; level: number; section_id: string }[]
): TemplateLayoutEntry[] => {
  const ordered = [...layout].sort((a, b) => a.order - b.order)
  const remaining = new Set(ordered.filter((e) => e.heading_text.trim()))
  const continuations = new Map<TemplateLayoutEntry, TemplateLayoutEntry[]>()
  let owner: TemplateLayoutEntry | undefined
  for (const entry of ordered) {
    if (entry.heading_text.trim()) owner = entry
    else if (owner) continuations.set(owner, [...(continuations.get(owner) ?? []), entry])
  }
  const result: TemplateLayoutEntry[] = []
  const used = new Set<string>()
  for (const source of sourceHeadings) {
    const existing = [...remaining].find((e) => e.heading_text.trim() === source.heading_text.trim())
    if (existing) remaining.delete(existing)
    const bound = bindFixedTemplateSlots([{ ...source, section_id: existing?.section_id ?? source.section_id }])[0]
    let id = bound.section_id
    if (id === "unmapped" || /^(feature|function):@/.test(id) || used.has(id)) id = `group:source:${source.block_id}`
    used.add(id)
    result.push({ order: result.length, heading_text: source.heading_text, level: source.level, section_id: id })
    if (existing?.section_id.startsWith("custom:") && existing.section_id !== id) {
      result.push({ order: result.length, heading_text: "", level: source.level + 1, section_id: existing.section_id })
    }
    for (const continuation of existing ? continuations.get(existing) ?? [] : []) {
      result.push({ ...continuation, order: result.length, level: source.level + 1 })
    }
  }
  return result
}

export interface TemplateLayout {
  layout: readonly TemplateLayoutEntry[]
  language: string
  /** FLF-390: họ mẫu của file (`fpt` / `ieee29148` / `mixed`) — mẫu IEEE có mục "Phân tán" in sơ đồ triển khai. */
  family?: string
  /** T15: dòng Record of Changes của file gốc — in trước lịch sử FlintFlow. */
  legacyRecord?: readonly RocRow[]
  /**
   * FLF-252: id chức năng đọc từ bảng Non-Screen Functions của file. Có ⇒ bảng 3.1.4 in đúng các chức năng này (+ chức năng
   * không màn thêm sau, chưa có mục trong file), và chức năng chỉ có ở bảng không được chèn mục 3.x.y khi chưa có chi tiết.
   */
  nonScreenTable?: readonly string[]
  /**
   * FLF-252 — in theo file gốc: nguyên văn từng mục chức năng của file + dấu nội dung chức năng lúc nhập. Dấu còn khớp
   * (chưa change request nào sửa chức năng đó) ⇒ mục in nguyên văn file; lệch ⇒ in từ Spine như cũ.
   */
  functionOriginals?: readonly FunctionOriginal[]
  /**
   * Mẫu IEEE: heading lặp lại một section FPT (`custom_id`, vd Availability dưới 4.2.2) + phần tử trích từ nó
   * (`nfrs:NFR-03`). Phần tử in dưới heading đó, lần đầu của section chỉ in phần còn lại (kể cả phần tử thêm sau).
   */
  sectionSlices?: readonly SectionSliceView[]
  /**
   * Mẫu bắt buộc (`Project.template_intent = fixed`, chế độ 3 — business-flow 2.10): chỉ in đúng các mục của mẫu, **không
   * chèn** heading FlintFlow mẫu không có. Dữ liệu chức năng in trong bảng của mục chức năng gốc;
   * `omittedSectionIds` báo các vùng dữ liệu không có chỗ trong mẫu.
   */
  fixedTemplate?: boolean
  /** FLF-366: đoạn nguyên văn của từng mục FPT `fixed:*` (`TemplateProfile.section_segments`). Không có ⇒ in như cũ. */
  sectionSegments?: readonly SectionSegments[]
}

export interface SectionSliceView {
  custom_id: string
  section_id: string
  items: readonly string[]
}

/** Spine chỉ giữ (`keep = true`) hoặc bỏ các phần tử `entity:id` trong `items` — chỉ đụng mảng có mặt trong `items`. */
export const filterSliceItems = (spine: Spine, items: ReadonlySet<string>, keep: boolean): Spine => {
  const entities = new Set([...items].map((k) => k.slice(0, k.indexOf(":"))))
  const out: Record<string, unknown> = { ...spine }
  for (const entity of entities) {
    const list = (spine as unknown as Record<string, unknown>)[entity]
    if (!Array.isArray(list)) continue
    out[entity] = list.filter((x: { id?: string }) => items.has(`${entity}:${x.id}`) === keep)
  }
  return out as unknown as Spine
}

/**
 * Spine chỉ còn phần tử `keep` (`business_rules:BR-01`, `project:vision`) trong các mảng mục `sectionId` in ra — mảng chỉ
 * dùng để tra tên giữ nguyên — và không còn sơ đồ (FLF-366: dựng lại một đoạn / phần tử cuối mục).
 */
export const segmentSpine = (spine: Spine, sectionId: string, keep: ReadonlySet<string>, diagrams: Spine["diagrams"] = []): Spine => {
  const out: Record<string, unknown> = { ...spine, diagrams }
  for (const array of SECTION_ITEM_ARRAYS[sectionId] ?? []) {
    if (array === "project") {
      out.project = {
        ...spine.project,
        vision: keep.has("project:vision") ? spine.project.vision : null,
        goals: keep.has("project:goals") ? spine.project.goals : [],
        release_scope: keep.has("project:release_scope") ? spine.project.release_scope : { ...spine.project.release_scope, in: [], out: [] }
      }
      continue
    }
    const list = (spine as unknown as Record<string, unknown>)[array]
    if (Array.isArray(list)) out[array] = list.filter((x: { id?: string }) => keep.has(`${array}:${x.id}`)).map((x: Record<string, unknown>) => asPrintedIn(sectionId, array, x))
  }
  return out as unknown as Spine
}

export interface FunctionOriginal {
  section_id: string
  source_hash: string
  blocks: readonly FunctionOriginalBlock[]
  /** FLF-361: chữ từng trường lúc import — CR chỉ sửa khối chứa phần tử đã đổi. Dữ liệu cũ không có ⇒ dựng lại cả mục. */
  field_values?: Readonly<FunctionFieldValues>
}

/**
 * Dấu nội dung một chức năng (không gồm thứ tự / tính năng — đổi vị trí không phải sửa nội dung). Lệch so với lúc nhập ⇒
 * chức năng đã được sửa qua change request, mục in từ Spine.
 */
export const functionSourceHash = (f: Spine["functions"][number]): string =>
  createHash("sha1")
    .update(
      JSON.stringify([f.name, f.screen_id, f.trigger, f.description, f.normal, f.abnormal, f.validations.map((v) => [v.kind, v.statement]), f.business_rule_ids, f.priority])
    )
    .digest("hex")
    .slice(0, 16)

const CUSTOM_PREFIX = "custom:"
const GROUP_PREFIX = "group:"
const MAX_LEVEL = 6

/** Số gõ tay ở đầu heading (`1.2 Scope`, `IV. NFR`) — cùng mẫu `import/text-similarity.ts` `splitHeadingNumber`. */
const TYPED_NUMBER = /^\s*((?:\d{1,2}\.)*\d{1,2}|[IVX]{1,4})\.?[\s ]+(.*)$/

const splitTypedNumber = (text: string): { typed: boolean; title: string; label: string } => {
  const m = TYPED_NUMBER.exec(text)
  return m && m[2].trim() ? { typed: true, title: m[2].trim(), label: m[1] } : { typed: false, title: text.trim(), label: "" }
}

/**
 * Số của heading gốc (FLF-362): số gõ tay trong chữ, không có thì nhãn số Word tự đánh (`number_label`, chữ giữ nguyên).
 * `typed` = heading có số trong file (gõ tay hoặc Word tự đánh).
 */
const fileNumber = (text: string, numberLabel?: string | null): { typed: boolean; title: string; label: string } => {
  const typed = splitTypedNumber(text)
  if (typed.typed) return typed
  const label = numberLabel?.trim()
  return label ? { typed: true, title: text.trim(), label } : typed
}

/** Nhãn số bỏ dấu kết ("2.1." ⇒ "2.1", "II." ⇒ "II", "A)" ⇒ "A") — để so với số đếm theo cấp. */
const bareLabel = (label: string): string => label.trim().replace(/[.)\s]+$/, "")

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

/** `slot`: heading mẫu nhận một phần dữ liệu Spine (`slot:*`, FLF-278 — `import/content-slots.ts`). */
type EntryKind = "fpt" | "group" | "custom" | "continuation" | "slot"

interface Placed {
  sourceOrder?: number
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
  /** FLF-364 (câu 10): chữ hướng dẫn của mẫu dưới heading (mục FPT / phần nhỏ). */
  guidance?: readonly string[]
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

/**
 * Khối nguyên văn: đoạn · danh sách (gộp dòng liền nhau) · bảng · ảnh. Ảnh có `image_ref` + `imagePng` ⇒ khối ảnh thật
 * (tham chiếu ảnh gốc của file upload — phase 5, T3); không có ⇒ dòng chú thích như trước.
 */
/** Chỗ đặt hình vẽ lại (bug #16): khối ảnh không còn file nhưng giữ `diagram` ⇒ hình FlintFlow in đúng chỗ đó. */
export const redrawSlotOf = (b: CustomBlock): OriginalDiagram | null => (b.kind === "image" && !b.image_ref && b.diagram ? b.diagram : null)

export const customBlocks = (
  blocks: readonly CustomBlock[],
  imagePng?: (imageRef: string) => string | undefined,
  redrawn?: (d: OriginalDiagram) => Block[]
): Block[] => {
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
      case "image": {
        const slot = redrawSlotOf(b)
        if (slot) {
          out.push(...(redrawn?.(slot) ?? []))
          break
        }
        const png = b.image_ref ? imagePng?.(b.image_ref) : undefined
        if (png) out.push({ type: "image", png, ...(b.text.trim() ? { caption: b.text.trim() } : {}) })
        else out.push({ type: "paragraph", runs: [{ text: b.text.trim() ? `[Image: ${b.text.trim()}]` : "[Image]", italic: true }] })
        break
      }
    }
  }
  return out
}

/**
 * FLF-364 (câu 10): chữ hướng dẫn của mẫu (`[…]` / `{…}`) chỉ in khi mục chưa có dữ liệu — mục riêng có nội dung thật (ảnh,
 * bảng / đoạn có chữ thật, kể cả thêm qua CR) ⇒ bỏ đoạn hướng dẫn, bỏ đoạn ngoặc hướng dẫn trong câu, ô bảng chỉ có hướng dẫn
 * để trống. Khối vẫn nằm trong Spine (ngữ cảnh khi soạn) — xoá hết dữ liệu thì hướng dẫn in lại.
 */
export const guidanceWhileEmpty = (blocks: readonly CustomBlock[]): CustomBlock[] => {
  const filled = blocks.some((b) => b.kind === "image" || (b.kind === "table" ? tableHasRealText(b.rows) : isRealText(b.text)))
  if (!filled) return [...blocks]
  return blocks.flatMap((b): CustomBlock[] => {
    if (b.kind === "table") return [{ ...b, rows: (b.rows ?? []).map((r) => r.map((c) => (isInstructionText(c) ? "" : splitInstruction(c).text))) }]
    if (b.kind !== "paragraph" && b.kind !== "list_item") return [b]
    const text = splitInstruction(b.text).text
    return text ? [{ ...b, text }] : []
  })
}

/** Khối hướng dẫn của mẫu cho mục FPT / phần nhỏ chưa có dữ liệu — nguyên văn như file upload. */
const guidanceBlocks = (guidance: readonly string[] | undefined): Block[] => (guidance ?? []).filter((t) => t.trim()).map((t) => ({ type: "paragraph", runs: runs(t) }))

// ─── xếp chỗ ───────────────────────────────────────────────────────

const clampLevel = (level: number): number => Math.min(9, Math.max(1, Math.round(level)))

/** Mục riêng thêm tay chưa có tiêu đề — không in khoá thô `custom:CS07` vào tài liệu. */
const untitledCustom = (language: string): string => (language === "vi" ? "Mục bổ sung" : "Additional Section")

/** Chức năng có chi tiết riêng (kích hoạt, luồng, kiểm tra) — đủ để thành mục 3.x.y. */
const hasDetail = (f: Spine["functions"][number]): boolean =>
  f.trigger.trim().length > 0 || f.normal.length > 0 || f.abnormal.length > 0 || f.validations.length > 0

/**
 * Mục FPT KHÔNG chèn vào bản in theo layout file (FLF-252):
 * - chức năng chỉ có ở bảng Non-Screen Functions của file (không màn, chưa có chi tiết): file chỉ liệt kê nó trong bảng
 *   3.1.4; chèn mục 3.x.y cho nó làm lệch số mục gốc ("3.8.3 View Subscription Status" thành "3.8.8");
 * - tính năng file không có heading mà không có mục chức năng nào sẽ chèn dưới nó (tính năng lấy từ cột Feature của bảng
 *   màn / bảng 3.1.4; chức năng có mục trong file vẫn in đúng chỗ của file): heading rỗng file gốc không có.
 */
export const sectionsNotInserted = (spine: Spine, template: TemplateLayout): Set<string> => {
  const inLayout = new Set(template.layout.map((e) => e.section_id))
  const listed = new Set(template.nonScreenTable ?? [])
  const out = new Set<string>()
  for (const f of spine.functions) {
    if (!inLayout.has(`function:${f.id}`) && listed.has(f.id) && f.screen_id === null && !hasDetail(f)) out.add(`function:${f.id}`)
  }
  const inserted = (f: Spine["functions"][number]) => !inLayout.has(`function:${f.id}`) && !out.has(`function:${f.id}`)
  for (const feature of spine.features) {
    const id = `feature:${feature.id}`
    if (!inLayout.has(id) && !spine.functions.some((f) => f.feature_id === feature.id && inserted(f))) out.add(id)
  }
  if (template.fixedTemplate) {
    // TechMart 11/11 (user chốt): mẫu cố định vẫn chèn feature / chức năng MỚI (CR thêm use case có chức năng riêng) dưới
    // đúng feature — chương chức năng là phần lặp của mẫu; mục khác ngoài khung mẫu vẫn không chèn
    // Chỉ khi khung mẫu vốn có mục feature / chức năng riêng; mẫu in chức năng thành bảng (FU, `slot:*`) thì chèn sẽ in trùng
    const repeats = [...inLayout].some(isRepeatingSection)
    for (const def of listSections(spine)) if (!inLayout.has(def.id) && !(repeats && isRepeatingSection(def.id))) out.add(def.id)
  }
  // Mục FPT đã in qua các phần nhỏ của nó (`slot:*`) ⇒ không chèn lại cả mục (dữ liệu in hai lần)
  for (const id of inLayout) for (const parent of slotParents(id)) if (!inLayout.has(parent)) out.add(parent)
  return out
}

/**
 * Chức năng in ở bảng Non-Screen Functions (3.1.4) của bản in theo layout file (FLF-252): đúng các dòng bảng 3.1.4 của file
 * + chức năng không màn thêm sau chưa có mục trong file. Chức năng có mục riêng trong file (có màn nhưng đặc tả không ghi
 * tên màn khớp bảng màn) không vào bảng. File cũ chưa ghi danh sách ⇒ `null` (bảng theo cách cũ: mọi chức năng không màn).
 */
export const nonScreenTableIds = (spine: Spine, template: TemplateLayout): Set<string> | null => {
  if (!template.nonScreenTable?.length) return null
  const inLayout = new Set(template.layout.map((e) => e.section_id))
  const listed = new Set(template.nonScreenTable)
  return new Set(spine.functions.filter((f) => f.screen_id === null && (listed.has(f.id) || !inLayout.has(`function:${f.id}`))).map((f) => f.id))
}

/** Mục layout còn dùng được + mục FPT chèn thêm, theo thứ tự tài liệu. */
export const placeSections = (spine: Spine, template: TemplateLayout): Placed[] => {
  if (template.fixedTemplate) template = { ...template, layout: bindFixedTemplateSlots(template.layout) }
  const notInserted = sectionsNotInserted(spine, template)
  const defs = listSections(spine).filter((d) => d.id !== "fixed:I" && !notInserted.has(d.id))
  const defById = new Map(defs.map((d) => [d.id, d]))
  const customById = new Map(spine.custom_sections.map((c) => [c.id, c]))
  const placed: Placed[] = []
  const used = new Set<string>()
  const insertMissing = (candidates: readonly SectionDef[]) => insertMissingSections(placed, used, defs, candidates, spine, template)

  for (const entry of [...template.layout].sort((a, b) => a.order - b.order)) {
    const id = entry.section_id
    if (used.has(id) && !template.fixedTemplate) continue
    const { typed, title, label } = fileNumber(entry.heading_text, entry.number_label)
    const level = clampLevel(entry.level)
    if (id.startsWith(GROUP_PREFIX)) {
      placed.push({ section_id: id, kind: "group", title: title || id.slice(GROUP_PREFIX.length), level, fromLayout: true, typed, label })
    } else if (id.startsWith(CUSTOM_PREFIX)) {
      const custom = customById.get(id.slice(CUSTOM_PREFIX.length))
      if (!custom && !template.fixedTemplate) continue
      if (!custom) {
        placed.push({ section_id: id, kind: "custom", title, level, fromLayout: true, typed, label })
        used.add(id)
        continue
      }
      const heading = template.fixedTemplate ? entry.heading_text.trim() : custom.heading.trim()
      const own = heading ? fileNumber(heading, entry.number_label) : null
      placed.push({
        section_id: id,
        kind: heading ? "custom" : "continuation",
        title: own?.title ?? "",
        level: template.fixedTemplate ? level : clampLevel(custom.level),
        fromLayout: true,
        typed: own?.typed ?? false,
        label: own?.label ?? ""
      })
    } else if (isContentSlot(id)) {
      placed.push({ section_id: id, kind: "slot", title: title || id, level, fromLayout: true, typed, label, guidance: entry.template_guidance, sourceOrder: entry.order })
    } else if (defById.has(id)) {
      placed.push({
        section_id: id,
        kind: "fpt",
        title: title || defaultSectionTitle(spine, id, template.language),
        level,
        fromLayout: true,
        typed,
        label,
        guidance: entry.template_guidance
      })
    } else {
      continue
    }
    used.add(id)
  }

  if (template.fixedTemplate) {
    insertMissing(defs.filter((d) => isRepeatingSection(d.id)))
    return placed
  }

  // Mục riêng thêm tay (chat) chưa có trong layout ⇒ cuối tài liệu
  for (const c of spine.custom_sections) {
    const id = `${CUSTOM_PREFIX}${c.id}`
    if (used.has(id)) continue
    used.add(id)
    const heading = c.heading.trim()
    placed.push({ section_id: id, kind: "custom", title: heading || untitledCustom(template.language), level: clampLevel(c.level), fromLayout: false, typed: false })
  }

  insertDistribution(placed, used, spine, template)

  insertMissing(defs)
  return placed
}

/** Mục lặp của mẫu (feature, chức năng) — CR thêm được dù mẫu cố định. */
const isRepeatingSection = (id: string): boolean => /^(feature|function):/.test(id)

/**
 * Section FPT thiếu trong layout ⇒ chèn cạnh mục anh em cùng nhóm mẫu FPT (sau anh em đứng trước, không có thì trước
 * anh em đứng sau); nhóm chưa có mục nào ⇒ sau section FPT gần nhất đứng trước theo thứ tự mẫu. `candidates` ⊆ `defs`.
 */
const insertMissingSections = (placed: Placed[], used: Set<string>, defs: SectionDef[], candidates: readonly SectionDef[], spine: Spine, template: TemplateLayout): void => {
  const wanted = new Set(candidates.map((d) => d.id))
  defs.forEach((def, i) => {
    if (used.has(def.id) || !wanted.has(def.id)) return
    const sibling = (d: SectionDef) => def.parent !== undefined && d.parent === def.parent && used.has(d.id)
    const before = defs.slice(0, i).reverse()
    // TechMart 11/11: chức năng mới (chưa có trong file) đứng SAU mọi chức năng của file trong cùng feature — không chen
    // giữa làm đổi số mục của file ("Write Product Review" 3.3.3 ⇒ 3.3.4)
    const placedAt = (d: SectionDef) => placed.findIndex((p) => p.section_id === d.id)
    const lastPlacedSibling = def.id.startsWith("function:") ? (defs.filter(sibling).sort((a, b) => placedAt(b) - placedAt(a))[0] ?? null) : null
    const anchor = lastPlacedSibling ?? before.find(sibling) ?? null
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
}

const DESIGN_HEADING = /design and implementation|thiết kế và triển khai/i
const APPENDIX_HEADING = /^(appendix|appendices|appendixes|phụ lục)(\s|$)/iu

/**
 * FLF-390: mẫu IEEE (jam01 3.5 "Thiết kế và triển khai" › "Phân tán") có sơ đồ triển khai mà file chưa có mục "Phân tán" ⇒
 * chèn mục đó cuối nhóm "Thiết kế và triển khai"; chưa có cả nhóm ⇒ chèn nhóm (trước Phụ lục, không có thì cuối tài liệu).
 * Mẫu FPT không chèn (sơ đồ ở §4.1, chỉ khi người dùng yêu cầu).
 */
const insertDistribution = (placed: Placed[], used: Set<string>, spine: Spine, template: TemplateLayout): void => {
  const ieee = template.family === "ieee29148" || template.family === "mixed"
  if (!ieee || used.has("slot:distribution") || (spine.deployment_nodes ?? []).length === 0) return
  const vi = template.language.toLowerCase().startsWith("vi")
  const slot = (level: number): Placed => ({ section_id: "slot:distribution", kind: "slot", title: vi ? "Phân tán" : "Distribution", level: clampLevel(level), fromLayout: false, typed: false })
  const designAt = placed.findIndex((p) => p.fromLayout && DESIGN_HEADING.test(p.title))
  if (designAt >= 0) {
    let at = designAt + 1
    while (at < placed.length && placed[at].level > placed[designAt].level) at++
    placed.splice(at, 0, slot(placed[designAt].level + 1))
  } else {
    const appendixAt = placed.findIndex((p) => APPENDIX_HEADING.test(p.title.trim()))
    const at = appendixAt >= 0 ? appendixAt : placed.length
    const level = appendixAt >= 0 ? placed[appendixAt].level : 1
    const group: Placed = { section_id: `${GROUP_PREFIX}design_implementation`, kind: "group", title: vi ? "Thiết kế và triển khai" : "Design and Implementation", level: clampLevel(level), fromLayout: false, typed: false }
    placed.splice(at, 0, group, slot(level + 1))
    used.add(group.section_id)
  }
  used.add("slot:distribution")
}

/**
 * TechMart 11/11: mục chức năng của file ghi mã use case sau tên ("Search Products (UC-03)") ⇒ chức năng mới thêm cùng kiểu
 * ("Compare Products (UC-21)") khi chức năng đó hiện thực một use case.
 */
const USE_CASE_SUFFIX = /\((UC|US)[-_ ]?\d+[a-z]?\)\s*$/i
const withUseCaseCode = (title: string, def: SectionDef, placed: readonly Placed[], spine: Spine): string => {
  if (!def.id.startsWith("function:") || USE_CASE_SUFFIX.test(title)) return title
  const fileUsesCodes = placed.some((p) => p.section_id.startsWith("function:") && p.fromLayout && USE_CASE_SUFFIX.test(p.title))
  if (!fileUsesCodes) return title
  const fnId = def.id.slice("function:".length)
  const uc = spine.use_cases.find((u) => u.function_ids.includes(fnId))
  return uc ? `${title} (${uc.id})` : title
}

const insertionPoint = (
  placed: Placed[],
  def: SectionDef,
  anchor: { after: SectionDef | null; before: SectionDef | null },
  template: TemplateLayout,
  spine: Spine
): [number, number, Placed] => {
  const title = withUseCaseCode(defaultSectionTitle(spine, def.id, template.language), def, placed, spine)
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
  const value = p.fromLayout && p.typed && p.label ? romanValue(bareLabel(p.label)) : null
  if (value === null) return false
  for (let j = i + 1; j < placed.length && placed[j].level > p.level; j++) {
    const child = placed[j]
    if (!child.fromLayout || !child.typed || !child.label || romanValue(bareLabel(child.label)) !== null) continue
    return Number(child.label.split(".")[0]) !== value
  }
  return false
}

/**
 * Đếm số theo cấp (cấp nhảy quá 1 được kéo về cấp kế tiếp); phần nối không số (gộp vào section trước); phần La Mã giữ nhãn
 * gốc, không chiếm cấp số; mục của file không có số ⇒ không số, không chiếm số đếm.
 */
const countNumbers = (placed: readonly Placed[]): Numbered[] => {
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
      return { ...p, number: bareLabel(p.label ?? ""), renderLevel: Math.min(MAX_LEVEL, p.level) }
    }
    const level = partLevel ? p.level - partLevel : p.level
    if (p.fromLayout && !p.typed) return { ...p, number: "", renderLevel: Math.min(MAX_LEVEL, p.level) }
    depth = Math.min(level, depth + 1)
    counters.length = depth
    counters[depth - 1] = (counters[depth - 1] ?? 0) + 1
    return { ...p, number: counters.slice(0, depth).join("."), renderLevel: Math.min(MAX_LEVEL, depth + partLevel) }
  })
}

const DECIMAL_LABEL = /^\d+(\.\d+)*$/

/** Số kế tiếp của mục chèn thêm khi file đánh số không đều: anh em đứng trước + 1, không có thì mục cha + ".1". */
const nextAfter = (out: readonly Numbered[], level: number): string => {
  for (let k = out.length - 1; k >= 0; k--) {
    const q = out[k]
    if (q.kind === "continuation" || q.level > level) continue
    const bare = bareLabel(q.number)
    if (!DECIMAL_LABEL.test(bare)) return ""
    if (q.level === level) {
      const parts = bare.split(".")
      parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1)
      return parts.join(".")
    }
    return `${bare}.1`
  }
  return ""
}

/**
 * Số hiệu theo **số của file upload** (FLF-362), không đánh lại:
 * - file không có số nào (gõ tay hay Word tự đánh) ⇒ không mục nào có số;
 * - file đánh số đều (số của file = số đếm theo cấp) ⇒ đếm theo cấp trên cả tài liệu: không chèn mục thì ra đúng số file,
 *   có mục FlintFlow chèn thêm thì mục đó nhận số theo thứ tự, anh em đứng sau cùng nhánh dịch số theo;
 * - file đánh số không đều (nhảy số, chữ cái, kiểu riêng) ⇒ giữ nguyên văn số của file; mục chèn thêm lấy số kế tiếp của
 *   anh em đứng trước khi tính được (`nextAfter`).
 * Số trả ra luôn bỏ dấu kết ("1." ⇒ "1", "A)" ⇒ "A"): bản in và FE tự thêm dấu / khoảng cách sau số.
 */
export const numberSections = (placed: readonly Placed[]): Numbered[] => {
  const flat = (p: Placed, number: string): Numbered => ({ ...p, number, renderLevel: Math.min(MAX_LEVEL, p.level) })
  if (!placed.some((p) => p.fromLayout && p.kind !== "continuation" && p.typed)) return placed.map((p) => flat(p, ""))
  const sameAsFile = (n: Numbered): boolean => !!n.label && bareLabel(n.label) === bareLabel(n.number)
  const regular = countNumbers(placed.filter((p) => p.fromLayout)).every((n) => !n.typed || sameAsFile(n))
  if (regular) return countNumbers(placed)
  const out: Numbered[] = []
  for (const p of placed) {
    if (p.kind === "continuation") out.push(flat(p, ""))
    else if (p.fromLayout) out.push(flat(p, p.typed ? bareLabel(p.label ?? "") : ""))
    else out.push(flat(p, nextAfter(out, p.level)))
  }
  return out
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
  /** Fixed-template data sections without a source region; callers must surface these separately. */
  omittedSectionIds?: string[]
}

export const buildLayoutSections = (
  spine: Spine,
  template: TemplateLayout,
  states: SectionStateView[],
  opts: LayoutSectionsOptions
): LayoutSectionsResult => {
  const originalLayout = template.layout
  if (template.fixedTemplate) template = { ...template, layout: bindFixedTemplateSlots(template.layout) }
  const numbered = numberSections(placeSections(spine, template))
  // FLF-390: có mục "Phân tán" ⇒ sơ đồ triển khai in ở đó, §4.1 không in lại
  const distributionSlot = numbered.some((n) => n.section_id === "slot:distribution")
  const numbers = new Map(numbered.filter((n) => n.number).map((n) => [n.section_id, n.number]))
  const titles = new Map(numbered.filter((n) => n.title).map((n) => [n.section_id, n.title]))
  const stateById = new Map(states.map((s) => [s.id, s]))
  const customById = new Map<string, CustomSection>(spine.custom_sections.map((c) => [`${CUSTOM_PREFIX}${c.id}`, c]))
  // §4.13: sơ đồ người dùng đã có hình gốc (in ở phần nối) ⇒ không in thêm PlantUML cùng loại — một sơ đồ một hình
  const kept = keptOriginalKinds(spine)
  // FLF-366: loại sơ đồ có ảnh gốc trong một đoạn ⇒ sơ đồ FlintFlow của nó chỉ in tại chỗ ảnh đó (khi CR đã bỏ ảnh)
  const records = template.sectionSegments ?? []
  const recordedKinds = new Set<string>(records.flatMap((r) => r.parts.flatMap((p) => (p.kind === "original" ? p.diagrams.map((d) => originalKey(d.kind, d.owner_id)) : []))))
  // Bug #16: chỗ đặt hình vẽ lại (CR bỏ ảnh gốc, giữ vị trí) ⇒ hình FlintFlow chỉ in tại chỗ đó, không in ở mục mặc định
  const slotKinds = spine.custom_sections.flatMap((c) => c.blocks.flatMap((b) => { const d = redrawSlotOf(b); return d ? [originalKey(d.kind, d.owner_id)] : [] }))
  const hiddenKinds = new Set<string>([...kept, ...recordedKinds, ...slotKinds])
  // FLF-390: sequence / activity ẩn theo function chủ (`<kind>@<owner>`), không ẩn cả loại
  const contentSpine: Spine = hiddenKinds.size ? { ...spine, diagrams: spine.diagrams.filter((d) => !hiddenKinds.has(diagramKey(d))) } : spine
  const nonScreen = nonScreenTableIds(spine, template)
  // FLF-252: mục chức năng chưa bị sửa từ lúc nhập ⇒ in nguyên văn file (nhãn, gạch đầu dòng, ảnh đúng thứ tự)
  const originals = new Map((template.functionOriginals ?? []).filter((o) => o.blocks.length).map((o) => [o.section_id, o]))
  /** Khối in của mục chức năng từ nguyên văn file: chưa sửa ⇒ y nguyên văn; CR sửa ⇒ chỉ khối của trường đã đổi dựng lại. */
  const originalOf = (sectionId: string): FunctionOriginalBlock[] | null => {
    const o = originals.get(sectionId)
    const fn = o ? spine.functions.find((f) => `function:${f.id}` === sectionId) : undefined
    if (!o || !fn) return null
    if (functionSourceHash(fn) === o.source_hash) return [...o.blocks]
    return o.field_values ? patchFunctionOriginal(o.blocks, o.field_values, functionFieldValues(spine, fn)) : null
  }
  /**
   * Heading con của mục chức năng: cấp tương đối heading mục ⇒ dời theo cấp in của mục. FLF-390: ảnh sơ đồ gốc gắn phần
   * tử (sequence của function, activity của use case) mà dữ liệu đã đổi ⇒ thay bằng hình FlintFlow vẽ lại tại đúng chỗ ảnh.
   */
  const functionBlocks = (blocks: readonly FunctionOriginalBlock[], renderLevel: number, sectionId: string, number: string): Block[] => {
    const out: Block[] = []
    let run: CustomBlock[] = []
    const flush = () => {
      if (run.length) out.push(...customBlocks(guidanceWhileEmpty(run), (ref) => opts.diagramPng(mediaId(ref)), slotFor(sectionId, number)))
      run = []
    }
    for (const b of blocks) {
      const d = b.kind === "image" ? b.diagram : undefined
      if (d && OWNER_DIAGRAM_KINDS.has(d.kind) && d.owner_id && isOriginalStale(spine, d)) {
        flush()
        out.push(...functionDiagramBlocks(spine, d.owner_id, d.kind as "sequence" | "activity", contextFor(sectionId, number)))
        continue
      }
      if (b.kind === "heading") {
        flush()
        out.push({ type: "heading", level: Math.min(MAX_LEVEL, renderLevel + b.level), text: b.text })
      } else {
        const { tags: _tags, ...block } = b
        run.push(block)
      }
    }
    flush()
    return out
  }
  const fromOriginal = new Set<RenderedSection>()
  // Mẫu IEEE: phần tử của heading lặp in dưới heading đó; lần đầu của section bỏ chúng
  const sliceOf = new Map((template.sectionSlices ?? []).map((sl) => [`${CUSTOM_PREFIX}${sl.custom_id}`, sl]))
  const claimed = new Map<string, Set<string>>()
  for (const sl of template.sectionSlices ?? []) {
    const set = claimed.get(sl.section_id) ?? new Set<string>()
    sl.items.forEach((k) => set.add(k))
    claimed.set(sl.section_id, set)
  }
  const contextFor = (sectionId: string, number: string): SectionRenderContext => {
    const state = stateById.get(sectionId)
    return {
      number,
      diagramPng: opts.diagramPng,
      numberOf: (id) => numbers.get(id),
      language: template.language,
      ...(distributionSlot ? { distributionSlot: true } : {}),
      ...(template.fixedTemplate ? { fixedTemplate: true, representedSlots: new Set(template.layout.filter((e) => isContentSlot(e.section_id)).map((e) => e.section_id)) } : {}),
      ...(nonScreen ? { nonScreenFunctionIds: nonScreen } : {}),
      // FLF-361: tài liệu nhập tự do — mục chức năng dựng từ Spine theo khung FPT (Function trigger / Function description /
      // Screen layout / Function details) thay vì khung cũ không có tiêu đề con; mục tính năng không thêm dòng "Screens: …"
      ...(!template.fixedTemplate && /^(feature|function):/.test(sectionId) ? { functionLayout: "fpt" as const } : {}),
      ...(state?.status !== undefined ? { status: state.status } : {}),
      ...(state?.awaiting_reaccept !== undefined ? { awaiting_reaccept: state.awaiting_reaccept } : {})
    }
  }
  /** Bug #16: hình FlintFlow tại chỗ đặt hình vẽ lại của khối ảnh gốc đã bỏ. */
  const slotFor = (sectionId: string, number: string) => (d: OriginalDiagram): Block[] =>
    generatedDiagramBlocks(spine, d.kind, d.owner_id, contextFor(sectionId, number))
  // FLF-366: đoạn nguyên văn của mục FPT
  const segmentsOf = new Map(records.map((r) => [r.section_id, r]))
  const homed = homedItems(records)
  /** Phần nối in tại chỗ trong đoạn của mục — không gộp lên đầu mục nữa. */
  const consumed = new Set(records.flatMap((r) => r.parts.flatMap((p) => (p.kind === "original" ? [`${CUSTOM_PREFIX}${p.custom_id}`] : []))))
  const redrawn = new Set<string>()
  const originalPng = (ref: string) => opts.diagramPng(mediaId(ref))
  const segmentBlocks = (record: SectionSegments, n: Numbered): Block[] => {
    const sectionId = record.section_id
    const shifted = (section: RenderedSection): Block[] => shiftHeadings(section.blocks, n.renderLevel - section.level)
    // FLF-361: bảng dựng lại giữ cột của bảng trong file (3.1.4: Name · Trigger · Description); FLF-380: đoạn gốc là bảng ⇒
    // dựng lại thành bảng (ghép vào bảng gốc), không thành danh sách cạnh bảng cũ
    const fileHeader = (blocks: readonly CustomBlock[]): readonly string[] | undefined => blocks.find((b) => b.kind === "table" && b.rows?.length)?.rows?.[0]
    const fileTableRows = (blocks: readonly CustomBlock[]): string[][] | undefined => blocks.find((b) => b.kind === "table" && b.rows?.length)?.rows ?? undefined
    const rebuild = (items: readonly string[], blocks: readonly CustomBlock[] = [], asTable = blocks.some((b) => b.kind === "table")): Block[] => {
      const header = sectionId === "fixed:3.1.4" ? fileHeader(blocks) : undefined
      const ctx = { ...contextFor(sectionId, n.number), ...(header ? { nonScreenHeader: header } : {}), ...(asTable ? { preferTable: true } : {}) }
      const rendered = shifted(renderSection(segmentSpine(contentSpine, sectionId, new Set(items)), sectionId, ctx))
      // FLF-375: bảng dựng lại mang đúng cột của bảng trong file (không thêm cột Includes / Extends… vào bảng của khách)
      return header ? rendered : conformBlocksToFileTable(rendered, fileTableRows(blocks), sectionId)
    }
    const out: Block[] = []
    const parts = record.parts
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part.kind === "heading") {
        // Cấp tương đối với heading của mục trong file ⇒ dời theo cấp in của mục
        out.push({ type: "heading", level: Math.min(MAX_LEVEL, Math.max(1, n.renderLevel + part.level - n.level)), text: part.text })
        continue
      }
      if (part.kind === "spine") {
        // FLF-375 (B15): phần tử "tiêu đề + dòng Nhãn: giá trị" — đuôi là các đoạn không gắn phần tử ngay sau nó
        let end = i + 1
        while (end < parts.length) {
          const next = parts[end]
          if (next.kind !== "spine" || next.items.length > 0 || !next.blocks.length || !next.blocks.every(isLabelLine)) break
          end++
        }
        if (part.items.length === 1 && end > i + 1 && !isVerbatim(spine, part)) {
          const element = elementOfKey(spine, part.items[0])
          // Phần tử bị xoá ⇒ bỏ cả tiêu đề lẫn đuôi; đổi ⇒ giữ định dạng file, thay giá trị theo nhãn (không chèn bảng FlintFlow)
          if (element) {
            out.push(...customBlocks(part.blocks, originalPng, slotFor(n.section_id, n.number)))
            for (let j = i + 1; j < end; j++) {
              const tail = parts[j] as Extract<typeof part, { kind: "spine" }>
              out.push(...customBlocks(tail.blocks.map((b) => refreshTailBlock(b, element)), originalPng))
            }
          }
          i = end - 1
          continue
        }
        out.push(...(isVerbatim(spine, part) ? customBlocks(part.blocks, originalPng, slotFor(n.section_id, n.number)) : rebuild(part.items, part.blocks)))
        continue
      }
      const blocks = customById.get(`${CUSTOM_PREFIX}${part.custom_id}`)?.blocks ?? []
      // FLF-364: dãy có nội dung thật ⇒ bỏ chữ hướng dẫn của mẫu, như mọi phần nối
      out.push(...customBlocks(guidanceWhileEmpty(blocks), originalPng, slotFor(n.section_id, n.number)))
      // Ảnh sơ đồ gốc CR đã bỏ (đề xuất vẽ lại, §4.13) ⇒ sơ đồ FlintFlow cùng loại đúng chỗ ảnh; loại còn ảnh gốc ở chỗ khác thì thôi
      const present = new Set(blocks.flatMap((b) => (b.image_ref ? [b.image_ref] : [])))
      // Bug #16: khối giữ chỗ đã in hình vẽ lại ngay chỗ ảnh ⇒ không in lần nữa
      const slotted = new Set(blocks.flatMap((b) => { const d = redrawSlotOf(b); return d ? [originalKey(d.kind, d.owner_id)] : [] }))
      for (const d of part.diagrams.filter((x) => !present.has(x.image_ref))) {
        const key = originalKey(d.kind, d.owner_id)
        if (slotted.has(key)) continue
        if (kept.has(key) || redrawn.has(key)) continue
        redrawn.add(key)
        const kind = d.kind
        // FLF-390: sơ đồ gắn function ⇒ chỉ hình (và mô tả) của function đó, không dựng lại cả mục function
        if (OWNER_DIAGRAM_KINDS.has(kind)) {
          if (d.owner_id) out.push(...functionDiagramBlocks(spine, d.owner_id, kind as "sequence" | "activity", contextFor(originalSectionOf(d), n.number)))
          continue
        }
        const target = ORIGINAL_DIAGRAM_SECTION[kind]
        const diagrams = spine.diagrams.filter((d) => d.kind === kind)
        out.push(...shifted(renderSection(segmentSpine(spine, target, new Set(), diagrams), target, contextFor(target, n.number))))
      }
    }
    // Phần tử mới / đã đổi từ lúc import mà không đoạn nào in (CR thêm) ⇒ cuối mục
    const known = new Map(record.known.map((k) => [k.key, k.hash]))
    const taken = claimed.get(sectionId)
    const candidates = sectionItemKeys(spine, sectionId).filter((k) => !homed.has(k) && !taken?.has(k))
    const trailing = segmentItemHashes(spine, candidates).filter((h) => known.get(h.key) !== h.hash).map((h) => h.key)
    // phần tử mới cuối mục: cột theo bảng của file (FLF-361), không ép thành bảng (FLF-380)
    if (trailing.length) {
      const partBlocks = record.parts.flatMap((p) => (p.kind === "spine" ? p.blocks : []))
      // FLF-375: mục có bảng cùng loại phần tử ⇒ phần tử mới là dòng mới của bảng đó, không phải bảng thứ hai
      const asRows = out.some((b) => b.type === "table") ? rebuild(trailing, partBlocks, true) : []
      const merged = [...out]
      const left = asRows.length ? appendToFileTables(merged, asRows, sectionId) : asRows
      if (asRows.length && !left.some((b) => b.type === "table")) out.splice(0, out.length, ...merged, ...left)
      else out.push(...rebuild(trailing, partBlocks, false))
    }
    return out
  }

  /** Khối Spine của heading lặp — phần tử đã xoá hết ⇒ không có gì. */
  const sliceBlocks = (n: Numbered): Block[] => {
    const sl = sliceOf.get(n.section_id)
    if (!sl) return []
    const section = renderSection(filterSliceItems(contentSpine, new Set(sl.items), true), sl.section_id, contextFor(sl.section_id, n.number))
    return shiftHeadings(section.blocks, n.renderLevel - section.level)
  }

  const out: RenderedSection[] = []
  const emptyUntilMerged = new Set<RenderedSection>()
  /** Cấp layout (chưa chuẩn hoá) của từng section trong `out` — tìm section chủ của phần nối. */
  const levels: number[] = []
  const emitted = new Set<string>()
  const push = (section: RenderedSection, level: number) => {
    if (template.fixedTemplate) {
      // Only the template's own headings contribute to its outline.
      section.blocks = emitted.has(section.id) ? [] : section.blocks.map((b) => b.type === "heading" ? { type: "paragraph", runs: [{ text: b.text, bold: true }] } : b)
      emitted.add(section.id)
    }
    out.push(section)
    levels.push(level)
  }
  for (const n of numbered) {
    const base = { id: n.section_id, number: n.number, heading: n.title, level: n.renderLevel }
    if (n.kind === "group") {
      push({ ...base, blocks: [] }, n.level)
      continue
    }
    if (n.kind === "continuation" && consumed.has(n.section_id)) continue
    if (n.kind === "custom" || n.kind === "continuation") {
      const sourceBlocks = customById.get(n.section_id)?.blocks ?? []
      const kept = template.fixedTemplate
        ? sourceBlocks.filter((b) => !isInstructionText(b.text) && (b.kind !== "table" || tableBodyHasRealText(b.rows)))
        : guidanceWhileEmpty(sourceBlocks)
      const blocks = [...sliceBlocks(n), ...customBlocks(kept, (ref) => opts.diagramPng(mediaId(ref)), slotFor(n.section_id, n.number))]
      if (n.kind === "continuation") {
        // Chủ = section gần nhất phía trước có cấp nhỏ hơn (phần nối có cấp = cấp chủ + 1, xem import/step-plan.ts)
        let owner = levels.length - 1
        while (owner >= 0 && levels[owner] >= n.level) owner--
        const target = out[owner >= 0 ? owner : out.length - 1]
        if (target) {
          // Mục chức năng đang in nguyên văn file đã có sẵn mọi khối của phần nối ⇒ không gộp lần nữa
          if (!fromOriginal.has(target)) target.blocks = [...blocks, ...target.blocks]
          continue
        }
      }
      push({ ...base, heading: base.heading || "-", blocks }, n.level)
      continue
    }
    if (n.kind === "slot") {
      // Khối của phần nhỏ đánh cấp heading con từ 1 ⇒ dời theo cấp heading của mẫu
      const blocks = shiftHeadings(renderContentSlot(contentSpine, n.section_id, contextFor(n.section_id, n.number)), n.renderLevel - 1)
      if (template.fixedTemplate) {
        // A cached custom binding can carry real source prose (e.g. dependencies).
        // Rebinding its heading must retain that prose while removing template prompts.
        const sourceId = originalLayout.find((e) => e.order === n.sourceOrder)?.section_id
        const original = sourceId ? customById.get(sourceId) : undefined
        const renderedText = JSON.stringify(blocks)
        const retained = original?.blocks.filter((b) => !isInstructionText(b.text) && (b.kind !== "table" || tableBodyHasRealText(b.rows)) && (!b.text.trim() || !renderedText.includes(b.text))) ?? []
        blocks.push(...customBlocks(retained, (ref) => opts.diagramPng(mediaId(ref)), slotFor(n.section_id, n.number)))
      }
      // FLF-364 (câu 10): phần nhỏ chưa có dữ liệu ⇒ in chữ hướng dẫn của mẫu (mẫu bắt buộc thì không)
      push({ ...base, blocks: blocks.length || template.fixedTemplate ? blocks : guidanceBlocks(n.guidance) }, n.level)
      continue
    }
    const taken = claimed.get(n.section_id)
    const section = renderSection(taken ? filterSliceItems(contentSpine, taken, false) : contentSpine, n.section_id, contextFor(n.section_id, n.number))
    const record = segmentsOf.get(n.section_id)
    if (record) {
      const blocks = segmentBlocks(record, n)
      // Mục chưa có dữ liệu ⇒ chữ hướng dẫn của mẫu (FLF-364 câu 10), như mục không chia đoạn
      const rendered = { ...section, heading: n.title, level: n.renderLevel, blocks: blocks.length ? blocks : guidanceBlocks(n.guidance) }
      if (opts.partial && rendered.blocks.length === 0) emptyUntilMerged.add(rendered)
      push(rendered, n.level)
      continue
    }
    const original = originalOf(n.section_id)
    const rendered = original
      ? { ...section, heading: n.title, level: n.renderLevel, blocks: functionBlocks(original, n.renderLevel, n.section_id, n.number) }
      : {
          ...section,
          heading: n.title,
          level: n.renderLevel,
          // Mục chưa có dữ liệu ⇒ in chữ hướng dẫn của mẫu (câu 10); có dữ liệu thì không
          blocks: section.blocks.length ? shiftHeadings(section.blocks, n.renderLevel - section.level) : guidanceBlocks(n.guidance)
        }
    if (original) fromOriginal.add(rendered)
    // `partial`: mục rỗng vẫn giữ chỗ tới khi gộp xong phần nối — mục chỉ có hình gốc của người dùng (§4.13, PlantUML
    // không in) nhận khối từ phần nối ngay sau nó; bỏ sớm thì khối đó rơi vào mục đứng trước
    if (opts.partial && !template.fixedTemplate && rendered.blocks.length === 0) emptyUntilMerged.add(rendered)
    push(rendered, n.level)
  }
  const omittedSectionIds = template.fixedTemplate
    ? [...listSections(spine).map((s) => s.id), ...spine.custom_sections.map((s) => `custom:${s.id}`)].filter((id) => {
      if (id === "fixed:I" || template.layout.some((e) => e.section_id === id)) return false
      if (id.startsWith("custom:")) return !originalLayout.some((e) => e.section_id === id)
      if (template.layout.some((e) => e.section_id === "slot:functional_requirements") && /^(feature|function):/.test(id)) return false
      // Partial child slots do not claim unrepresented data in the aggregate parent.
      return renderSection(contentSpine, id, contextFor(id, "")).blocks.length > 0
    })
    : undefined
  return { sections: opts.partial ? out.filter((x) => !(emptyUntilMerged.has(x) && x.blocks.length === 0)) : out, numbers, titles, ...(omittedSectionIds ? { omittedSectionIds } : {}) }
}
