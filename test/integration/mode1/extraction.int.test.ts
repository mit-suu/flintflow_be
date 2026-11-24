/**
 * FLF-338 §3.6.1 — rút yêu cầu từ tài liệu thô qua HTTP trên Mongo thật (provider mock): tài liệu tham khảo đã parse ⇒ AI rút
 * danh sách kèm mã đoạn / nhãn ⇒ BA duyệt ⇒ mỗi nhóm một CR nguồn `reference_document`, mục trùng thành nguồn của phần tử.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
import { importedProject, promptsOf, prompts, resetCrMock, routeCr, detail, type Mode1Client } from "../../helpers/mode1-cr-p4.js"
import { ProjectDocument } from "../../../src/modules/project/project-document.model.js"
import { RequirementSource } from "../../../src/modules/project/requirement-source.model.js"
import { ChangeRequest } from "../../../src/modules/change-request/change-request.model.js"
import { extractionSchema } from "../../../src/modules/change-request/change-request.dto.js"

const MINUTES = ["Meeting 2026-10-20 with PM Lan.", "Finance asked that every report can be exported to CSV.", "Login stays with email and password as today.", "The dashboard should feel fast."].join("\n\n")

const EXTRACTION = {
  requirements: [
    { id: "R1", text: "Every report must be exportable to CSV.", source: { para_id: "D1-P02", quote: "every report can be exported to CSV" }, label: "new", entity_paths: [], group: "G1", question: null, suggested_answers: [] },
    { id: "R2", text: "Login keeps email and password.", source: { para_id: "D1-P03", quote: "Login stays with email and password" }, label: "duplicate", entity_paths: ["use_cases[id=UC-01]"], group: "G2", question: null, suggested_answers: [] },
    { id: "R3", text: "The dashboard should feel fast.", source: { para_id: "D1-P04", quote: "The dashboard should feel fast." }, label: "ambiguous", entity_paths: [], group: "G3", question: "Fast means what?", suggested_answers: ["Under 2 seconds", "Under 5 seconds"] }
  ]
}

const seedDocument = async (projectId: string, userId: string) =>
  ProjectDocument.create({
    projectId,
    uploadedBy: userId,
    fileName: "minutes",
    originalName: "minutes.txt",
    mimeType: "text/plain",
    size: MINUTES.length,
    cloudinaryPublicId: "minutes",
    url: "https://example.test/minutes.txt",
    extractedText: MINUTES,
    parseStatus: "success",
    summaryStatus: "success",
    summary: "Minutes",
    docCode: 1
  })

describe("FLF-338 rút yêu cầu từ tài liệu thô (sau baseline)", () => {
  beforeEach(() => resetCrMock())
  /** Sau khi import xong mới cắm mock rút yêu cầu — lượt import dùng mock mặc định. */
  const mockExtraction = () => routeCr((p) => (p.includes("# Extract requirements from a raw document") ? JSON.stringify(EXTRACTION) : undefined))

  const extractAll = async (c: Mode1Client, documentId: string) => {
    const res = await c.post(`/documents/${documentId}/extract`)
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    return extractionSchema.parse(res.body.data)
  }

  it("rút ⇒ danh sách có mã đoạn + nhãn + câu hỏi; GET đọc lại; duyệt ⇒ 2 CR nguồn reference_document, mục trùng thành nguồn phần tử; duyệt lại ⇒ 409", async () => {
    const { c, projectId, seeded } = await importedProject()
    mockExtraction()
    const doc = await seedDocument(projectId, seeded.userId)
    const docId = String(doc._id)
    expect((await c.get(`/documents/${docId}/extract`)).body.data).toBeNull()

    const extracted = await extractAll(c, docId)
    expect(extracted).toMatchObject({ document_name: "minutes.txt", doc_code: 1, status: "extracted" })
    expect(extracted.items.map((i) => [i.id, i.label, i.para_id])).toEqual([
      ["R1", "new", "D1-P02"],
      ["R2", "duplicate", "D1-P03"],
      ["R3", "ambiguous", "D1-P04"]
    ])
    expect(extracted.items[0].quote).toBe("every report can be exported to CSV")
    expect(extracted.items[2]).toMatchObject({ question: "Fast means what?", suggested_answers: ["Under 2 seconds", "Under 5 seconds"] })
    expect(extracted.credits).toBeGreaterThan(0)
    expect((await c.get(`/documents/${docId}/extract`)).body.data.items).toHaveLength(3)

    // Mơ hồ chưa trả lời ⇒ 400 kèm item_ids
    const bad = await c.post(`/documents/${docId}/extract/approve`, { requester: "PM Lan", decisions: [{ id: "R1", include: true }, { id: "R2", include: true }, { id: "R3", include: true }] })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe("EXTRACTION_DECISION_INVALID")
    expect(bad.body.meta.item_ids).toEqual(["R3"])

    const approved = await c.post(`/documents/${docId}/extract/approve`, {
      requester: "PM Lan",
      decisions: [{ id: "R1", include: true }, { id: "R2", include: true }, { id: "R3", include: true, answer: "Under 2 seconds" }]
    })
    expect(approved.status, JSON.stringify(approved.body.error)).toBe(200)
    const result = extractionSchema.parse(approved.body.data)
    expect(result.status).toBe("approved")
    const crIds = result.items.map((i) => i.cr_id)
    expect(crIds[0]).toMatch(/^CR-\d{3}$/)
    expect(crIds[1]).toBeNull()
    expect(crIds[2]).toMatch(/^CR-\d{3}$/)
    expect(crIds[0]).not.toBe(crIds[2])

    const crs = await ChangeRequest.find({ projectId }).sort({ cr_id: 1 }).lean()
    expect(crs).toHaveLength(2)
    // FLF-449 L6: nguồn / vật liệu ghi số đoạn cho người đọc, không mã đoạn thô (trước đây "minutes.txt · D1-P02")
    expect(crs[0]).toMatchObject({ status: "draft", requester: "PM Lan", source: { kind: "reference_document", ref: "minutes.txt · đoạn 2" }, title: "Every report must be exportable to CSV." })
    expect(crs[0].materials[0]).toMatchObject({ kind: "text", name: "minutes.txt · đoạn 2", text: "every report can be exported to CSV" })
    expect(crs[1].description).toContain("Trả lời BA: Under 2 seconds")
    expect((await c.get(`/change-requests`)).body.data).toHaveLength(2)

    // Mục trùng ⇒ UC-01 có thêm nguồn trỏ về đoạn D1-P03
    const source = await RequirementSource.findOne({ projectId, entity_path: "use_cases[id=UC-01]" }).lean()
    expect(source?.refs?.some((r: { para_id: string }) => r.para_id === "D1-P03")).toBe(true)

    expect((await c.post(`/documents/${docId}/extract/approve`, { requester: "PM Lan", decisions: [{ id: "R1", include: true }] })).body.error?.code).toBe("EXTRACTION_ALREADY_APPROVED")
    expect((await c.post(`/documents/${docId}/extract`)).body.error?.code).toBe("EXTRACTION_ALREADY_APPROVED")
  })

  it("tài liệu chưa đọc được chữ ⇒ 422; id lạ ⇒ 404; rút lại thay bản chưa duyệt", async () => {
    const { c, projectId, seeded } = await importedProject()
    mockExtraction()
    const broken = await ProjectDocument.create({ projectId, uploadedBy: seeded.userId, fileName: "x", originalName: "x.pdf", mimeType: "application/pdf", size: 1, cloudinaryPublicId: "x", url: "https://example.test/x", parseStatus: "failed", summaryStatus: "failed" })
    expect((await c.post(`/documents/${String(broken._id)}/extract`)).body.error?.code).toBe("EXTRACTION_DOCUMENT_UNREADABLE")
    expect((await c.post(`/documents/650000000000000000000099/extract`)).status).toBe(404)

    const doc = await seedDocument(projectId, seeded.userId)
    const first = await extractAll(c, String(doc._id))
    const second = await extractAll(c, String(doc._id))
    expect(second.items).toHaveLength(first.items.length)
    expect(second.status).toBe("extracted")
  })
})

describe("FLF-449 rút yêu cầu: tài liệu dài chia lô, Suy ra, chỗ đã tra sang CR, bỏ bước làm rõ khi đã hỏi", () => {
  beforeEach(() => resetCrMock())

  const FILLER = Array.from({ length: 130 }, (_, i) => `Note ${i + 1}: the team talked about the weather and lunch plans. ${"Nothing relevant here. ".repeat(20)}`)
  const LAST = "The dashboard (NFR-01) should feel fast for every learner."
  const LONG = [...FILLER, "Customer service spends the whole morning searching the Excel file for order status.", LAST].join("\n\n")
  const lastPara = `D1-P${FILLER.length + 2}`
  const symptomPara = `D1-P${FILLER.length + 1}`

  /** Lô chứa đoạn cuối trả mục mơ hồ + Suy ra; lô đầu trả một mục Mới. Route theo tiêu đề prompt (đổi tiêu đề thì sửa ở đây). */
  const mockLong = () =>
    routeCr((p) => {
      if (!p.includes("# Extract requirements from a raw document")) return undefined
      if (!p.includes(LAST)) {
        return JSON.stringify({
          situation: { current: [{ text: "Lunch is planned by hand.", para_id: "D1-P01", quote: "the team talked about the weather and lunch plans" }], desired: [] },
          requirements: [{ id: "R1", text: "Lunch plans are shared in the app.", source: { para_id: "D1-P01", quote: "lunch plans" }, label: "new", group: "G1" }]
        })
      }
      return JSON.stringify({
        situation: { current: [], desired: [{ text: "Dashboard is fast.", para_id: lastPara, quote: "should feel fast for every learner" }] },
        requirements: [
          {
            id: "R1",
            text: "Learners can see order status without asking customer service.",
            source: { para_id: symptomPara, quote: "" },
            label: "inferred",
            group: "G1",
            inference: {
              symptom: "CS spends a morning searching Excel.",
              symptom_quote: "spends the whole morning searching the Excel file",
              symptom_para_id: symptomPara,
              root_cause: "Order status only lives in Excel.",
              rationale: "A lookup removes the manual search.",
              options: [
                { label: "Order lookup screen", pros: ["Fast answers"], cons: ["New screen"], risks: ["Order data must be in the system"] },
                { label: "Nightly Excel import", pros: ["Little change"], cons: ["Day-old status"], risks: ["Excel layout changes"] }
              ],
              recommended: null
            }
          },
          { id: "R2", text: "The dashboard should feel fast.", source: { para_id: lastPara, quote: "should feel fast" }, label: "ambiguous", entity_paths: ["nfrs[id=NFR-01]"], group: "G2", question: "Fast means what?", suggested_answers: ["Under 2 seconds", "Under 5 seconds"] }
        ]
      })
    })

  it("tài liệu hơn 60 000 ký tự ⇒ 2 lô, rút được mục ở cuối file; ứng viên Code tra có trong prompt; CR mang seed.targets + câu trả lời, vào thẳng phân tích ảnh hưởng không có lượt làm rõ", async () => {
    expect(LONG.length).toBeGreaterThan(60_000)
    const { c, projectId, seeded } = await importedProject()
    mockLong()
    const doc = await ProjectDocument.create({
      projectId,
      uploadedBy: seeded.userId,
      fileName: "long",
      originalName: "long-minutes.txt",
      mimeType: "text/plain",
      size: LONG.length,
      cloudinaryPublicId: "long",
      url: "https://example.test/long.txt",
      extractedText: LONG,
      parseStatus: "success",
      summaryStatus: "success",
      summary: "Long minutes",
      docCode: 1
    })
    const docId = String(doc._id)
    const estimate = await c.get(`/documents/${docId}/extract/estimate`)
    expect(estimate.status).toBe(200)
    expect(estimate.body.data).toMatchObject({ batches: 2, credits: 6, cost_per_batch: 3 })

    const res = await c.post(`/documents/${docId}/extract`)
    expect(res.status, JSON.stringify(res.body.error)).toBe(201)
    const extracted = extractionSchema.parse(res.body.data)
    expect(extracted.batches).toBe(2)
    // Mục nói rõ trước, Suy ra sau; mục ở cuối file có mặt
    expect(extracted.items.map((i) => [i.id, i.label])).toEqual([
      ["R1", "new"],
      ["R2", "ambiguous"],
      ["R3", "inferred"]
    ])
    expect(extracted.items[1]).toMatchObject({ para_id: lastPara, entity_paths: ["nfrs[id=NFR-01]"] })
    expect(extracted.items[1].entity_names[0]).not.toBe("")
    expect(extracted.items[2].inference).toMatchObject({ symptom_para_id: symptomPara, recommended: null })
    expect(extracted.items[2].group).not.toBe(extracted.items[0].group)
    expect(extracted.situation.current).toHaveLength(1)
    expect(extracted.situation.desired).toHaveLength(1)
    const extractPrompts = prompts.filter((p) => p.includes("# Extract requirements from a raw document"))
    expect(extractPrompts).toHaveLength(2)
    expect(extractPrompts.find((p) => p.includes(LAST))).toContain("nfrs[id=NFR-01]")
    // E2E 24/11: chữ AI viết theo ngôn ngữ tài liệu SRS, có dòng ngôn ngữ cụ thể chứ không chỉ "document's language"
    for (const p of extractPrompts) expect(p).toMatch(/Output language: (Vietnamese \(tiếng Việt\)|English)\./)

    // Suy ra tích mà chưa chọn phương án ⇒ 400
    const decisions = [
      { id: "R1", include: false, drop_reason: "Không thuộc phạm vi" },
      { id: "R2", include: true, answer: "Under 2 seconds" },
      { id: "R3", include: true }
    ]
    const bad = await c.post(`/documents/${docId}/extract/approve`, { requester: "PM Lan", decisions })
    expect(bad.status).toBe(400)
    expect(bad.body.meta.item_ids).toEqual(["R3"])

    const approved = await c.post(`/documents/${docId}/extract/approve`, { requester: "PM Lan", decisions: decisions.map((d) => (d.id === "R3" ? { ...d, chosen_option: 1 } : d)) })
    expect(approved.status, JSON.stringify(approved.body.error)).toBe(200)
    const result = extractionSchema.parse(approved.body.data)
    expect(result.items[2]).toMatchObject({ chosen_option: 1, include: true })

    const crs = await ChangeRequest.find({ projectId }).sort({ cr_id: 1 }).lean()
    expect(crs).toHaveLength(2)
    const ambiguousCr = crs.find((cr) => cr.cr_id === result.items[1].cr_id)!
    const inferredCr = crs.find((cr) => cr.cr_id === result.items[2].cr_id)!
    expect(ambiguousCr.seed?.targets).toContain("nfrs[id=NFR-01]")
    expect(ambiguousCr.clarifications).toEqual([expect.objectContaining({ round: 1, questions: ["Fast means what?"], answers: ["Under 2 seconds"] })])
    expect(ambiguousCr.description).not.toMatch(/D1-P\d+/)
    expect(inferredCr.description).toContain("Phương án đã chọn: Nightly Excel import")

    // CR đã trả lời câu hỏi ⇒ /clarify đi thẳng impact_review, không gọi AI làm rõ
    const before = promptsOf("# CR Clarify").length
    const clarified = detail(await c.post(`/change-requests/${ambiguousCr.cr_id}/clarify`))
    expect(clarified.change_request.status).toBe("impact_review")
    expect(promptsOf("# CR Clarify").length).toBe(before)
  })
})
