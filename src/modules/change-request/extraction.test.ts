import { describe, expect, it } from "vitest"
import type { Spine } from "../spine/spine.types.js"
import { crDescriptionOf, crTitleOf, normalizeItems, planExtractionCrs } from "./extraction.service.js"
import type { IExtractionItem } from "./requirement-extraction.model.js"

const item = (over: Partial<IExtractionItem>): IExtractionItem => ({
  id: "R1",
  text: "Reports must be exportable to CSV.",
  label: "new",
  para_id: "D1-P02",
  quote: "Finance asked for CSV export.",
  group: "G1",
  entity_paths: [],
  question: null,
  suggested_answers: [],
  include: null,
  drop_reason: null,
  answer: null,
  cr_id: null,
  ...over
})

describe("planExtractionCrs (FLF-338 §3.6.1 — BA duyệt danh sách rút)", () => {
  const items = [
    item({ id: "R1", group: "G1" }),
    item({ id: "R2", group: "G1", label: "modification", text: "Export must finish within 5 seconds.", entity_paths: ["nfrs[id=NFR-01]"] }),
    item({ id: "R3", group: "G2", label: "duplicate", text: "Users log in with email.", entity_paths: ["use_cases[id=UC-01]"] }),
    item({ id: "R4", group: "G3", label: "ambiguous", text: "The system should be fast.", question: "Fast means what?", suggested_answers: ["< 2s", "< 5s"] })
  ]

  it("gộp mục cùng nhóm thành một CR; mục trùng không tạo CR; mục bỏ cần lý do; câu hỏi trả lời rồi mới vào CR", () => {
    const plan = planExtractionCrs(items, [
      { id: "R1", include: true },
      { id: "R2", include: true },
      { id: "R3", include: true },
      { id: "R4", include: true, answer: "Under 2 seconds" }
    ])
    expect(plan.crs.map((c) => [c.group, c.items.map((i) => i.id)])).toEqual([
      ["G1", ["R1", "R2"]],
      ["G3", ["R4"]]
    ])
    expect(plan.duplicates.map((i) => i.id)).toEqual(["R3"])
    expect(plan.crs[1].answers.get("R4")).toBe("Under 2 seconds")
  })

  it("BA tách nhóm bằng group riêng; bỏ mục kèm lý do", () => {
    const plan = planExtractionCrs(items, [
      { id: "R1", include: true },
      { id: "R2", include: true, group: "G1b" },
      { id: "R3", include: false, drop_reason: "Đã có trong SRS" },
      { id: "R4", include: false, drop_reason: "Không đo được, bỏ" }
    ])
    expect(plan.crs.map((c) => c.group)).toEqual(["G1", "G1b"])
    expect(plan.dropped.map((d) => [d.item.id, d.reason])).toEqual([
      ["R3", "Đã có trong SRS"],
      ["R4", "Không đo được, bỏ"]
    ])
  })

  it("lỗi quyết định: bỏ không lý do, mơ hồ chưa trả lời, thiếu mục, id lạ ⇒ 400 EXTRACTION_DECISION_INVALID kèm item_ids", () => {
    const all = (over: Record<string, Partial<{ include: boolean; drop_reason: string; answer: string }>>) =>
      items.map((i) => ({ id: i.id, include: true, answer: i.id === "R4" ? "x" : undefined, ...over[i.id] }))
    expect(() => planExtractionCrs(items, all({ R3: { include: false } }))).toThrow(/lý do/)
    expect(() => planExtractionCrs(items, all({ R4: { include: true, answer: "" } }))).toThrowError(expect.objectContaining({ code: "EXTRACTION_DECISION_INVALID", meta: { item_ids: ["R4"] } }))
    expect(() => planExtractionCrs(items, all({}).slice(1))).toThrow(/chưa quyết định/)
    expect(() => planExtractionCrs(items, [...all({}), { id: "R9", include: true }])).toThrow(/R9/)
  })

  it("tiêu đề = câu đầu của mục đầu (≤ 100 ký tự), mô tả liệt kê nhãn + nguồn + câu trả lời", () => {
    const plan = planExtractionCrs(items, [
      { id: "R1", include: true },
      { id: "R2", include: true },
      { id: "R3", include: false, drop_reason: "x" },
      { id: "R4", include: true, answer: "Under 2 seconds" }
    ])
    expect(crTitleOf(plan.crs[0])).toBe("Reports must be exportable to CSV.")
    const desc = crDescriptionOf(plan.crs[1], "minutes.txt")
    expect(desc).toContain("[Mơ hồ] The system should be fast.")
    expect(desc).toContain("Nguồn: minutes.txt · D1-P02")
    expect(desc).toContain("Trả lời BA: Under 2 seconds")
    expect(crTitleOf({ group: "g", answers: new Map(), items: [item({ text: `${"a".repeat(120)}. b` })] }).length).toBe(100)
  })
})

describe("normalizeItems — Code kiểm lại đầu ra model", () => {
  const spine = { use_cases: [{ id: "UC-01" }], project: {} } as unknown as Spine
  const paragraphs = ["Meeting on Monday.", "Finance asked that every report can be exported to CSV.", "Login stays as is."]

  it("mã đoạn lạ ⇒ para_id null, trích dẫn lấy từ chính yêu cầu; trích dẫn không có trong đoạn ⇒ lấy cả đoạn; đường dẫn phần tử không tồn tại bị bỏ; lặp bị bỏ; mục hỏi luôn có câu hỏi", () => {
    const items = normalizeItems(
      {
        requirements: [
          { id: "R1", text: "Reports must be exportable to CSV.", source: { para_id: "D1-P02", quote: "every report can be exported to CSV" }, label: "new", entity_paths: [], group: "G1", question: null, suggested_answers: [] },
          { id: "R2", text: "Login keeps email + password.", source: { para_id: "D1-P03", quote: "nope" }, label: "duplicate", entity_paths: ["use_cases[id=UC-01]", "use_cases[id=UC-99]"], group: "G2", question: null, suggested_answers: [] },
          { id: "R3", text: "Reports must be exportable to CSV.", source: { para_id: "D1-P02", quote: "" }, label: "new", entity_paths: [], group: "G1", question: null, suggested_answers: [] },
          { id: "R4", text: "It should be fast.", source: { para_id: "D1-P99", quote: "fast" }, label: "ambiguous", entity_paths: [], group: "", question: "", suggested_answers: ["< 2s", "< 5s", "a", "b", "c"] }
        ]
      },
      1,
      paragraphs,
      spine
    )
    expect(items.map((i) => i.id)).toEqual(["R1", "R2", "R4"])
    expect(items[0]).toMatchObject({ para_id: "D1-P02", quote: "every report can be exported to CSV", group: "G1" })
    expect(items[1]).toMatchObject({ para_id: "D1-P03", quote: "Login stays as is.", entity_paths: ["use_cases[id=UC-01]"] })
    expect(items[2]).toMatchObject({ para_id: null, quote: "It should be fast.", group: "G4", question: "Bạn muốn xử lý yêu cầu này thế nào?" })
    expect(items[2].suggested_answers).toHaveLength(4)
  })
})
