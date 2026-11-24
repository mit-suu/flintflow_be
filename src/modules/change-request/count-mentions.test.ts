import { describe, it, expect } from "vitest"
import { findCountMentions, findCountMentionsInText } from "./count-mentions.js"
import type { Spine } from "../spine/spine.types.js"

describe("findCountMentionsInText - FLF-473 (C-3/C-4/C-5 câu đếm)", () => {
  it("nhận câu đếm tiếng Việt và tiếng Anh viết bằng chữ số", () => {
    expect(findCountMentionsInText("Hệ thống có 10 use case cho người học.")).toEqual([{ number: 10, collection: "use_cases" }])
    expect(findCountMentionsInText("The system has 10 use cases for students.")).toEqual([{ number: 10, collection: "use_cases" }])
    expect(findCountMentionsInText("Hệ thống gồm 5 tác nhân chính.")).toEqual([{ number: 5, collection: "actors" }])
    expect(findCountMentionsInText("There are 5 actors in total.")).toEqual([{ number: 5, collection: "actors" }])
    expect(findCountMentionsInText("Ứng dụng có 8 màn hình.")).toEqual([{ number: 8, collection: "screens" }])
    expect(findCountMentionsInText("Hệ thống có 6 chức năng chính.")).toEqual([{ number: 6, collection: "functions" }])
    expect(findCountMentionsInText("Có 3 quy tắc nghiệp vụ áp dụng.")).toEqual([{ number: 3, collection: "business_rules" }])
  })

  it("nhận \"10 UC\" (viết tắt use case) nhưng không nhận mã \"UC-10\" hay tỉ lệ \"10%\"", () => {
    expect(findCountMentionsInText("Hệ thống có 10 UC đã hoàn thành.")).toEqual([{ number: 10, collection: "use_cases" }])
    expect(findCountMentionsInText("Xem chi tiết ở UC-10 và UC-11.")).toEqual([])
    expect(findCountMentionsInText("Tỉ lệ hoàn thành đạt 10% trong tháng này.")).toEqual([])
  })

  it("không nhận số viết bằng chữ (\"mười use case\", \"five actors\") - chốt bản đầu chỉ nhận số viết bằng chữ số", () => {
    expect(findCountMentionsInText("Hệ thống có mười use case.")).toEqual([])
    expect(findCountMentionsInText("There are five actors in this system.")).toEqual([])
  })

  it("nhiều câu đếm trong một đoạn ⇒ trả đủ, đúng thứ tự xuất hiện", () => {
    expect(findCountMentionsInText("Hệ thống có 10 use case và 5 tác nhân.")).toEqual([
      { number: 10, collection: "use_cases" },
      { number: 5, collection: "actors" }
    ])
  })
})

describe("findCountMentions - dò trên Spine (custom_sections + project)", () => {
  const block = (text: string) => ({ kind: "paragraph" as const, text, rows: null, image_ref: null })
  const spine = {
    custom_sections: [
      { id: "CS07", heading: "", level: 3, source: "import" as const, blocks: [block("Hệ thống có 10 use case cho người học."), block("Không có số nào ở đây.")] },
      { id: "CS08", heading: "Ghi chú", level: 2, source: "import" as const, blocks: [block("Hệ thống có 5 tác nhân.")] }
    ],
    project: { vision: "Hệ thống phục vụ 10 use case cốt lõi.", goals: ["Hoàn thành 5 tác nhân trong quý này.", "Không liên quan."] }
  } as Pick<Spine, "custom_sections" | "project">

  it("gom đủ câu đếm của custom_sections (kèm block_index) và project (vision + goals)", () => {
    const mentions = findCountMentions(spine)
    expect(mentions).toEqual([
      { path: "custom_sections[id=CS07]", block_index: 0, number: 10, collection: "use_cases" },
      { path: "custom_sections[id=CS08]", block_index: 0, number: 5, collection: "actors" },
      { path: "project", block_index: 0, number: 10, collection: "use_cases" },
      { path: "project", block_index: 1, number: 5, collection: "actors" }
    ])
  })

  it("custom_sections / project không có câu đếm nào ⇒ trả rỗng", () => {
    expect(findCountMentions({ custom_sections: [], project: { vision: null, goals: [] } } as unknown as Pick<Spine, "custom_sections" | "project">)).toEqual([])
  })
})
