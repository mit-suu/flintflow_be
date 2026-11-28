/**
 * C-3 tìm vị trí ảnh hưởng trên Spine — phần hàm thuần (`spine-location.ts`). Mode 1 v2 (FLF-186, plan v2 §8).
 * Phần chạy trên DB (khoá theo path, tìm lại) ở `test/integration/mode1/impact.int.test.ts`.
 */
import { describe, expect, it, vi } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { crImpactIntent, formatLocationId } from "./cr-impact.service.js"
import {
  KEYWORD_MAX_HITS,
  rankByKeywords,
  countMentionLocations,
  elementPathOf,
  elementValue,
  emptySectionTargets,
  expandSlotTargets,
  fillPathsOfSection,
  findSpineLocations,
  isArrayPath,
  isGenericName,
  listElements,
  mergeFoundLocations,
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
  s.custom_sections.push({ id: "CS02", heading: "Appendix A - Meeting notes", level: 1, source: "import", blocks: [{ kind: "paragraph", text: "Learner feedback about registration.", rows: null, image_ref: null }] })
  return s
}

describe("C-3 findSpineLocations", () => {
  it("đích + phần tử tham chiếu tới đích (spine_link) + phần tử nhắc tên đích (mention) + từ khoá; theo thứ tự tài liệu, không trùng", () => {
    // FLF-483: đích actor chỉ kéo use case tham chiếu / nhắc mã khi CR xoá ⇒ ca này dùng intent "remove"
    const found = findSpineLocations(spine(), ["actors[id=A01].name"], ["registration"], [], { intent: "remove" })
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
    const found = findSpineLocations(s, ["actors[id=A01]", "actors[id=A02]"], [], [], { intent: "remove" })
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

  it("FLF-278: đích là phần nhỏ của mẫu (`slot:*`) ⇒ đổi sang mục FPT cha / mảng dữ liệu - CR nhắm mục mẫu trống có vị trí thêm mới", () => {
    expect(expandSlotTargets(["slot:business_rules", "slot:functional_requirements", "slot:vision", "actors[id=A01]"])).toEqual(["fixed:5.1", "functions[]", "fixed:1", "actors[id=A01]"])
    const found = findSpineLocations(spine(), ["slot:business_rules"], [])
    expect(found.map((f) => [f.path, f.section_id])).toEqual([["business_rules[]", "fixed:5.1"]])
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

  it("mục có phần tử nhưng cờ vẫn coi là chưa có dữ liệu (5.1 chỉ có rule tier=high) ⇒ thêm vị trí thêm mới - cùng tiêu chí với cờ", () => {
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

  it(`FLF-375: từ khoá xếp hạng BM25 - tối đa ${KEYWORD_MAX_HITS} phần tử khớp nhất (không còn trả mọi phần tử chứa chữ)`, () => {
    const s = spine()
    for (let i = 0; i < 20; i++) s.glossary.push({ id: `G${i}`, term: `login ${i}`, definition: "login term" } as never)
    // FLF-483: từ khoá khớp hơn 15% phần tử bị bỏ ⇒ thêm phần tử nền để 20 chỗ khớp vẫn là từ khoá hợp lệ
    for (let i = 0; i < 150; i++) s.glossary.push({ id: `H${i}`, term: `Other ${i}`, definition: "unrelated" } as never)
    const found = findSpineLocations(s, [], ["login"])
    expect(found).toHaveLength(KEYWORD_MAX_HITS)
    expect(found.every((f) => f.found_by.includes("keyword") && (f.keyword_score ?? 0) > 0)).toBe(true)
  })

  it("FLF-375: phần tử nói nhiều về yêu cầu xếp trên phần tử chỉ nhắc qua một lần", () => {
    const s = spine()
    s.glossary.push({ id: "G1", term: "Excel import", definition: "Import and export student lists and grade sheets with Excel files." } as never)
    s.glossary.push({ id: "G2", term: "Report", definition: "A PDF report; an Excel copy is optional." } as never)
    const [first] = rankByKeywords([{ path: "glossary[id=G2]", value: s.glossary[s.glossary.length - 1] }, { path: "glossary[id=G1]", value: s.glossary[s.glossary.length - 2] }], ["import export Excel"])
    expect(first.path).toBe("glossary[id=G1]")
  })
})

describe("FLF-473 (B14) - countMentionLocations: câu đếm là vị trí CR khi CR đổi đúng số phần tử đó", () => {
  const block = (text: string) => ({ kind: "paragraph" as const, text, rows: null, image_ref: null })
  const spineWith10UseCases = (): Spine => {
    const s = spine()
    s.custom_sections.push({ id: "CS07", heading: "", level: 3, source: "import", blocks: [block("Hệ thống có 10 use case cho người học.")] })
    for (let i = 2; i <= 10; i++) s.use_cases.push({ id: `UC-${String(i).padStart(2, "0")}`, name: `Use case ${i}`, actor_ids: ["A01"], function_ids: [], description: "...", includes: [], extends: [] } as never)
    return s
  }

  it("CR thêm 2 use case (10 ⇒ 12) ⇒ câu đếm use case là vị trí count; CR chỉ sửa mô tả use case (không đổi số) ⇒ không có", () => {
    const before = spineWith10UseCases()
    expect(before.use_cases).toHaveLength(10)
    const addedTwo = structuredClone(before)
    addedTwo.use_cases.push(
      { id: "UC-11", name: "Use case 11", actor_ids: ["A01"], function_ids: [], description: "...", includes: [], extends: [] } as never,
      { id: "UC-12", name: "Use case 12", actor_ids: ["A01"], function_ids: [], description: "...", includes: [], extends: [] } as never
    )
    const found = countMentionLocations(before, addedTwo)
    expect(found).toEqual([{ path: "custom_sections[id=CS07]", section_id: "custom:CS07", found_by: ["count"], entity_paths: ["use_cases"], owner_step: null }])

    const editedDescription = structuredClone(before)
    editedDescription.use_cases[0].description = "Mô tả mới, không đổi số use case."
    expect(countMentionLocations(before, editedDescription)).toEqual([])
  })

  it("không đổi số phần tử của loại câu đếm nhắc tới (CR thêm actor, câu đếm nói use case) ⇒ không có vị trí count", () => {
    const before = spineWith10UseCases()
    const addedActor = structuredClone(before)
    addedActor.actors.push({ id: "A03", name: "Guest", kind: "human", description: "..." } as never)
    expect(countMentionLocations(before, addedActor)).toEqual([])
  })

  it("after = null (op lỗi / không có ops) ⇒ không bắt câu đếm nào (không đoán số đổi thế nào)", () => {
    expect(countMentionLocations(spineWith10UseCases(), null)).toEqual([])
  })

  it("mergeFoundLocations: cùng path thì hợp found_by/entity_paths, khác path thì thêm mới", () => {
    const found = [{ path: "custom_sections[id=CS02]", section_id: "custom:CS02", found_by: ["keyword" as const], entity_paths: [], owner_step: null }]
    const extra = [
      { path: "custom_sections[id=CS02]", section_id: "custom:CS02", found_by: ["count" as const], entity_paths: ["use_cases"], owner_step: null },
      { path: "project", section_id: "fixed:1", found_by: ["count" as const], entity_paths: ["actors"], owner_step: null }
    ]
    expect(mergeFoundLocations(found, extra)).toEqual([
      { path: "custom_sections[id=CS02]", section_id: "custom:CS02", found_by: ["keyword", "count"], entity_paths: ["use_cases"], owner_step: null },
      { path: "project", section_id: "fixed:1", found_by: ["count"], entity_paths: ["actors"], owner_step: null }
    ])
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

describe("FLF-483 (M4-b) - lọc nguồn nhiễu của C-3", () => {
  const rule = (i: number, statement: string) => ({ id: `BR-${String(i).padStart(2, "0")}`, statement, tier: "detail" }) as never
  /** 60 phần tử: thực thể E08 "Đơn hàng" được nhắc ở 20 quy tắc, 7 use case tham chiếu actor A01. */
  const bigSpine = (): Spine => {
    const s = createEmptySpine({ name: "Shop" })
    s.actors.push({ id: "A01", name: "Student", kind: "human", description: "" } as never)
    s.entities.push({ id: "E08", name: "Đơn hàng", description: "Đơn đặt mua" } as never)
    for (let i = 1; i <= 7; i++) s.use_cases.push({ id: `UC-${String(i).padStart(2, "0")}`, name: `Case ${i}`, actor_ids: ["A01"], function_ids: [], description: `Flow ${i}`, includes: [], extends: [] } as never)
    for (let i = 1; i <= 20; i++) s.business_rules.push(rule(i, `Đơn hàng phải được xác nhận lần ${i}`))
    for (let i = 21; i <= 50; i++) s.business_rules.push(rule(i, `Quy tắc khác số ${i}`))
    return s
  }
  const mentions = (found: ReturnType<typeof findSpineLocations>) => found.filter((f) => f.found_by.includes("mention")).map((f) => f.path)

  it("tên 'Đơn hàng' ở 20/60 phần tử ⇒ intent other không có chỗ nhắc theo tên; rename ⇒ đủ 20", () => {
    const s = bigSpine()
    expect(isGenericName(s, "Đơn hàng")).toBe(true)
    expect(isGenericName(s, "Student")).toBe(false)
    expect(mentions(findSpineLocations(s, ["entities[id=E08]"], [], [], { intent: "other" }))).toEqual([])
    expect(mentions(findSpineLocations(s, ["entities[id=E08]"], []))).toEqual([])
    expect(mentions(findSpineLocations(s, ["entities[id=E08]"], [], [], { intent: "rename" }))).toHaveLength(20)
    expect(mentions(findSpineLocations(s, ["entities[id=E08]"], [], [], { intent: "remove" }))).toHaveLength(20)
  })

  it("tên không chung vẫn là chỗ nhắc; mã tài liệu của đích chung vẫn dùng", () => {
    const s = bigSpine()
    s.business_rules.push(rule(51, "Chỉ BR-03 được áp dụng"))
    s.business_rules.push(rule(52, "Khách Lumen Gold được giảm giá"))
    s.entities.push({ id: "E09", name: "Lumen Gold", description: "" } as never)
    expect(mentions(findSpineLocations(s, ["entities[id=E09]"], []))).toEqual(["business_rules[id=BR-52]"])
    expect(mentions(findSpineLocations(s, ["business_rules[id=BR-03]"], []))).toContain("business_rules[id=BR-51]")
  })

  it("đích actor A01 + ô thêm use case ⇒ 7 use case cũ không thành vị trí chỉ vì tham chiếu actor; xoá actor ⇒ đủ 7", () => {
    const s = bigSpine()
    const adding = findSpineLocations(s, ["actors[id=A01]", "use_cases[]"], [])
    expect(adding.map((f) => f.path)).toEqual(["actors[id=A01]", "use_cases[]"])
    const removing = findSpineLocations(s, ["actors[id=A01]"], [], [], { intent: "remove" })
    expect(removing.filter((f) => f.path.startsWith("use_cases[")).map((f) => f.path)).toHaveLength(7)
    // đích loại khác (không phải actor / vai trò) vẫn kéo tham chiếu như cũ
    expect(findSpineLocations(s, ["entities[id=E08]"], [])[0]?.path).toBe("entities[id=E08]")
  })

  it("đích mục 2.2.2 + ô thêm use case ⇒ không mở cả mục; đích mục đứng một mình ⇒ mở như cũ", () => {
    const s = bigSpine()
    const together = findSpineLocations(s, ["fixed:2.2.2", "use_cases[]"], []).map((f) => f.path)
    expect(together.filter((p) => p.startsWith("use_cases[id="))).toEqual([])
    expect(together).toContain("use_cases[]")
    const alone = findSpineLocations(s, ["fixed:2.2.2"], []).map((f) => f.path)
    expect(alone.filter((p) => p.startsWith("use_cases[id="))).toHaveLength(7)
    // đích là phần tử nằm trong mục ⇒ mục chỉ là ngữ cảnh
    const withElement = findSpineLocations(s, ["fixed:2.2.2", "use_cases[id=UC-01]"], []).map((f) => f.path)
    expect(withElement.filter((p) => p.startsWith("use_cases[id="))).toEqual(["use_cases[id=UC-01]"])
  })

  it("từ khoá khớp hơn 15% phần tử bị bỏ (log một dòng); từ khoá hiếm vẫn giữ", () => {
    const s = bigSpine()
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    s.business_rules.push(rule(60, "Zebra pricing applies"))
    const found = findSpineLocations(s, [], ["xác nhận", "zebra"])
    const paths = found.map((f) => f.path)
    expect(paths).toContain("business_rules[id=BR-60]")
    expect(paths).not.toContain("business_rules[id=BR-01]") // "xác nhận" khớp 20 > max(12, 15% của 61)
    expect(info.mock.calls.some((c) => String(c[0]).includes('bỏ từ khoá chung "xác nhận"'))).toBe(true)
    info.mockRestore()
  })
})

describe("FLF-483 (M4-b) - crImpactIntent", () => {
  const cr = (title: string, description = "", entity_paths: string[] = []) => ({ title, description, amendments: [], clarifications: [], targets: { entity_paths, keywords: [] } }) as never
  const s = (() => {
    const sp = createEmptySpine({ name: "Shop" })
    sp.actors.push({ id: "A01", name: "Student", kind: "human", description: "" } as never)
    return sp
  })()

  it("xoá: op remove, hoặc động từ xoá đứng trước tên / mã đích", () => {
    expect(crImpactIntent(cr("Sửa"), [{ op: "remove", path: "actors[id=A01]" }])).toBe("remove")
    expect(crImpactIntent(cr("Bỏ tác nhân Student", "", ["actors[id=A01]"]), [], s)).toBe("remove")
    expect(crImpactIntent(cr("Xoá A01", "", ["actors[id=A01]"]))).toBe("remove")
    expect(crImpactIntent(cr("Thêm use case cho Student, bỏ qua phần khác", "", ["actors[id=A01]"]), [], s)).toBe("other")
  })

  it("đổi tên: đổi tên hệ thống hoặc cụm đổi tên phần tử; còn lại other", () => {
    expect(crImpactIntent(cr("Đổi tên Student thành Learner", "", ["actors[id=A01]"]), [], s)).toBe("rename")
    expect(crImpactIntent(cr("Rename the app to Lumen"))).toBe("rename")
    expect(crImpactIntent(cr("Hạ COD từ 5 triệu xuống 3 triệu"))).toBe("other")
  })
})
