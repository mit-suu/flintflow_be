/**
 * C-3 tìm vị trí ảnh hưởng trên Spine — phần hàm thuần (`spine-location.ts`). Mode 1 v2 (FLF-186, plan v2 §8).
 * Phần chạy trên DB (khoá theo path, tìm lại) ở `test/integration/mode1/impact.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { formatLocationId } from "./cr-impact.service.js"
import { MAX_LOCATIONS, elementPathOf, elementValue, findSpineLocations, listElements, opElement, sectionOfElement, valueText } from "./spine-location.js"

const spine = (): Spine => {
  const s = createEmptySpine({ name: "Lumen" })
  s.project.vision = "Lumen lets a Learner register and study online."
  s.actors.push({ id: "A01", name: "Learner", kind: "human", description: "A person who enrolls." } as never, { id: "A02", name: "Admin", kind: "human", description: "Manages courses." } as never)
  s.use_cases.push({ id: "UC-01", name: "Register account", actor_ids: ["A01"], function_ids: [], description: "Create an account with email.", includes: [], extends: [] } as never)
  s.nfrs.push({ id: "NFR-01", category: "performance", kind: "quantitative", statement: "The system shall respond within 2 seconds.", metric: "response time", threshold: "2 s", priority: null } as never)
  s.custom_sections.push({ id: "CS02", heading: "Appendix A — Meeting notes", level: 1, source: "import", blocks: [{ kind: "paragraph", text: "Learner feedback about registration.", rows: null, image_ref: null }] })
  return s
}

describe("C-3 findSpineLocations", () => {
  it("đích + phần tử tham chiếu tới đích (spine_link) + phần tử nhắc tên đích (mention) + từ khoá; theo thứ tự tài liệu, không trùng", () => {
    const found = findSpineLocations(spine(), ["actors[id=A01].name"], ["registration"])
    expect(found.map((f) => [f.path, f.found_by])).toEqual([
      ["project", ["mention"]],
      ["actors[id=A01]", ["spine_link"]],
      ["use_cases[id=UC-01]", ["spine_link", "mention"]], // tham chiếu A01 + nhắc mã A01
      ["custom_sections[id=CS02]", ["mention", "keyword"]]
    ])
    expect(found.find((f) => f.path === "use_cases[id=UC-01]")).toMatchObject({ entity_paths: ["actors[id=A01]"], section_id: "fixed:2.2.2" })
    expect(found.find((f) => f.path === "actors[id=A01]")).toMatchObject({ section_id: "fixed:2.1", owner_step: "S-3.1" })
    // mục riêng: section custom, không step sở hữu
    expect(found.find((f) => f.path === "custom_sections[id=CS02]")).toMatchObject({ section_id: "custom:CS02", owner_step: null })
  })

  it("đích không còn trong Spine / path không phải phần tử bị bỏ; từ khoá < 3 ký tự bỏ; theo ranh giới từ", () => {
    expect(findSpineLocations(spine(), ["actors[id=A99]", "flags"], ["go"])).toEqual([])
    expect(findSpineLocations(spine(), [], ["second"]).map((f) => f.path)).toEqual([])
    expect(findSpineLocations(spine(), [], ["2 seconds"]).map((f) => f.path)).toEqual(["nfrs[id=NFR-01]"])
  })

  it(`tối đa ${MAX_LOCATIONS} vị trí`, () => {
    const s = spine()
    for (let i = 0; i < MAX_LOCATIONS + 10; i++) s.glossary.push({ id: `G${i}`, term: `login ${i}`, definition: "login term" } as never)
    expect(findSpineLocations(s, [], ["login"])).toHaveLength(MAX_LOCATIONS)
  })
})

describe("phần tử Spine làm vị trí", () => {
  it("elementPathOf / opElement: field ⇒ phần tử; project.* ⇒ project; thêm mới (arr[]) ⇒ null", () => {
    expect(elementPathOf("nfrs[id=NFR-01].threshold")).toBe("nfrs[id=NFR-01]")
    expect(elementPathOf("project.vision")).toBe("project")
    expect(elementPathOf("actors")).toBeNull()
    expect(opElement("business_rules[]")).toBeNull()
    expect(formatLocationId(1)).toBe("L001")
    expect(formatLocationId(1234)).toBe("L1234")
  })

  it("valueText ổn định (khoá sắp xếp); phần tử không còn ⇒ chuỗi rỗng; path field không phải phần tử", () => {
    const s = spine()
    expect(valueText(elementValue(s, "actors[id=A01]"))).toBe(valueText({ name: "Learner", id: "A01", kind: "human", description: "A person who enrolls." }))
    expect(valueText(elementValue(s, "actors[id=A99]"))).toBe("")
    expect(elementValue(s, "actors[id=A01].name")).toBeUndefined()
  })

  it("section của phần tử: sở hữu trước; project ⇒ fixed:1; mục riêng ⇒ custom:<id>", () => {
    const s = spine()
    expect(sectionOfElement(s, "project")).toBe("fixed:1")
    expect(sectionOfElement(s, "nfrs[id=NFR-01]")).toBe("fixed:4.2.3")
    expect(sectionOfElement(s, "custom_sections[id=CS02]")).toBe("custom:CS02")
    expect(listElements(s).map((e) => e.path)[0]).toBe("project")
  })
})
