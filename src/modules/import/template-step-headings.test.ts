import { readFileSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"
import { parseDocument } from "./parse.service.js"
import { assignBlockSections, matchProfile } from "./profile-match.service.js"
import { buildLayout } from "./step-plan.js"
import type { LayoutEntry } from "./template-profile.model.js"
import { headingsOfStep, slotOwnerSteps, templateSectionOwnerSteps, templateSectionsByStep } from "./template-step-headings.js"

let layout: LayoutEntry[] = []

beforeAll(async () => {
  const parsed = await parseDocument(readFileSync(new URL("../../../fixtures/fixed-template-fu-it-srs-01.docx", import.meta.url)))
  const profile = matchProfile(parsed.blocks, { fixedTemplate: true })
  const sections = assignBlockSections(parsed.blocks, profile.heading_map)
  layout = buildLayout(
    parsed.blocks.map((b) => ({ ...b, section_id: sections.get(b.block_id) ?? null })),
    new Map(profile.heading_map.map((h) => [h.block_id, h.section_id]))
  ).layout
})

describe("slotOwnerSteps (FLF-278)", () => {
  it("phần nhỏ có mục cha ⇒ chỉ bước của mục cha ghi đúng loại dữ liệu", () => {
    expect(slotOwnerSteps("slot:vision")).toEqual(["S-2.1", "S-2.2"])
    expect(slotOwnerSteps("slot:context")).toEqual(["S-2.3"])
    expect(slotOwnerSteps("slot:business_rules")).toEqual(["S-7.1"])
  })

  it("phần nhỏ không có mục cha ⇒ bước soạn tài liệu (S-2…S-9) ghi loại dữ liệu đó, không gồm Brief / phân tích", () => {
    const owners = slotOwnerSteps("slot:functional_requirements")
    expect(owners).toEqual(expect.arrayContaining(["S-4.1", "S-5.2"]))
    expect(owners.some((id) => id.startsWith("B-") || id.startsWith("S-1."))).toBe(false)
    expect(slotOwnerSteps("slot:unknown")).toEqual([])
  })

  it("mục thường giữ bảng sở hữu của section registry", () => {
    expect(templateSectionOwnerSteps("fixed:4.1")).toEqual(["S-6.1"])
  })
})

describe("templateSectionsByStep - mẫu FU-IT-SRS-01", () => {
  it("mỗi bước kèm heading nguyên văn của mẫu mà bước đó soạn, theo thứ tự mẫu", () => {
    const byStep = templateSectionsByStep(layout)
    expect(byStep.get("S-2.1")).toEqual(["1.1 Purpose", "1.2 Scope"])
    expect(byStep.get("S-6.1")).toEqual(["3.1.2 Software Interfaces"])
    expect(byStep.get("S-7.1")).toEqual(["5.1 Business Rules"])
    expect(byStep.get("S-7.3")).toEqual(["5.2 Messages"])
    expect(byStep.get("S-4.1")).toContain("3.2 Functional Requirements")
  })

  it("heading bao không gắn vào bước nào; FLF-378: mục riêng của mẫu do S-8.1 soạn", () => {
    const byStep = templateSectionsByStep(layout)
    const all = [...byStep.values()].flat()
    for (const title of ["1. Introduction", "3. Specific Requirements", "3.1 External Interface Requirements"]) {
      expect(all).not.toContain(title)
    }
    expect(byStep.get("S-8.1")).toContain("5.3 Sign-off")
  })

  it("bước vòng S-5 theo màn nhận cả mục chung của bước mẫu; bước không soạn mục nào ⇒ rỗng", () => {
    const byStep = new Map([["S-5.2", ["3.2 Functional Requirements"]], ["S-5.2@S01", ["3.2.1 Login"]]])
    expect(headingsOfStep(byStep, "S-5.2@S01")).toEqual(["3.2.1 Login", "3.2 Functional Requirements"])
    expect(headingsOfStep(byStep, "S-5.2@S02")).toEqual(["3.2 Functional Requirements"])
    expect(headingsOfStep(templateSectionsByStep(layout), "S-9.1")).toEqual([])
  })
})
