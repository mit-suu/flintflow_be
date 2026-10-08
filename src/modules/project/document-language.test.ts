import { describe, it, expect } from "vitest"
import { documentLanguageOf, sourceLanguageOf } from "./document-language.js"

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
})
