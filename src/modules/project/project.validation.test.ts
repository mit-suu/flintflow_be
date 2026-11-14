import { describe, it, expect, vi } from "vitest"
import type { Request, Response } from "express"
import { CreateProjectSchema, UpdateDocumentLanguageSchema, UpdateErdNotationSchema, UpdateScreenThemeSchema, UpdateSequenceLevelSchema, parseKnowledgeFlag, projectModeSchema, validateRequest } from "./project.validation.js"
import { Project, PROJECT_MODES } from "./project.model.js"
import { erdNotationChosen, erdNotationOf } from "../../shared/diagram/erd-notation.js"
import { sequenceLevelChosen, sequenceLevelOf } from "../../shared/diagram/sequence-level.js"

describe("documentLanguage (FLF-265)", () => {
  it("tạo dự án: tuỳ chọn, chỉ nhận vi | en", () => {
    expect(CreateProjectSchema.parse({ name: "Lumen" }).documentLanguage).toBeUndefined()
    expect(CreateProjectSchema.parse({ name: "Lumen", documentLanguage: "vi" }).documentLanguage).toBe("vi")
    expect(CreateProjectSchema.parse({ name: "Lumen", documentLanguage: "en" }).documentLanguage).toBe("en")
    expect(CreateProjectSchema.safeParse({ name: "Lumen", documentLanguage: "fr" }).success).toBe(false)
  })

  it("đổi ngôn ngữ: bắt buộc, không nhận key lạ", () => {
    expect(UpdateDocumentLanguageSchema.safeParse({ documentLanguage: "en" }).success).toBe(true)
    expect(UpdateDocumentLanguageSchema.safeParse({}).success).toBe(false)
    expect(UpdateDocumentLanguageSchema.safeParse({ documentLanguage: "fr" }).success).toBe(false)
    expect(UpdateDocumentLanguageSchema.safeParse({ documentLanguage: "vi", name: "x" }).success).toBe(false)
  })
})

describe("Project.mode (FLF-171)", () => {
  it("không gửi mode ⇒ fpt (hành vi cũ của mode 2)", () => {
    expect(projectModeSchema.parse(undefined)).toBe("fpt")
    expect(CreateProjectSchema.parse({ name: "Lumen" }).mode).toBe("fpt")
  })

  it.each(PROJECT_MODES)("nhận mode %s", (mode) => {
    expect(CreateProjectSchema.parse({ name: "Lumen", mode }).mode).toBe(mode)
  })

  it("từ chối mode lạ", () => {
    expect(projectModeSchema.safeParse("coaching").success).toBe(false)
  })

  it("FLF-335: nhận source new / existing kèm has_required_template; source lạ ⇒ từ chối", () => {
    expect(CreateProjectSchema.parse({ name: "Lumen", source: "new", has_required_template: true })).toMatchObject({ source: "new", has_required_template: true, mode: "fpt" })
    expect(CreateProjectSchema.parse({ name: "Lumen", source: "existing" })).toMatchObject({ source: "existing" })
    expect(CreateProjectSchema.safeParse({ name: "Lumen", source: "later" }).success).toBe(false)
    expect(CreateProjectSchema.safeParse({ name: "Lumen", source: "new", has_required_template: "yes" }).success).toBe(false)
  })

  it("hộp Tạo dự án: nhận has_srs_file + complete_to_standard (boolean)", () => {
    expect(CreateProjectSchema.parse({ name: "Lumen", has_srs_file: true, complete_to_standard: true })).toMatchObject({ has_srs_file: true, complete_to_standard: true })
    expect(CreateProjectSchema.safeParse({ name: "Lumen", has_srs_file: "yes" }).success).toBe(false)
  })

  it("model: project cũ không có mode đọc ra fpt, import_state null; import_state phải thuộc máy trạng thái import", () => {
    const legacy = new Project({ userId: "66f000000000000000000001", name: "Old" })
    expect(legacy.validateSync()).toBeUndefined()
    expect(legacy.mode).toBe("fpt")
    expect(legacy.import_state).toBeNull()

    const imported = new Project({ userId: "66f000000000000000000001", name: "New", mode: "import", import_state: "mapping_review" })
    expect(imported.validateSync()).toBeUndefined()
    expect(new Project({ userId: "66f000000000000000000001", name: "X", import_state: "done" }).validateSync()?.errors.import_state).toBeDefined()
    expect(new Project({ userId: "66f000000000000000000001", name: "X", mode: "coaching" }).validateSync()?.errors.mode).toBeDefined()
  })
})

const run = (body: unknown) => {
  const req = { body } as Request
  const next = vi.fn()
  validateRequest(CreateProjectSchema)(req, {} as Response, next)
  return { req, next }
}

describe("CreateProjectSchema qua validateRequest", () => {
  it("trim tên, không gửi mode ⇒ fpt, giữ folderId", () => {
    const { req, next } = run({ name: "  Lumen  ", folderId: "f1" })

    expect(next).toHaveBeenCalledOnce()
    expect(req.body).toEqual({ name: "Lumen", mode: "fpt", folderId: "f1" })
  })

  it.each([
    ["mode lạ", { name: "Lumen", mode: "coaching" }],
    ["tên chỉ có khoảng trắng", { name: "   " }],
    ["tên quá 100 ký tự", { name: "x".repeat(101) }]
  ])("%s ⇒ 400 VALIDATION_ERROR", (_label, body) => {
    expect(() => run(body)).toThrow(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }))
  })
})

describe("cờ knowledge của tin chat (FLF-267)", () => {
  it("thiếu ⇒ false; boolean thật giữ nguyên; field khác của body không bị kiểm", () => {
    expect(parseKnowledgeFlag({ content: "x", step: "chat" })).toBe(false)
    expect(parseKnowledgeFlag(undefined)).toBe(false)
    expect(parseKnowledgeFlag({ knowledge: true })).toBe(true)
    expect(parseKnowledgeFlag({ knowledge: false, discoveryStep: "2" })).toBe(false)
  })

  it.each([["chuỗi", "true"], ["số", 1], ["null", null]])("%s ⇒ 400 VALIDATION_ERROR", (_label, value) => {
    expect(() => parseKnowledgeFlag({ knowledge: value })).toThrow(expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }))
  })
})

describe("erdNotation", () => {
  it("đổi ký pháp: bắt buộc, chỉ nhận chen | crowsfoot | idef1x, không nhận key lạ", () => {
    for (const erdNotation of ["chen", "crowsfoot", "idef1x"]) expect(UpdateErdNotationSchema.safeParse({ erdNotation }).success).toBe(true)
    expect(UpdateErdNotationSchema.safeParse({}).success).toBe(false)
    expect(UpdateErdNotationSchema.safeParse({ erdNotation: "uml" }).success).toBe(false)
    expect(UpdateErdNotationSchema.safeParse({ erdNotation: "Chen" }).success).toBe(false)
    expect(UpdateErdNotationSchema.safeParse({ erdNotation: "chen", name: "x" }).success).toBe(false)
  })

  it("schema Project: không default (FLF-418: thiếu = chưa chọn, vẽ vẫn là chen), từ chối giá trị lạ", () => {
    expect(new Project({ name: "x" }).erdNotation).toBeUndefined()
    expect(erdNotationOf(new Project({ name: "x" }))).toBe("chen")
    expect(erdNotationChosen(new Project({ name: "x" }))).toBe(false)
    expect(erdNotationChosen(new Project({ name: "x", erdNotation: "chen" }))).toBe(true)
    expect(new Project({ name: "x", erdNotation: "idef1x" }).erdNotation).toBe("idef1x")
    expect(new Project({ name: "x", erdNotation: "uml" }).validateSync()?.errors.erdNotation).toBeDefined()
  })
})

describe("sequenceLevel (FLF-418)", () => {
  it("đổi mức: bắt buộc, chỉ nhận system | component, không nhận key lạ", () => {
    for (const sequenceLevel of ["system", "component"]) expect(UpdateSequenceLevelSchema.safeParse({ sequenceLevel }).success).toBe(true)
    expect(UpdateSequenceLevelSchema.safeParse({}).success).toBe(false)
    expect(UpdateSequenceLevelSchema.safeParse({ sequenceLevel: "design" }).success).toBe(false)
    expect(UpdateSequenceLevelSchema.safeParse({ sequenceLevel: "system", name: "x" }).success).toBe(false)
  })

  it("schema Project: không default (thiếu = chưa chọn, vẽ là system), từ chối giá trị lạ", () => {
    expect(new Project({ name: "x" }).sequenceLevel).toBeUndefined()
    expect(sequenceLevelOf(new Project({ name: "x" }))).toBe("system")
    expect(sequenceLevelChosen(new Project({ name: "x" }))).toBe(false)
    expect(new Project({ name: "x", sequenceLevel: "component" }).sequenceLevel).toBe("component")
    expect(sequenceLevelChosen(new Project({ name: "x", sequenceLevel: "component" }))).toBe(true)
    expect(new Project({ name: "x", sequenceLevel: "uml" }).validateSync()?.errors.sequenceLevel).toBeDefined()
  })
})

describe("UpdateScreenThemeSchema (FLF-410)", () => {
  it("nhận từng field, chuẩn hoá màu + domain; null = về mặc định", () => {
    expect(UpdateScreenThemeSchema.parse({ primaryColor: "#e4572e" })).toEqual({ primaryColor: "#E4572E" })
    expect(UpdateScreenThemeSchema.parse({ domain: "https://Shop.Example.com/cart" })).toEqual({ domain: "shop.example.com" })
    expect(UpdateScreenThemeSchema.parse({ domain: "" })).toEqual({ domain: null })
    expect(UpdateScreenThemeSchema.parse({ primaryColor: null, domain: null, platforms: null })).toEqual({ primaryColor: null, domain: null, platforms: null })
    expect(UpdateScreenThemeSchema.parse({ platforms: ["web", "mobile"] })).toEqual({ platforms: ["web", "mobile"] })
  })

  it("sai ⇒ không qua", () => {
    for (const body of [{}, { primaryColor: "red" }, { primaryColor: "#FFF" }, { domain: "not a host" }, { platforms: [] }, { platforms: ["web", "web"] }, { platforms: ["tv"] }, { primaryColor: "#FFFFFF", extra: 1 }])
      expect(UpdateScreenThemeSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
  })
})
