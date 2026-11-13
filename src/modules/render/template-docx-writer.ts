import { ApiError } from "../../shared/utils/api-error.js"
import { DocxPackage, MAIN_PART, readBlocks, writeStamp } from "../docx-ooxml/index.js"
import { NS, isW, wAll, wAttr, wEl, wKid, wKids, wText } from "../docx-ooxml/xml.js"
import { assignBlockIds, parseDocument } from "../import/parse.service.js"
import { exportLineage, writeDocx } from "./docx-writer.js"
import type { Block, InlineRun, RenderedDocument, RenderedSection } from "./rendered-document.types.js"
import { isInstructionText } from "../../shared/utils/instruction-text.js"
import { TABLE_ENTITIES } from "../import/table-header-dictionary.js"
import { recordColumnOfHeader } from "../import/legacy-record.js"
import type { TableMapEntry } from "../import/template-profile.model.js"
import { isPlaceholderText } from "../import/template-markers.js"
import { requestFieldUpdate } from "../template-migration/ooxml-transplant.js"

const TEMPLATE_LAYOUT_UNAVAILABLE = "TEMPLATE_LAYOUT_UNAVAILABLE"

const unavailable = (reason: string): never => {
  throw new ApiError(422, "Không thể điền nội dung vào bố cục mẫu gốc.", TEMPLATE_LAYOUT_UNAVAILABLE, { reason })
}

/**
 * Dự án "Upload SRS có sẵn" (`render/source-fidelity.ts`): file upload là bản gốc đã viết, không phải mẫu để điền.
 * - `keepSource`: mục nguyên vẹn so với lúc import ⇒ slot giữ nguyên node gốc (đoạn, bảng, ảnh, field, chú thích).
 * - `legacyRecordCount`: số dòng lịch sử đọc từ file ⇒ bảng lịch sử gốc giữ nguyên, chỉ thêm dòng mới vào cuối.
 * - Mục phải dựng lại mà có field / bookmark / công thức ⇒ giữ các đoạn đó tại chỗ; slot không ghi an toàn được ⇒ giữ
 *   nguyên slot (cảnh báo) thay vì hỏng cả file.
 */
const GROUP_OF_CUSTOM = "group:custom:"

export interface SourceWriteOptions {
  keepSource?: ReadonlySet<string>
  legacyRecordCount?: number
  /**
   * FLF-378 (luồng C, C2.5): file là **mẫu** của dự án mới — hướng dẫn, ví dụ, ngữ cảnh của mẫu không lọt vào bản in: mục
   * chưa có nội dung bỏ đoạn thân của mẫu; bảng mẫu không được điền giữ hàng tiêu đề + style, bỏ dòng mẫu.
   */
  stripTemplateText?: boolean
  /**
   * FLF-416 chế độ 4 (business-flow §3.1.2 bước 2.10): sắp lại bố cục file khách theo mẫu chuẩn FlintFlow — mục không có heading
   * trong file (mục FPT soạn thêm) ⇒ heading mới (style của heading cùng cấp trong file) + nội dung, chèn đúng vị trí trong bản
   * in (trước heading kế tiếp của file); `moveToEnd` (mục Ngoài phạm vi) ⇒ cả heading lẫn nội dung chuyển xuống cuối tài liệu.
   */
  rearrange?: { moveToEnd: readonly string[] }
}

/** Populate the imported package in place: its styles, sections and ancillary parts remain authoritative. */
export async function writeTemplateDocx(
  doc: RenderedDocument,
  template: Buffer,
  headingMap: readonly { block_id: string; section_id: string }[],
  tableMap: readonly TableMapEntry[] = [],
  sourceOptions: SourceWriteOptions = {}
): Promise<Buffer> {
  const keep = sourceOptions.keepSource
  const sourceMode = !!keep
  const pkg = await DocxPackage.load(template)
  const xml = await pkg.requireXml(MAIN_PART)
  const originalBookmarkIds = new Set(wAll(xml, "bookmarkStart").map((b) => wAttr(b, "id")))
  const blocks = assignBlockIds(await readBlocks(pkg))
  const headings = blocks.filter((b) => b.kind === "heading")
  if (!headingMap.length) unavailable("No mapped headings")
  const slots = headingMap.map((entry) => {
    const heading = headings.find((b) => b.block_id === entry.block_id)
    if (!heading || heading.tail || !heading.element.parentNode) return unavailable(`Missing heading ${entry.block_id}`)
    // A heading sharing its paragraph with body text cannot be safely replaced as a slot.
    if (blocks.some((b) => b.tail && b.element === heading.element)) return unavailable(`Shared heading paragraph ${entry.block_id}`)
    const nodes: Element[] = []
    for (let n = heading.element.nextSibling; n; n = n.nextSibling) {
      if (headings.some((h) => h.element === n) || isW(n, "sectPr")) break
      if (n.nodeType === 1) nodes.push(n as Element)
    }
    return { ...entry, heading, nodes, sections: [] as RenderedSection[] }
  })
  if (new Set(slots.map((s) => s.block_id)).size !== slots.length) unavailable("Duplicate mapped heading")
  // FLF-413: heading khung của mẫu (`3.2 <<Feature Name 1>>`) — tính năng / chức năng thật lấp vào, phần dư lặp theo khung
  const frameSlots = slots.filter((s) => isFrameHeading(s.section_id, s.heading.text))
  const frameMode = frameSlots.length > 0
  const ancestors: { level: number; slot: typeof slots[number] }[] = []
  const rearrange = sourceOptions.rearrange
  const moveToEnd = new Set(rearrange?.moveToEnd ?? [])
  /** FLF-416: mục chèn thành heading mới — `index` trong `doc.sections` để tìm heading kế tiếp của file làm mốc chèn. */
  const inserted: { section: RenderedSection; index: number }[] = []
  for (const [index, raw] of doc.sections.entries()) {
    // FLF-411 (U2-2): dòng chia phần của mẫu dựng thành heading nhóm `group:custom:X` cho màn Xem — trong file nó vẫn là slot
    // `custom:X` của chính heading đó (ghi như trước)
    const section = raw.id.startsWith(`${GROUP_OF_CUSTOM}`) ? { ...raw, id: raw.id.slice("group:".length) } : raw
    while (ancestors.length && ancestors[ancestors.length - 1].level >= section.level) ancestors.pop()
    const own = slots.find((s) => s.section_id === section.id)
    const slot = own ?? ancestors[ancestors.length - 1]?.slot
    // Mục nguyên vẹn không có chỗ trong file nền (FlintFlow tự thêm khi dựng) ⇒ không in: file gốc vốn không có
    if (!own && keep?.has(section.id) && (rearrange || !slot)) continue
    // FLF-416 chế độ 4: mục không có heading trong file ⇒ heading mới đúng vị trí bản in, không gộp vào mục cha.
    // FLF-413: tính năng / chức năng dư của mẫu có khung ⇒ heading mới lặp theo định dạng khung (không thành đoạn chữ đậm)
    if (!own && (rearrange || (frameMode && REPEATING_SECTION.test(section.id)))) {
      inserted.push({ section, index })
      continue
    }
    if (!slot) {
      if (section.blocks.length || !section.id.startsWith("group:")) unavailable(`No template parent for ${section.id}`)
      continue
    }
    slot.sections.push(section)
    ancestors.push({ level: section.level, slot })
  }
  const history = slots.find((s) => s.section_id === "fixed:I")
  const records = doc.recordOfChanges.filter((row) => !isInstructionText(row.version) && !isInstructionText(row.description))
  const handledSlots = new Set<typeof slots[number]>()
  if (sourceMode && history) {
    // Bảng lịch sử của file là nguồn: giữ nguyên (kể cả chú thích dưới bảng), chỉ thêm dòng của CR / phát hành vào cuối
    const added = records.slice(sourceOptions.legacyRecordCount ?? 0)
    const sourceHistory = history.nodes.find((n) => isW(n, "tbl"))
    if (sourceHistory && added.length) appendRecordRows(sourceHistory, added)
    if (sourceHistory || !added.length) handledSlots.add(history)
  }
  if (history && records.length && !handledSlots.has(history)) {
    const sourceHistory = history.nodes.find((n) => isW(n, "tbl"))
    if (!sourceHistory) unavailable("Revision history has no source table")
    const headers = wKids(wKids(sourceHistory!, "tr")[0], "tc").map((cell) => wAll(cell, "t").map((t) => t.textContent ?? "").join(""))
    const fieldOf = recordFieldOf
    if (headers.some((h) => !fieldOf(h))) unavailable("Revision history column has no mapping")
    const section: RenderedSection = {
      id: history.section_id, number: "", heading: history.heading.text, level: history.heading.level ?? 1,
      blocks: [{ type: "table", header: headers.map((text) => [{ text }]), rows: records.map((row) => headers.map((h) => [{ text: row[fieldOf(h)!] }])) }]
    }
    const index = history.sections.findIndex((s) => s.id === history.section_id)
    if (index >= 0) history.sections[index] = section
    else history.sections.unshift(section)
  }

  const bodyPattern = blocks.find((b) => b.kind === "paragraph" && !b.cell && b.ordinal > (headings[0]?.ordinal ?? Infinity))?.element
  const drawingIds = { next: Math.max(0, ...Array.from(xml.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "docPr")).map((e) => Number(e.getAttribute("id")) || 0)) + 1 }
  const styles = await pkg.xml("word/styles.xml")
  const defaultBodyStyle = (styles ? wAll(styles, "style") : []).find((s) => wAttr(s, "type") === "paragraph" && (wAttr(s, "default") === "1" || /^(normal|body text)$/i.test(wAttr(wKid(s, "name"), "val") ?? "")))
  const bodyStyleId = wAttr(defaultBodyStyle, "styleId") ?? undefined
  const numbering = await pkg.xml("word/numbering.xml")
  const listFormat = (p: Element): string | null => {
    if (!numbering) return null
    const pr = wKid(wKid(p, "pPr") ?? p, "numPr")
    if (!pr) return null
    const numId = wAttr(wKid(pr, "numId"), "val")
    const level = wAttr(wKid(pr, "ilvl"), "val") ?? "0"
    const num = wAll(numbering, "num").find((n) => wAttr(n, "numId") === numId)
    const abstractId = num && wAttr(wKid(num, "abstractNumId"), "val")
    const abstract = wAll(numbering, "abstractNum").find((n) => wAttr(n, "abstractNumId") === abstractId)
    const lvl = abstract && wKids(abstract, "lvl").find((n) => wAttr(n, "ilvl") === level)
    return lvl ? wAttr(wKid(lvl, "numFmt"), "val") : null
  }
  interface BlockContext {
    paragraphs: readonly Element[]
    tables: readonly Element[]
    pattern?: Element
    cursor: { table: number }
    /** FLF-416: mục chèn mới không có bảng nguồn ⇒ in bảng FlintFlow thật, không trải thành đoạn. */
    freeTables?: boolean
  }
  const writeBlocks = async (section: RenderedSection, ctx: BlockContext, out: Element[]): Promise<void> => {
    for (const block of section.blocks) {
      switch (block.type) {
        case "paragraph":
          if (!isInstructionText(block.runs.map((r) => r.text).join(""))) out.push(paragraph(xml, block.runs, ctx.pattern))
          break
        case "heading": out.push(paragraph(xml, [{ text: block.text, bold: true }], ctx.pattern)); break
        case "bullet_list":
        case "numbered_list": {
          const listPattern = ctx.paragraphs.find((p) => {
            const format = listFormat(p)
            return block.type === "bullet_list" ? format === "bullet" : !!format && format !== "bullet"
          })
          block.items.forEach((runs, i) => out.push(paragraph(xml, listPattern ? runs : [{ text: block.type === "bullet_list" ? "• " : `${i + 1}. ` }, ...runs], listPattern ?? ctx.pattern)))
          break
        }
        case "table": {
          const sourceTable = ctx.tables[ctx.cursor.table++]
          if (sourceTable) {
            const sourceBlock = blocks.find((b) => b.kind === "table" && b.element === sourceTable)
            const columns = tableMap.filter((entry) => entry.block_id === sourceBlock?.block_id)
            // FLF-372: bảng không ghép được cột với bảng mẫu ⇒ in bảng riêng theo cột FlintFlow tại chỗ của mục (không đoán
            // cột, không dồn ô cuối) thay vì hỏng cả lượt tạo bản; lỗi khác vẫn ném
            try {
              out.push(table(xml, projectMappedTable(block, sourceTable, columns), sourceTable, ctx.pattern, bodyStyleId))
            } catch (err) {
              if ((err as { code?: string }).code !== TEMPLATE_LAYOUT_UNAVAILABLE) throw err
              console.warn(`[template-docx] Bảng của ${section.id} không ghép được với bảng mẫu (${String((err as { meta?: { reason?: string } }).meta?.reason ?? "")}) ⇒ in bảng FlintFlow`)
              out.push(table(xml, block, undefined, ctx.pattern, bodyStyleId))
            }
          }
          else if (ctx.freeTables) out.push(table(xml, block, undefined, ctx.pattern, bodyStyleId))
          else out.push(...tableAsParagraphs(xml, block, ctx.pattern))
          break
        }
        case "image": out.push(...await image(pkg, xml, doc, block, drawingIds)); break
        case "page_break": break // Source page/section breaks are authoritative.
      }
    }
  }
  const skipSlot = (slot: typeof slots[number], reason: string): void => {
    console.warn(`[template-docx] Giữ nguyên mục "${slot.heading.text}" của file nền: ${reason}`)
  }
  for (const slot of slots) {
    if (handledSlots.has(slot)) continue
    // FLF-411 #25: dự án có sẵn — mục đã đổi so với lúc import (không nguyên trạng) mà bản in mới không còn dữ liệu (xoá qua CR) ⇒
    // bỏ thân gốc, giữ heading + chữ hướng dẫn của mẫu (BF §3.1.1: hướng dẫn chỉ xoá khi mục được điền). Trước đây slot trống bị
    // bỏ qua ⇒ dữ liệu đã xoá in lại nguyên văn từ file gốc. Mục nguyên trạng (kể cả vốn trống) vẫn giữ nguyên văn.
    if (keep && slot.section_id !== "fixed:I" && slot.sections.length && !slot.sections.every((s) => keep.has(s.id)) && guidanceOnly(slot.sections, slot.section_id)) {
      const guidance = slot.sections.flatMap((s) => s.blocks.flatMap((b) => (b.type === "paragraph" ? [b.runs] : [])))
      clearToGuidance(xml, slot.heading.element, slot.nodes, guidance, bodyPatternFor(bodyPattern, bodyStyleId))
      continue
    }
    if (!slot.sections.some((s) => s.blocks.length || s.id !== slot.section_id)) {
      if (sourceOptions.stripTemplateText && slot.section_id !== "fixed:I") stripTemplateBody(slot.nodes)
      continue
    }
    // Mục nguyên vẹn so với lúc import ⇒ không đụng node nào của file gốc
    if (keep && slot.sections.every((s) => keep.has(s.id))) continue
    if (slot.nodes.some((n) => isW(n, "p") && isLayoutParagraph(n) && wAll(n, "t").some((t) => t.textContent?.trim()))) {
      if (sourceMode) { skipSlot(slot, "chữ chung đoạn với ngắt trang / section"); continue }
      unavailable(`Body text shares a layout break below ${slot.block_id}`)
    }
    // FLF-372: đoạn chỉ chứa ảnh (sơ đồ ngữ cảnh, use case… của file gốc) thay được khi bản in của mục mang lại đủ số ảnh —
    // bản in Mode 1 giữ ảnh gốc thành khối ảnh; field / sdt / công thức / bookmark lạ vẫn không xoá
    const opaque = slot.nodes.filter((n) => isW(n, "p") && hasOpaqueContent(n))
    const pictures = opaque.filter(isPictureOnly)
    const printedImages = slot.sections.reduce((n, s) => n + s.blocks.filter((b) => b.type === "image").length, 0)
    // Dự án có sẵn: đoạn có field / bookmark / công thức (chú thích hình "Figure {SEQ}", tham chiếu chéo…) giữ nguyên tại chỗ
    const preserved = new Set<Element>(sourceMode ? (pictures.length > printedImages ? opaque : opaque.filter((n) => !isPictureOnly(n))) : [])
    // FLF-413: hình dưới heading khung của mẫu (`3.2.1 <<Function Name 1>>`) là hình mẫu ("Manage Products") — bỏ khi lấp khung
    const samplePictures = sourceOptions.stripTemplateText && frameSlots.includes(slot)
    if (!sourceMode && (opaque.length > pictures.length || (!samplePictures && pictures.length > printedImages))) unavailable(`Source objects or fields cannot be safely replaced below ${slot.block_id}`)
    const replaceable = slot.nodes.map((node, index) => isW(node, "tbl") || (isW(node, "p") && !isLayoutParagraph(node)) ? index : -1).filter((index) => index >= 0)
    if (slot.nodes.some((node, index) => isW(node, "p") && isLayoutParagraph(node) && index > replaceable[0] && index < replaceable[replaceable.length - 1])) {
      if (sourceMode) { skipSlot(slot, "nội dung vắt qua ngắt section"); continue }
      unavailable(`Source content spans an internal layout boundary below ${slot.block_id}`)
    }
    const paragraphs = slot.nodes.filter((n) => isW(n, "p") && !isLayoutParagraph(n) && !preserved.has(n))
    const tables = slot.nodes.filter((n) => isW(n, "tbl"))
    const pattern = bodyPatternFor(paragraphs.find((p) => !wKid(wKid(p, "pPr") ?? p, "numPr")) ?? bodyPattern, bodyStyleId)
    const cursor = { table: 0 }
    const output: Element[] = []
    for (const section of slot.sections) {
      // Descendant data belongs inside the source region, never in invented heading levels.
      if (section.id !== slot.section_id) output.push(paragraph(xml, [{ text: section.heading, bold: true }], pattern))
      await writeBlocks(section, { paragraphs, tables, pattern, cursor }, output)
    }
    const parent = slot.heading.element.parentNode!
    // A leading page/section break belongs before the slot's generated content.
    const ref = slot.nodes.find((node) => isW(node, "tbl") || (isW(node, "p") && !isLayoutParagraph(node) && !preserved.has(node)))
      ?? (slot.nodes.length ? slot.nodes[slot.nodes.length - 1].nextSibling : slot.heading.element.nextSibling)
    for (const node of output) parent.insertBefore(node, ref)
    const replacedTables = new Set(tables.slice(0, cursor.table))
    for (const node of slot.nodes) {
      // Breaks and paragraph section properties are layout, even inside a body slot.
      // An unfilled source table remains part of the template, including its sample rows (FLF-378: trừ mẫu của dự án mới —
      // bỏ dòng mẫu, giữ hàng tiêu đề).
      if (preserved.has(node)) continue
      if (replacedTables.has(node) || (isW(node, "p") && !isLayoutParagraph(node))) parent.removeChild(node)
      else if (sourceOptions.stripTemplateText && isW(node, "tbl")) stripSampleRows(node)
    }
  }
  /**
   * FLF-416 chế độ 4: chèn mục FPT soạn thêm thành heading mới trước heading kế tiếp của file (theo thứ tự bản in), rồi chuyển
   * mục Ngoài phạm vi (heading + nội dung + mục con) xuống cuối tài liệu, trước `sectPr` của thân.
   */
  const rearrangeLayout = async (): Promise<void> => {
    const body = wKid(xml.documentElement, "body")
    if (!body) return
    const bodySectPr = wKids(body, "sectPr")[0] ?? null
    // Vùng của từng mục Ngoài phạm vi (tính trước khi chèn): từ heading tới heading gốc cùng cấp / cấp trên kế tiếp
    const levelOf = new Map(headings.map((h) => [h.element, h.level ?? 1]))
    const moved = new Set<Element>()
    const regions: Element[][] = []
    for (const slot of slots) {
      if (!moveToEnd.has(slot.section_id) || moved.has(slot.heading.element)) continue
      const level = slot.heading.level ?? 1
      const region: Element[] = []
      for (let n: Node | null = slot.heading.element; n; n = n.nextSibling) {
        if (n !== slot.heading.element) {
          if (isW(n, "sectPr")) break
          const other = levelOf.get(n as Element)
          if (other !== undefined && other <= level) break
        }
        if (n.nodeType === 1) region.push(n as Element)
      }
      for (const node of region) moved.add(node)
      regions.push(region)
    }
    await insertSections(body, bodySectPr, moved)
    for (const node of regions.flat()) body.insertBefore(node, bodySectPr)
  }

  /** Mốc chèn: heading kế tiếp của file theo thứ tự bản in, bỏ heading nằm trong vùng sẽ chuyển xuống cuối / khung đã bỏ. */
  const insertSections = async (body: Element, bodySectPr: Element | null, skip: ReadonlySet<Element>): Promise<void> => {
    const slotOf = new Map(slots.map((s) => [s.section_id, s]))
    const pattern = bodyPatternFor(bodyPattern, bodyStyleId)
    const slotIdOf = (id: string) => (id.startsWith(GROUP_OF_CUSTOM) ? id.slice("group:".length) : id)
    for (const { section, index } of inserted) {
      const next = doc.sections.slice(index + 1).map((s) => slotOf.get(slotIdOf(s.id))).find((s) => s && !skip.has(s.heading.element) && s.heading.element.parentNode)
      const ref = next?.heading.element ?? bodySectPr
      const parent = next?.heading.element.parentNode ?? body
      const output: Element[] = [insertedHeading(section)]
      await writeBlocks(section, { paragraphs: [], tables: [], pattern, cursor: { table: 0 }, freeTables: true }, output)
      for (const node of output) parent.insertBefore(node, ref)
    }
  }

  /**
   * FLF-413: heading khung đã có phần tử thật ⇒ đổi chữ chỗ điền thành tên thật trên chính heading (giữ số gõ tay, style, rPr);
   * khung không còn phần tử ở Spine ⇒ bỏ heading + thân (ngắt trang / section giữ); phần dư chèn thành heading lặp theo khung.
   * Trả `true` khi đã đổi heading ⇒ mục lục của mẫu (còn dòng chỗ điền) được đánh dấu cập nhật khi mở file.
   */
  const fillTemplateFrames = async (): Promise<boolean> => {
    const body = wKid(xml.documentElement, "body")
    if (!body) return false
    const printed = new Map(doc.sections.map((s) => [s.id, s]))
    let changed = inserted.length > 0
    const dropped = new Set<Element>()
    for (const slot of frameSlots) {
      const section = printed.get(slot.section_id)
      if (!section) {
        for (const node of [slot.heading.element, ...slot.nodes]) {
          if (node !== slot.heading.element && isW(node, "p") && isLayoutParagraph(node)) continue
          node.parentNode?.removeChild(node)
        }
        dropped.add(slot.heading.element)
        changed = true
        continue
      }
      const name = section.heading.trim()
      const placeholder = PLACEHOLDER_IN_HEADING.exec(slot.heading.text)?.[0]
      if (!placeholder || !name || isPlaceholderText(name)) continue
      replaceInParagraph(slot.heading.element, placeholder, name)
      changed = true
    }
    await insertSections(body, wKids(body, "sectPr")[0] ?? null, dropped)
    return changed
  }

  /**
   * Heading mới theo heading cùng cấp cuối cùng trong file (style, đánh số tự động); file gõ số tay ⇒ thêm số của bản in.
   * FLF-413: mục lặp (tính năng / chức năng) theo heading khung cùng loại, cùng cấp gần nhất của mẫu.
   */
  const insertedHeading = (section: RenderedSection): Element => {
    const kind = REPEATING_SECTION.exec(section.id)?.[1]
    const frameSample = kind ? frameSlots.filter((s) => s.section_id.startsWith(`${kind}:`) && (s.heading.level ?? 1) === section.level).pop()?.heading : undefined
    const sameLevel = headings.filter((h) => (h.level ?? 1) === section.level)
    const sample = frameSample ?? sameLevel[sameLevel.length - 1]
    if (!sample) return paragraph(xml, [{ text: section.heading, bold: true }], bodyPatternFor(bodyPattern, bodyStyleId))
    const typed = /^\s*(\d+(\.\d+)*\.?|[IVXLC]+\.)\s+/.test(sample.text)
    const text = typed && section.number ? `${section.number} ${section.heading}` : section.heading
    const heading = paragraph(xml, [{ text }], sample.element)
    for (const pr of wAll(heading, "sectPr")) pr.parentNode?.removeChild(pr)
    return heading
  }
  if (rearrange) await rearrangeLayout()
  else if (frameMode && (await fillTemplateFrames())) await requestFieldUpdate(pkg)
  // Mẫu để điền: thay chữ giữ chỗ của bìa. Dự án có sẵn: bìa là của file đã viết ⇒ giữ nguyên
  if (!sourceMode) replacePlaceholders(xml, { "[Project name]": doc.projectName, "[Version]": doc.version, "[Date]": doc.generatedAt.slice(0, 10) })
  // Import-only anchors are useful while resolving slots, but untouched source
  // paragraphs must not acquire extra bookmarks in the exported package.
  const addedIds = new Set(wAll(xml, "bookmarkStart").filter((b) => !originalBookmarkIds.has(wAttr(b, "id"))).map((b) => wAttr(b, "id")))
  for (const local of ["bookmarkStart", "bookmarkEnd"]) for (const bookmark of wAll(xml, local)) if (addedIds.has(wAttr(bookmark, "id"))) bookmark.parentNode?.removeChild(bookmark)
  const lineage = exportLineage(doc)
  await writeStamp(pkg, { project_id: doc.projectId, version: doc.version, source: doc.source, base_version: lineage.base, kind: lineage.release ? "release" : "draft" })
  return pkg.toBuffer()
}

const REPEATING_SECTION = /^(feature|function):/
const PLACEHOLDER_IN_HEADING = /<<[^<>]*>>/
const HEADING_NUMBER = /^\s*(\d+(\.\d+)*\.?|[IVXLC]+\.)\s*/

/** FLF-413: heading của mục lặp mà chữ (bỏ số gõ tay) là chỗ điền của mẫu — `3.2 <<Feature Name 1>>`. */
export const isFrameHeading = (sectionId: string, text: string): boolean =>
  REPEATING_SECTION.test(sectionId) && isPlaceholderText(text.replace(HEADING_NUMBER, ""))

/** Thay `needle` trong chữ của một đoạn (vắt nhiều run) bằng `value`, giữ `rPr` của run đầu chứa nó. */
const replaceInParagraph = (p: Element, needle: string, value: string): void => {
  const texts = wAll(p, "t")
  const joined = texts.map((t) => t.textContent ?? "").join("")
  const start = joined.indexOf(needle)
  if (start < 0) return
  const end = start + needle.length
  let offset = 0
  for (const t of texts) {
    const text = t.textContent ?? "", from = offset, to = offset + text.length
    offset = to
    if (to <= start || from >= end) continue
    t.textContent = text.slice(0, Math.max(0, start - from)) + (from <= start ? value : "") + text.slice(Math.min(text.length, end - from))
    t.setAttribute("xml:space", "preserve")
  }
}

/** FLF-378: bảng mẫu giữ hàng tiêu đề (+ style), bỏ dòng mẫu / ví dụ bên dưới. */
const stripSampleRows = (tbl: Element): void => {
  for (const row of wKids(tbl, "tr").slice(1)) tbl.removeChild(row)
}

/**
 * FLF-378: mục của mẫu chưa có nội dung soạn — bỏ đoạn thân (hướng dẫn, ví dụ, ngữ cảnh) và dòng mẫu của bảng. Ngắt trang /
 * section, field (mục lục), ảnh, đối tượng lạ giữ nguyên.
 */
const stripTemplateBody = (nodes: readonly Element[]): void => {
  for (const node of nodes) {
    const parent = node.parentNode
    if (isW(node, "tbl")) stripSampleRows(node)
    else if (isW(node, "p") && !isLayoutParagraph(node) && !hasOpaqueContent(node)) parent?.removeChild(node)
  }
}

/** Bản in của slot không có dữ liệu: không có mục con, mọi khối (nếu có) là đoạn hướng dẫn của mẫu (`[…]` / `{…}`). */
const guidanceOnly = (sections: readonly RenderedSection[], slotId: string): boolean =>
  sections.every((s) => s.id === slotId && s.blocks.every((b) => b.type === "paragraph" && isInstructionText(b.runs.map((r) => r.text).join(""))))

const paragraphText = (p: Element): string => wAll(p, "t").map((t) => t.textContent ?? "").join("").trim()

/**
 * Đoạn hướng dẫn của mẫu trong thân gốc: đoạn chữ thuần nằm trọn trong ngoặc, kể cả khối hướng dẫn nhiều đoạn (đoạn đầu mở
 * `[` / `{`, đoạn cuối đóng `]` / `}`).
 */
const guidanceNodes = (nodes: readonly Element[]): Set<Element> => {
  const out = new Set<Element>()
  let open: Element[] | null = null
  for (const node of nodes) {
    const text = isW(node, "p") && !isLayoutParagraph(node) && !hasOpaqueContent(node) ? paragraphText(node) : null
    if (open) {
      if (text === null) { open = null; continue }
      open.push(node)
      if (/[\]}]$/.test(text)) { open.forEach((n) => out.add(n)); open = null }
      continue
    }
    if (!text) continue
    if (isInstructionText(text)) out.add(node)
    else if (/^[[{]/.test(text)) open = [node]
  }
  return out
}

/**
 * FLF-411 #25: thân gốc của mục bị xoá hết dữ liệu ⇒ bỏ đoạn, ảnh, field; bảng giữ hàng tiêu đề (bảng một hàng bỏ hẳn); giữ ngắt
 * trang / section và đoạn hướng dẫn của mẫu. File gốc không có hướng dẫn mà bản in mang hướng dẫn (`template_guidance`) ⇒ in
 * hướng dẫn đó sau heading.
 */
const clearToGuidance = (xml: Document, heading: Element, nodes: readonly Element[], guidance: readonly InlineRun[][], pattern?: Element): void => {
  const kept = guidanceNodes(nodes)
  for (const node of nodes) {
    if (kept.has(node) || (isW(node, "p") && isLayoutParagraph(node))) continue
    if (isW(node, "tbl") && wKids(node, "tr").length > 1) stripSampleRows(node)
    else node.parentNode?.removeChild(node)
  }
  if (kept.size || !guidance.length) return
  const parent = heading.parentNode!
  const remaining = nodes.filter((n) => n.parentNode === parent)
  // Trước bảng còn lại (nếu có), không thì ngay sau heading — ngắt trang cuối mục vẫn đứng sau hướng dẫn
  const ref = remaining.find((n) => !(isW(n, "p") && isLayoutParagraph(n))) ?? heading.nextSibling
  for (const runs of guidance) parent.insertBefore(paragraph(xml, runs, pattern), ref)
}

type RecordRow = RenderedDocument["recordOfChanges"][number]

const RECORD_FIELDS: Record<string, keyof RecordRow> = {
  version: "version", date: "date", author: "in_charge", "in charge": "in_charge",
  description: "description", "change description": "description", "change type": "change_type", "a*, m, d": "change_type"
}

// FLF-372: tiêu đề tiếng Việt / biến thể ("Người thực hiện", "Lý do thay đổi") ⇒ cùng bảng nhận cột của bộ đọc lịch sử
const recordFieldOf = (header: string): keyof RecordRow | null => RECORD_FIELDS[columnKey(header)] ?? recordColumnOfHeader(header) ?? null

/**
 * Thêm dòng lịch sử vào bảng gốc: điền trước các dòng trống cuối bảng (bảng mẫu thường kẻ sẵn nhiều dòng trống — FLF-411
 * #26: dòng mới không được nằm dưới 13 dòng trống), hết dòng trống mới nhân bản dòng cuối (giữ định dạng ô) thêm vào cuối.
 * Ghi chữ theo cột của bảng, cột lạ ("No.", "Approved by"…) để trống.
 */
function appendRecordRows(sourceTable: Element, rows: readonly RecordRow[]): void {
  const trs = wKids(sourceTable, "tr")
  if (trs.length < 2) return
  const headers = wKids(trs[0], "tc").map((cell) => wAll(cell, "t").map((t) => t.textContent ?? "").join(""))
  const model = trs[trs.length - 1]
  // Dòng trống = sau dòng có chữ cuối cùng (không điền vào khoảng trống xen giữa các dòng lịch sử cũ)
  const isBlank = (tr: Element) => !wAll(tr, "t").some((t) => t.textContent?.trim())
  const body = trs.slice(1)
  const lastFilled = body.reduce((last, tr, i) => (isBlank(tr) ? last : i), -1)
  const blanks = body.slice(lastFilled + 1)
  for (const row of rows) {
    const blank = blanks.shift()
    const tr = blank ?? model.cloneNode(true) as Element
    wKids(tr, "tc").forEach((cell, i) => {
      const field = recordFieldOf(headers[i] ?? "")
      setCellText(cell, field ? String(row[field] ?? "") : "")
    })
    if (!blank) sourceTable.appendChild(tr)
  }
}

/** Ghi chữ vào ô: giữ đoạn + run đầu (định dạng của ô gốc), bỏ phần còn lại. */
function setCellText(cell: Element, text: string): void {
  const paragraphs = wKids(cell, "p")
  paragraphs.slice(1).forEach((p) => cell.removeChild(p))
  const p = paragraphs[0]
  if (!p) return
  const runs = wKids(p, "r")
  runs.slice(1).forEach((r) => p.removeChild(r))
  const run = runs[0] ?? p.appendChild(wEl(p.ownerDocument, "r"))
  const ts = wAll(run, "t")
  ts.slice(1).forEach((t) => t.parentNode?.removeChild(t))
  const t = ts[0] ?? run.appendChild(wEl(p.ownerDocument, "t"))
  t.textContent = text
  t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve")
}

const isLayoutParagraph = (p: Element): boolean => wAll(p, "sectPr").length > 0 || wAll(p, "br").some((b) => wAttr(b, "type") === "page")
/** Đoạn chỉ chứa hình (`drawing` / `pict`), không field, sdt, đối tượng nhúng, công thức hay bookmark lạ. */
const isPictureOnly = (p: Element): boolean =>
  (wAll(p, "drawing").length > 0 || wAll(p, "pict").length > 0)
  && !["object", "fldSimple", "fldChar", "instrText", "sdt"].some((name) => wAll(p, name).length > 0)
  && p.getElementsByTagNameNS("http://schemas.openxmlformats.org/officeDocument/2006/math", "oMath").length === 0
  && !wAll(p, "bookmarkStart").some((b) => !/^_ff(?:t)?_B\d+$/.test(wAttr(b, "name") ?? ""))

const hasOpaqueContent = (p: Element): boolean =>
  ["drawing", "pict", "object", "fldSimple", "fldChar", "instrText", "sdt"].some((name) => wAll(p, name).length > 0)
  || p.getElementsByTagNameNS("http://schemas.openxmlformats.org/officeDocument/2006/math", "oMath").length > 0
  || wAll(p, "bookmarkStart").some((b) => !/^_ff(?:t)?_B\d+$/.test(wAttr(b, "name") ?? ""))

function bodyPatternFor(source?: Element, defaultStyleId?: string): Element | undefined {
  if (!source || !isInstructionText(wAll(source, "t").map((t) => t.textContent ?? "").join(""))) return source
  const clean = source.cloneNode(true) as Element
  for (const pr of wAll(clean, "rPr")) pr.parentNode?.removeChild(pr)
  const pPr = wKid(clean, "pPr")
  const style = pPr && wKid(pPr, "pStyle")
  if (style) pPr!.removeChild(style)
  if (pPr && defaultStyleId) pPr.insertBefore(wEl(clean.ownerDocument, "pStyle", { val: defaultStyleId }), pPr.firstChild)
  return clean
}

function paragraph(xml: Document, runs: InlineRun[], source?: Element): Element {
  const p = wEl(xml, "p")
  const sourcePr = source && wKid(source, "pPr")
  if (sourcePr) p.appendChild(sourcePr.cloneNode(true))
  // Guidance carries authoring-only gray/italic overrides. Its replacement inherits
  // the template's default body style instead of copying those overrides.
  const guidance = source && isInstructionText(wAll(source, "t").map((t) => t.textContent ?? "").join(""))
  const rPr = source && !guidance && wAll(source, "rPr")[0]
  for (const run of runs) {
    const r = wEl(xml, "r")
    const pr = rPr ? rPr.cloneNode(true) as Element : wEl(xml, "rPr")
    for (const [name, value] of [["b", run.bold], ["i", run.italic]] as const) {
      if (value === undefined) continue
      const existing = wKid(pr, name)
      if (existing) pr.removeChild(existing)
      pr.appendChild(wEl(xml, name, { val: value ? "1" : "0" }))
    }
    if (run.code) pr.appendChild(wEl(xml, "rFonts", { ascii: "Consolas", hAnsi: "Consolas" }))
    if (pr.childNodes.length) r.appendChild(pr)
    run.text.split(/\r?\n/).forEach((line, i) => { if (i) r.appendChild(wEl(xml, "br")); r.appendChild(wText(xml, "t", line)) })
    p.appendChild(r)
  }
  return p
}

function tableAsParagraphs(xml: Document, block: Extract<Block, { type: "table" }>, pattern?: Element): Element[] {
  const headers = block.header.map((cell) => cell.map((r) => r.text).join(""))
  return block.rows.map((cells) => paragraph(xml, cells.flatMap((runs, i) => [
    ...(i ? [{ text: "\n" }] : []), ...(headers[i] ? [{ text: `${headers[i]}: `, bold: true }] : []), ...runs
  ]), pattern))
}

/** Reuse the import's explicit field paths; no fuzzy header matching or overflow cells. */
function projectMappedTable(block: Extract<Block, { type: "table" }>, source: Element, mappings: readonly TableMapEntry[]): Extract<Block, { type: "table" }> {
  const headers = wKids(wKids(source, "tr")[0], "tc").map((cell) => wAll(cell, "t").map((t) => t.textContent ?? "").join(""))
  return projectTableColumns(block, headers, mappings)
}

/**
 * Bảng FlintFlow ⇒ đúng cột của bảng mẫu (`headers` = hàng tiêu đề của bảng trong file upload): cột mẫu không có dữ liệu để
 * trống, cột FlintFlow mẫu không có thì bỏ. FLF-379: bản xem trước của dự án mẫu cố định dùng chung hàm này để hiện đúng cột
 * như bản xuất. Không ghép được ⇒ ném `TEMPLATE_LAYOUT_UNAVAILABLE`.
 */
export function projectTableColumns(block: Extract<Block, { type: "table" }>, headers: readonly string[], mappings: readonly TableMapEntry[]): Extract<Block, { type: "table" }> {
  if (!mappings.length || headers.every((h) => block.header.some((c) => columnKey(c.map((r) => r.text).join("")) === columnKey(h)))) return block
  const entities = new Set(mappings.flatMap((m) => m.field_path ? [m.field_path.split("[].")[0]] : []))
  const fieldOf = (definition: (typeof TABLE_ENTITIES)[number], text: string) =>
    definition.columns.find((col) => col.headers.some((h) => columnKey(h) === columnKey(text)))?.field
  // FLF-372: bảng của bản ghi import trước khi từ điển có thực thể này (table_map không mang field) ⇒ ghép theo tên cột của
  // từ điển: thực thể mà mọi cột FlintFlow in ra và ít nhất một cột của mẫu đều có tên trong từ điển
  const byDictionary = entities.size === 0
    ? TABLE_ENTITIES.find((def) => block.header.every((cell) => fieldOf(def, cell.map((r) => r.text).join(""))) && headers.some((h) => fieldOf(def, h)))
    : undefined
  if (entities.size !== 1 && !byDictionary) unavailable("Source table field mapping is ambiguous")
  const [entity] = entities
  const definition = byDictionary ?? TABLE_ENTITIES.find((entry) => entry.entity === entity)
  if (!definition) unavailable("Source table entity has no renderer")
  const generated = block.header.map((cell) => fieldOf(definition!, cell.map((r) => r.text).join("")))
  const indexes = headers.map((header, column) => {
    const mapping = mappings.find((m) => m.column_index === column)
    const field = byDictionary ? fieldOf(byDictionary, header) : mapping?.field_path?.split("[].")[1]
    if (mapping?.role === "row_no") return -2
    // FLF-372: cột của mẫu mà FlintFlow không có dữ liệu ("Thuộc tính chính", "Yêu cầu liên quan") ⇒ để trống, giữ bố cục mẫu
    return field ? generated.indexOf(field) : -1
  })
  if (!indexes.some((index) => index >= 0)) unavailable("Source table has no column with a generated field")
  return {
    type: "table",
    header: headers.map((text) => [{ text }]),
    rows: block.rows.map((row, i) => indexes.map((index) => (index === -2 ? [{ text: String(i + 1) }] : index >= 0 ? (row[index] ?? []) : [])))
  }
}

function table(xml: Document, block: Extract<Block, { type: "table" }>, source?: Element, pattern?: Element, bodyStyleId?: string): Element {
  const tbl = source ? source.cloneNode(true) as Element : wEl(xml, "tbl")
  const rows = wKids(tbl, "tr")
  if (source && !rows.length) unavailable("Template table has no row pattern")
  if (source && wAll(source, "tbl").length) unavailable("Nested source tables require an explicit nested binding")
  if (source && wAll(source, "p").some(hasOpaqueContent)) unavailable("Source table objects or fields cannot be safely replaced")
  const spanOf = (cell: Element) => Math.max(1, Number(wAttr(wKid(wKid(cell, "tcPr") ?? cell, "gridSpan"), "val")) || 1)
  const headerCells = rows[0] ? wKids(rows[0], "tc") : []
  const headerPositions: number[] = []
  let gridWidth = 0
  for (const cell of headerCells) { headerPositions.push(gridWidth); gridWidth += spanOf(cell) }
  if (source && wAll(source, "vMerge").length && block.rows.length !== rows.length - 1) unavailable("A vertically merged row group cannot be repeated as independent records")
  for (const row of rows) tbl.removeChild(row)
  let content = [block.header, ...block.rows]
  const columns = Math.max(0, ...content.map((r) => r.length))
  const sourceColumns = rows[0] ? wKids(rows[0], "tc").length : columns
  if (source && sourceColumns) {
    // Word tách một chữ thành nhiều run (dấu tiếng Việt, sửa chính tả) ⇒ ghép không chèn dấu cách ("Thu"+"ật ng"+"ữ")
    const sourceHeaders = wKids(rows[0], "tc").map((cell) => wAll(cell, "t").map((t) => t.textContent ?? "").join("").trim())
    const generatedHeaders = block.header.map((cell) => cell.map((run) => run.text).join("").trim())
    // Exact header binding only. Ambiguous/missing columns must never be dumped
    // into the last cell or matched by generic words like "name" or "id".
    const mapping = generatedHeaders.map((header) => {
      const matches = sourceHeaders.map((text, i) => columnKey(text) === columnKey(header) ? i : -1).filter((i) => i >= 0)
      return matches.length === 1 ? headerPositions[matches[0]] : -1
    })
    // FLF-372: cột FlintFlow mà mẫu không có (Thuật ngữ thêm "Tiếng Việt") ⇒ mẫu bắt buộc không in cột đó (dữ liệu vẫn ở
    // Spine) thay vì hỏng cả lượt tạo bản; không khớp cột nào / hai cột cùng một cột gốc mới là lỗi
    const bound = mapping.filter((i) => i >= 0)
    if (!bound.length || new Set(bound).size !== bound.length) unavailable("Generated table columns do not match the source table")
    content = [sourceHeaders.map((text) => [{ text }]), ...block.rows.map((cells) => {
      const projected: InlineRun[][] = Array.from({ length: gridWidth }, () => [])
      cells.forEach((runs, index) => {
        const target = mapping[index] ?? -1
        if (target < 0) return // cột mẫu không có — không in (xem trên)
        const dest = projected[target]
        if (dest.length) dest.push({ text: "\n" })
        dest.push(...runs)
      })
      return projected
    })]
  }
  content.forEach((cells, i) => {
    const rowPattern = rows[Math.min(i, rows.length - 1)]
    const row = rowPattern ? rowPattern.cloneNode(true) as Element : wEl(xml, "tr")
    if (source && i === 0) { tbl.appendChild(row); return }
    const originalCells = wKids(row, "tc")
    for (const cell of originalCells) row.removeChild(cell)
    let logicalColumn = Number(wAttr(wKid(wKid(row, "trPr") ?? row, "gridBefore"), "val")) || 0
    for (let col = 0; col < (source ? originalCells.length : columns); col++) {
      const sourceCell = originalCells[col] ?? originalCells[originalCells.length - 1]
      const cell = sourceCell ? sourceCell.cloneNode(true) as Element : wEl(xml, "tc")
      const span = sourceCell ? spanOf(sourceCell) : 1
      const runs = cells.slice(logicalColumn, logicalColumn + span).flatMap((value, j) => [...(j && value.length ? [{ text: "\n" }] : []), ...value])
      logicalColumn += span
      const merge = wKid(wKid(cell, "tcPr") ?? cell, "vMerge")
      if (merge && wAttr(merge, "val") !== "restart" && runs.some((r) => r.text.trim())) unavailable("A vertical merge continuation cannot hide an independent value")
      const cellPattern = bodyPatternFor(wKids(cell, "p")[0], bodyStyleId) ?? pattern
      for (const child of wKids(cell)) if (!isW(child, "tcPr")) cell.removeChild(child)
      cell.appendChild(paragraph(xml, runs, cellPattern)); row.appendChild(cell)
    }
    if (source && logicalColumn + (Number(wAttr(wKid(wKid(row, "trPr") ?? row, "gridAfter"), "val")) || 0) !== gridWidth) unavailable("Source table row does not align with its logical grid")
    tbl.appendChild(row)
  })
  return tbl
}

/**
 * FLF-379: bước đặt cột của `table()` (ghép đúng tên cột, cột FlintFlow mẫu không có thì bỏ) ở dạng thuần cho bản xem trước —
 * một ô mỗi cột mẫu (không tính gộp ô). Không khớp cột nào / hai cột cùng một cột mẫu ⇒ ném như `table()`.
 */
export function fitTableToHeaders(block: Extract<Block, { type: "table" }>, headers: readonly string[]): Extract<Block, { type: "table" }> {
  const sourceHeaders = headers.map((h) => h.trim())
  const mapping = block.header.map((cell) => {
    const header = cell.map((run) => run.text).join("").trim()
    const matches = sourceHeaders.map((text, i) => (columnKey(text) === columnKey(header) ? i : -1)).filter((i) => i >= 0)
    return matches.length === 1 ? matches[0] : -1
  })
  const bound = mapping.filter((i) => i >= 0)
  if (!bound.length || new Set(bound).size !== bound.length) unavailable("Generated table columns do not match the source table")
  return {
    ...block,
    header: sourceHeaders.map((text) => [{ text }]),
    rows: block.rows.map((cells) => {
      const projected: InlineRun[][] = sourceHeaders.map(() => [])
      cells.forEach((runs, index) => {
        const target = mapping[index] ?? -1
        if (target < 0) return
        if (projected[target].length) projected[target].push({ text: "\n" })
        projected[target].push(...runs)
      })
      return projected
    })
  }
}

function columnKey(header: string): string {
  return header.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim()
}

async function image(pkg: DocxPackage, xml: Document, doc: RenderedDocument, block: Extract<Block, { type: "image" }>, drawingIds: { next: number }): Promise<Element[]> {
  const scratch = await parseDocument(await writeDocx({ ...doc, flagsAppendix: undefined, sections: [{ id: "image", number: "", heading: "Image", level: 1, blocks: [block] }] }))
  const imageBlock = scratch.blocks.find((b) => b.kind === "image")
  if (!imageBlock) return unavailable("Image drawing could not be generated")
  const p = xml.importNode(imageBlock.element, true) as Element
  // Scratch import assigns block bookmarks; those IDs belong to the scratch package only.
  for (const local of ["bookmarkStart", "bookmarkEnd"]) for (const bookmark of wAll(p, local)) bookmark.parentNode?.removeChild(bookmark)
  const blips = Array.from(p.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "blip"))
  for (const blip of blips) {
    const oldId = blip.getAttributeNS(NS.r, "embed") ?? ""
    const target = await scratch.pkg.resolveRelationship(MAIN_PART, oldId)
    const bytes = target && await scratch.pkg.binary(target)
    if (!target || !bytes) return unavailable("Image media missing")
    const extension = target.split(".").pop() ?? "png"
    let i = 1
    while (pkg.has(`word/media/flintflow${i}.${extension}`)) i++
    const name = `word/media/flintflow${i}.${extension}`
    await pkg.addBinaryPart(name, bytes, extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "image/png")
    const id = await pkg.addRelationship(MAIN_PART, `${NS.r}/image`, name.slice(5))
    blip.setAttributeNS(NS.r, "r:embed", id)
  }
  const wp = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  for (const prop of Array.from(p.getElementsByTagNameNS(wp, "docPr"))) prop.setAttribute("id", String(drawingIds.next++))
  return [p, ...(block.caption ? [paragraph(xml, [{ text: block.caption }])] : [])]
}

/** Replace across split runs while preserving every run's properties and surrounding text. */
function replacePlaceholders(xml: Document, replacements: Record<string, string>): void {
  for (const p of wAll(xml, "p")) {
    const texts = wAll(p, "t")
    for (const [needle, value] of Object.entries(replacements)) {
      let joined = texts.map((t) => t.textContent ?? "").join("")
      let start: number
      while ((start = joined.indexOf(needle)) >= 0) {
        let offset = 0
        const end = start + needle.length
        for (const t of texts) {
          const text = t.textContent ?? "", from = offset, to = offset + text.length
          offset = to
          if (to <= start || from >= end) continue
          t.textContent = text.slice(0, Math.max(0, start - from)) + (from <= start ? value : "") + text.slice(Math.min(text.length, end - from))
          t.setAttribute("xml:space", "preserve")
        }
        joined = texts.map((t) => t.textContent ?? "").join("")
        if (value.includes(needle)) break
      }
    }
  }
}
