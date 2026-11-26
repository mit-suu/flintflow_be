import { describe, expect, it } from "vitest"
import { hasBaseFile, sourceLanguageOf } from "./document-language.js"

describe("hasBaseFile & sourceLanguageOf (FLF-466 ma trận 4 loại dự án)", () => {
  it("1. Mode 2 thuần (không template_ref, không import) ⇒ không file nền, sourceLanguage = en", () => {
    const project = { mode: "fpt", documentLanguage: "vi", source_language: null, converted_from: null, template_ref: null } as const
    expect(hasBaseFile(project, null)).toBe(false)
    expect(sourceLanguageOf(project, null, null)).toBe("en")
  })

  it("2. Mode 2 tạo từ mẫu org (có template_ref) ⇒ có file nền; đã từng đổi mẫu (migrated_base_at) ⇒ có file nền", () => {
    const fromOrg = { mode: "fpt", documentLanguage: "vi", source_language: null, converted_from: null, template_ref: { template_id: "t1", version: 1 } } as const
    expect(hasBaseFile(fromOrg, null)).toBe(true)

    const migrated = { mode: "fpt", documentLanguage: "en", source_language: "vi", converted_from: null, template_ref: null } as const
    expect(hasBaseFile(migrated, { source_file_ref: null, migrated_base_at: new Date() })).toBe(true)
    expect(sourceLanguageOf(migrated, "en", { flow2_entry_at: null })).toBe("vi")
  })

  it("3. Chuyển từ FPT (converted_from='fpt') chưa từng đổi sang mẫu file nền ⇒ không file nền, nguồn luôn en", () => {
    const converted = { mode: "import", documentLanguage: "vi", source_language: null, converted_from: "fpt", template_ref: null } as const
    expect(hasBaseFile(converted, { source_file_ref: null, migrated_base_at: null })).toBe(false)
    expect(sourceLanguageOf(converted, "vi", { flow2_entry_at: null })).toBe("en")
  })

  it("4. Mode 1 / 3 / 4 import thật ⇒ có file nền; chưa đổi mẫu dùng profileLanguage hoặc source_language", () => {
    const imported = { mode: "import", documentLanguage: "vi", source_language: null, converted_from: null, template_ref: null } as const
    expect(hasBaseFile(imported, { source_file_ref: "grid-1", migrated_base_at: null })).toBe(true)
    expect(sourceLanguageOf(imported, "vi", { flow2_entry_at: null })).toBe("vi")
    // Mode 3/4 (flow2_entry_at) sau khi chuyển sang mode fpt: dùng sourceLanguage/profileLanguage
    const flow2 = { mode: "fpt", documentLanguage: "vi", source_language: null, converted_from: null, template_ref: null } as const
    expect(sourceLanguageOf(flow2, "vi", { flow2_entry_at: new Date() })).toBe("vi")
  })
})
