import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSpine: vi.fn(),
  loadBaselineSpine: vi.fn(),
  requireDocVersion: vi.fn()
}))
vi.mock("../spine/spine.repository.js", () => ({ get: mocks.getSpine }))
vi.mock("../render/assemble.service.js", () => ({ loadBaselineSpine: mocks.loadBaselineSpine }))
vi.mock("../doc-version/doc-version.service.js", () => ({ requireDocVersion: mocks.requireDocVersion }))

import { targetSpineLoader } from "./translation-target.js"

const PROJECT = "650000000000000000000001"
const current = { actors: [{ id: "A01" }] }
const snapshot = { actors: [{ id: "A02" }] }

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.getSpine.mockResolvedValue(current)
  mocks.loadBaselineSpine.mockResolvedValue(snapshot)
})

describe("targetSpineLoader — FLF-334 B đích snapshot của #26 / #27", () => {
  it("không đích ⇒ Spine hiện tại", async () => {
    await expect(targetSpineLoader(PROJECT, {})()).resolves.toBe(current)
    expect(mocks.loadBaselineSpine).not.toHaveBeenCalled()
  })

  it("baseline_id ⇒ snapshot baseline đó (cùng giá trị #18 nhận)", async () => {
    await expect(targetSpineLoader(PROJECT, { baseline_id: "BL001" })()).resolves.toBe(snapshot)
    expect(mocks.loadBaselineSpine).toHaveBeenCalledWith(PROJECT, "BL001")
    expect(mocks.getSpine).not.toHaveBeenCalled()
  })

  it("version có baseline_ref ⇒ snapshot của version; không có (bản nháp CR) ⇒ 409 DOCUMENT_LANGUAGE_UNAVAILABLE", async () => {
    mocks.requireDocVersion.mockResolvedValueOnce({ version: "1.0", baseline_ref: "650000000000000000000077" })
    await expect(targetSpineLoader(PROJECT, { version: "1.0" })()).resolves.toBe(snapshot)
    expect(mocks.loadBaselineSpine).toHaveBeenCalledWith(PROJECT, "650000000000000000000077")

    mocks.requireDocVersion.mockResolvedValueOnce({ version: "1.1", baseline_ref: null })
    await expect(targetSpineLoader(PROJECT, { version: "1.1" })()).rejects.toMatchObject({ statusCode: 409, code: "DOCUMENT_LANGUAGE_UNAVAILABLE" })
  })

  it("loader lười: tạo loader không đọc gì", () => {
    targetSpineLoader(PROJECT, { version: "1.0" })
    expect(mocks.requireDocVersion).not.toHaveBeenCalled()
    expect(mocks.getSpine).not.toHaveBeenCalled()
  })
})
