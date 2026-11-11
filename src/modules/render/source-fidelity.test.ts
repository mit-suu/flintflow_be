import { describe, expect, it } from "vitest"
import type { RenderedDocument } from "./rendered-document.types.js"
import { pristineSectionIds, sourceBasedFrom } from "./source-fidelity.js"

const doc = (sections: RenderedDocument["sections"]): RenderedDocument => ({
  projectId: "p", projectName: "Portal", version: "0.1", source: "draft", generatedAt: "2026-11-06T00:00:00Z", recordOfChanges: [], sections
})
const para = (text: string) => ({ type: "paragraph" as const, runs: [{ text }] })

describe("sourceBasedFrom - dự án 'Upload SRS có sẵn' dùng file upload làm nền", () => {
  const profile = { source_file_ref: "file", target_structure: { resolved_mode: 1 } }
  it("có sẵn: mẫu cố định của công ty, hoặc cấu trúc FlintFlow đủ mục (chế độ 1)", () => {
    expect(sourceBasedFrom({ start_kind: "existing", template_intent: "fixed", mode: "import" }, { source_file_ref: "file", target_structure: { resolved_mode: 3 } })).toBe(true)
    expect(sourceBasedFrom({ start_kind: "existing", template_intent: "free", mode: "import" }, profile)).toBe(true)
    // dự án import cũ (trước FLF-335) chưa có start_kind
    expect(sourceBasedFrom({ start_kind: null, template_intent: null, mode: "import" }, profile)).toBe(true)
  })

  it("không áp: dự án mới (mẫu để điền), chuyển từ mode 2, chế độ 4, chưa có file nguồn, chưa so cấu trúc", () => {
    expect(sourceBasedFrom({ start_kind: "new", template_intent: "fixed", mode: "import" }, profile)).toBe(false)
    expect(sourceBasedFrom({ start_kind: null, converted_from: "fpt", mode: "import" }, profile)).toBe(false)
    expect(sourceBasedFrom({ start_kind: "existing", template_intent: "free", mode: "import" }, { source_file_ref: "file", target_structure: { resolved_mode: 4 } })).toBe(false)
    expect(sourceBasedFrom({ start_kind: "existing", template_intent: "fixed", mode: "import" }, { source_file_ref: null })).toBe(false)
    expect(sourceBasedFrom({ start_kind: "existing", template_intent: "free", mode: "import" }, { source_file_ref: "file" })).toBe(false)
    expect(sourceBasedFrom({ start_kind: "existing", template_intent: "fixed", mode: "fpt" }, profile)).toBe(false)
    expect(sourceBasedFrom(null, profile)).toBe(false)
  })

  it("màn đọc khung: khung mẫu không bao giờ in lại; SRS viết dở giữ khung đã sang Luồng 2 (mode fpt, kể cả sau 1.0) vẫn lấy file làm nền", () => {
    const preview = (kind: "written" | "template") => ({
      summary: { present: 0, missing: 0, out_of_scope: 0, kind },
      sections: [],
      resolved_mode: 3 as const,
      intent: "fixed" as const,
      computed_at: "2026-11-08T00:00:00.000Z"
    })
    const entered = { source_file_ref: "file", target_structure: { resolved_mode: 3 }, structure_preview: preview("written"), flow2_entry_at: "2026-11-08T00:00:00.000Z" }
    expect(sourceBasedFrom({ start_kind: "existing", template_intent: "fixed", mode: "fpt" }, entered)).toBe(true)
    expect(sourceBasedFrom({ start_kind: "existing", template_intent: "fixed", mode: "import", converted_from: "fpt" }, entered)).toBe(true)
    expect(sourceBasedFrom({ start_kind: "existing", template_intent: "fixed", mode: "import" }, { ...entered, structure_preview: preview("template"), flow2_entry_at: null })).toBe(false)
    expect(sourceBasedFrom({ start_kind: "existing", template_intent: "free", mode: "fpt" }, entered)).toBe(false)
  })
})

describe("pristineSectionIds - mục in giống hệt lúc import", () => {
  it("so heading + khối của từng mục; mục sửa / mục mới không nguyên vẹn; trạng thái duyệt không tính", () => {
    const imported = doc([
      { id: "fixed:1", number: "1", heading: "Product Overview", level: 1, blocks: [para("Portal for students.")] },
      { id: "fixed:5.1", number: "5.1", heading: "Business Rules", level: 2, blocks: [para("BR-01 Only University accounts.")] }
    ])
    const current = doc([
      { id: "fixed:1", number: "1", heading: "Product Overview", level: 1, status: "accepted", blocks: [para("Portal for students.")] },
      { id: "fixed:5.1", number: "5.1", heading: "Business Rules", level: 2, blocks: [para("BR-01 Registration closes at 23:59.")] },
      { id: "fixed:5.2", number: "5.2", heading: "Common Requirements", level: 2, blocks: [para("New")] }
    ])
    expect(pristineSectionIds(current, imported)).toEqual(new Set(["fixed:1"]))
  })
})
