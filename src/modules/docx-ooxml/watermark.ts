/**
 * Watermark "DRAFT" cho bản draft tải về (G8, 2F). FLF-171, plan §6 2A; P0 §4.7.
 * Shape VML textpath (giống watermark mặc định của Word) chèn vào **mọi header part được tham chiếu**;
 * section đầu thiếu header (`default` / `first` khi có `titlePg` / `even` khi bật `evenAndOddHeaders`) ⇒ tạo header mới,
 * các section sau kế thừa. Chỉ dùng cho bản tải về, không sửa file lưu.
 */

import { MAIN_PART } from "./blocks.js"
import type { DocxPackage } from "./package.js"
import { CONTENT_TYPE, NS, REL_TYPE, parseXml, wAll, wAttr, wEl, wKids } from "./xml.js"

const VML_NS = `xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w10="urn:schemas-microsoft-com:office:word"`

const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

const watermarkParagraph = (n: number, text: string): string =>
  `<w:p xmlns:w="${NS.w}" ${VML_NS}><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:pict>` +
  `<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e">` +
  `<v:formulas><v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/><v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/><v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/><v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/></v:formulas>` +
  `<v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/>` +
  `<v:textpath on="t" fitshape="t"/><o:lock v:ext="edit" text="t" shapetype="t"/></v:shapetype>` +
  `<v:shape id="FFWatermark${n}" o:spid="_x0000_s${2049 + n}" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:412pt;height:137pt;rotation:315;z-index:-251657216;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin" o:allowincell="f" fillcolor="silver" stroked="f">` +
  `<v:fill opacity=".5"/><v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="${escapeAttr(text)}"/><w10:wrap anchorx="margin" anchory="margin"/></v:shape>` +
  `</w:pict></w:r></w:p>`

export interface WatermarkResult {
  headerParts: string[]
  created: number
}

const bodySections = (doc: Document): Element[] =>
  wAll(doc, "sectPr").filter((s) => !["rPr", "pPrChange", "sectPrChange"].includes((s.parentNode as Element | null)?.localName ?? ""))

export const addDraftWatermark = async (pkg: DocxPackage, text = "DRAFT"): Promise<WatermarkResult> => {
  const doc = await pkg.requireXml(MAIN_PART)
  const sections = bodySections(doc)
  let created = 0
  const first = sections[0]
  if (first) {
    const settings = await pkg.xml("word/settings.xml")
    const evenOdd = !!settings && wAll(settings, "evenAndOddHeaders").length > 0
    const needed = ["default", ...(wKids(first, "titlePg").length ? ["first"] : []), ...(evenOdd ? ["even"] : [])]
    const existing = new Set(wKids(first, "headerReference").map((h) => wAttr(h, "type") ?? "default"))
    for (const type of needed) {
      if (existing.has(type)) continue
      const name = pkg.freePartName("header")
      await pkg.addXmlPart(
        name,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${NS.w}" xmlns:r="${NS.r}" ${VML_NS}/>`,
        CONTENT_TYPE.header
      )
      const rId = await pkg.addRelationship(MAIN_PART, REL_TYPE.header, name.slice("word/".length))
      const ref = wEl(doc, "headerReference", { type })
      ref.setAttributeNS(NS.r, "r:id", rId)
      first.insertBefore(ref, first.firstChild)
      created++
    }
  }

  const headerParts = new Set<string>()
  for (const s of sections) {
    for (const h of wKids(s, "headerReference")) {
      const part = await pkg.resolveRelationship(MAIN_PART, h.getAttributeNS(NS.r, "id") ?? "")
      if (part) headerParts.add(part)
    }
  }
  let n = 0
  for (const name of headerParts) {
    const header = await pkg.requireXml(name)
    const frag = parseXml(watermarkParagraph(n++, text), "watermark").documentElement
    header.documentElement.appendChild(header.importNode(frag, true))
  }
  return { headerParts: [...headerParts], created }
}
