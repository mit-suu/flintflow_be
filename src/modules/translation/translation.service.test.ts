import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  getSpine: vi.fn(),
  profile: vi.fn(async (): Promise<{ language?: string } | null> => null),
  getActionCost: vi.fn(async (_actionType: string) => 2),
  executeAiAction: vi.fn()
}))

vi.mock("./translation.repository.js", async () => (await import("./__tests__/translation-store.js")).fakeRepository)
vi.mock("../spine/spine.repository.js", () => ({ get: mocks.getSpine }))
vi.mock("../import/template-profile.model.js", () => ({ TemplateProfile: { findOne: () => ({ lean: mocks.profile }) } }))
vi.mock("../../shared/ai/credit-reservation.service.js", () => ({ getActionCost: mocks.getActionCost }))
vi.mock("../../shared/ai/ai-action.service.js", () => ({ executeAiAction: mocks.executeAiAction }))

import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { translationStatusResponseSchema } from "../pipeline/pipeline.dto.js"
import { fakeRepository, resetStore, store } from "./__tests__/translation-store.js"
import { hashSource, translationUnits } from "./translation-units.js"
import {
  assertTranslationComplete,
  BATCH_MAX_CHARS,
  BATCH_MAX_UNITS,
  projectLanguages,
  targetLocale,
  translationCompleteness,
  resolveTranslations,
  splitBatches,
  translationStatus,
  uniqueBatchItems,
  type BatchItem
} from "./translation.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)
const PROJECT = "64b000000000000000000001"

const seedTranslation = (value: string | string[], text: string | string[], origin: "author" | "machine" = "machine") =>
  store.translations.set(`${PROJECT}|vi|${hashSource(value)}`, { sourceHash: hashSource(value), text, origin, sourceLocale: "en" })

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  mocks.getSpine.mockResolvedValue(structuredClone(FIXTURE))
  mocks.profile.mockResolvedValue(null)
})

describe("resolveTranslations", () => {
  it("một truy vấn $in; hash trùng ⇒ dùng chung bản dịch; không có ⇒ thiếu", async () => {
    const units = translationUnits({ actors: FIXTURE.actors.slice(0, 2), use_cases: [{ ...FIXTURE.use_cases[0], name: FIXTURE.actors[0].name }] })
    seedTranslation(FIXTURE.actors[0].name, "Khách")

    const resolved = await resolveTranslations(PROJECT, "vi", units)

    expect(fakeRepository.findByHashes).toHaveBeenCalledTimes(1)
    // Tên actor và tên use case cùng chữ ⇒ cùng một bản dịch
    expect(resolved.map.get(`actors[id=${FIXTURE.actors[0].id}].name`)).toBe("Khách")
    expect(resolved.map.get(`use_cases[id=${FIXTURE.use_cases[0].id}].name`)).toBe("Khách")
    expect(resolved).toMatchObject({ total: units.length, translated: 2, missing: units.length - 2 })
    expect(resolved.missingUnits.map((u) => u.key)).not.toContain(`actors[id=${FIXTURE.actors[0].id}].name`)
  })

  it("chữ gốc đổi ⇒ hash đổi ⇒ thiếu (bản cũ vẫn còn cho baseline)", async () => {
    const actor = FIXTURE.actors[0]
    seedTranslation(actor.description, "Mô tả cũ")
    const before = await resolveTranslations(PROJECT, "vi", translationUnits({ actors: [actor] }))
    expect(before.map.get(`actors[id=${actor.id}].description`)).toBe("Mô tả cũ")

    const after = await resolveTranslations(PROJECT, "vi", translationUnits({ actors: [{ ...actor, description: "A changed description" }] }))
    expect(after.map.has(`actors[id=${actor.id}].description`)).toBe(false)
    expect(after.missingUnits.map((u) => u.key)).toContain(`actors[id=${actor.id}].description`)
    expect(store.translations.has(`${PROJECT}|vi|${hashSource(actor.description)}`)).toBe(true)
  })

  it("bản lưu lệch hình dạng (mảng khác độ dài) ⇒ coi là thiếu", async () => {
    const fn = FIXTURE.functions[0]
    seedTranslation(fn.normal, ["chỉ một bước"])
    const resolved = await resolveTranslations(PROJECT, "vi", translationUnits({ functions: [fn] }))
    expect(resolved.map.has(`functions[id=${fn.id}].normal`)).toBe(false)
  })

  it("ngôn ngữ khác không lẫn", async () => {
    seedTranslation(FIXTURE.actors[0].name, "Khách")
    const resolved = await resolveTranslations(PROJECT, "en", translationUnits({ actors: [FIXTURE.actors[0]] }))
    expect(resolved.translated).toBe(0)
  })
})

describe("splitBatches", () => {
  const item = (i: number, text: string | string[] = `Sentence ${i}`): BatchItem => ({ key: `k${i}`, sourceHash: `h${i}`, text })

  it("tối đa 40 đơn vị một lô", () => {
    const batches = splitBatches(Array.from({ length: 95 }, (_, i) => item(i)))
    expect(batches.map((b) => b.length)).toEqual([BATCH_MAX_UNITS, BATCH_MAX_UNITS, 15])
  })

  it("tối đa ~6k ký tự một lô; đơn vị quá dài đứng riêng", () => {
    const long = "x".repeat(2500)
    const batches = splitBatches([item(1, long), item(2, long), item(3, long), item(4, "y".repeat(BATCH_MAX_CHARS + 10)), item(5)])
    expect(batches.map((b) => b.map((i) => i.key))).toEqual([["k1", "k2"], ["k3"], ["k4"], ["k5"]])
  })

  it("uniqueBatchItems gộp chữ trùng: dịch một lần", () => {
    const units = translationUnits({ actors: [FIXTURE.actors[0]], use_cases: [{ ...FIXTURE.use_cases[0], name: FIXTURE.actors[0].name }] })
    const items = uniqueBatchItems(units)
    expect(items.length).toBe(units.length - 1)
    expect(new Set(items.map((i) => i.sourceHash)).size).toBe(items.length)
  })
})

describe("projectLanguages", () => {
  it("mode 2: documentLanguage ⇒ locale, gốc luôn en, không đọc TemplateProfile", async () => {
    await expect(projectLanguages(PROJECT, { mode: "fpt", documentLanguage: "vi" })).resolves.toEqual({ locale: "vi", source: "en" })
    await expect(projectLanguages(PROJECT, { mode: "fpt" })).resolves.toEqual({ locale: "en", source: "en" })
    expect(mocks.profile).not.toHaveBeenCalled()
  })

  it("mode 1: cả hai theo ngôn ngữ file ⇒ không có gì để dịch", async () => {
    mocks.profile.mockResolvedValue({ language: "vi" })
    await expect(projectLanguages(PROJECT, { mode: "import" })).resolves.toEqual({ locale: "vi", source: "vi" })
  })
})

describe("translationStatus — GET /translations/status", () => {
  it("dự án vi: đếm đơn vị, phần thiếu, số lô và credit ước tính; không gọi model", async () => {
    const units = translationUnits(FIXTURE)
    seedTranslation(FIXTURE.actors[0].name, "Khách")

    const status = await translationStatus(PROJECT, { mode: "fpt", documentLanguage: "vi" })

    expect(translationStatusResponseSchema.parse(status)).toEqual(status)
    const shared = units.filter((u) => hashSource(u.value) === hashSource(FIXTURE.actors[0].name)).length
    expect(status).toMatchObject({ locale: "vi", source_locale: "en", total: units.length, missing: units.length - shared })
    const expectedBatches = splitBatches(uniqueBatchItems(units.filter((u) => hashSource(u.value) !== hashSource(FIXTURE.actors[0].name)))).length
    expect(status.batches).toBe(expectedBatches)
    expect(status.batches).toBeGreaterThan(1)
    expect(status.estimated_credits).toBe(expectedBatches * 2)
    expect(mocks.getActionCost).toHaveBeenCalledWith("translate_document")
    expect(mocks.executeAiAction).not.toHaveBeenCalled()
  })

  it("dự án en (ngôn ngữ = gốc) ⇒ total 0, không đọc Spine", async () => {
    const status = await translationStatus(PROJECT, { mode: "fpt", documentLanguage: "en" })
    expect(status).toEqual({ locale: "en", source_locale: "en", total: 0, missing: 0, batches: 0, estimated_credits: 0 })
    expect(mocks.getSpine).not.toHaveBeenCalled()
    expect(mocks.executeAiAction).not.toHaveBeenCalled()
  })

  it("đã dịch hết ⇒ missing 0, 0 lô, 0 credit", async () => {
    for (const u of translationUnits(FIXTURE)) seedTranslation(u.value, Array.isArray(u.value) ? u.value.map((s) => `[vi] ${s}`) : `[vi] ${u.value}`)
    const status = await translationStatus(PROJECT, { mode: "fpt", documentLanguage: "vi" })
    expect(status).toMatchObject({ missing: 0, batches: 0, estimated_credits: 0 })
    expect(status.total).toBeGreaterThan(0)
  })

  it("chưa có Spine ⇒ total 0", async () => {
    mocks.getSpine.mockResolvedValue(null)
    await expect(translationStatus(PROJECT, { mode: "fpt", documentLanguage: "vi" })).resolves.toMatchObject({ locale: "vi", total: 0 })
  })

  it("FLF-334 B: ?locale= đếm theo ngôn ngữ yêu cầu; locale = gốc ⇒ total 0", async () => {
    const units = translationUnits(FIXTURE)
    const asked = await translationStatus(PROJECT, { mode: "fpt", documentLanguage: "en" }, { locale: "vi" })
    expect(asked).toMatchObject({ locale: "vi", source_locale: "en", total: units.length, missing: units.length })
    const source = await translationStatus(PROJECT, { mode: "fpt", documentLanguage: "vi" }, { locale: "en" })
    expect(source).toEqual({ locale: "en", source_locale: "en", total: 0, missing: 0, batches: 0, estimated_credits: 0 })
  })
})

describe("FLF-334 B — tải theo ngôn ngữ khác", () => {
  it("targetLocale: yêu cầu ⇒ theo yêu cầu; mode 1 import thật hỏi ngôn ngữ khác ⇒ 409; dự án chuyển đổi ⇒ theo yêu cầu", () => {
    const languages = { locale: "en" as const, source: "en" as const }
    expect(targetLocale({ mode: "fpt" }, languages, "vi")).toBe("vi")
    expect(targetLocale({ mode: "fpt" }, languages)).toBe("en")
    expect(() => targetLocale({ mode: "import" }, languages, "vi")).toThrow(expect.objectContaining({ statusCode: 409, code: "DOCUMENT_LANGUAGE_UNAVAILABLE" }))
    expect(targetLocale({ mode: "import" }, languages, "en")).toBe("en")
    expect(targetLocale({ mode: "import" }, languages)).toBe("en")
    expect(targetLocale({ mode: "import", converted_from: "fpt" }, languages, "vi")).toBe("vi")
  })

  it("translationStatus đếm trên Spine của đích (loadSpine), không trên Spine hiện tại", async () => {
    const snapshot = { actors: FIXTURE.actors.slice(0, 1) } as unknown as Spine
    mocks.getSpine.mockClear()
    const loadSpine = vi.fn(async () => snapshot)
    const res = await translationStatus(PROJECT, { mode: "fpt", documentLanguage: "vi" }, { locale: "vi", loadSpine })
    expect(res).toMatchObject({ locale: "vi", total: translationUnits(snapshot).length, missing: translationUnits(snapshot).length })
    expect(loadSpine).toHaveBeenCalledTimes(1)
    expect(mocks.getSpine).not.toHaveBeenCalled()
    // ngôn ngữ đích = gốc ⇒ không đọc Spine nào
    loadSpine.mockClear()
    await translationStatus(PROJECT, { mode: "fpt", documentLanguage: "vi" }, { locale: "en", loadSpine })
    expect(loadSpine).not.toHaveBeenCalled()
  })

  it("đủ bản dịch ⇒ qua; thiếu ⇒ 409 TRANSLATION_INCOMPLETE { locale, missing, total }", async () => {
    const spine = { actors: FIXTURE.actors.slice(0, 2) } as unknown as Spine
    const total = translationUnits(spine).length
    seedTranslation(FIXTURE.actors[0].name, "Khách")
    await expect(translationCompleteness(PROJECT, "vi", spine)).resolves.toEqual({ locale: "vi", missing: total - 1, total })
    await expect(assertTranslationComplete(PROJECT, "vi", spine)).rejects.toMatchObject({
      statusCode: 409,
      code: "TRANSLATION_INCOMPLETE",
      meta: { locale: "vi", missing: total - 1, total }
    })
    for (const u of translationUnits(spine)) seedTranslation(u.value, Array.isArray(u.value) ? u.value.map((x) => `[vi] ${x}`) : `[vi] ${u.value}`)
    await expect(assertTranslationComplete(PROJECT, "vi", spine)).resolves.toBeUndefined()
    expect(mocks.executeAiAction).not.toHaveBeenCalled()
  })
})
