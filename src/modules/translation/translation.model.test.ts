import { describe, it, expect } from "vitest"
import mongoose from "mongoose"
import { SpineTranslation } from "./spine-translation.model.js"
import { TranslationGlossary } from "./translation-glossary.model.js"
import { TranslationRunLock } from "./translation-run-lock.model.js"

const projectId = new mongoose.Types.ObjectId()

describe("SpineTranslation model", () => {
  it("text là chuỗi hoặc mảng chuỗi; origin author | machine; locale vi | en", () => {
    const check = (text: unknown, extra: Record<string, unknown> = {}) =>
      new SpineTranslation({ projectId, locale: "vi", sourceLocale: "en", sourceHash: "0123456789abcdef", text, origin: "machine", ...extra }).validateSync()
    expect(check("Đăng nhập")).toBeUndefined()
    expect(check(["Bước 1", "Bước 2"])).toBeUndefined()
    expect(check({ x: 1 })?.errors.text).toBeDefined()
    expect(check([1, 2])?.errors.text).toBeDefined()
    expect(check("x", { origin: "manual" })?.errors.origin).toBeDefined()
    expect(check("x", { locale: "fr" })?.errors.locale).toBeDefined()
    expect(new SpineTranslation({ projectId, locale: "vi", sourceLocale: "en", sourceHash: "h", text: "x", origin: "author" }).createdAt).toBeInstanceOf(Date)
  })

  it("unique (projectId, locale, sourceHash)", () => {
    expect(SpineTranslation.schema.indexes()).toContainEqual([{ projectId: 1, locale: 1, sourceHash: 1 }, expect.objectContaining({ unique: true })])
  })
})

describe("TranslationGlossary model", () => {
  it("origin seed | model; unique (projectId, locale, term)", () => {
    const doc = (origin: string) => new TranslationGlossary({ projectId, locale: "vi", term: " Order ", translation: "Đơn hàng", origin })
    expect(doc("seed").validateSync()).toBeUndefined()
    expect(doc("seed").term).toBe("Order")
    expect(doc("manual").validateSync()?.errors.origin).toBeDefined()
    expect(TranslationGlossary.schema.indexes()).toContainEqual([{ projectId: 1, locale: 1, term: 1 }, expect.objectContaining({ unique: true })])
  })
})

describe("TranslationRunLock model", () => {
  it("một khoá mỗi (projectId, locale); TTL theo lockedUntil; cần token + lockedUntil", () => {
    expect(TranslationRunLock.schema.indexes()).toContainEqual([{ projectId: 1, locale: 1 }, expect.objectContaining({ unique: true })])
    expect(TranslationRunLock.schema.indexes()).toContainEqual([{ lockedUntil: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })])
    const errors = new TranslationRunLock({ projectId, locale: "vi" }).validateSync()?.errors
    expect(errors?.token).toBeDefined()
    expect(errors?.lockedUntil).toBeDefined()
    expect(new TranslationRunLock({ projectId, locale: "vi", token: "t", lockedUntil: new Date() }).validateSync()).toBeUndefined()
  })
})
