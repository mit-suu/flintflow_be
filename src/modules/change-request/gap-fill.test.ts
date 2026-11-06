import { describe, expect, it, vi } from "vitest"

const costs = vi.hoisted(() => ({ cr_clarify: 1, cr_propose: 3, cr_consistency: 2 }) as Record<string, number>)
vi.mock("../../shared/ai/credit-reservation.service.js", async (orig) => ({
  ...(await orig<typeof import("../../shared/ai/credit-reservation.service.js")>()),
  getActionCost: async (action: string) => costs[action] ?? 0
}))

import { createEmptySpine } from "../spine/spine.repository.js"
import type { CustomSection, Spine } from "../spine/spine.types.js"
import {
  GAP_SECTION_EMPTY_RULE,
  emptyGapSections,
  fillableGapSections,
  gapFillBatches,
  gapFillLocations,
  gapFillRequestText,
  gapSectionFlags,
  gapSectionPaths,
  gapSectionsContext
} from "./gap-fill.js"
import { gapFillCreditPerGroup } from "./gap-fill.service.js"
import { PROPOSE_BATCH } from "./propose.service.js"

const custom = (id: string, heading: string, texts: string[], rows: string[][] | null = null): CustomSection => ({
  id,
  heading,
  level: 2,
  source: "import",
  blocks: [...texts.map((text) => ({ kind: "paragraph" as const, text, rows: null, image_ref: null })), ...(rows ? [{ kind: "table" as const, text: "", rows, image_ref: null }] : [])]
})

const spineWith = (over: Partial<Spine> = {}): Spine => ({ ...createEmptySpine({ name: "Lumen" }), ...over })

describe("FLF-382 lời yêu cầu CR bổ sung", () => {
  it("liệt kê tiêu đề theo file, theo ngôn ngữ tài liệu", () => {
    const vi = gapFillRequestText(["2.3 User Characteristics", "3.3 Performance Requirements"], "vi")
    expect(vi.title).toBe("Bổ sung mục còn thiếu")
    expect(vi.description).toContain("Soạn các mục còn trống của tài liệu: 2.3 User Characteristics, 3.3 Performance Requirements.")
    const en = gapFillRequestText(["5.5 Glossary", " "], "en")
    expect(en.title).toBe("Fill in missing sections")
    expect(en.description).toContain("still empty: 5.5 Glossary.")
    expect(gapFillRequestText(Array.from({ length: 2000 }, (_, i) => `Section ${i}`), "en").description.length).toBeLessThanOrEqual(5000)
  })
})

describe("FLF-382 C-3 vị trí loại 'mục' cho mục trống", () => {
  it("mục FPT ⇒ mảng nuôi mục (fixed:1 ⇒ project); phần nhỏ ⇒ đích của phần; mục riêng ⇒ phần tử custom_sections", () => {
    expect(gapSectionPaths("fixed:5.5")).toEqual(["glossary[]"])
    expect(gapSectionPaths("fixed:3.1.3")).toEqual(["roles[]", "permissions[]"])
    expect(gapSectionPaths("fixed:1")).toEqual(["project"])
    expect(gapSectionPaths("slot:assumptions")).toEqual(["other_requirements[]"])
    expect(gapSectionPaths("slot:vision")).toEqual(["project"])
    expect(gapSectionPaths("slot:analysis_models")).toEqual([])
    expect(gapSectionPaths("custom:CS02")).toEqual(["custom_sections[id=CS02]"])
    expect(gapSectionPaths("feature:F-3.2")).toEqual([])
  })

  it("mỗi mục một vị trí, step sở hữu với mục FPT; hai mục cùng đường ghi ⇒ một vị trí nêu cả hai; mục riêng không còn ⇒ bỏ", () => {
    const spine = spineWith({ custom_sections: [custom("CS02", "5.10 Document Conventions", ["[Describe conventions]"])] })
    const found = gapFillLocations(spine, ["fixed:5.5", "slot:assumptions", "custom:CS02", "fixed:5.4", "custom:CS99", "slot:vision", "slot:goals"])
    expect(found.map((f) => [f.path, f.section_id, f.owner_step, f.entity_paths])).toEqual([
      ["glossary[]", "fixed:5.5", "S-8.1", ["fixed:5.5"]],
      ["other_requirements[]", "slot:assumptions", null, ["slot:assumptions", "fixed:5.4"]],
      ["custom_sections[id=CS02]", "custom:CS02", null, ["custom:CS02"]],
      ["project", "slot:vision", null, ["slot:vision", "slot:goals"]]
    ])
    expect(found.every((f) => f.found_by.join() === "spine_link")).toBe(true)
    expect(fillableGapSections(spine, ["feature:F-3.2", "fixed:5.5", "custom:CS99", "slot:analysis_models"])).toEqual(["fixed:5.5"])
  })

  it("chia lô theo phần (step sở hữu / skill), mỗi phần cắt theo PROPOSE_BATCH", () => {
    const spine = spineWith({ custom_sections: [custom("CS02", "Document Conventions", []), custom("CS03", "Team notes", [])] })
    const nfr = ["fixed:4.2.1", "fixed:4.2.2", "fixed:4.2.3", "fixed:4.2.4", "fixed:4.1"].map((section_id) => ({ section_id, owner_step: "S-6.x" }))
    const batches = gapFillBatches(spine, [
      ...nfr,
      { section_id: "fixed:5.5", owner_step: "S-8.1" },
      { section_id: "slot:assumptions", owner_step: null },
      { section_id: "slot:risks", owner_step: null },
      { section_id: "custom:CS02", owner_step: null },
      { section_id: "custom:CS03", owner_step: null }
    ])
    expect(PROPOSE_BATCH).toBe(4)
    // NFR 5 mục cùng phần ⇒ 2 lô; Glossary; hai phần nhỏ phụ lục cùng skill; Document Conventions (skill tổng quan) và mục riêng không khớp phần nào
    expect(batches).toEqual([nfr.slice(0, 4).map((n) => n.section_id), ["fixed:4.1"], ["fixed:5.5"], ["slot:assumptions", "slot:risks"], ["custom:CS02"], ["custom:CS03"]])
  })
})

describe("FLF-382 C-5 mục của CR bổ sung vẫn trống", () => {
  it("FPT / phần nhỏ / mục riêng: chỉ chữ hướng dẫn = trống; có dữ liệu = đã soạn; nhận xét gắn vào vị trí của mục", () => {
    const empty = spineWith({ custom_sections: [custom("CS02", "Document Conventions", ["[Describe conventions]"])] })
    const ids = ["fixed:5.5", "slot:assumptions", "custom:CS02"]
    expect(emptyGapSections(empty, ids)).toEqual(ids)

    const filled = spineWith({
      glossary: [{ id: "GL-01", term: "LMS", definition: "Learning management system" }],
      other_requirements: [{ id: "OR-01", kind: "assumption", statement: "Stable internet" }],
      custom_sections: [custom("CS02", "Document Conventions", ["Bold marks a term."])]
    })
    expect(emptyGapSections(filled, ids)).toEqual([])

    const partly = spineWith({ ...filled, custom_sections: empty.custom_sections })
    const locations = [
      { location_id: "L001", section_id: "fixed:5.5", entity_paths: ["fixed:5.5"] },
      { location_id: "L002", section_id: "custom:CS02", entity_paths: ["custom:CS02"] }
    ]
    const flags = gapSectionFlags(partly, ids, new Map([["custom:CS02", "5.10 Document Conventions"]]), locations)
    expect([...flags.keys()]).toEqual(["L002"])
    expect(flags.get("L002")).toEqual([{ rule: GAP_SECTION_EMPTY_RULE, message: expect.stringContaining('"5.10 Document Conventions" vẫn còn trống') }])
    expect(flags.get("L002")![0].message).not.toContain("custom:")
  })
})

describe("FLF-382 ngữ cảnh mục trống cho C-2 / C-4", () => {
  it("tiêu đề file + hướng dẫn mẫu + nội dung nên có 29148 + skill + cột bảng mẫu", () => {
    const spine = spineWith({ custom_sections: [custom("CS02", "Document Conventions", ["[Describe the typographical conventions.]"], [["Convention", "Meaning"]])] })
    const text = gapSectionsContext(
      spine,
      [
        { section_id: "fixed:5.5", title: "5.5 Glossary" },
        { section_id: "custom:CS02", title: "5.10 Document Conventions" }
      ],
      new Map([["fixed:5.5", "List the terms"]]),
      new Map([["fixed:5.5", ["[e.g. SRS: Software Requirements Specification]"]]])
    )
    expect(text).toContain('- "5.5 Glossary"')
    expect(text).toContain("Template guidance (instructions / examples — never copy them as content): List the terms · [e.g. SRS")
    expect(text).toContain("Expected content (ISO 29148): terms, acronyms")
    expect(text).toContain("Writing skill: glossary")
    expect(text).toContain("Describe the typographical conventions.")
    expect(text).toContain("Template table columns (keep exactly these, in this order): Convention | Meaning")
    expect(text).toContain("custom_sections[id=CS02]")
  })
})

describe("FLF-382 ước tính credit", () => {
  it("một lô = C-2 + C-4 + C-5 theo bảng giá", async () => {
    expect(await gapFillCreditPerGroup()).toBe(6)
  })
})
