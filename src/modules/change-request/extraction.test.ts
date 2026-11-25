import { describe, expect, it } from "vitest"
import type { Spine } from "../spine/spine.types.js"
import { extractRequirementsSchema, type ExtractRequirementsOutput } from "../../shared/ai/response-parser.js"
import { approveExtractionSchema } from "./change-request.dto.js"
import {
  EXTRACTION_BATCH_CHARS,
  answeredClarification,
  crDescriptionOf,
  crTitleOf,
  extractionBatches,
  mergeItems,
  normalizeItems,
  normalizeSituation,
  paragraphLabel,
  planExtractionCrs,
  seedTargetsOf,
  sourceLabel
} from "./extraction.service.js"
import { candidatesText, locatedPathsFor, lookupParagraphs } from "./extraction-lookup.js"
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

type RawRequirement = ExtractRequirementsOutput["requirements"][number]
const raw = (over: Partial<RawRequirement>): RawRequirement => ({
  id: "R1",
  text: "Reports must be exportable to CSV.",
  source: { para_id: "D1-P02", quote: "" },
  label: "new",
  entity_paths: [],
  group: "G1",
  speaker: null,
  sides: [],
  inference: null,
  question: null,
  suggested_answers: [],
  ...over
})
const out = (requirements: RawRequirement[], situation: ExtractRequirementsOutput["situation"] = null): ExtractRequirementsOutput => ({ requirements, situation })

const option = (label: string) => ({ label, description: null, pros: [`${label} nhanh`], cons: [`${label} tốn công`], risks: [`${label} giả định có dữ liệu`] })

describe("planExtractionCrs (FLF-338 §3.6.1 - BA duyệt danh sách rút)", () => {
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

  it("tiêu đề = câu đầu của mục đầu (≤ 100 ký tự), mô tả liệt kê nhãn + nguồn (tên tài liệu + số đoạn, không mã đoạn) + câu trả lời", () => {
    const plan = planExtractionCrs(items, [
      { id: "R1", include: true },
      { id: "R2", include: true },
      { id: "R3", include: false, drop_reason: "x" },
      { id: "R4", include: true, answer: "Under 2 seconds" }
    ])
    expect(crTitleOf(plan.crs[0])).toBe("Reports must be exportable to CSV.")
    const desc = crDescriptionOf(plan.crs[1], "minutes.txt")
    expect(desc).toContain("[Mơ hồ] The system should be fast.")
    // FLF-449 L6: mô tả CR không lộ mã đoạn thô `D1-P02` (trước đây "minutes.txt · D1-P02")
    expect(desc).toContain("Nguồn: minutes.txt · đoạn 2")
    expect(desc).not.toMatch(/D1-P\d+/)
    expect(desc).toContain("Trả lời BA: Under 2 seconds")
    expect(crTitleOf({ group: "g", answers: new Map(), items: [item({ text: `${"a".repeat(120)}. b` })] }).length).toBeLessThanOrEqual(100)
  })

  it("FLF-449: mục Suy ra được tick mà chưa chọn phương án ⇒ 400; chọn phương án 2 ⇒ CR mang chữ phương án 2", () => {
    const inferred = item({
      id: "R5",
      group: "G5",
      label: "inferred",
      text: "CS tra được trạng thái đơn theo mã đơn.",
      inference: {
        symptom: "CS mất cả buổi tra Excel.",
        symptom_quote: "CS mất cả buổi sáng tra file Excel",
        symptom_para_id: "D1-P05",
        root_cause: "Trạng thái đơn chỉ nằm trong file Excel chung.",
        rationale: "Có màn tra cứu thì không phải tìm tay.",
        options: [option("Màn tra cứu đơn cho CS"), option("Nhập file Excel mỗi đêm")],
        recommended: null,
        recommendation_reason: null,
        serves_goal: null
      }
    })
    const list = [...items, inferred]
    const base = list.map((i) => ({ id: i.id, include: true, answer: i.id === "R4" ? "x" : undefined }))
    expect(() => planExtractionCrs(list, base)).toThrowError(expect.objectContaining({ code: "EXTRACTION_DECISION_INVALID", meta: { item_ids: ["R5"] } }))
    expect(() => planExtractionCrs(list, base.map((d) => (d.id === "R5" ? { ...d, chosen_option: 2 } : d)))).toThrow(/phương án/)
    // Bỏ mục Suy ra (có lý do) thì không cần chọn
    expect(() => planExtractionCrs(list, base.map((d) => (d.id === "R5" ? { id: "R5", include: false, drop_reason: "Chưa cần" } : d)))).not.toThrow()

    const plan = planExtractionCrs(list, base.map((d) => (d.id === "R5" ? { ...d, chosen_option: 1 } : d)))
    const planned = plan.crs.find((c) => c.group === "G5")!
    expect(planned.options?.get("R5")).toBe(1)
    const desc = crDescriptionOf(planned, "bien-ban.docx")
    expect(desc).toContain("[Suy ra] CS tra được trạng thái đơn theo mã đơn.")
    expect(desc).toContain("Phương án đã chọn: Nhập file Excel mỗi đêm")
    expect(desc).not.toContain("Màn tra cứu đơn cho CS")
  })

  it("FLF-449: đích gieo cho CR = entity_paths ∪ chỗ đã tra còn trong Spine; câu đã trả lời thành một vòng làm rõ", () => {
    const spine = { use_cases: [{ id: "UC-01" }], nfrs: [{ id: "NFR-01" }], project: {} } as unknown as Spine
    const planned = {
      group: "G1",
      items: [
        item({ id: "R1", entity_paths: ["nfrs[id=NFR-01]"], located_paths: ["use_cases[id=UC-01]", "use_cases[id=UC-99]"] }),
        item({ id: "R2", label: "ambiguous", question: "Nhanh là bao nhiêu?", suggested_answers: ["< 2s", "< 5s"] })
      ],
      answers: new Map([["R2", "< 2s"]])
    }
    expect(seedTargetsOf(planned, spine)).toEqual(["nfrs[id=NFR-01]", "use_cases[id=UC-01]"])
    expect(seedTargetsOf(planned, null)).toEqual([])
    expect(answeredClarification(planned)).toEqual({ round: 1, questions: ["Nhanh là bao nhiêu?"], answers: ["< 2s"], suggestions: [["< 2s", "< 5s"]] })
    expect(answeredClarification({ ...planned, answers: new Map() })).toBeNull()
  })
})

describe("normalizeItems - Code kiểm lại đầu ra model", () => {
  const spine = { use_cases: [{ id: "UC-01", name: "Login" }], project: { goals: [] } } as unknown as Spine
  const paragraphs = ["Meeting on Monday.", "Finance asked that every report can be exported to CSV.", "Login stays as is."]

  it("mã đoạn lạ ⇒ para_id null, trích dẫn lấy từ chính yêu cầu; trích dẫn không có trong đoạn ⇒ lấy cả đoạn; đường dẫn phần tử không tồn tại bị bỏ; lặp bị bỏ; mục hỏi luôn có câu hỏi", () => {
    const items = normalizeItems(
      out([
        raw({ id: "R1", source: { para_id: "D1-P02", quote: "every report can be exported to CSV" } }),
        raw({ id: "R2", text: "Login keeps email + password.", source: { para_id: "D1-P03", quote: "nope" }, label: "duplicate", entity_paths: ["use_cases[id=UC-01]", "use_cases[id=UC-99]"], group: "G2" }),
        raw({ id: "R3", source: { para_id: "D1-P02", quote: "" } }),
        raw({ id: "R4", text: "It should be fast.", source: { para_id: "D1-P99", quote: "fast" }, label: "ambiguous", group: "", question: "", suggested_answers: ["< 2s", "< 5s", "a", "b", "c"] })
      ]),
      1,
      paragraphs,
      spine
    )
    expect(items.map((i) => i.id)).toEqual(["R1", "R2", "R4"])
    expect(items[0]).toMatchObject({ para_id: "D1-P02", quote: "every report can be exported to CSV", group: "G1" })
    // FLF-449 L6: kèm tên phần tử để UI không in `use_cases[id=UC-01]`
    expect(items[1]).toMatchObject({ para_id: "D1-P03", quote: "Login stays as is.", entity_paths: ["use_cases[id=UC-01]"], entity_names: ["Login"] })
    expect(items[2]).toMatchObject({ para_id: null, quote: "It should be fast.", group: "G4", question: "Bạn muốn xử lý yêu cầu này thế nào?" })
    expect(items[2].suggested_answers).toHaveLength(4)
  })

  const minutes = [
    "Biên bản họp 12/09 - Anh A, chị B, PM Lan.",
    "Anh A: duyệt hoàn tiền trong 1 ngày.",
    "Chị B: duyệt hoàn tiền phải trong 3 ngày.",
    "CS mất cả buổi sáng tra file Excel để trả lời khách hỏi đơn."
  ]
  const inference = (over: Partial<NonNullable<RawRequirement["inference"]>> = {}): NonNullable<RawRequirement["inference"]> => ({
    symptom: "CS mất cả buổi tra Excel.",
    symptom_quote: "CS mất cả buổi sáng tra file Excel",
    symptom_para_id: "D1-P04",
    root_cause: "Trạng thái đơn chỉ nằm trong file Excel.",
    rationale: "Màn tra cứu bỏ việc tìm tay.",
    options: [option("Màn tra cứu đơn"), option("Nhập Excel mỗi đêm"), option("Thứ ba bị bỏ")],
    recommended: 0,
    recommendation_reason: null,
    serves_goal: "giảm thời gian trả lời khách",
    ...over
  })

  it("FLF-449 Suy ra: câu trích triệu chứng không nằm trong đoạn ⇒ bỏ mục (không lấy cả đoạn); trích đúng ⇒ giữ đúng 2 phương án; khuyến nghị thiếu lý do ⇒ không khuyến nghị; không có mục tiêu ⇒ serves_goal null", () => {
    const items = normalizeItems(
      out([
        raw({ id: "R1", text: "CS tra trạng thái đơn theo mã.", label: "inferred", source: { para_id: "D1-P04", quote: "" }, inference: inference() }),
        raw({ id: "R2", text: "Quản lý nhiều chi nhánh.", label: "inferred", source: { para_id: "D1-P04", quote: "" }, inference: inference({ symptom_quote: "tháng sau mở chi nhánh Đà Nẵng" }) }),
        raw({ id: "R3", text: "Không có khối suy ra.", label: "inferred", source: { para_id: "D1-P04", quote: "" }, inference: null }),
        raw({ id: "R4", text: "Chỉ một phương án.", label: "inferred", source: { para_id: "D1-P04", quote: "" }, inference: inference({ options: [option("Một")] }) })
      ]),
      1,
      minutes,
      spine
    )
    expect(items.map((i) => i.id)).toEqual(["R1"])
    expect(items[0]).toMatchObject({ label: "inferred", para_id: "D1-P04", quote: "CS mất cả buổi sáng tra file Excel" })
    expect(items[0].inference).toMatchObject({ symptom_para_id: "D1-P04", recommended: null, recommendation_reason: null, serves_goal: null })
    expect(items[0].inference!.options.map((o) => o.label)).toEqual(["Màn tra cứu đơn", "Nhập Excel mỗi đêm"])
    expect(items[0].question).toBeNull()
  })

  it("FLF-449 Suy ra: khuyến nghị có lý do được giữ; mục tiêu dự án khớp ⇒ chép nguyên văn mục tiêu, không khớp ⇒ null", () => {
    const goals = ["Giảm thời gian trả lời khách xuống dưới 5 phút"]
    const [kept] = normalizeItems(
      out([raw({ text: "CS tra trạng thái đơn.", label: "inferred", source: { para_id: "D1-P04", quote: "" }, inference: inference({ recommendation_reason: "Biên bản nói CS cần trả lời ngay khi khách gọi.", serves_goal: "giảm thời gian trả lời khách" }) })]),
      1,
      minutes,
      spine,
      { goals }
    )
    expect(kept.inference).toMatchObject({ recommended: 0, recommendation_reason: "Biên bản nói CS cần trả lời ngay khi khách gọi.", serves_goal: goals[0] })
    const [other] = normalizeItems(out([raw({ text: "x", label: "inferred", source: { para_id: "D1-P04", quote: "" }, inference: inference({ serves_goal: "tăng doanh thu" }) })]), 1, minutes, spine, { goals })
    expect(other.inference?.serves_goal).toBeNull()
  })

  it("FLF-449 người nói chỉ giữ khi tên có trong tài liệu; mâu thuẫn giữ các phía có câu trích đúng (anh A 1 ngày, chị B 3 ngày)", () => {
    const [conflict, email] = normalizeItems(
      out([
        raw({
          id: "R1",
          text: "Thời hạn duyệt hoàn tiền.",
          label: "contradiction",
          source: { para_id: "D1-P02", quote: "duyệt hoàn tiền trong 1 ngày" },
          speaker: "Anh A",
          question: "Thời hạn duyệt hoàn tiền là 1 hay 3 ngày?",
          suggested_answers: ["1 ngày", "3 ngày"],
          sides: [
            { speaker: "Anh A", para_id: "D1-P02", quote: "duyệt hoàn tiền trong 1 ngày" },
            { speaker: "Chị B", para_id: "D1-P03", quote: "duyệt hoàn tiền phải trong 3 ngày" },
            { speaker: "Anh C", para_id: "D1-P03", quote: "không có câu này" }
          ]
        }),
        raw({ id: "R2", text: "Gửi email xác nhận.", source: { para_id: "D1-P01", quote: "" }, speaker: "Giám đốc Minh" })
      ]),
      1,
      minutes,
      spine
    )
    expect(conflict.speaker).toBe("Anh A")
    expect(conflict.sides).toEqual([
      { speaker: "Anh A", para_id: "D1-P02", quote: "duyệt hoàn tiền trong 1 ngày" },
      { speaker: "Chị B", para_id: "D1-P03", quote: "duyệt hoàn tiền phải trong 3 ngày" }
    ])
    expect(email.speaker).toBeNull()
    expect(email.sides).toEqual([])
  })

  it("FLF-449 hiện trạng / mong muốn: chỉ giữ ý có câu trích đúng đoạn", () => {
    const situation = normalizeSituation(
      {
        current: [
          { text: "CS tra đơn bằng Excel.", para_id: "D1-P04", quote: "tra file Excel" },
          { text: "Bịa.", para_id: "D1-P04", quote: "không có" }
        ],
        desired: [{ text: "Duyệt hoàn tiền nhanh.", para_id: "D1-P02", quote: "duyệt hoàn tiền trong 1 ngày" }]
      },
      1,
      minutes
    )
    expect(situation).toEqual({
      current: [{ text: "CS tra đơn bằng Excel.", para_id: "D1-P04", quote: "tra file Excel" }],
      desired: [{ text: "Duyệt hoàn tiền nhanh.", para_id: "D1-P02", quote: "duyệt hoàn tiền trong 1 ngày" }]
    })
    expect(normalizeSituation(null, 1, minutes)).toEqual({ current: [], desired: [] })
  })
})

describe("FLF-449 bỏ trần 40, chia lô, gộp trùng ý", () => {
  it("schema đầu ra nhận hơn 40 mục (trước đây model trả 41 mục là lỗi parse mất cả lượt); duyệt nhận hơn 40 quyết định", () => {
    const requirements = Array.from({ length: 45 }, (_, i) => ({ id: `R${i + 1}`, text: `Requirement ${i + 1}`, source: { para_id: "D1-P01", quote: "" }, label: "new" }))
    expect(extractRequirementsSchema.parse({ requirements }).requirements).toHaveLength(45)
    const decisions = Array.from({ length: 45 }, (_, i) => ({ id: `R${i + 1}`, include: true }))
    expect(approveExtractionSchema.safeParse({ requester: "PM Lan", decisions }).success).toBe(true)
  })

  it("tài liệu dài chia lô theo đoạn, không cắt: mọi đoạn nằm trong đúng một lô, đoạn dài hơn ngân sách đứng riêng", () => {
    const paragraphs = Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1}: ${"x".repeat(400)}`)
    const batches = extractionBatches(1, paragraphs)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches[0].start).toBe(0)
    expect(batches[batches.length - 1].end).toBe(300)
    for (let i = 1; i < batches.length; i++) expect(batches[i].start).toBe(batches[i - 1].end)
    expect(extractionBatches(1, ["short", "y".repeat(EXTRACTION_BATCH_CHARS + 10), "tail"]).map((b) => [b.start, b.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3]
    ])
    expect(extractionBatches(1, ["a", "b"])).toEqual([{ index: 0, start: 0, end: 2 }])
    expect(extractionBatches(1, [])).toEqual([])
  })

  it("gộp các lô: hơn 40 mục giữ đủ; trùng ý (chữ gập trùng, hoặc gần như trùng + cùng nhãn + cùng phần tử) gộp một; nhóm mỗi lô đánh lại; Suy ra xếp sau; id đánh lại", () => {
    const spine = { nfrs: [{ id: "NFR-01", statement: "Export finishes within 5 seconds" }], project: { goals: [] } } as unknown as Spine
    const many = Array.from({ length: 42 }, (_, i) => item({ id: `R${i + 1}`, text: `Requirement code ${i + 1}x${i + 1}y`, group: `G${i + 1}` }))
    const inferred = item({ id: "R1", label: "inferred", text: "Order status lookup for CS.", group: "G1" })
    const second = [
      inferred,
      item({ id: "R2", text: "REPORTS must be exportable to CSV!", group: "G1" }),
      item({ id: "R3", label: "modification", text: "The export must finish within 5 seconds", entity_paths: ["nfrs[id=NFR-01]"], located_paths: ["nfrs[id=NFR-01]"], group: "G2" }),
      item({ id: "R4", label: "modification", text: "The export must finish within 50 seconds", entity_paths: [], group: "G2" })
    ]
    const first = [
      item({ id: "R1", text: "Reports must be exportable to CSV.", group: "G1" }),
      item({ id: "R2", label: "modification", text: "The export must finish within 5 seconds.", entity_paths: ["nfrs[id=NFR-01]"], group: "G1" }),
      ...many
    ]
    const merged = mergeItems([first, second], spine)
    // 2 + 42 của lô 1; lô 2: CSV và "5 seconds" gộp vào mục lô 1, "50 seconds" (khác phần tử) và Suy ra giữ
    expect(merged).toHaveLength(46)
    expect(merged.map((i) => i.id)).toEqual(Array.from({ length: 46 }, (_, i) => `R${i + 1}`))
    expect(merged[merged.length - 1]).toMatchObject({ label: "inferred", text: "Order status lookup for CS." })
    expect(merged.filter((i) => /CSV/i.test(i.text))).toHaveLength(1)
    expect(merged[1]).toMatchObject({ text: "The export must finish within 5 seconds.", located_paths: ["nfrs[id=NFR-01]"], entity_names: ["Export finishes within 5 seconds"] })
    // Nhóm G1 của lô 2 khác nhóm G1 của lô 1
    expect(merged[0].group).toBe("G1")
    expect(merged.find((i) => i.text.includes("50 seconds"))!.group).not.toBe(merged[0].group)
    expect(merged.find((i) => i.label === "inferred")!.group).not.toBe("G1")
  })

  it("E2E 24/11 #4: một mâu thuẫn bị tách mỗi người một mục (cùng câu hỏi / cùng các bên) gộp thành một mục, đủ các bên", () => {
    const spine = { project: { goals: [] } } as unknown as Spine
    const hoa = { speaker: "Chị Hoa", para_id: "D1-P04", quote: "hoàn trong vòng 1 ngày làm việc" }
    const binh = { speaker: "Anh Bình", para_id: "D1-P04", quote: "ít nhất 3 ngày làm việc mới hoàn được" }
    const q = "Thời hạn hoàn tiền là 1 ngày hay ít nhất 3 ngày làm việc?"
    const a = item({ id: "R1", label: "contradiction", text: "Hoàn tiền trong 1 ngày làm việc.", question: q, sides: [hoa, binh], group: "G1" })
    const b = item({ id: "R2", label: "contradiction", text: "Kế toán kiểm tra trước, hoàn sau ít nhất 3 ngày.", question: `${q} `, sides: [binh], group: "G2" })
    const c = item({ id: "R3", label: "contradiction", text: "Khác hẳn.", question: "Câu khác?", sides: [binh, hoa], group: "G3" })
    const other = item({ id: "R4", label: "contradiction", text: "Mâu thuẫn khác.", question: "Hủy đơn tới khi nào?", sides: [hoa], group: "G4" })
    const merged = mergeItems([[a, b, c, other]], spine)
    expect(merged).toHaveLength(2)
    expect(merged[0].sides).toHaveLength(2)
    expect(merged[1].question).toBe("Hủy đơn tới khi nào?")
  })

  it("nhãn nguồn cho người đọc: không mã đoạn", () => {
    expect(paragraphLabel("D1-P03")).toBe("đoạn 3")
    expect(paragraphLabel(null)).toBe("")
    expect(sourceLabel("minutes.txt", ["D1-P02", "D1-P04", "D1-P02", null])).toBe("minutes.txt · đoạn 2, 4")
    expect(sourceLabel("minutes.txt", [null])).toBe("minutes.txt")
  })
})

describe("FLF-449 Code tra SRS cho từng đoạn trước lượt AI (thay 8000 ký tự đầu)", () => {
  const spine = {
    project: { goals: [] },
    actors: [{ id: "A01", name: "Customer" }],
    use_cases: [
      { id: "UC-01", name: "Đăng nhập", description: "Khách đăng nhập bằng email và mật khẩu" },
      { id: "UC-02", name: "Xem báo cáo", description: "Kế toán xem báo cáo doanh thu" }
    ],
    functions: [],
    screens: [],
    entities: [],
    features: [],
    nfrs: [],
    business_rules: [{ id: "BR-01", statement: "Kế toán duyệt hoàn tiền" }]
  } as unknown as Spine

  it("yêu cầu nằm sau ký tự thứ 50 000 vẫn tra ra đúng phần tử; ứng viên vào prompt của lô; chỗ đã tra chỉ lấy nhắc tên / gần nghĩa", async () => {
    const filler = Array.from({ length: 130 }, (_, i) => `Đoạn ${i + 1} nói chuyện thời tiết hôm nay ${"lorem ".repeat(60)}`)
    expect(filler.join("\n\n").length).toBeGreaterThan(50_000)
    const paragraphs = [...filler, "Khách hay quên mật khẩu khi Đăng nhập, cần cho đặt lại mật khẩu qua email."]
    const last = paragraphs.length - 1
    const vectorQueries: string[] = []
    const hits = await lookupParagraphs(spine, paragraphs, {
      vector: async (text) => {
        vectorQueries.push(text)
        return text.includes("quên mật khẩu") ? [{ ref: "use_cases[id=UC-01]", score: 0.9 }, { ref: "use_cases[id=UC-99]", score: 0.95 }] : []
      }
    })
    expect([...(hits.get(last)?.get("use_cases[id=UC-01]") ?? [])].sort()).toEqual(["keyword", "mention", "vector"])
    expect(hits.get(last)?.has("use_cases[id=UC-99]")).toBe(false)
    // Mỗi cửa sổ ~2000 ký tự một lần tra gần nghĩa — phủ cả tài liệu
    expect(vectorQueries.length).toBeGreaterThan(10)
    expect(vectorQueries[vectorQueries.length - 1]).toContain("quên mật khẩu")

    const text = candidatesText(spine, hits, [last], (i) => `D1-P${i + 1}`)
    expect(text).toContain(`use_cases[id=UC-01] "Đăng nhập"`)
    expect(text).toContain(`D1-P${last + 1}`)
    expect(locatedPathsFor(spine, hits, last, "Cho đặt lại mật khẩu")).toEqual(["use_cases[id=UC-01]"])
    // Không vector (trước baseline): chỉ nhắc tên + từ khoá
    const keywordOnly = await lookupParagraphs(spine, paragraphs)
    expect([...(keywordOnly.get(last)?.get("use_cases[id=UC-01]") ?? [])].sort()).toEqual(["keyword", "mention"])
    expect(candidatesText(spine, keywordOnly, [0], (i) => `D1-P${i + 1}`)).toBeTruthy()
  })

  it("vector lỗi ⇒ coi như không có, vẫn trả nhắc tên + từ khoá", async () => {
    const hits = await lookupParagraphs(spine, ["BR-01 cần đổi: Kế toán trưởng duyệt hoàn tiền"], { vector: async () => Promise.reject(new Error("atlas down")) })
    expect(hits.get(0)?.get("business_rules[id=BR-01]")?.has("mention")).toBe(true)
  })
})
