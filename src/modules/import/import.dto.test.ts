import { describe, it, expect } from "vitest"
import {
  confirmLatestRequestSchema,
  docBlockDtoSchema,
  fieldsPatchRequestSchema,
  finalizeRequestSchema,
  finalizeResponseSchema,
  gapReportQuerySchema,
  gapReportSchema,
  getImportResponseSchema,
  importedDocumentDtoSchema,
  mappingPatchRequestSchema,
  reuploadDiffDtoSchema,
  stepPlanPatchRequestSchema,
  stepPlanResponseSchema,
  templateProfileDtoSchema
} from "./import.dto.js"
import { MODE1_ERROR_STATUS, Mode1Error, mode1ErrorCodeSchema } from "./mode1.errors.js"

const AT = "2026-09-18T08:00:00.000Z"
const IMPORT_ID = "66f000000000000000000001"
const PROJECT_ID = "66f000000000000000000002"

const sampleImport = () => ({
  id: IMPORT_ID,
  project_id: PROJECT_ID,
  original_name: "SRS_Lumen_v1.2.docx",
  size: 245_760,
  sha256: "a".repeat(64),
  status: "mapping_review" as const,
  preflight: { status: "accepted" as const, issues: [] },
  stamp: null,
  confirmed_latest_at: AT,
  paused: null,
  extract_cursor: null,
  created_at: AT,
  updated_at: AT
})

describe("import.dto — request", () => {
  it("confirm-latest cần import_id, không nhận field lạ", () => {
    expect(confirmLatestRequestSchema.safeParse({ import_id: IMPORT_ID }).success).toBe(true)
    expect(confirmLatestRequestSchema.safeParse({}).success).toBe(false)
    expect(confirmLatestRequestSchema.safeParse({ import_id: IMPORT_ID, x: 1 }).success).toBe(false)
  })

  it("mapping: cần ít nhất một mục hoặc confirm_all; block_id đúng dạng B0001", () => {
    expect(mappingPatchRequestSchema.safeParse({ import_id: IMPORT_ID }).success).toBe(false)
    expect(mappingPatchRequestSchema.safeParse({ import_id: IMPORT_ID, confirm_all: true }).success).toBe(true)
    const ok = mappingPatchRequestSchema.parse({
      import_id: IMPORT_ID,
      headings: [{ block_id: "B0012", section_id: "fixed:2.1" }, { block_id: "B0013", section_id: "unmapped" }],
      tables: [{ block_id: "B0020", column_index: 0, field_path: "use_cases[].id" }, { block_id: "B0020", column_index: 3, field_path: null }]
    })
    expect(ok.confirm_all).toBe(false)
    expect(mappingPatchRequestSchema.safeParse({ import_id: IMPORT_ID, headings: [{ block_id: "12", section_id: "fixed:2.1" }] }).success).toBe(false)
  })

  it("fields: xác nhận / sửa / bỏ từng field, hoặc confirm_all", () => {
    expect(fieldsPatchRequestSchema.safeParse({ import_id: IMPORT_ID }).success).toBe(false)
    expect(fieldsPatchRequestSchema.safeParse({ import_id: IMPORT_ID, confirm_all: true }).success).toBe(true)
    const parsed = fieldsPatchRequestSchema.parse({
      import_id: IMPORT_ID,
      fields: [
        { section_id: "fixed:2.1", path: "actors[id=A01].name", confirmed: true, edited_value: "Student" },
        { section_id: "fixed:2.1", path: "actors[id=A02].description", confirmed: false }
      ]
    })
    expect(parsed.fields).toHaveLength(2)
  })

  it("finalize ghi Spine nên bắt buộc base_version ≥ 1", () => {
    expect(finalizeRequestSchema.safeParse({ import_id: IMPORT_ID }).success).toBe(false)
    expect(finalizeRequestSchema.safeParse({ import_id: IMPORT_ID, base_version: 0 }).success).toBe(false)
    expect(finalizeRequestSchema.safeParse({ import_id: IMPORT_ID, base_version: 3 }).success).toBe(true)
  })

  it("gap-report mặc định format json", () => {
    expect(gapReportQuerySchema.parse({}).format).toBe("json")
    expect(gapReportQuerySchema.safeParse({ format: "pdf" }).success).toBe(false)
  })
})

describe("import.dto — response", () => {
  it("ImportedDocument hợp lệ; sha256 phải 64 ký tự; status phải thuộc máy trạng thái", () => {
    expect(importedDocumentDtoSchema.safeParse(sampleImport()).success).toBe(true)
    expect(importedDocumentDtoSchema.safeParse({ ...sampleImport(), sha256: "abc" }).success).toBe(false)
    expect(importedDocumentDtoSchema.safeParse({ ...sampleImport(), status: "done" }).success).toBe(false)
  })

  it("preflight bị từ chối kèm vị trí", () => {
    const rejected = {
      ...sampleImport(),
      status: "preflight_rejected",
      preflight: {
        status: "rejected",
        issues: [
          { code: "FOREIGN_TRACK_CHANGE", message: "Track Changes của \"Nguyen Van A\" chưa được Accept/Reject", location: { block_ord: 5, text: "3.2.5 Create SRS project" } },
          { code: "FILE_ENCRYPTED", message: "File có mật khẩu" }
        ]
      }
    }
    expect(importedDocumentDtoSchema.safeParse(rejected).success).toBe(true)
    expect(importedDocumentDtoSchema.safeParse({ ...rejected, preflight: { status: "rejected", issues: [{ code: "VIRUS", message: "x" }] } }).success).toBe(false)
  })

  it("GET /import khi chưa upload: import = null", () => {
    const empty = { import: null, profile: null, extraction: { sections: [], review_fields: [] }, blocks_count: 0 }
    expect(getImportResponseSchema.safeParse(empty).success).toBe(true)
  })

  it("DocBlock có revisions tuỳ chọn cho bản draft", () => {
    const block = {
      block_id: "B0042",
      doc_version: "0.1",
      kind: "list_item",
      level: null,
      heading_path: ["1 Product Overview"],
      text: "BR-01: A course must have at least three lessons before publishing.",
      section_id: "fixed:1",
      mentions: [{ entity: "business_rule", id: "BR-01" }],
      editable: true,
      locked_by_cr: "CR-002",
      revisions: [{ kind: "del", text: "one lesson", author: "CR-001" }, { kind: "ins", text: "three lessons", author: "CR-001" }]
    }
    expect(docBlockDtoSchema.safeParse(block).success).toBe(true)
    expect(docBlockDtoSchema.safeParse({ ...block, kind: "textbox" }).success).toBe(false)
  })

  it("finalize trả baseline type imported, doc_version 0.0", () => {
    const res = {
      import: { ...sampleImport(), status: "checking" },
      doc_version: "0.0",
      baseline: { id: "BL001", version: "0.0", type: "imported", doc_version: "0.0", at: AT, snapshot_ref: "66f000000000000000000009", checked_at_version: 4, waived_count: 0 },
      spine_version: 4,
      flags: { red: 2, yellow: 7 }
    }
    const parsed = finalizeResponseSchema.parse(res)
    expect(parsed.baseline.type).toBe("imported")
    expect(finalizeResponseSchema.safeParse({ ...res, doc_version: "0.1" }).success).toBe(false)
  })

  it("gap report và re-upload diff", () => {
    const report = {
      project_id: PROJECT_ID,
      doc_version: "0.0",
      generated_at: AT,
      totals: { red: 0, yellow: 1, missing_sections: 1, unmapped_headings: 1, low_confidence_fields: 0, missing_fpt_sections: 1, unrendered_diagrams: 0 },
      missing_fpt_sections: [{ section_id: "fixed:5.1", title: "Business Rules", step_id: "S-7.1", in_layout: false }],
      layout: [{ order: 0, section_id: "custom:CS01", heading: "Phụ lục B — Biên bản họp", level: 1, kind: "custom", red: 0, yellow: 0 }],
      sections: [],
      unrendered_diagrams: [],
      missing_sections: [{ section_id: "fixed:5.3", title: "Application Messages List" }],
      unmapped_headings: [{ block_id: "B0100", text: "Phụ lục B — Biên bản họp" }],
      low_confidence_fields: []
    }
    expect(gapReportSchema.safeParse(report).success).toBe(true)
    const diff = {
      id: "66f000000000000000000003",
      original_name: "SRS_v0.1_sua.docx",
      against_version: "0.1",
      created_at: AT,
      summary: { added: 1, removed: 0, modified: 1, moved: 0 },
      blocks: [{ block_id: null, change: "added", after: "New paragraph" }, { block_id: "B0007", change: "modified", before: "a", after: "b" }]
    }
    expect(reuploadDiffDtoSchema.safeParse(diff).success).toBe(true)
  })
})

describe("mode 1 v2 — layout + step-plan (FLF-182, contract-change)", () => {
  const profile = { doc_version: "0.0", heading_map: [], table_map: [], required_sections: [], language: "en" }

  it("profile cũ không có layout ⇒ []; layout mang section FPT hoặc custom:<id>", () => {
    expect(templateProfileDtoSchema.parse(profile).layout).toEqual([])
    const layout = [
      { order: 0, heading_text: "1 Introduction", level: 1, section_id: "fixed:1" },
      { order: 1, heading_text: "1.4 References", level: 2, section_id: "custom:CS01" }
    ]
    expect(templateProfileDtoSchema.parse({ ...profile, layout }).layout).toEqual(layout)
    expect(templateProfileDtoSchema.safeParse({ ...profile, layout: [{ ...layout[0], level: 0 }] }).success).toBe(false)
  })

  it("step-plan: state applied | hidden | enabled, missing đánh dấu đầu mục FPT bị thiếu", () => {
    const steps = [
      { step_id: "S-7.1", state: "applied", missing: true, section_ids: ["fixed:5.1"], reason: "Đầu mục mẫu FPT — file không có" },
      { step_id: "B-0.1", state: "hidden", missing: false, section_ids: [], reason: "Không sinh đầu mục" }
    ]
    expect(stepPlanResponseSchema.parse({ steps }).steps).toHaveLength(2)
    expect(stepPlanResponseSchema.safeParse({ steps: [{ ...steps[0], state: "suggested" }] }).success).toBe(false)
    expect(stepPlanPatchRequestSchema.parse({ step_id: "B-0.1", enabled: true })).toEqual({ step_id: "B-0.1", enabled: true })
    expect(stepPlanPatchRequestSchema.safeParse({ step_id: "", enabled: true }).success).toBe(false)
  })

  it("mã lỗi mới: CORE_STEP_REQUIRED 409, STEP_NOT_IN_PLAN 404", () => {
    expect(MODE1_ERROR_STATUS.CORE_STEP_REQUIRED).toBe(409)
    expect(MODE1_ERROR_STATUS.STEP_NOT_IN_PLAN).toBe(404)
  })
})

describe("mode1.errors", () => {
  it("mỗi mã có HTTP status; Mode1Error mang status + code + meta", () => {
    const e = new Mode1Error("PATH_LOCKED", "actors[id=A01] đang bị CR-001 khoá", { locked: [{ path: "actors[id=A01]", cr_id: "CR-001" }] })
    expect(e.statusCode).toBe(409)
    expect(e.code).toBe("PATH_LOCKED")
    expect(e.meta).toEqual({ locked: [{ path: "actors[id=A01]", cr_id: "CR-001" }] })
    expect(MODE1_ERROR_STATUS.CR_SOURCE_REQUIRED).toBe(400)
    expect(MODE1_ERROR_STATUS.RELEASE_RED_FLAGS_OPEN).toBe(422)
    expect(mode1ErrorCodeSchema.options).toHaveLength(Object.keys(MODE1_ERROR_STATUS).length)
  })
})
