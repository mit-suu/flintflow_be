/**
 * C-3 tìm vị trí ảnh hưởng trên Spine — phần hàm thuần (`spine-location.ts`). Mode 1 v2 (FLF-186, plan v2 §8).
 * Phần chạy trên DB (khoá theo path, tìm lại) ở `test/integration/mode1/impact.int.test.ts`.
 */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { formatLocationId } from "./cr-impact.service.js"
import {
  MAX_LOCATIONS,
  elementPathOf,
  elementValue,
  emptySectionTargets,
  fillPathsOfSection,
  findSpineLocations,
  isArrayPath,
  listElements,
  opElement,
  sectionOfElement,
  valueText
} from "./spine-location.js"

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
      ["use_cases[id=UC-01]", ["spine_link"]], // tham chiếu A01 bằng field ⇒ không gắn thêm "mention" cho cùng đích (T10)
      ["custom_sections[id=CS02]", ["mention", "keyword"]]
    ])
    expect(found.find((f) => f.path === "use_cases[id=UC-01]")).toMatchObject({ entity_paths: ["actors[id=A01]"], section_id: "fixed:2.2.2" })
    expect(found.find((f) => f.path === "actors[id=A01]")).toMatchObject({ section_id: "fixed:2.1", owner_step: "S-3.1" })
    // mục riêng: section custom, không step sở hữu
    expect(found.find((f) => f.path === "custom_sections[id=CS02]")).toMatchObject({ section_id: "custom:CS02", owner_step: null })
  })

  it("đã spine_link tới đích thì thôi mention cùng đích, nhưng nhắc đích KHÁC vẫn là mention (T10)", () => {
    const s = spine()
    s.use_cases.push({ id: "UC-02", name: "Manage courses", actor_ids: ["A01"], function_ids: [], description: "Admin reviews what the Learner submits.", includes: [], extends: [] } as never)
    const found = findSpineLocations(s, ["actors[id=A01]", "actors[id=A02]"], [])
    // UC-01 chỉ tham chiếu A01 bằng actor_ids ⇒ một cách tìm
    expect(found.find((f) => f.path === "use_cases[id=UC-01]")).toMatchObject({ found_by: ["spine_link"], entity_paths: ["actors[id=A01]"] })
    // UC-02 tham chiếu A01 (field) và nhắc tên A02 (văn xuôi) ⇒ hai cách tìm, hai đích
    expect(found.find((f) => f.path === "use_cases[id=UC-02]")).toMatchObject({
      found_by: ["spine_link", "mention"],
      entity_paths: ["actors[id=A01]", "actors[id=A02]"]
    })
  })

  it("đích là mã section ⇒ mọi phần tử section đó sở hữu là vị trí spine_link; mục còn trống ⇒ vị trí thêm mới `arr[]`", () => {
    const s = spine()
    const found = findSpineLocations(s, ["fixed:2.1", "custom:CS02", "fixed:5.1"], [])
    expect(found.map((f) => [f.path, f.found_by, f.entity_paths])).toEqual([
      ["actors[id=A01]", ["spine_link"], ["fixed:2.1"]],
      ["actors[id=A02]", ["spine_link"], ["fixed:2.1"]],
      ["custom_sections[id=CS02]", ["spine_link"], ["custom:CS02"]],
      // 2026-09-24: mục đã có dữ liệu cũng có ô thêm mới (CR thêm tác nhân / thực thể mới vào mục có sẵn)
      ["actors[]", ["spine_link"], ["fixed:2.1"]],
      // fixed:5.1 (Business Rules) chưa có phần tử nào ⇒ phương án B: vị trí là cả mảng, C-4 đề xuất thêm mới
      ["business_rules[]", ["spine_link"], ["fixed:5.1"]]
    ])
    expect(found.find((f) => f.path === "business_rules[]")).toMatchObject({ section_id: "fixed:5.1", owner_step: "S-7.1" })
    expect(elementValue(s, "business_rules[]")).toEqual([]) // giá trị = cả mảng ⇒ C-5 so được mảng có bị đổi không
    expect(isArrayPath("business_rules[]")).toBe(true)
    expect(isArrayPath("business_rules[id=BR-01]")).toBe(false)
  })

  it("C-2 trả đích thêm mới `entities[]` ⇒ ô thêm mới ở mục ERD; mảng nuôi nhiều mục ⇒ ưu tiên mục CR nhắm; ô thêm mới không bị cắt", () => {
    const s = spine()
    expect(findSpineLocations(s, ["entities[]"], []).map((f) => [f.path, f.section_id])).toEqual([["entities[]", "fixed:3.1.5"]])
    expect(findSpineLocations(s, ["nfrs[]", "fixed:4.2.3"], []).find((f) => f.path === "nfrs[]")?.section_id).toBe("fixed:4.2.3")
    expect(findSpineLocations(s, ["khong_co[]"], [])).toEqual([])
  })

  it("mode 1 v3: mọi mục FPT mà cờ section_empty soi đều có đường vào CR (không còn step để chỉ sang)", () => {
    const s = spine()
    expect(fillPathsOfSection("fixed:3.1.3")).toEqual(["roles[]", "permissions[]"])
    expect(fillPathsOfSection("fixed:3.1.1")).toEqual(["screens[]"])
    expect(fillPathsOfSection("fixed:2.2.1")).toEqual(["use_cases[]"])
    expect(fillPathsOfSection("fixed:1")).toEqual([]) // sửa phần tử `project` có sẵn
    expect(emptySectionTargets(s, ["fixed:5.1", "fixed:3.1.1", "actors[id=A01]"])).toEqual([])
    expect(emptySectionTargets(s, ["actors[id=A01]"])).toEqual([])
    // project trống vẫn có vị trí: chính phần tử project
    const blank = createEmptySpine({ name: "Blank" })
    expect(findSpineLocations(blank, ["fixed:1"], []).map((f) => f.path)).toEqual(["project"])
  })

  it("Screens Flow / Use Case Diagram: dữ liệu ở field phần tử mục khác ⇒ phần tử đó là vị trí của mục được nhắm; mảng rỗng ⇒ thêm mới", () => {
    const s = spine()
    s.screens.push({ id: "SCR-01", name: "Login", flow_to: [], is_popup: false, tabs: [] } as never, { id: "SCR-02", name: "Home", flow_to: [], is_popup: false, tabs: [] } as never)
    const flow = findSpineLocations(s, ["fixed:3.1.1"], [])
    expect(flow.map((f) => [f.path, f.section_id, f.owner_step])).toEqual([
      ["screens[id=SCR-01]", "fixed:3.1.1", "S-4.2"],
      ["screens[id=SCR-02]", "fixed:3.1.1", "S-4.2"]
    ])
    // chưa có màn nào ⇒ thêm mới vào screens[]
    expect(findSpineLocations(spine(), ["fixed:3.1.1"], []).map((f) => f.path)).toEqual(["screens[]"])
    // Use Case Diagram vẽ từ use case có sẵn ⇒ sửa use case, không mời thêm mới
    expect(findSpineLocations(spine(), ["fixed:2.2.1"], []).map((f) => [f.path, f.section_id])).toEqual([["use_cases[id=UC-01]", "fixed:2.2.1"]])
  })

  it("mục có phần tử nhưng cờ vẫn coi là chưa có dữ liệu (5.1 chỉ có rule tier=high) ⇒ thêm vị trí thêm mới — cùng tiêu chí với cờ", () => {
    const s = spine()
    s.business_rules.push({ id: "BR-01", tier: "high", statement: "Only paid learners can study." } as never)
    const paths = findSpineLocations(s, ["fixed:5.1"], []).map((f) => f.path)
    expect(paths).toContain("business_rules[]")
  })

  it("giả định là phần tử làm được vị trí (cờ unconfirmed_assumption chỉ đóng được bằng CR)", () => {
    const s = spine()
    s.assumptions.push({ id: "AS-01", statement: "Learners use email to sign in.", status: "unconfirmed", path: "actors[id=A01]", origin_step_id: "S-7.2" } as never)
    expect(listElements(s).map((e) => e.path)).toContain("assumptions[id=AS-01]")
    expect(findSpineLocations(s, ["assumptions[id=AS-01].status"], []).map((f) => f.path)).toContain("assumptions[id=AS-01]")
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
