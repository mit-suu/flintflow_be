import { describe, expect, it } from "vitest"
import type { LayoutBlock } from "./step-plan.js"
import { cleanTableRows, isPlaceholderRow, isPlaceholderText, isSkeletonTable, sampleBlockIds, stripTemplateMarks, templateMarks } from "./template-markers.js"

const h = (id: string, text: string, section: string | null = null): LayoutBlock => ({ block_id: id, kind: "heading", level: 2, text, section_id: section })
const p = (id: string, text: string, section: string | null = "fixed:2.1"): LayoutBlock => ({ block_id: id, kind: "paragraph", level: null, text, section_id: section })
const li = (id: string, text: string, section = "fixed:2.1"): LayoutBlock => ({ block_id: id, kind: "list_item", level: null, text, section_id: section })
const img = (id: string, section = "fixed:2.1"): LayoutBlock => ({ block_id: id, kind: "image", level: null, text: "", section_id: section, image_ref: `word/media/${id}.png` })
const tbl = (id: string, rows: string[][], section = "fixed:2.1"): LayoutBlock => ({ block_id: id, kind: "table", level: null, text: "", section_id: section, rows })

describe("chỗ điền của mẫu", () => {
  it("<<…>>, .., …, - là chỗ điền; chữ thật / ngoặc tròn thì không", () => {
    for (const t of ["<<Function Name 1>>", " <<Screen Brief description>>", "..", "…", "-", " <<Screen Name1>>"]) expect(isPlaceholderText(t), t).toBe(true)
    for (const t of ["Administrator", "<= 24 h", "(optional)", "<<Sample: The system is", "1"]) expect(isPlaceholderText(t), t).toBe(false)
  })

  it("dòng chỉ còn số thứ tự + chỗ điền, hoặc ô tên là chỗ điền ⇒ dòng mẫu", () => {
    expect(isPlaceholderRow(["3", "..", "", ""])).toBe(true)
    expect(isPlaceholderRow(["1", "<<Feature Name>>", "<<Function Name1>>", "<<Function Name1 Description>>"])).toBe(true)
    expect(isPlaceholderRow(["    <<Screen Activity>>", "", "", "X", "X"])).toBe(true)
    expect(isPlaceholderRow(["1", "Order Meals", "Create Order", "<<Screen Brief description>>"])).toBe(false)
    expect(isPlaceholderRow(["    Query All Data", "X", "", "", ""])).toBe(false)
  })

  it("bảng bỏ dòng mẫu, ô chỗ điền thành rỗng; hàng tiêu đề giữ nguyên", () => {
    expect(cleanTableRows([["#", "Screen", "Description"], ["1", "Create Order", "<<Screen Brief description>>"], ["2", "..", ""]])).toEqual([
      ["#", "Screen", "Description"],
      ["1", "Create Order", ""]
    ])
  })

  it("bảng khung: có cột trống ở mọi dòng thân", () => {
    expect(isSkeletonTable([["#", "Actor", "Description"], ["1", "Administrator", ""], ["2", "Menu Manager", ""]])).toBe(true)
    expect(isSkeletonTable([["ID", "Rule"], ["BR-01", "Delivery windows are 15 minutes."]])).toBe(false)
  })
})

describe("templateMarks - khoảng hướng dẫn / ví dụ nhiều đoạn", () => {
  it("[ … ] mở ở đoạn đầu, list ở giữa, đóng ở đoạn sau ⇒ cả khoảng là hướng dẫn; đoạn sau khoảng là nội dung", () => {
    const blocks = [
      h("h", "2.1 Actors", "fixed:2.1"),
      p("a", "[An actor is a person that interacts with the system. Questions to ask:"),
      li("b", "Who (or what) is notified when something occurs?"),
      p("c", "This part gives the description of system actors, you can follow the table form as below]"),
      p("d", "Librarians and members use the system.")
    ]
    const marks = templateMarks(blocks)
    expect([...marks.keys()]).toEqual(["a", "b", "c"])
    expect(stripTemplateMarks(blocks).map((b) => b.block_id)).toEqual(["h", "d"])
  })

  it("<<Sample: … >> với hình ở giữa và >> đoạn riêng ⇒ ví dụ; <<Function Name 1>> trọn đoạn ⇒ chỗ điền", () => {
    const blocks = [p("a", "<<Sample: The Cafeteria Ordering System is a new software system", "fixed:1"), img("i", "fixed:1"), p("b", ">>", "fixed:1"), p("c", "<<Function Name 1>>", "fixed:1")]
    expect(Object.fromEntries(templateMarks(blocks))).toEqual({ a: "sample", i: "sample", b: "sample", c: "placeholder" })
  })

  it("khoảng chưa đóng dừng ở heading kế; đuôi `…]` dưới heading con chỉ là hướng dẫn khi khoảng bị heading cắt ngang", () => {
    const blocks = [
      h("g", "2.2 Use Cases"),
      p("a", "[A use case describes a sequence of interactions", null),
      h("h1", "2.2.1 Diagram(s)", "fixed:2.2.1"),
      p("b", "[Provide the UC diagram(s) like the sample below]", "fixed:2.2.1"),
      img("i", "fixed:2.2.1"),
      h("h2", "2.2.2 Descriptions", "fixed:2.2.2"),
      p("c", "This part describes the use cases, you can follow the table form as below]", "fixed:2.2.2"),
      h("h3", "4.2.2 Reliability", "fixed:4.2.2"),
      p("d", "[Requirements for reliability should be specified here:", "fixed:4.2.2"),
      p("e", "Availability—specify the percentage of time available", "fixed:4.2.2"),
      h("h4", "4.2.3 Performance", "fixed:4.2.3"),
      p("f", "Response time is under 2 seconds for 95% of requests.", "fixed:4.2.3")
    ]
    const marks = templateMarks(blocks)
    expect(["a", "b", "c", "d", "e"].every((id) => marks.has(id))).toBe(true)
    // Hình sau hướng dẫn trọn đoạn không thuộc khoảng (luật 4 mới xét); 4.2.3 không bị khoảng 4.2.2 nuốt
    expect(marks.has("i")).toBe(false)
    expect(marks.has("f")).toBe(false)
  })

  it("khách viết đè hướng dẫn còn sót `]` cuối câu (không có khoảng mở dở) ⇒ vẫn là nội dung", () => {
    const blocks = [h("h", "2.1 Product Perspective", "slot:context"), p("a", "Student Club Hub signs students in through the University SSO...).]", "slot:context")]
    expect(templateMarks(blocks).size).toBe(0)
  })

  it("dẫn chiếu [1] đóng trong cùng đoạn không mở khoảng", () => {
    expect(templateMarks([p("a", "[1] IEEE 830-1998, Recommended Practice for SRS"), p("b", "Members borrow up to five books.")]).size).toBe(0)
  })
})

describe("sampleBlockIds - bảng / hình mẫu (chỉ để quyết khung mẫu)", () => {
  it("mục có hướng dẫn: bảng khung, bảng sau 'sample below', hình mà mục không còn gì khác ⇒ mẫu", () => {
    const blocks = [
      p("g1", "[You can follow the table form as below]", "fixed:2.1"),
      tbl("t1", [["#", "Actor", "Description"], ["1", "Administrator", ""]], "fixed:2.1"),
      p("g2", "[Provide the UC diagram(s)]", "fixed:2.2.1"),
      img("i1", "fixed:2.2.1"),
      p("g3", "[Provide common business rules in the table format as the sample below]", "slot:business_rules"),
      tbl("t2", [["ID", "Rule"], ["BR-01", "Delivery windows are 15 minutes."]], "slot:business_rules")
    ]
    expect([...sampleBlockIds(blocks)].sort()).toEqual(["i1", "t1", "t2"])
  })

  it("mục không có hướng dẫn, hoặc có chữ khách viết cạnh hình ⇒ không phải mẫu", () => {
    const blocks = [
      tbl("t1", [["#", "Actor", "Description"], ["1", "Administrator", ""]], "fixed:2.1"),
      p("g", "[Provide the screen flow]", "fixed:3.1.1"),
      p("x", "The librarian starts at the dashboard and opens the loan list.", "fixed:3.1.1"),
      img("i", "fixed:3.1.1")
    ]
    expect(sampleBlockIds(blocks).size).toBe(0)
  })
})
