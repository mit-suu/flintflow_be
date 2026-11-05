import { ApiError } from "../../shared/utils/api-error.js"
import { DocxPackage, MAIN_PART, readBlocks, writeStamp } from "../docx-ooxml/index.js"
import { NS, isW, wAll, wAttr, wEl, wKid, wKids, wText } from "../docx-ooxml/xml.js"
import { assignBlockIds, parseDocument } from "../import/parse.service.js"
import { exportLineage, writeDocx } from "./docx-writer.js"
import type { Block, InlineRun, RenderedDocument, RenderedSection } from "./rendered-document.types.js"
import { isInstructionText } from "../../shared/utils/instruction-text.js"
import { TABLE_ENTITIES } from "../import/table-header-dictionary.js"
import type { TableMapEntry } from "../import/template-profile.model.js"

const unavailable = (reason: string): never => {
  throw new ApiError(422, "Không thể điền nội dung vào bố cục mẫu gốc.", "TEMPLATE_LAYOUT_UNAVAILABLE", { reason })
}

/** Populate the imported package in place: its styles, sections and ancillary parts remain authoritative. */
export async function writeTemplateDocx(
  doc: RenderedDocument,
  template: Buffer,
  headingMap: readonly { block_id: string; section_id: string }[],
  tableMap: readonly TableMapEntry[] = []
): Promise<Buffer> {
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
  const ancestors: { level: number; slot: typeof slots[number] }[] = []
  for (const section of doc.sections) {
    while (ancestors.length && ancestors[ancestors.length - 1].level >= section.level) ancestors.pop()
    const own = slots.find((s) => s.section_id === section.id)
    const slot = own ?? ancestors[ancestors.length - 1]?.slot
    if (!slot) {
      if (section.blocks.length || !section.id.startsWith("group:")) unavailable(`No template parent for ${section.id}`)
      continue
    }
    slot.sections.push(section)
    ancestors.push({ level: section.level, slot })
  }
  const history = slots.find((s) => s.section_id === "fixed:I")
  const records = doc.recordOfChanges.filter((row) => !isInstructionText(row.version) && !isInstructionText(row.description))
  if (history && records.length) {
    const sourceHistory = history.nodes.find((n) => isW(n, "tbl"))
    if (!sourceHistory) unavailable("Revision history has no source table")
    const headers = wKids(wKids(sourceHistory!, "tr")[0], "tc").map((cell) => wAll(cell, "t").map((t) => t.textContent ?? "").join(""))
    const values: Record<string, keyof typeof records[number]> = {
      version: "version", date: "date", author: "in_charge", "in charge": "in_charge",
      description: "description", "change description": "description", "change type": "change_type", "a*, m, d": "change_type"
    }
    if (headers.some((h) => !values[columnKey(h)])) unavailable("Revision history column has no mapping")
    const section: RenderedSection = {
      id: history.section_id, number: "", heading: history.heading.text, level: history.heading.level ?? 1,
      blocks: [{ type: "table", header: headers.map((text) => [{ text }]), rows: records.map((row) => headers.map((h) => [{ text: row[values[columnKey(h)]] }])) }]
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
  for (const slot of slots) {
    if (!slot.sections.some((s) => s.blocks.length || s.id !== slot.section_id)) continue
    if (slot.nodes.some((n) => isW(n, "p") && isLayoutParagraph(n) && wAll(n, "t").some((t) => t.textContent?.trim()))) unavailable(`Body text shares a layout break below ${slot.block_id}`)
    if (slot.nodes.some((n) => isW(n, "p") && hasOpaqueContent(n))) unavailable(`Source objects or fields cannot be safely replaced below ${slot.block_id}`)
    const replaceable = slot.nodes.map((node, index) => isW(node, "tbl") || (isW(node, "p") && !isLayoutParagraph(node)) ? index : -1).filter((index) => index >= 0)
    if (slot.nodes.some((node, index) => isW(node, "p") && isLayoutParagraph(node) && index > replaceable[0] && index < replaceable[replaceable.length - 1])) unavailable(`Source content spans an internal layout boundary below ${slot.block_id}`)
    const paragraphs = slot.nodes.filter((n) => isW(n, "p") && !isLayoutParagraph(n))
    const tables = slot.nodes.filter((n) => isW(n, "tbl"))
    const pattern = bodyPatternFor(paragraphs.find((p) => !wKid(wKid(p, "pPr") ?? p, "numPr")) ?? bodyPattern, bodyStyleId)
    let tableIndex = 0
    const output: Element[] = []
    for (const section of slot.sections) {
      // Descendant data belongs inside the source region, never in invented heading levels.
      if (section.id !== slot.section_id) output.push(paragraph(xml, [{ text: section.heading, bold: true }], pattern))
      for (const block of section.blocks) {
        switch (block.type) {
          case "paragraph":
            if (!isInstructionText(block.runs.map((r) => r.text).join(""))) output.push(paragraph(xml, block.runs, pattern))
            break
          case "heading": output.push(paragraph(xml, [{ text: block.text, bold: true }], pattern)); break
          case "bullet_list":
          case "numbered_list": {
            const listPattern = paragraphs.find((p) => {
              const format = listFormat(p)
              return block.type === "bullet_list" ? format === "bullet" : !!format && format !== "bullet"
            })
            block.items.forEach((runs, i) => output.push(paragraph(xml, listPattern ? runs : [{ text: block.type === "bullet_list" ? "• " : `${i + 1}. ` }, ...runs], listPattern ?? pattern)))
            break
          }
          case "table": {
            const sourceTable = tables[tableIndex++]
            if (sourceTable) {
              const sourceBlock = blocks.find((b) => b.kind === "table" && b.element === sourceTable)
              const columns = tableMap.filter((entry) => entry.block_id === sourceBlock?.block_id)
              output.push(table(xml, projectMappedTable(block, sourceTable, columns), sourceTable, pattern, bodyStyleId))
            }
            else output.push(...tableAsParagraphs(xml, block, pattern))
            break
          }
          case "image": output.push(...await image(pkg, xml, doc, block, drawingIds)); break
          case "page_break": break // Source page/section breaks are authoritative.
        }
      }
    }
    const parent = slot.heading.element.parentNode!
    // A leading page/section break belongs before the slot's generated content.
    const ref = slot.nodes.find((node) => isW(node, "tbl") || (isW(node, "p") && !isLayoutParagraph(node)))
      ?? (slot.nodes.length ? slot.nodes[slot.nodes.length - 1].nextSibling : slot.heading.element.nextSibling)
    for (const node of output) parent.insertBefore(node, ref)
    const replacedTables = new Set(tables.slice(0, tableIndex))
    for (const node of slot.nodes) {
      // Breaks and paragraph section properties are layout, even inside a body slot.
      // An unfilled source table remains part of the template, including its sample rows.
      if (replacedTables.has(node) || (isW(node, "p") && !isLayoutParagraph(node))) parent.removeChild(node)
    }
  }
  replacePlaceholders(xml, { "[Project name]": doc.projectName, "[Version]": doc.version, "[Date]": doc.generatedAt.slice(0, 10) })
  // Import-only anchors are useful while resolving slots, but untouched source
  // paragraphs must not acquire extra bookmarks in the exported package.
  const addedIds = new Set(wAll(xml, "bookmarkStart").filter((b) => !originalBookmarkIds.has(wAttr(b, "id"))).map((b) => wAttr(b, "id")))
  for (const local of ["bookmarkStart", "bookmarkEnd"]) for (const bookmark of wAll(xml, local)) if (addedIds.has(wAttr(bookmark, "id"))) bookmark.parentNode?.removeChild(bookmark)
  const lineage = exportLineage(doc)
  await writeStamp(pkg, { project_id: doc.projectId, version: doc.version, source: doc.source, base_version: lineage.base, kind: lineage.release ? "release" : "draft" })
  return pkg.toBuffer()
}

const isLayoutParagraph = (p: Element): boolean => wAll(p, "sectPr").length > 0 || wAll(p, "br").some((b) => wAttr(b, "type") === "page")
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
  if (!mappings.length || headers.every((h) => block.header.some((c) => columnKey(c.map((r) => r.text).join("")) === columnKey(h)))) return block
  const entities = new Set(mappings.flatMap((m) => m.field_path ? [m.field_path.split("[].")[0]] : []))
  if (entities.size !== 1) unavailable("Source table field mapping is ambiguous")
  const [entity] = entities
  const definition = TABLE_ENTITIES.find((entry) => entry.entity === entity)
  if (!definition) unavailable("Source table entity has no renderer")
  const generated = block.header.map((cell) => {
    const key = columnKey(cell.map((r) => r.text).join(""))
    return definition!.columns.find((col) => col.headers.some((h) => columnKey(h) === key))?.field
  })
  const indexes = headers.map((_header, column) => {
    const mapping = mappings.find((m) => m.column_index === column)
    const field = mapping?.field_path?.split("[].")[1]
    if (mapping?.role === "row_no") return -2
    const index = field ? generated.indexOf(field) : -1
    if (index < 0) unavailable(`Source table column ${column + 1} has no explicit generated field`)
    return index
  })
  return { type: "table", header: headers.map((text) => [{ text }]), rows: block.rows.map((row, i) => indexes.map((index) => index === -2 ? [{ text: String(i + 1) }] : row[index] ?? [])) }
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
    const sourceHeaders = wKids(rows[0], "tc").map((cell) => wAll(cell, "t").map((t) => t.textContent ?? "").join(" ").trim())
    const generatedHeaders = block.header.map((cell) => cell.map((run) => run.text).join("").trim())
    // Exact header binding only. Ambiguous/missing columns must never be dumped
    // into the last cell or matched by generic words like "name" or "id".
    const mapping = generatedHeaders.map((header) => {
      const matches = sourceHeaders.map((text, i) => columnKey(text) === columnKey(header) ? i : -1).filter((i) => i >= 0)
      return matches.length === 1 ? headerPositions[matches[0]] : -1
    })
    if (mapping.some((i) => i < 0) || new Set(mapping).size !== mapping.length) unavailable("Generated table columns do not match the source table")
    content = [sourceHeaders.map((text) => [{ text }]), ...block.rows.map((cells) => {
      const projected: InlineRun[][] = Array.from({ length: gridWidth }, () => [])
      cells.forEach((runs, index) => {
        const target = mapping[index] ?? -1
        if (target < 0) unavailable("Table cell has no source column")
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
