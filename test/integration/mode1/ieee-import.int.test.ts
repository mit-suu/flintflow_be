/**
 * FLF-252: import SRS viết theo mẫu IEEE 830 trên Mongo thật + provider AI giả — nhận họ mẫu, map mục IEEE vào section
 * FPT (nhiều mục cùng một section, mục chỉ có ở IEEE giữ nguyên văn), Revision History thành Record of Changes, bảng
 * yêu cầu "ID | Requirement | Priority" dưới chương yêu cầu chức năng thành chức năng của tính năng đó.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeMode1 } from "../../helpers/mode1.js"
import { importAtExtracting } from "../../helpers/mode1-import-p4.js"
import { makeIeeeSrsDocx } from "../../../src/modules/import/testing/srs-fixture.js"
import { runExtraction, patchFields } from "../../../src/modules/import/extract.service.js"
import { finalizeImport } from "../../../src/modules/import/finalize.service.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

beforeEach(() => {
  resetMockLlm()
  mockOverrides.next = fakeMode1
})

describe("import mẫu IEEE 830 (FLF-252)", () => {
  it("nhận họ mẫu IEEE, map mục IEEE vào section FPT, không cần bước xác nhận mapping", async () => {
    const { projectId } = await importAtExtracting({ buffer: await makeIeeeSrsDocx() })
    const profile = (await TemplateProfile.findOne({ projectId }).lean())!
    expect(profile.template_family).toBe("ieee830")
    const section = (text: string) => profile.heading_map.find((h) => h.heading_text === text)?.section_id
    expect(section("Revision History")).toBe("fixed:I")
    expect(section("1.4 References")).toBe("unmapped")
    expect(section("2.3 User Characteristics")).toBe("fixed:2.1")
    expect(section("3.2 Functional Requirements")).toMatch(/^feature:@B\d{4}$/)
    expect(section("3.5.1 Reliability")).toBe("fixed:4.2.2")
    expect(section("3.5.2 Availability")).toBe("fixed:4.2.2")
    expect(profile.legacy_record_of_changes).toEqual([{ date: "01/09/2026", version: "0.1", change_type: "M", in_charge: "Lan", description: "Initial draft" }])
    expect(profile.table_map.filter((t) => t.field_path?.startsWith("functions[]")).map((t) => t.field_path)).toEqual([
      "functions[].id",
      "functions[].description",
      "functions[].priority"
    ])
  })

  it("trích + finalize: bảng yêu cầu thành chức năng của tính năng 3.2, tác nhân từ 2.3, lịch sử từ Revision History", async () => {
    const ctx = await importAtExtracting({ buffer: await makeIeeeSrsDocx() })
    const run = await runExtraction(ctx.projectId, ctx.userId, ctx.importId)
    if (run.doc.status === "fields_review") await patchFields(ctx.projectId, { import_id: ctx.importId, fields: [], confirm_all: true })
    const before = (await spineRepository.get(ctx.projectId))!
    await finalizeImport(ctx.projectId, ctx.userId, { import_id: ctx.importId, base_version: before.spine_version })

    const spine = (await spineRepository.get(ctx.projectId))!
    const feature = spine.features.find((f) => f.name === "Functional Requirements")!
    expect(feature).toBeDefined()
    expect(spine.functions.filter((f) => f.feature_id === feature.id).map((f) => [f.id, f.name, f.priority])).toEqual([
      ["FR-001", "Let a learner register with an email address", "must"],
      ["FR-002", "Let an admin lock a learner account", "should"]
    ])
    expect(spine.actors.map((a) => a.name)).toEqual(["Learner", "Admin"])
    const profile = (await TemplateProfile.findOne({ projectId: ctx.projectId }).lean())!
    expect(profile.legacy_record_of_changes.map((r) => r.description)).toEqual(["Initial draft"])
    // Availability lặp section 4.2.2 ⇒ mục riêng của layout chỉ giữ phần không trích được, không chép lại nội dung đã trích
    const availability = profile.layout.find((l) => l.heading_text === "3.5.2 Availability")!
    expect(availability.section_id).toMatch(/^custom:/)
    // NFR trích từ đoạn dưới Availability in dưới chính heading đó (không dồn lên 3.5.1 Reliability)
    const availabilityNfr = spine.nfrs.find((n) => n.statement.includes("24 hours"))!
    expect(profile.section_slices).toEqual([
      { custom_id: availability.section_id.slice("custom:".length), section_id: "fixed:4.2.2", items: [`nfrs:${availabilityNfr.id}`] }
    ])
  })
})
