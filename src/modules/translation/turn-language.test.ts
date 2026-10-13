import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import mongoose from "mongoose"

const models = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  profileLanguage: null as string | null,
  projectFail: false,
  spineGlossary: null as { term: string; term_native?: string }[] | null,
  spineFail: false
}))

vi.mock("../project/project.model.js", () => ({
  Project: {
    findById: vi.fn(() => ({
      lean: async () => {
        if (models.projectFail) throw new Error("mongo down")
        return models.project
      }
    }))
  }
}))
vi.mock("../spine/spine.model.js", () => ({
  Spine: {
    findOne: vi.fn(() => ({
      lean: async () => {
        if (models.spineFail) throw new Error("spine read failed")
        return models.spineGlossary ? { glossary: models.spineGlossary } : null
      }
    }))
  }
}))
vi.mock("../import/template-profile.model.js", () => ({
  TemplateProfile: { findOne: vi.fn(() => ({ lean: async () => (models.profileLanguage ? { language: models.profileLanguage } : null) })) }
}))
vi.mock("./translation.repository.js", async () => (await import("./__tests__/translation-store.js")).fakeRepository)

import { documentLanguageForTurn, documentLanguageInput } from "./turn-language.js"
import { Project } from "../project/project.model.js"
import { fakeRepository, resetStore } from "./__tests__/translation-store.js"

const P = "64b000000000000000000001"

const connected = (state: number) => vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(state as never)

beforeEach(() => {
  resetStore()
  models.project = { mode: "fpt", documentLanguage: "vi" }
  models.profileLanguage = null
  models.projectFail = false
  models.spineGlossary = null
  models.spineFail = false
  vi.mocked(Project.findById).mockClear()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("documentLanguageForTurn (FLF-265 D16)", () => {
  it("mode 2, documentLanguage vi ⇒ { vi, en, glossary của dự án }", async () => {
    connected(1)
    await fakeRepository.upsertGlossary(P, "vi", [{ term: "Student", translation: "Sinh viên" }], "seed")
    expect(await documentLanguageForTurn(P)).toEqual({ locale: "vi", source: "en", glossary: [{ term: "Student", translation: "Sinh viên" }] })
  })

  it("dự án vi chưa từng /run: term_native của Spine vào glossary (seed thắng bản đã lưu cùng term), gộp tên đã học", async () => {
    connected(1)
    models.spineGlossary = [
      { term: "Appointment", term_native: "Lịch hẹn" },
      { term: "Student", term_native: "Học viên" },
      { term: "Clinic" },
      { term: "Visit", term_native: "Visit" }
    ]
    await fakeRepository.upsertGlossary(P, "vi", [{ term: "Student", translation: "Sinh viên" }, { term: "Nurse", translation: "Y tá" }], "model")
    const turn = await documentLanguageForTurn(P)
    expect(turn?.glossary).toEqual([
      { term: "Appointment", translation: "Lịch hẹn" },
      { term: "Student", translation: "Học viên" },
      { term: "Nurse", translation: "Y tá" }
    ])
  })

  it("đọc glossary Spine lỗi ⇒ vẫn dùng glossary đã lưu, không ném", async () => {
    connected(1)
    models.spineFail = true
    await fakeRepository.upsertGlossary(P, "vi", [{ term: "Nurse", translation: "Y tá" }], "model")
    expect((await documentLanguageForTurn(P))?.glossary).toEqual([{ term: "Nurse", translation: "Y tá" }])
    expect(console.warn).toHaveBeenCalled()
  })

  it("dự án en / dự án cũ không field / mode 1 (ngôn ngữ file) ⇒ null, không đọc glossary", async () => {
    connected(1)
    models.project = { mode: "fpt", documentLanguage: "en" }
    expect(await documentLanguageForTurn(P)).toBeNull()
    models.project = { mode: "fpt" }
    expect(await documentLanguageForTurn(P)).toBeNull()
    models.project = { mode: "import" }
    models.profileLanguage = "vi"
    expect(await documentLanguageForTurn(P)).toBeNull()
    expect(fakeRepository.loadGlossary).not.toHaveBeenCalled()
  })

  it("chưa nối DB (unit test) / id sai / không thấy dự án / đọc lỗi ⇒ null, không ném", async () => {
    connected(0)
    expect(await documentLanguageForTurn(P)).toBeNull()
    expect(Project.findById).not.toHaveBeenCalled()

    connected(1)
    expect(await documentLanguageForTurn("not-an-id")).toBeNull()
    models.project = null
    expect(await documentLanguageForTurn(P)).toBeNull()
    models.project = { mode: "fpt", documentLanguage: "vi" }
    models.projectFail = true
    expect(await documentLanguageForTurn(P)).toBeNull()
    expect(console.warn).toHaveBeenCalled()
  })
})

describe("documentLanguageInput", () => {
  it("có ngôn ngữ ⇒ ba field của AiActionInput; null / thiếu ⇒ {} (input y như cũ)", () => {
    const glossary = [{ term: "Student", translation: "Sinh viên" }]
    expect(documentLanguageInput({ locale: "vi", source: "en", glossary })).toEqual({ documentLanguage: "vi", sourceLanguage: "en", documentGlossary: glossary })
    expect(documentLanguageInput(null)).toEqual({})
    expect(documentLanguageInput(undefined)).toEqual({})
  })
})
