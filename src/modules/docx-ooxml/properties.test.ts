import { Document, Packer, Paragraph } from "docx"
import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { DocxPackage } from "./package.js"
import { readCustomProperties, readStamp, writeStamp } from "./properties.js"
import { makeDocx, p } from "./testing/make-docx.js"
import { NS } from "./xml.js"

describe("stamp", () => {
  it("file không có custom.xml ⇒ null; ghi rồi đọc lại", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("a") }))
    expect(await readStamp(pkg)).toBeNull()
    await writeStamp(pkg, { project_id: "p1", version: "0.0", source: "import" })
    const out = await DocxPackage.load(await pkg.toBuffer())
    expect(await readStamp(out)).toEqual({ project_id: "p1", version: "0.0", source: "import" })
    const zip = await JSZip.loadAsync(await pkg.toBuffer())
    expect(await zip.file("_rels/.rels")!.async("string")).toContain('Target="docProps/custom.xml"')
    expect(await zip.file("[Content_Types].xml")!.async("string")).toContain("/docProps/custom.xml")
  })

  it("ghi đè giữ property khác, pid không trùng; version null ⇒ bỏ property", async () => {
    const pkg = await DocxPackage.load(await makeDocx({ body: p("a") }))
    await writeStamp(pkg, { project_id: "p1", version: "0.0", source: "import" })
    await writeStamp(pkg, { project_id: "p1", version: "0.1", source: null })
    const props = await readCustomProperties(pkg)
    expect(props).toEqual({ flintflow_project_id: "p1", flintflow_version: "0.1" })
    const doc = await pkg.requireXml("docProps/custom.xml")
    const pids = Array.from(doc.getElementsByTagName("property")).map((x) => x.getAttribute("pid"))
    expect(new Set(pids).size).toBe(pids.length)
  })

  it("đọc stamp của file do mode 2 (docx-writer) xuất", async () => {
    const doc = new Document({
      customProperties: [
        { name: "flintflow_project_id", value: "abc" },
        { name: "flintflow_version", value: "v0.3" },
        { name: "flintflow_source", value: "baseline" },
        { name: "Other", value: "x" }
      ],
      sections: [{ children: [new Paragraph("x")] }]
    })
    const pkg = await DocxPackage.load(await Packer.toBuffer(doc))
    expect(await readStamp(pkg)).toEqual({ project_id: "abc", version: "v0.3", source: "baseline" })
    await writeStamp(pkg, { project_id: "abc", version: "1.0", source: "release" })
    expect((await readCustomProperties(pkg)).Other).toBe("x")
  })

  const CUSTOM = (props: string) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="${NS.cp}" xmlns:vt="${NS.vt}">${props}</Properties>`
  const prop = (pid: number, name: string, value: string) =>
    `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${pid}" name="${name}"><vt:lpwstr>${value}</vt:lpwstr></property>`

  it("custom.xml có nhưng không có flintflow_project_id ⇒ null; ghi stamp dùng lại part cũ, pid nối tiếp", async () => {
    const pkg = await DocxPackage.load(
      await makeDocx({
        body: p("a"),
        extraParts: { "docProps/custom.xml": CUSTOM(prop(5, "Company", "FPT") + prop(6, "flintflow_version", "0.4")) },
        extraContentTypes: `<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>`
      })
    )
    expect(await readStamp(pkg)).toBeNull()
    expect(await readCustomProperties(pkg)).toEqual({ Company: "FPT", flintflow_version: "0.4" })
    await writeStamp(pkg, { project_id: "p9", version: "0.5", source: "cr_revision" })
    const zip = await JSZip.loadAsync(await pkg.toBuffer())
    const ct = await zip.file("[Content_Types].xml")!.async("string")
    expect(ct.match(/\/docProps\/custom\.xml/g)).toHaveLength(1)
    const doc = await pkg.requireXml("docProps/custom.xml")
    const props = Array.from(doc.getElementsByTagNameNS(NS.cp, "property")).map((x) => [x.getAttribute("name"), x.getAttribute("pid")])
    expect(props).toEqual([
      ["Company", "5"],
      ["flintflow_version", "6"],
      ["flintflow_project_id", "7"],
      ["flintflow_source", "8"]
    ])
    expect(await readStamp(pkg)).toEqual({ project_id: "p9", version: "0.5", source: "cr_revision" })
  })

  it("stamp chỉ có project_id ⇒ version/source null; property rỗng tên bị bỏ qua", async () => {
    const pkg = await DocxPackage.load(
      await makeDocx({ body: p("a"), extraParts: { "docProps/custom.xml": CUSTOM(prop(2, "flintflow_project_id", " p1 ") + `<property pid="3"><vt:lpwstr>x</vt:lpwstr></property>`) } })
    )
    expect(await readStamp(pkg)).toEqual({ project_id: "p1", version: null, source: null })
    expect(Object.keys(await readCustomProperties(pkg))).toEqual(["flintflow_project_id"])
  })
})
