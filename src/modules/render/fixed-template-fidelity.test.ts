import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DocxPackage } from "../docx-ooxml/index.js"
import { wAll, wKid, wKids } from "../docx-ooxml/xml.js"
import { parseDocument } from "../import/parse.service.js"
import { assignBlockSections, matchProfile } from "../import/profile-match.service.js"
import { buildLayout } from "../import/step-plan.js"
import { spineSchema } from "../spine/spine.schema.js"
import { _internal } from "./assemble.service.js"
import { templateHeadingMap } from "./project-docx-writer.js"
import { writeTemplateDocx } from "./template-docx-writer.js"
import { readZipEntries } from "./zip.test-helper.js"

/** Mẫu thực tế trong báo lỗi của người dùng, giữ trong fixtures để CI kiểm tra được độc lập. */
describe("FU-IT-SRS-01 — upload → mapping → layout → assembly → DOCX", () => {
  it("keeps every Word part byte-identical when no content is filled", async () => {
    const source = readFileSync(new URL("../../../fixtures/fixed-template-fu-it-srs-01.docx", import.meta.url))
    const parsed = await parseDocument(source)
    const profile = matchProfile(parsed.blocks, { fixedTemplate: true })
    const output = await writeTemplateDocx({
      projectId: "650000000000000000000001", projectName: "[Project name]", version: "[Version]",
      generatedAt: "[Date]", source: "draft", sections: [], recordOfChanges: []
    }, source, profile.heading_map)
    const original = readZipEntries(source), result = readZipEntries(output)
    for (const [name, bytes] of original) if (name.startsWith("word/")) expect(result.get(name), name).toEqual(bytes)
  })

  it("giữ bìa, lề 2cm, heading, bảng và package định dạng của mẫu thực tế", async () => {
    const source = readFileSync(new URL("../../../fixtures/fixed-template-fu-it-srs-01.docx", import.meta.url))
    const parsed = await parseDocument(source)
    const profile = matchProfile(parsed.blocks)
    const headingSections = new Map(profile.heading_map.map((h) => [h.block_id, h.section_id]))
    const sectionMap = assignBlockSections(parsed.blocks, profile.heading_map)
    const built = buildLayout(parsed.blocks.map((b) => ({ ...b, section_id: sectionMap.get(b.block_id) ?? null })), headingSections)
    const spine = spineSchema.parse(JSON.parse(readFileSync(new URL("../../../fixtures/spine-fixture-minimal.json", import.meta.url), "utf8")))
    spine.custom_sections = built.customSections
    const doc = await _internal.buildDocument({
      projectId: "650000000000000000000001", projectName: "Student Club Hub", spine,
      statusChanges: [], recordChanges: [], source: "draft", version: "v0",
      partial: true, template: { layout: built.layout, language: profile.language, fixedTemplate: true }
    }, { loadDiagramPng: async () => null, now: () => new Date("2026-11-04T00:00:00Z") })
    const output = await writeTemplateDocx(doc, source, templateHeadingMap(profile.heading_map, built.layout))
    const outputParts = readZipEntries(output)
    const sourceParts = readZipEntries(source)
    for (const name of ["word/styles.xml", "word/numbering.xml"]) expect(outputParts.get(name)).toEqual(sourceParts.get(name))
    const outPkg = await DocxPackage.load(output)
    const outXml = await outPkg.requireXml("word/document.xml")
    const sourceXml = await (await DocxPackage.load(source)).requireXml("word/document.xml")
    expect(wAll(outXml, "sectPr").map((n) => n.toString())).toEqual(wAll(sourceXml, "sectPr").map((n) => n.toString()))
    const text = wAll(outXml, "t").map((t) => t.textContent).join("")
    expect(text).toContain("FPT University — Software Requirements Specification Template")
    expect(text).toContain("Student Club Hub — v0 — 2026-11-04")
    expect(text).not.toContain("WORKING DRAFT - NOT BASELINED")
    expect(text).not.toContain("I. Record of Changes")
    expect(outPkg.partNames().filter((n) => /word\/(header|footer)/.test(n))).toEqual([])
    const headings = (await parseDocument(output)).blocks.filter((b) => b.kind === "heading")
    for (const original of parsed.blocks.filter((b) => b.kind === "heading")) {
      expect(headings.some((h) => h.text === original.text && h.level === original.level), original.text).toBe(true)
    }
    const originalHistory = wAll(sourceXml, "tbl")[0]
    const outputHistory = wAll(outXml, "tbl")[0]
    expect(outputHistory.toString()).toBe(originalHistory.toString())
    for (const tbl of wAll(outXml, "tbl")) {
      const props = wKid(tbl, "tblPr")
      expect(props).toBeDefined()
    }

    doc.recordOfChanges = [{ version: "0.2", date: "2026-11-04", in_charge: "Club reviewer", change_type: "M", description: "Update club registration rules" }]
    const withHistory = await DocxPackage.load(await writeTemplateDocx(doc, source, templateHeadingMap(profile.heading_map, built.layout)))
    const history = wAll(await withHistory.requireXml("word/document.xml"), "tbl")[0]
    expect(wKids(history, "tr").every((row) => wKids(row, "tc").length === 4)).toBe(true)
    expect(wKids(history, "tr")[0].toString()).toBe(wKids(originalHistory, "tr")[0].toString())
    expect(wKid(history, "tblPr")?.toString()).toBe(wKid(originalHistory, "tblPr")?.toString())
    expect(wAll(history, "t").map((t) => t.textContent).join(" ")).toContain("Update club registration rules")
  })

  it("mapping lúc tách file của mẫu bắt buộc: heading xuất đúng từng dòng như mẫu; dữ liệu nằm dưới heading con, không dưới heading bao", async () => {
    const source = readFileSync(new URL("../../../fixtures/fixed-template-fu-it-srs-01.docx", import.meta.url))
    const parsed = await parseDocument(source)
    const profile = matchProfile(parsed.blocks, { fixedTemplate: true })
    const headingSections = new Map(profile.heading_map.map((h) => [h.block_id, h.section_id]))
    const sectionMap = assignBlockSections(parsed.blocks, profile.heading_map)
    const built = buildLayout(parsed.blocks.map((b) => ({ ...b, section_id: sectionMap.get(b.block_id) ?? null })), headingSections)
    const spine = spineSchema.parse(JSON.parse(readFileSync(new URL("../../../fixtures/spine-fixture-minimal.json", import.meta.url), "utf8")))
    spine.custom_sections = built.customSections
    spine.project.release_scope = { in: ["Club registration"], out: ["Payments"] }
    spine.project.goals = ["Halve the time to approve a club"]
    const doc = await _internal.buildDocument({
      projectId: "650000000000000000000001", projectName: "Student Club Hub", spine,
      statusChanges: [], recordChanges: [], source: "draft", version: "v0",
      partial: true, template: { layout: built.layout, language: profile.language, fixedTemplate: true }
    }, { loadDiagramPng: async () => null, now: () => new Date("2026-11-04T00:00:00Z") })
    const byHeading = (re: RegExp) => doc.sections.find((s) => re.test(s.heading))
    // Heading bao giữ tiêu đề nhưng không mang dữ liệu của mục FPT; heading con mang mục đó
    expect(byHeading(/External Interface Requirements/)?.id).not.toBe("fixed:4.1")
    expect(byHeading(/Software Interfaces/)?.id).toBe("fixed:4.1")
    expect(byHeading(/^Introduction$/)?.id).not.toBe("fixed:1")
    // 1.2 Scope: in / out (+ goals theo IEEE) là dòng nhãn thường, không phải dòng giống heading
    const scope = byHeading(/^Scope$/)
    expect(scope?.id).toBe("slot:scope")
    const runs = (scope?.blocks ?? []).flatMap((b) => (b.type === "paragraph" ? b.runs : []))
    expect(runs.some((r) => r.bold)).toBe(false)
    expect(runs.map((r) => r.text)).toEqual(expect.arrayContaining(["Goals:", "In Scope:", "Out of Scope:"]))

    const output = await writeTemplateDocx(doc, source, templateHeadingMap(profile.heading_map, built.layout))
    const outHeadings = (await parseDocument(output)).blocks.filter((b) => b.kind === "heading").map((b) => [b.text, b.level])
    expect(outHeadings).toEqual(parsed.blocks.filter((b) => b.kind === "heading").map((b) => [b.text, b.level]))
  })
})
