import { XMLSerializer } from "@xmldom/xmldom"
import JSZip from "jszip"
import { describe, expect, it, vi } from "vitest"
import { DocxPackage, MAIN_PART } from "../docx-ooxml/index.js"
import { NS, wAll, wKids } from "../docx-ooxml/xml.js"
import type { RenderedDocument, RenderedSection } from "../render/rendered-document.types.js"
import {
  FORWARD_DECISIONS,
  V1_HEADINGS,
  V1_HEADING_KEYS,
  V2_HEADINGS,
  buildV1Source,
  buildV2Template,
  emptyGroups,
  forwardPlan
} from "./base-file-fixtures.test-helper.js"
import { buildBaseFile, planLayout, type BuildBaseFileInput, type BuildBaseFileResult } from "./build-base-file.js"
import { validateDocxStructure } from "./ooxml-transplant.js"

const text = async (buf: Buffer, name: string) => (await (await JSZip.loadAsync(buf)).file(name)!.async("string")) as string
const docText = (buf: Buffer) => text(buf, "word/document.xml")

const section = (id: string, heading: string, body: string): RenderedSection => ({ id, number: "", heading, level: 1, blocks: [{ type: "paragraph", runs: [{ text: body }] }] })
const renderedDoc = (sections: RenderedSection[]): RenderedDocument => ({
  projectId: "p1",
  projectName: "Demo",
  version: "v1.0",
  source: "baseline",
  generatedAt: "2026-11-10T00:00:00.000Z",
  sections,
  recordOfChanges: []
})

const forwardInput = async (over: Partial<BuildBaseFileInput> = {}, sourceOpts: Parameters<typeof buildV1Source>[0] = { dangerous: true }): Promise<BuildBaseFileInput> => ({
  target: await buildV2Template(),
  targetHeadings: V2_HEADINGS,
  oldHeadings: V1_HEADINGS,
  ...forwardPlan(),
  decisions: FORWARD_DECISIONS,
  direction: "forward",
  source: { buffer: await buildV1Source(sourceOpts), headingKeys: V1_HEADING_KEYS },
  ...over
})

const modeOf = (r: BuildBaseFileResult, key: string) => r.sections.find((s) => s.key === key)

const xmlOf = (el: Element): string => new XMLSerializer().serializeToString(el)

/** Heading (style Heading1 / u1) → XML của heading và các phần tử thân tới heading kế, theo thứ tự tài liệu. */
const regions = async (buf: Buffer): Promise<{ heading: string; xml: string }[]> => {
  const pkg = await DocxPackage.load(buf)
  const body = (await pkg.requireXml(MAIN_PART)).getElementsByTagNameNS(NS.w, "body")[0]
  const out: { heading: string; xml: string }[] = []
  for (const el of wKids(body).filter((e) => e.localName !== "sectPr")) {
    const xml = xmlOf(el)
    if (el.localName === "p" && /<w:pStyle w:val="(?:Heading1|u1)"\/>/.test(xml)) out.push({ heading: wAll(el, "t").map((t) => t.textContent).join(""), xml })
    else if (out.length) out[out.length - 1].xml += xml
  }
  return out
}

describe("buildBaseFile — v1 sang v2", () => {
  it("chép nội dung mục khớp theo style mẫu đích, mục thiếu giữ hướng dẫn, mục riêng đặt sau mục đứng trước", async () => {
    const result = await buildBaseFile(await forwardInput({ spineOnly: new Set(["fixed:4.1"]), renderFromSpine: async () => renderedDoc([section("fixed:4.1", "3. Edited", "Edited from spine")]) }))
    expect(result.problems).toEqual([])
    expect(await validateDocxStructure(await DocxPackage.load(result.buffer))).toEqual([])
    const doc = await docText(result.buffer)

    // Mọi chữ / bảng / ảnh của mục khớp có trong file mới
    for (const t of ["Purpose paragraph v1", "List item alpha", "List item beta", "Text with note", "Overview text v1", "Feature X", "High", "Feature Y", "Low"]) expect(doc).toContain(t)
    expect(doc).toMatch(/<a:blip r:embed=/)
    expect(await text(result.buffer, "word/footnotes.xml")).toContain("Footnote text v1")
    // Heading + style của mẫu đích; không còn chữ hướng dẫn của mục đã có nội dung
    expect(doc).toContain("1. Introduction")
    expect(doc).not.toContain("1 Introduction")
    expect(doc).not.toMatch(/w:val="(u1|u2|Dsach|Ghichu|KyTu|TabA)"/)
    expect(doc).not.toContain("Guidance intro")
    expect(doc).not.toContain("Guidance overview")
    expect(doc).not.toContain("Sample feature")
    // Mục thiếu: heading + hướng dẫn, không nội dung
    expect(doc).toContain("4. Brand New")
    expect(doc).toContain("Guidance new: describe the new section")
    expect(modeOf(result, "n3")?.mode).toBe("guidance")
    // Mục riêng: nằm sau Overview, trước Edited
    const order = ["2. Overview", "Feature Y", "3 Extra Notes", "Extra note text v1", "3. Edited"].map((t) => doc.indexOf(t))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(modeOf(result, "custom:x")?.mode).toBe("custom")

    // Bảng Overview: bảng mẫu đích, cột Owner của mẫu để trống không có sẵn dữ liệu — cột cũ không bị mất
    expect(doc).toContain("Priority")
  })

  it("bỏ OLE / link UNC của file nền và attachedTemplate của mẫu, báo trong dropped", async () => {
    const result = await buildBaseFile(await forwardInput({ spineOnly: new Set(["fixed:4.1"]), renderFromSpine: async () => renderedDoc([]) }))
    const zip = await JSZip.loadAsync(result.buffer)
    const names = Object.keys(zip.files)
    expect(names.some((n) => n.includes("oleObject"))).toBe(false)
    const all = (await Promise.all(names.filter((n) => /\.(xml|rels)$/.test(n)).map((n) => zip.file(n)!.async("string")))).join("\n")
    expect(all).not.toContain("fileserver")
    expect(all).not.toContain("attachedTemplate")
    expect(all).not.toContain("OLEObject")
    const kinds = result.dropped.map((d) => d.kind)
    expect(kinds).toEqual(expect.arrayContaining(["ole", "external_link", "attached_template"]))
  })

  it("chuyển dòng Record of Changes sang cột bảng mới, cột mới để trống", async () => {
    const result = await buildBaseFile(await forwardInput({ spineOnly: new Set(["fixed:4.1"]), renderFromSpine: async () => renderedDoc([]) }))
    const pkg = await DocxPackage.load(result.buffer)
    const tables = wAll(await pkg.requireXml(MAIN_PART), "tbl")
    const roc = tables[tables.length - 1]
    const rows = wKids(roc, "tr").map((tr) => wKids(tr, "tc").map((tc) => wAll(tc, "t").map((t) => t.textContent).join("")))
    expect(rows).toEqual([
      ["Version", "Date", "Author", "Description"],
      ["1.0", "2026-01-01", "", "Initial"],
      ["1.1", "2026-02-01", "", "Second"]
    ])
    expect(modeOf(result, "n4")?.mode).toBe("table_mapped")
  })

  it("bảng chép sang không rộng hơn vùng chữ của mẫu đích", async () => {
    const result = await buildBaseFile(await forwardInput({ spineOnly: new Set(["fixed:4.1"]), renderFromSpine: async () => renderedDoc([]) }))
    const pkg = await DocxPackage.load(result.buffer)
    // Mẫu đích: A4 11906 - 2 x 2000 = 7906
    for (const grid of wAll(await pkg.requireXml(MAIN_PART), "tblGrid")) {
      const total = wKids(grid, "gridCol").reduce((s, c) => s + Number(c.getAttributeNS(NS.w, "w")), 0)
      expect(total).toBeLessThanOrEqual(7906)
    }
  })

  it("mục đã bị CR sửa dựng từ Spine, các mục khác không bị writer đụng", async () => {
    const render = vi.fn(async () =>
      renderedDoc([section("fixed:4.1", "3. Edited", "Edited from spine"), section("fixed:1.1", "1. Introduction", "KHONG DUOC XUAT HIEN")])
    )
    const result = await buildBaseFile(await forwardInput({ spineOnly: new Set(["fixed:4.1"]), renderFromSpine: render }))
    const doc = await docText(result.buffer)
    expect(render).toHaveBeenCalledWith(["fixed:4.1"])
    expect(doc).toContain("Edited from spine")
    expect(doc).not.toContain("Old text of edited")
    expect(doc).not.toContain("Guidance edited")
    expect(doc).not.toContain("KHONG DUOC XUAT HIEN")
    expect(doc).toContain("Purpose paragraph v1")
    expect(modeOf(result, "n2")).toMatchObject({ mode: "spine", reason: "Mục đã bị change request sửa" })
    expect(modeOf(result, "n2")?.flag).toBeUndefined()
  })

  it("mục chép lỗi dựng từ Spine kèm cờ vàng, các mục khác vẫn chép bình thường", async () => {
    const result = await buildBaseFile(
      await forwardInput(
        { spineOnly: new Set(["fixed:4.1"]), renderFromSpine: async () => renderedDoc([section("fixed:2.1", "2. Overview", "Overview from spine"), section("fixed:4.1", "3. Edited", "Edited from spine")]) },
        { dangerous: false, unsafeOverview: true }
      )
    )
    const doc = await docText(result.buffer)
    expect(modeOf(result, "n1")).toMatchObject({ mode: "spine", flag: "yellow" })
    expect(modeOf(result, "n1")?.reason).toMatch(/unsafe_field/)
    expect(doc).toContain("Overview from spine")
    expect(doc).not.toContain("Overview text v1")
    expect(doc).not.toContain("INCLUDETEXT")
    expect(doc).toContain("Purpose paragraph v1")
    expect(modeOf(result, "n0")?.mode).toBe("transplant")
    expect(result.problems).toEqual([])
  })

  it("không có file nền (mode 2 / fpt / dự án mới / mode 4): mọi mục dựng từ Spine, mục riêng có heading mẫu", async () => {
    const render = vi.fn(async (ids: readonly string[]) => ({
      ...renderedDoc(ids.map((id) => section(id, id, `spine body of ${id}`))),
      recordOfChanges: [{ date: "2026-03-01", version: "2.0", change_type: "A" as const, in_charge: "Lan", description: "Row from spine" }]
    }))
    const result = await buildBaseFile(await forwardInput({ source: null, renderFromSpine: render }))
    const doc = await docText(result.buffer)
    expect(doc).not.toContain("Purpose paragraph v1")
    for (const id of ["fixed:1.1", "fixed:2.1", "fixed:4.1", "custom:x"]) expect(doc).toContain(`spine body of ${id}`)
    expect(doc).toContain("Row from spine")
    expect(modeOf(result, "n0")?.mode).toBe("spine")
    expect(modeOf(result, "custom:x")?.mode).toBe("spine")
    expect(doc).toContain("3 Extra Notes")
    expect(result.problems).toEqual([])
  })

  it("đổi sang mẫu khác ngôn ngữ: mọi mục có cặp dựng từ Spine (đã dịch)", async () => {
    const render = vi.fn(async (ids: readonly string[]) => renderedDoc(ids.map((id) => section(id, id, `translated ${id}`))))
    const result = await buildBaseFile(await forwardInput({ needsTranslation: true, renderFromSpine: render }))
    const doc = await docText(result.buffer)
    expect(doc).not.toContain("Purpose paragraph v1")
    expect(doc).toContain("translated fixed:1.1")
    expect(result.sections.filter((s) => s.old_key && s.mode === "spine").length).toBeGreaterThanOrEqual(4)
  })

  it("thiếu bộ dựng từ Spine ⇒ giữ hướng dẫn của mẫu và gắn cờ vàng, không ném", async () => {
    const result = await buildBaseFile(await forwardInput({ spineOnly: new Set(["fixed:4.1"]) }))
    expect(modeOf(result, "n2")).toMatchObject({ mode: "spine", flag: "yellow" })
    expect(await docText(result.buffer)).toContain("Guidance edited")
  })

  it("quyết định: xoá mục thừa, giữ bảng cũ nguyên cột", async () => {
    const result = await buildBaseFile(
      await forwardInput({
        spineOnly: new Set(["fixed:4.1"]),
        renderFromSpine: async () => renderedDoc([]),
        decisions: [
          { id: "e:custom:x", choice: "delete" },
          { id: "c:record_of_changes:fixed:I", choice: "keep_old_table" }
        ]
      })
    )
    const doc = await docText(result.buffer)
    expect(doc).not.toContain("Extra note text v1")
    expect(modeOf(result, "custom:x")?.mode).toBe("removed")
    const pkg = await DocxPackage.load(result.buffer)
    const tables = wAll(await pkg.requireXml(MAIN_PART), "tbl")
    const header = wKids(wKids(tables[tables.length - 1], "tr")[0], "tc").map((tc) => wAll(tc, "t").map((t) => t.textContent).join(""))
    expect(header).toEqual(["Version", "Date", "Description"])
  })

  it("heading mẫu không khớp số heading của file ⇒ ném lỗi rõ ràng", async () => {
    await expect(buildBaseFile(await forwardInput({ targetHeadings: V2_HEADINGS.slice(1) }))).rejects.toMatchObject({ code: "target_headings_mismatch" })
  })
})

describe("buildBaseFile — v2 về v1 (đổi ngược)", () => {
  /** Mục chưa sửa giữ nguyên văn khối của bản chụp v1 (so XML từng mục). */
  it("mục chưa sửa giống hệt file v1 ban đầu; mục đã sửa dựng từ Spine; không gọi dịch lại", async () => {
    const snapshot = await buildV1Source()
    // File nền hiện tại = kết quả đổi xuôi từ chính snapshot
    const forward = await buildBaseFile(await forwardInput({ spineOnly: new Set(["fixed:4.1"]), renderFromSpine: async () => renderedDoc([section("fixed:4.1", "3. Edited", "Edited from spine")]) }, { dangerous: false }))
    const currentKeys = ["fixed:1.1", "fixed:2.1", "custom:x", "fixed:4.1", "fixed:9.9", "fixed:I"]
    const current = currentKeys.map((key, i) => ({ key, heading_text: key, level: 1, section_id: key === "fixed:9.9" ? "fixed:9.9" : key, i }))
    const render = vi.fn(async () => renderedDoc([section("fixed:4.1", "4 Edited", "Edited after migration")]))
    const pairs = [
      { old_key: "fixed:1.1", new_key: "n0", by: "section_id" as const, score: 1, needs_review: false },
      { old_key: "fixed:2.1", new_key: "n1", by: "section_id" as const, score: 1, needs_review: false },
      { old_key: "custom:x", new_key: "n2", by: "title" as const, score: 1, needs_review: false },
      { old_key: "fixed:4.1", new_key: "n4", by: "section_id" as const, score: 1, needs_review: false },
      { old_key: "fixed:9.9", new_key: null, by: null, score: 0, needs_review: false },
      { old_key: "fixed:I", new_key: "n3", by: "section_id" as const, score: 1, needs_review: false }
    ]
    const result = await buildBaseFile({
      target: snapshot,
      targetIsSnapshot: true,
      targetHeadings: V1_HEADINGS.map((h, i) => ({ key: `n${i}`, heading_text: h.heading_text, section_id: h.section_id })),
      oldHeadings: current,
      pairing: { pairs, followers: [], ignored_new: [], split: [] },
      groups: {
        ...emptyGroups(),
        edited_since: [{ id: "s:fixed:4.1", old_key: "fixed:4.1", heading_text: "4 Edited", changes: 1, last_at: "2026-11-01T00:00:00.000Z", chars: 10, choices: ["keep", "discard"], default: "keep" }]
      },
      decisions: [{ id: "e:fixed:9.9", choice: "drop_from_print" }],
      direction: "reverse",
      source: { buffer: forward.buffer, headingKeys: currentKeys },
      renderFromSpine: render
    })
    expect(result.problems).toEqual([])
    expect(render).toHaveBeenCalledTimes(1)

    const before = await regions(snapshot)
    const after = await regions(result.buffer)
    expect(after.map((r) => r.heading)).toEqual(before.map((r) => r.heading))
    // Introduction, Overview, Extra Notes, Record of Changes: nguyên văn
    for (const i of [0, 1, 2, 3]) expect(after[i].xml).toBe(before[i].xml)
    expect(after[4].xml).toContain("Edited after migration")
    expect(after[4].xml).not.toContain("Old text of edited")
    expect(result.sections.map((s) => [s.key, s.mode])).toEqual(
      expect.arrayContaining([["n0", "restored"], ["n1", "restored"], ["n2", "restored"], ["n3", "restored"], ["n4", "spine"]])
    )
  })

  it("chọn discard cho mục đã sửa ⇒ lấy lại khối cũ, không gọi Spine", async () => {
    const snapshot = await buildV1Source()
    const render = vi.fn(async () => renderedDoc([]))
    const result = await buildBaseFile({
      target: snapshot,
      targetIsSnapshot: true,
      targetHeadings: V1_HEADINGS.map((h, i) => ({ key: `n${i}`, heading_text: h.heading_text, section_id: h.section_id })),
      oldHeadings: V1_HEADINGS,
      pairing: { pairs: V1_HEADINGS.map((h, i) => ({ old_key: h.key, new_key: `n${i}`, by: "section_id" as const, score: 1, needs_review: false })), followers: [], ignored_new: [], split: [] },
      groups: {
        ...emptyGroups(),
        edited_since: [{ id: "s:fixed:4.1", old_key: "fixed:4.1", heading_text: "4 Edited", changes: 1, last_at: "2026-11-01T00:00:00.000Z", chars: 10, choices: ["keep", "discard"], default: "keep" }]
      },
      decisions: [{ id: "s:fixed:4.1", choice: "discard" }],
      direction: "reverse",
      source: null,
      renderFromSpine: render
    })
    expect(render).not.toHaveBeenCalled()
    const before = await regions(snapshot)
    const after = await regions(result.buffer)
    after.forEach((r, i) => expect(r.xml).toBe(before[i].xml))
  })
})

const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1

describe("buildBaseFile — nội dung chuyển vào heading đã có cặp", () => {
  const moveDecisions = [{ id: "e:custom:x", choice: "move_to:n2" }, FORWARD_DECISIONS[1]]
  const extraWithMove = () => {
    const plan = forwardPlan()
    plan.groups.extra[0] = { ...plan.groups.extra[0], choices: ["keep_custom", "delete", "move_to:n2"] }
    return plan
  }

  it("mục đã sửa dựng từ Spine + nội dung chuyển vào cùng heading: cả hai đều có mặt, nội dung chuyển không bị writer ghi đè", async () => {
    const result = await buildBaseFile(
      await forwardInput({
        ...extraWithMove(),
        decisions: moveDecisions,
        spineOnly: new Set(["fixed:4.1"]),
        renderFromSpine: async () => renderedDoc([section("fixed:4.1", "3. Edited", "Edited from spine")])
      })
    )
    const doc = await docText(result.buffer)
    expect(doc).toContain("Edited from spine")
    expect(doc).toContain("3 Extra Notes")
    expect(doc).toContain("Extra note text v1")
    expect(doc.indexOf("Edited from spine")).toBeLessThan(doc.indexOf("3 Extra Notes"))
    expect(result.sections.find((s) => s.key === "n2")).toMatchObject({ mode: "spine", old_key: "fixed:4.1" })
    expect(result.sections.find((s) => s.key === "custom:x")).toMatchObject({ mode: "moved", new_key: "n2" })
    expect(result.problems).toEqual([])
  })

  it("mục chuyển bị CR sửa ⇒ dựng từ Spine dưới heading đích, không mất", async () => {
    const result = await buildBaseFile(
      await forwardInput({
        ...extraWithMove(),
        decisions: moveDecisions,
        spineOnly: new Set(["fixed:4.1", "custom:x"]),
        renderFromSpine: async (ids) => renderedDoc(ids.map((id) => section(id, id, `spine body of ${id}`)))
      })
    )
    const doc = await docText(result.buffer)
    expect(doc).toContain("spine body of fixed:4.1")
    expect(doc).toContain("spine body of custom:x")
    expect(doc).not.toContain("Extra note text v1")
    expect(result.sections.find((s) => s.key === "custom:x")).toMatchObject({ mode: "spine", new_key: "n2" })
  })
})

describe("buildBaseFile — đổi ngược có nội dung chuyển vào heading đã có cặp", () => {
  it("không in hai lần mục chưa sửa: chỉ phần chuyển vào được chép thêm", async () => {
    const snapshot = await buildV1Source()
    const forward = await buildBaseFile(await forwardInput({ spineOnly: new Set(["fixed:4.1"]), renderFromSpine: async () => renderedDoc([section("fixed:4.1", "3. Edited", "Edited from spine")]) }, { dangerous: false }))
    const keys = ["fixed:1.1", "fixed:2.1", "custom:x", "fixed:4.1", "fixed:9.9", "fixed:I"]
    const pair = (old_key: string, new_key: string | null) => ({ old_key, new_key, by: new_key ? ("section_id" as const) : null, score: 1, needs_review: false })
    const targetHeadings = V1_HEADINGS.map((h, i) => ({ key: `n${i}`, heading_text: h.heading_text, section_id: h.section_id }))
    const result = await buildBaseFile({
      target: snapshot,
      targetIsSnapshot: true,
      targetHeadings,
      oldHeadings: keys.map((key) => ({ key, heading_text: key, level: 1, section_id: key })),
      pairing: { pairs: [pair("fixed:1.1", "n0"), pair("fixed:2.1", "n1"), pair("custom:x", "n2"), pair("fixed:4.1", "n4"), pair("fixed:9.9", null), pair("fixed:I", "n3")], followers: [], ignored_new: [], split: [] },
      groups: emptyGroups(),
      // fixed:9.9 (mục "Brand New" của file hiện tại) chuyển vào heading n0 vốn đã có cặp với fixed:1.1
      decisions: [{ id: "e:fixed:9.9", choice: "move_to:n0" }],
      direction: "reverse",
      source: { buffer: forward.buffer, headingKeys: keys }
    })
    const doc = await docText(result.buffer)
    expect(countOf(doc, "Purpose paragraph v1")).toBe(1)
    expect(countOf(doc, "List item alpha")).toBe(1)
    expect(countOf(doc, "Guidance new: describe the new section")).toBe(1)
    expect(result.sections.find((s) => s.key === "fixed:9.9")).toMatchObject({ mode: "moved", new_key: "n0" })
    expect(result.sections.find((s) => s.key === "n0")?.mode).toBe("restored")
    // Mục khác vẫn nguyên văn
    const before = await regions(snapshot)
    // Phần chuyển vào là một khối có heading riêng ("4. Brand New") nằm sau mục n0; bỏ nó ra thì mọi mục khác y nguyên bản chụp
    const after = (await regions(result.buffer)).filter((r) => r.heading !== "4. Brand New")
    expect(after.map((r) => r.xml)).toEqual(before.map((r) => r.xml))
    expect(result.problems).toEqual([])
  })
})

describe("buildBaseFile — lỗi cấu trúc, dọn part, giới hạn gói", () => {
  it("lỗi có sẵn trong mẫu đích không làm các mục đã chép rơi về Spine", async () => {
    const result = await buildBaseFile(await forwardInput({ target: await buildV2Template({ orphanNumId: true }), spineOnly: new Set(["fixed:4.1"]), renderFromSpine: async () => renderedDoc([section("fixed:4.1", "3. Edited", "Edited from spine")]) }))
    expect(result.fellBackToSpine).toBe(false)
    expect(result.problems).toEqual([])
    expect(result.sections.find((s) => s.key === "n0")?.mode).toBe("transplant")
    expect(result.sections.find((s) => s.key === "n1")?.mode).toBe("transplant")
    expect(result.warnings.some((w) => w.includes("vấn đề cấu trúc"))).toBe(true)
  })

  it("mục chép lỗi giữa chừng: ảnh / rels đã ghi của mục đó được dọn khỏi gói", async () => {
    const plan = forwardPlan()
    plan.groups.conflict.push({ id: "c:table_columns:fixed:2.1", kind: "table_columns", old_key: "fixed:2.1", new_key: "n1", candidate_keys: [], old_columns: [["h:feature", "h:priority"]], new_columns: [["h:feature", "h:priority", "h:owner"]], choices: ["map_by_header", "keep_old_table", "ai_resolve"], ai_choices: ["ai_resolve"], decision_required: true })
    const result = await buildBaseFile(
      await forwardInput(
        {
          ...plan,
          decisions: [...FORWARD_DECISIONS, { id: "c:table_columns:fixed:2.1", choice: "map_by_header" }],
          spineOnly: new Set(["fixed:4.1"]),
          renderFromSpine: async () => renderedDoc([section("fixed:2.1", "2. Overview", "Overview from spine"), section("fixed:4.1", "3. Edited", "Edited from spine")])
        },
        { dangerous: false, overviewTrap: true }
      )
    )
    expect(result.sections.find((s) => s.key === "n1")).toMatchObject({ mode: "spine", flag: "yellow" })
    const zip = await JSZip.loadAsync(result.buffer)
    // Chỉ còn ảnh của mục Introduction; ảnh của mục Overview (chép trước khi mục lỗi) bị dọn
    expect(Object.keys(zip.files).filter((n) => /^word\/media\/transplant\d+\.png$/.test(n))).toHaveLength(1)
    const rels = await zip.file("word/_rels/document.xml.rels")!.async("string")
    expect(countOf(rels, "media/transplant")).toBe(1)
    expect(result.problems).toEqual([])
  })

  it("gói vượt giới hạn số mục ⇒ lỗi người dùng rõ ràng, không phải lỗi hạ tầng", async () => {
    const zip = await JSZip.loadAsync(await buildV2Template())
    for (let i = 0; i < 5100; i++) zip.file(`junk/${i}.txt`, "x")
    const target = await zip.generateAsync({ type: "nodebuffer" })
    await expect(buildBaseFile(await forwardInput({ target }))).rejects.toMatchObject({ statusCode: 422, code: "TEMPLATE_MIGRATION_FILE_TOO_LARGE" })
  })
})

describe("planLayout — mục khung chuyển vào heading mẫu chưa có cặp (test tay 11/11)", () => {
  const pair = (old_key: string, new_key: string | null) => ({ old_key, new_key, by: new_key ? ("section_id" as const) : null, score: 1, needs_review: false })
  const base = {
    targetHeadings: [
      { key: "n0", heading_text: "4.2.3 Performance", section_id: "fixed:4.2.3", level: 4 },
      { key: "n1", heading_text: "4.2.4 …", section_id: "unmapped", level: 4 }
    ],
    oldHeadings: [
      { key: "fixed:4.2.3", heading_text: "4.2.3 Performance", level: 3, section_id: "fixed:4.2.3" },
      { key: "fixed:4.2.4", heading_text: "4.2.4 Domain-Specific Attributes", level: 3, section_id: "fixed:4.2.4" },
      { key: "custom:c1", heading_text: "Team notes", level: 3, section_id: "custom:c1" }
    ],
    pairing: { pairs: [pair("fixed:4.2.3", "n0"), pair("fixed:4.2.4", null), pair("custom:c1", null)], followers: [], ignored_new: [], split: [] },
    groups: emptyGroups()
  }

  it("mục khung ⇒ nằm dưới heading đích, mang id mục cũ; không tạo mục riêng trống, không có heading anh em", () => {
    let n = 0
    const layout = planLayout({ ...base, decisions: [{ id: "e:fixed:4.2.4", choice: "move_to:n1" }, { id: "e:custom:c1", choice: "keep_custom" }] }, () => `CS${++n}`)
    expect(layout.newCustoms).toEqual([])
    expect(layout.entries.map((e) => [e.heading_text, e.section_id, e.kind, e.missing])).toEqual([
      ["4.2.3 Performance", "fixed:4.2.3", "target", false],
      ["4.2.4 …", "fixed:4.2.4", "target", false],
      ["Team notes", "custom:c1", "custom", false]
    ])
  })

  it("mục chữ tự do chuyển vào vẫn giữ heading gốc làm ranh giới (cách cũ)", () => {
    let n = 0
    const layout = planLayout({ ...base, decisions: [{ id: "e:fixed:4.2.4", choice: "keep_custom" }, { id: "e:custom:c1", choice: "move_to:n1" }] }, () => `CS${++n}`)
    expect(layout.entries.find((e) => e.kind === "moved")).toMatchObject({ heading_text: "Team notes", section_id: "custom:c1", new_key: "n1" })
  })
})

describe("planLayout — cấp phần tử / mục riêng theo cấp mẫu đích (test tay 11/11)", () => {
  it("mẫu đích sâu hơn một cấp ⇒ tính năng, chức năng, mục riêng giữ lại cùng dịch một cấp", () => {
    const pair = (old_key: string, new_key: string | null) => ({ old_key, new_key, by: new_key ? ("section_id" as const) : null, score: 1, needs_review: false })
    const layout = planLayout(
      {
        targetHeadings: [
          { key: "n0", heading_text: "3.1.5 Entity Relationship Diagram", section_id: "fixed:3.1.5", level: 4 },
          { key: "n1", heading_text: "5.4 Other Requirements", section_id: "fixed:5.4", level: 3 }
        ],
        oldHeadings: [
          { key: "fixed:3.1.5", heading_text: "3.1.5 Entity Relationship Diagram", level: 3, section_id: "fixed:3.1.5" },
          { key: "feature:F1", heading_text: "3.2 Authentication", level: 2, section_id: "feature:F1" },
          { key: "function:FN1", heading_text: "3.2.1 Log in", level: 3, section_id: "function:FN1" },
          { key: "fixed:5.4", heading_text: "5.4 Other Requirements", level: 2, section_id: "fixed:5.4" },
          { key: "custom:CS1", heading_text: "5.5 Glossary", level: 2, section_id: "custom:CS1" }
        ],
        pairing: {
          pairs: [pair("fixed:3.1.5", "n0"), pair("fixed:5.4", "n1"), pair("custom:CS1", null)],
          followers: [
            { old_key: "feature:F1", parent_old_key: "fixed:3.1.5", kind: "element" },
            { old_key: "function:FN1", parent_old_key: "fixed:3.1.5", kind: "element" }
          ],
          ignored_new: [],
          split: []
        },
        groups: emptyGroups(),
        decisions: [{ id: "e:custom:CS1", choice: "keep_custom" }]
      } as Parameters<typeof planLayout>[0],
      () => "CSX"
    )
    expect(layout.entries.map((e) => [e.heading_text, e.level])).toEqual([
      ["3.1.5 Entity Relationship Diagram", 4],
      ["3.2 Authentication", 3],
      ["3.2.1 Log in", 4],
      ["5.4 Other Requirements", 3],
      ["5.5 Glossary", 3]
    ])
  })
})

describe("buildBaseFile — mục riêng đứng trước mọi mục có cặp (test tay lượt 3, 11/11)", () => {
  it("thứ tự heading của file dựng ra khớp planLayout: mục riêng đầu file cũ ở cuối, mục riêng sau mục có cặp cuối cùng đứng trước nó", async () => {
    const pair = (old_key: string, new_key: string | null) => ({ old_key, new_key, by: new_key ? ("section_id" as const) : null, score: 1, needs_review: false })
    const extra = (key: string, text: string) => ({ id: `e:${key}`, old_key: key, heading_text: text, section_id: key, follower_keys: [], choices: ["keep_custom", "drop_from_print"], ai_choices: [], decision_required: true as const })
    const base = forwardPlan()
    const input = await forwardInput({
      pairing: { ...base.pairing, pairs: [pair("fixed:1.1", null), pair("fixed:2.1", "n1"), pair("custom:x", null), pair("fixed:I", "n4"), pair("fixed:4.1", null)] },
      groups: { ...base.groups, matched: [base.groups.matched[1]], extra: [extra("fixed:1.1", "1 Introduction"), extra("custom:x", "3 Extra Notes"), extra("fixed:4.1", "4 Edited")] },
      decisions: [
        { id: "e:fixed:1.1", choice: "keep_custom" },
        { id: "e:custom:x", choice: "keep_custom" },
        { id: "e:fixed:4.1", choice: "keep_custom" },
        { id: "c:record_of_changes:fixed:I", choice: "map_by_header" }
      ]
    })
    let n = 0
    const layout = planLayout(input, () => `CS${++n}`)
    const result = await buildBaseFile(input)
    const fileHeadings = (await regions(result.buffer)).map((r) => r.heading)
    expect(layout.entries.map((e) => e.heading_text)).toEqual(["1. Introduction", "2. Overview", "3 Extra Notes", "3. Edited", "4. Brand New", "Record of Changes", "4 Edited", "1 Introduction"])
    expect(fileHeadings).toEqual(layout.entries.map((e) => e.heading_text))
  })
})

