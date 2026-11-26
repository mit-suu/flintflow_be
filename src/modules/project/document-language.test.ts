import { describe, it, expect } from "vitest"
import { documentLanguageOf, hasBaseFile, sourceLanguageOf } from "./document-language.js"

describe("documentLanguageOf (FLF-265, D1)", () => {
  it("field đã lưu ⇒ dùng field, kể cả mode 1", () => {
    expect(documentLanguageOf({ mode: "fpt", documentLanguage: "vi" })).toBe("vi")
    expect(documentLanguageOf({ mode: "import", documentLanguage: "en" }, "vi")).toBe("en")
  })

  it("mode 1 thiếu field ⇒ ngôn ngữ file upload", () => {
    expect(documentLanguageOf({ mode: "import" }, "vi")).toBe("vi")
    expect(documentLanguageOf({ mode: "import", documentLanguage: null }, "en")).toBe("en")
  })

  it("mode 1 profile lạ / thiếu ⇒ en", () => {
    expect(documentLanguageOf({ mode: "import" }, "fr")).toBe("en")
    expect(documentLanguageOf({ mode: "import" })).toBe("en")
  })

  it("mode 2 thiếu field (dự án cũ) ⇒ en, bỏ qua profile", () => {
    expect(documentLanguageOf({ mode: "fpt" }, "vi")).toBe("en")
    // Dự án rất cũ không có cả `mode` ⇒ coi như fpt
    expect(documentLanguageOf({})).toBe("en")
  })

  it("giá trị lạ trong DB ⇒ không tin, rơi về mặc định", () => {
    expect(documentLanguageOf({ mode: "fpt", documentLanguage: "fr" as never })).toBe("en")
  })
})

describe("sourceLanguageOf (D4)", () => {
  it("mode 2 luôn en, kể cả khi dự án chọn vi", () => {
    expect(sourceLanguageOf({ mode: "fpt", documentLanguage: "vi" }, "vi")).toBe("en")
    expect(sourceLanguageOf({})).toBe("en")
  })

  it("mode 1 = ngôn ngữ file; lạ / thiếu ⇒ en", () => {
    expect(sourceLanguageOf({ mode: "import" }, "vi")).toBe("vi")
    expect(sourceLanguageOf({ mode: "import", documentLanguage: "en" }, "vi")).toBe("vi")
    expect(sourceLanguageOf({ mode: "import" }, "fr")).toBe("en")
    expect(sourceLanguageOf({ mode: "import" })).toBe("en")
  })

  it("FLF-318: dự án tạo SRS đã chuyển sang mode 1 giữ chữ gốc en; ngôn ngữ tài liệu vẫn theo dự án", () => {
    const converted = { mode: "import" as const, converted_from: "fpt" as const, documentLanguage: "vi" as const }
    expect(sourceLanguageOf(converted, "vi")).toBe("en")
    expect(documentLanguageOf(converted, "vi")).toBe("vi")
  })
})

describe("hasBaseFile + source_language (FLF-466, BF §3.7 bảng 4 loại dự án)", () => {
  const cases: [string, Parameters<typeof hasBaseFile>, boolean][] = [
    ["chế độ 1 / 3 / 4 (upload thật hoặc tạo từ mẫu org: mode import)", [{ mode: "import", converted_from: null }], true],
    ["chế độ 2 chưa áp mẫu nào (kể cả đã chuyển, converted_from = fpt)", [{ mode: "import", converted_from: "fpt" }, null], false],
    ["chế độ 2 chưa chuyển", [{ mode: "fpt", converted_from: null }, null], false],
    ["chế độ 2 đã chuyển + đã áp một lần đổi mẫu không phải chỉ đổi ngôn ngữ (migrated_base_at)", [{ mode: "import", converted_from: "fpt" }, { migrated_base_at: new Date() }], true],
    ["chế độ 2 đã áp mẫu nhưng chỉ đổi ngôn ngữ (migrated_base_at = null)", [{ mode: "import", converted_from: "fpt" }, { migrated_base_at: null }], false]
  ]
  it.each(cases)("%s ⇒ %s", (_name, args, expected) => {
    expect(hasBaseFile(...args)).toBe(expected)
  })

  it("source_language đã ghi thắng luật cũ; thiếu ⇒ suy như trước", () => {
    // Dự án chế độ 2 dịch đè sang vi: chữ Spine nay là vi dù converted_from = fpt
    expect(sourceLanguageOf({ mode: "import", converted_from: "fpt", source_language: "vi" })).toBe("vi")
    expect(sourceLanguageOf({ mode: "import", converted_from: "fpt" })).toBe("en")
    // Dự án import dịch đè từ vi sang en: không còn đọc ngôn ngữ file cũ
    expect(sourceLanguageOf({ mode: "import", converted_from: null, source_language: "en" }, "vi")).toBe("en")
    expect(sourceLanguageOf({ mode: "import", converted_from: null }, "vi")).toBe("vi")
    expect(sourceLanguageOf({ mode: "fpt", source_language: "fr" })).toBe("en")
  })
})
