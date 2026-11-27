/**
 * FLF-444: I-4 đọc theo nội dung, không theo tên heading - mỗi dòng của bảng *File lệch format* (business-flow §3.1) một
 * file .docx (`makeOffFormatSrsDocx`), Mongo thật + provider AI giả đọc theo chữ của block (không theo section).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting, runExtraction, useExtractConcurrency } from "../../helpers/mode1-import-p4.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { ExtractionDraft } from "../../../src/modules/import/extraction-draft.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { FIELD_CONFIDENCE_THRESHOLD } from "../../../src/modules/import/import.constants.js"
import { OFF_FORMAT_TEXT as O, makeOffFormatSrsDocx, type OffFormatVariant } from "../../../src/modules/import/testing/off-format-fixture.js"
import { SRS_FIXTURE_TEXT } from "../../../src/modules/import/testing/srs-fixture.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { getDocument } from "../../../src/modules/render/assemble.service.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

useExtractConcurrency(1)

/** Block có câu `text` trong phần block của prompt I-4. */
const blockOf = (prompt: string, text: string): string | null => {
  const tail = prompt.slice(prompt.indexOf("Blocks of the section"))
  const line = tail.split("\n").find((l) => l.includes(text.slice(0, 30)))
  return line ? (/^\[(B\d{4,})\]/.exec(line)?.[1] ?? null) : null
}

/** Section đã gửi cho từng câu (prompt I-4). */
let sectionOfText: Map<string, string> = new Map()

/** AI giả đọc theo nội dung: nhận câu nào thì trả phần tử đúng loại của câu đó, bất kể section / heading. */
const fakeByContent = (prompt: string): string | undefined => {
  if (!prompt.includes("# Import Extract")) return fakeMode1(prompt)
  const section = /Section \(registry id\): (\S+)/.exec(prompt)?.[1] ?? "?"
  const items: object[] = []
  const unmapped: string[] = []
  let mismatch: { content: string } | null = null
  const item = (text: string, entity: string, value: object, confidence = 0.9) => {
    const b = blockOf(prompt, text)
    if (!b) return
    sectionOfText.set(text, section)
    items.push({ entity, key: null, value, confidence, field_confidence: {}, source_block_ids: [b] })
  }
  item(O.reportRequirement, "functions", { name: "Export monthly progress report", description: O.reportRequirement })
  // Điểm AI thấp ⇒ cờ "Cần xem" lúc tạo bản 0.1 (kiểm cờ nêu đúng mục riêng của heading tự đặt)
  item(O.enrollRequirement, "functions", { name: "Enroll in a course", description: O.enrollRequirement }, 0.5)
  item(O.reminderFunction, "functions", { name: "Send nightly reminder email", description: O.reminderFunction })
  item(O.reminderNfr, "nfrs", { statement: O.reminderNfr, kind: "quantitative", metric: "delivery delay", threshold: "5 minutes", category: "performance" })
  item(O.customNfr, "nfrs", { statement: O.customNfr, kind: "quantitative", metric: "load time", threshold: "2 seconds", category: "performance" })
  item(O.proseActors[0], "actors", { name: "Learner", kind: "human", description: O.proseActors[0] })
  item(O.proseActors[1], "actors", { name: "Administrator", kind: "human", description: O.proseActors[1] })
  item(SRS_FIXTURE_TEXT.perf, "nfrs", { statement: SRS_FIXTURE_TEXT.perf, kind: "quantitative" })
  for (const tc of O.testCases) {
    const b = blockOf(prompt, tc)
    if (!b) continue
    sectionOfText.set(tc, section)
    unmapped.push(b)
    mismatch = { content: "test cases" }
  }
  if (!items.length && !mismatch) return fakeMode1(prompt)
  return JSON.stringify({ section_id: section, items, unmapped_block_ids: unmapped, content_mismatch: mismatch })
}

beforeEach(() => {
  resetMockLlm()
  sectionOfText = new Map()
  mockOverrides.next = fakeByContent
})

const extract = async (variant: OffFormatVariant) => {
  const ctx = await importAtExtracting({ buffer: await makeOffFormatSrsDocx(variant) })
  const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
  expect(run.doc.status).toBe("baselining")
  const drafts = await ExtractionDraft.find({ import_id: ctx.importId }).lean()
  const profile = (await TemplateProfile.findOne({ projectId: ctx.projectId }).lean())!
  return { ctx, drafts, profile }
}

type Draft = Awaited<ReturnType<typeof extract>>["drafts"][number]
const fieldsOf = (d: Draft | undefined) => (d?.fields ?? []).map((f) => [f.path, f.value])

describe("FLF-444 - File lệch format: I-4 đọc theo nội dung", () => {
  it("Tên khác chuẩn: heading tự đặt (\"Phần mở rộng\", \"Những gì hệ thống làm được\") vẫn được đọc, phần tử vào Spine, bố cục giữ nguyên", async () => {
    const { ctx, drafts, profile } = await extract("renamed")
    const headingOf = (text: string) => profile.heading_map.find((h) => h.heading_text.includes(text))!
    // I-3 không khớp được hai heading này với mục nào của mẫu
    expect(headingOf("Phần mở rộng").section_id).toBe("unmapped")
    expect(headingOf("Những gì hệ thống làm được").section_id).toBe("unmapped")
    const part3 = drafts.find((d) => d.section_id === `content:@${headingOf("Phần mở rộng").block_id}`)
    const whatItDoes = drafts.find((d) => d.section_id === `content:@${headingOf("Những gì hệ thống làm được").block_id}`)
    expect(part3?.status).toBe("done")
    expect(fieldsOf(part3)).toEqual(expect.arrayContaining([[expect.stringMatching(/^functions\[id=FR-\d+\]\.name$/), "Export monthly progress report"]]))
    expect(fieldsOf(whatItDoes)).toEqual(expect.arrayContaining([[expect.stringMatching(/^functions\[id=FR-\d+\]\.name$/), "Enroll in a course"]]))
    // Prompt mang tiêu đề như file viết, không mang khoá nội bộ
    expect(sectionOfText.get(O.reportRequirement)).toMatch(/^content:@B\d+$/)

    const before = (await spineRepository.get(ctx.projectId))!
    await finalizeImport(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: before.spine_version })
    const spine = (await spineRepository.get(ctx.projectId))!
    expect(spine.functions.map((f) => f.name)).toEqual(expect.arrayContaining(["Export monthly progress report", "Enroll in a course"]))
    expect(spine.flags.some((f) => f.section_id.startsWith("content:"))).toBe(false)
    // FLF-462 (đảo FLF-343): phần tử đọc từ heading tự đặt có độ tin thấp ("Enroll in a course", 0.5) không còn đưa thẳng
    // vào bản gốc kèm cờ vàng "Cần xem" - `extract()` (helper `runExtraction`) đã xác nhận hết ở bước 1.6 trước khi tới
    // đây, nên field đã `confirmed: true` và không còn đủ điều kiện ra cờ (`needsReviewFindings`)
    const enroll = spine.functions.find((f) => f.name === "Enroll in a course")!
    expect(enroll).toBeTruthy()
    expect(spine.flags.some((f) => f.rule_id === "import_needs_review" && f.message.includes("Enroll in a course"))).toBe(false)
    // Bố cục file giữ nguyên: hai heading tự đặt vẫn là mục riêng của layout, giữ thứ tự file
    const layout = (await TemplateProfile.findOne({ projectId: ctx.projectId }).lean())!.layout.map((l) => l.heading_text)
    expect(layout.indexOf("Phần mở rộng")).toBeGreaterThan(-1)
    expect(layout.indexOf("Những gì hệ thống làm được")).toBeGreaterThan(layout.indexOf("Phần mở rộng"))
  })

  it("Tên đúng, nội dung sai: mục \"Use Case\" chứa test case ⇒ không thành use case, đánh dấu để người xác nhận (bước 1.6)", async () => {
    const { drafts } = await extract("mismatch")
    const uc = drafts.find((d) => d.section_id === "fixed:2.2.2")!
    expect(uc.status).toBe("done")
    expect(uc.fields.filter((f) => f.path.startsWith("use_cases["))).toEqual([])
    // FLF-462: extract() xác nhận hết ở bước 1.6 (confirm_all) ⇒ mục tên đúng nội dung sai đã `confirmed: true`
    expect(uc.content_mismatch).toEqual({ by_heading: ["use_cases"], by_content: [], note: "test cases", confirmed: true })
    // Block test case giữ nguyên văn trong file
    expect(uc.unmapped_block_ids.length).toBe(O.testCases.length)
  })

  it("Một section nhiều loại nội dung: chức năng nền lẫn NFR trong 3.1.4 ⇒ mỗi phần tử vào đúng mảng, không coi là lệch", async () => {
    const { drafts } = await extract("mixed")
    const d = drafts.find((x) => x.section_id === "fixed:3.1.4")!
    expect(fieldsOf(d)).toEqual(
      expect.arrayContaining([
        [expect.stringMatching(/^functions\[id=FR-\d+\]\.name$/), "Send nightly reminder email"],
        ["nfrs[id=NFR-01].statement", O.reminderNfr],
        ["nfrs[id=NFR-01].category", "performance"]
      ])
    )
    expect(d.content_mismatch).toBeNull()
    // Prompt của mục cho phép loại ngoài mục
    expect(sectionOfText.get(O.reminderNfr)).toBe("fixed:3.1.4")
  })

  it("Trình bày khác: văn xuôi thay cho bảng, không có ID ⇒ AI trích, hệ thống tự cấp ID, độ tin qua ngưỡng nhờ tín hiệu code", async () => {
    const { drafts } = await extract("prose")
    const d = drafts.find((x) => x.section_id === "fixed:2.1")!
    const names = d.fields.filter((f) => /^actors\[id=[^\]]+\]\.name$/.test(f.path))
    expect(names.map((f) => f.value)).toEqual(["Learner", "Administrator"])
    const ids = names.map((f) => /\[id=([^\]]+)\]/.exec(f.path)![1])
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^A-?\d+$/)
    // Có trong chữ nguồn + đủ field Spine + mục khớp ⇒ không phải Cần xem chỉ vì không có mã
    for (const f of names) expect(f.confidence).toBeGreaterThanOrEqual(FIELD_CONFIDENCE_THRESHOLD)
  })

  it("Không dùng heading: tiêu đề chỉ in đậm có số mục ⇒ I-2 nhận heading, phần tử vào đúng mục", async () => {
    const { drafts, profile } = await extract("bold")
    const mapped = new Map(profile.heading_map.map((h) => [h.heading_text.trim(), h.section_id]))
    expect(mapped.get("2.1 Actors")).toBe("fixed:2.1")
    expect(mapped.get("4.2.3 Performance")).toBe("fixed:4.2.3")
    expect(fieldsOf(drafts.find((x) => x.section_id === "fixed:2.1"))).toEqual(expect.arrayContaining([[expect.stringMatching(/^actors\[id=[^\]]+\]\.name$/), "Learner"]]))
    expect(fieldsOf(drafts.find((x) => x.section_id === "fixed:4.2.3"))).toEqual(expect.arrayContaining([[expect.stringMatching(/^nfrs\[id=[^\]]+\]\.statement$/), SRS_FIXTURE_TEXT.perf]]))
  })

  it("Mục trống (chỉ heading) xét theo heading và mẫu đã khớp: không gọi AI, không thành mục đọc theo nội dung", async () => {
    let calls = 0
    mockOverrides.next = (prompt: string) => {
      if (prompt.includes("# Import Extract")) calls++
      return fakeByContent(prompt)
    }
    const { drafts, profile } = await extract("mixed")
    // "3 Functional Requirements", "3.1 …" chỉ có heading ⇒ không có bản trích theo nội dung nào
    expect(drafts.filter((d) => d.section_id.startsWith("content:"))).toEqual([])
    expect(profile.heading_map.find((h) => h.heading_text.startsWith("3.1 "))?.section_id).toBe("group:3.1")
    expect(calls).toBeGreaterThan(0)
  })
})

describe("FLF-453 - phần tử đọc từ heading tự đặt không in hai lần", () => {
  it("mục riêng chứa NFR + mục 4.2.3 không chia đoạn (mẫu để điền) ⇒ NFR chỉ in một lần, ở mục riêng", async () => {
    const ctx = await importAtExtracting({ buffer: await makeOffFormatSrsDocx("twice") })
    await Project.updateOne({ _id: ctx.projectId }, { $set: { template_intent: "fixed", start_kind: "existing", has_required_template: true } })
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    expect(run.doc.status).toBe("baselining")
    const before = (await spineRepository.get(ctx.projectId))!
    await finalizeImport(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: before.spine_version })
    const spine = (await spineRepository.get(ctx.projectId))!
    expect(spine.nfrs.some((n) => n.statement === O.customNfr)).toBe(true)
    const profile = (await TemplateProfile.findOne({ projectId: ctx.projectId }).lean())!
    // Mục 4.2.3 không chia đoạn (file là mẫu để điền)
    expect((profile.section_segments ?? []).some((s) => s.section_id === "fixed:4.2.3")).toBe(false)
    const doc = await getDocument(ctx.projectId, "Lumen", { source: "draft" })
    const printedIn = doc.sections.filter((s) => JSON.stringify(s.blocks).includes(O.customNfr)).map((s) => s.id)
    expect(printedIn).toHaveLength(1)
    expect(printedIn[0]).toMatch(/^custom:/)
    // NFR của mục 4.2.3 vẫn in ở mục đó
    expect(doc.sections.find((s) => s.id === "fixed:4.2.3" && JSON.stringify(s.blocks).includes(SRS_FIXTURE_TEXT.perf))).toBeTruthy()
  })
})
