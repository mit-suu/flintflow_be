/**
 * Dựng .docx tối thiểu cho unit test (FLF-171). Chỉ dùng trong test: cho phép kiểm soát chính xác XML
 * (paraId, styleId bản địa hoá, bookmark nằm ngoài `w:p`…) mà thư viện `docx` không sinh ra được.
 */

import JSZip from "jszip"
import { NS } from "../xml.js"

export const W_NS_DECL = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:w14="${NS.w14}" xmlns:mc="${NS.mc}" mc:Ignorable="w14"`

export interface MakeDocxOptions {
  /** Nội dung trong `<w:body>` (không gồm sectPr mặc định). */
  body: string
  /** Nội dung trong `<w:styles>`. */
  styles?: string
  sectPr?: string
  extraParts?: Record<string, string>
  extraDocRels?: string
  extraContentTypes?: string
}

export const p = (text: string, pPr = "", attrs = ""): string =>
  `<w:p${attrs ? ` ${attrs}` : ""}>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${text ? `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>` : ""}</w:p>`

export const styled = (styleId: string, text: string): string => p(text, `<w:pStyle w:val="${styleId}"/>`)

export const table = (rows: string[][]): string =>
  `<w:tbl><w:tblPr/><w:tblGrid/>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${p(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`

/** Style heading Word tiếng Việt: styleId `u1` nhưng `w:name` = `heading 1`. */
export const VI_HEADING_STYLES =
  `<w:style w:type="paragraph" w:styleId="u1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="u2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="MyH3"><w:name w:val="My H3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Mucluc1"><w:name w:val="toc 1"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Chuthich"><w:name w:val="caption"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Dsach"><w:name w:val="List Paragraph"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>`

export const makeDocx = async (opts: MakeDocxOptions): Promise<Buffer> => {
  const zip = new JSZip()
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS.ct}">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
      (opts.extraContentTypes ?? "") +
      `</Types>`
  )
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS.rels}">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`
  )
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS.rels}">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      (opts.extraDocRels ?? "") +
      `</Relationships>`
  )
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS_DECL}>${opts.styles ?? VI_HEADING_STYLES}</w:styles>`
  )
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS_DECL}><w:body>${opts.body}${
      opts.sectPr ?? `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>`
    }</w:body></w:document>`
  )
  for (const [name, xml] of Object.entries(opts.extraParts ?? {})) zip.file(name, xml)
  return zip.generateAsync({ type: "nodebuffer" })
}
