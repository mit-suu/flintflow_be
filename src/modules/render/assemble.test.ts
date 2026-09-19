import { describe, expect, it, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import type { Spine, SpineRecord } from "../spine/spine.types.js"
import { spineSchema } from "../spine/spine.schema.js"
import { makePng } from "./zip.test-helper.js"

type Doc = Record<string, unknown>

const cacheDb = vi.hoisted(() => {
  type D = Record<string, unknown>
  const docs: D[] = []
  let nextId = 1
  const matches = (doc: D, filter: D): boolean =>
    Object.entries(filter).every(([k, v]) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        if ("$exists" in v) return (k in doc) === (v as { $exists: boolean }).$exists
        if ("$in" in v) return (v as { $in: unknown[] }).$in.includes(doc[k])
      }
      return doc[k] === v
    })
  const findOne = vi.fn(async (filter: D, _p: unknown, options: { sort?: Record<string, number> } = {}) => {
    const rows = docs.filter((d) => matches(d, filter))
    if (options.sort) {
      const [[key, dir]] = Object.entries(options.sort)
      return [...rows].sort((a, b) => (Number(b[key]) - Number(a[key])) * (dir === -1 ? 1 : -1))[0] ?? null
    }
    return rows[0] ?? null
  })
  const findOneAndUpdate = vi.fn(async (filter: D, update: { $set: D }) => {
    const existing = docs.find((d) => matches(d, filter))
    if (existing) {
      Object.assign(existing, update.$set)
      return existing
    }
    const created = { _id: `cache-${nextId++}`, ...filter, ...update.$set }
    docs.push(created)
    return created
  })
  const find = vi.fn(async (filter: D, _proj: unknown, options: { sort?: Record<string, number>; skip?: number } = {}) => {
    let rows = docs.filter((d) => matches(d, filter))
    if (options.sort) {
      const [[key, dir]] = Object.entries(options.sort)
      rows = [...rows].sort((a, b) => (Number(a[key]) - Number(b[key])) * dir)
    }
    if (options.skip) rows = rows.slice(options.skip)
    return rows
  })
  const deleteMany = vi.fn(async (filter: D) => {
    const before = docs.length
    for (const d of docs.filter((d) => matches(d, filter))) {
      const idx = docs.indexOf(d)
      if (idx >= 0) docs.splice(idx, 1)
    }
    return { deletedCount: before - docs.length }
  })
  const updateOne = vi.fn(async (filter: D, update: { $set: D }) => {
    const existing = docs.find((d) => matches(d, filter))
    if (existing) Object.assign(existing, update.$set)
    return { matchedCount: existing ? 1 : 0 }
  })
  const reset = () => {
    docs.length = 0
    nextId = 1
    findOne.mockClear()
    findOneAndUpdate.mockClear()
    find.mockClear()
    deleteMany.mockClear()
    updateOne.mockClear()
  }
  return { docs, findOne, findOneAndUpdate, find, deleteMany, updateOne, reset }
})

const baselineDb = vi.hoisted(() => {
  const findOne = vi.fn()
  return { findOne, reset: () => findOne.mockReset() }
})

const changeDb = vi.hoisted(() => {
  type D = Record<string, unknown>
  let rows: D[] = []
  const find = vi.fn(async (filter: D, _proj: unknown, options: { sort?: Record<string, number> } = {}) => {
    let out = rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v))
    if (options.sort?.seq === 1) out = [...out].sort((a, b) => Number(a.seq) - Number(b.seq))
    return out
  })
  const setRows = (r: D[]) => {
    rows = r
  }
  const reset = () => {
    rows = []
    find.mockClear()
  }
  return { find, setRows, reset }
})

const userDb = vi.hoisted(() => {
  type D = Record<string, unknown>
  let rows: D[] = []
  const find = vi.fn(async (filter: { _id?: { $in: string[] } }) => {
    const ids = filter._id?.$in ?? []
    return rows.filter((r) => ids.includes(String(r._id)))
  })
  const setRows = (r: D[]) => {
    rows = r
  }
  const reset = () => {
    rows = []
    find.mockClear()
  }
  return { find, setRows, reset }
})

vi.mock("./rendered-document.model.js", () => ({
  RenderedDocumentCache: {
    findOne: cacheDb.findOne,
    findOneAndUpdate: cacheDb.findOneAndUpdate,
    find: cacheDb.find,
    deleteMany: cacheDb.deleteMany,
    updateOne: cacheDb.updateOne
  }
}))
vi.mock("../spine/baseline.model.js", () => ({ Baseline: { findOne: baselineDb.findOne } }))
vi.mock("../spine/change.model.js", () => ({ Change: { find: changeDb.find } }))
vi.mock("../user/user.model.js", () => ({ User: { find: userDb.find } }))
vi.mock("../spine/spine.repository.js", () => ({
  get: vi.fn(),
  listBaselineRefs: vi.fn(),
  listChanges: vi.fn(),
  SPINE_VERSION_CONFLICT: "SPINE_VERSION_CONFLICT",
  SPINE_NOT_FOUND: "SPINE_NOT_FOUND"
}))

import * as spineRepository from "../spine/spine.repository.js"
import { _internal, assemble, getDocument, getDraftMeta, NoWorkingDraftError } from "./assemble.service.js"
import { DIAGRAM_PLACEHOLDER_PNG } from "./diagram-placeholder.js"

const PROJECT = "650000000000000000000001"
const BASELINE_ID = "650000000000000000000099"

const baseSpine = (): Spine => ({
  project: { name: "Demo", vision: "V", goals: ["G1"], type: null, domain: null, complexity: null, form_factor: null, stakes: null, working_mode: null, release_scope: { in: [], out: [] } },
  progress: { current_phase: "S-9", current_step: "S-9.5", screen_cursor: null, screen_queue: [], elicit_turns_this_phase: 0 },
  steps: [],
  features: [{ id: "F1", name: "Auth", order: 0 }],
  actors: [],
  roles: [],
  use_cases: [],
  screens: [],
  permissions: [],
  entities: [],
  functions: [{ id: "FN1", screen_id: null, feature_id: "F1", order: 0, name: "Nightly", trigger: "t", description: "d", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }],
  nfrs: [],
  business_rules: [],
  common_requirements: [],
  messages: [],
  other_requirements: [],
  glossary: [],
  addendum: [],
  custom_sections: [],
  diagrams: [],
  assumptions: [],
  flags: [
    { id: "FLG1", level: "red", rule_id: "dead_reference", section_id: "fixed:1", message: "broken ref", remediation_step: "S-2.1", opened_at_version: 1, resolved_at: null, waived_by_user: false, waive_reason: null, waived_at_version: null },
    { id: "FLG2", level: "yellow", rule_id: "vague", section_id: "fixed:5.4", message: "vague wording", remediation_step: "S-7.4", opened_at_version: 1, resolved_at: null, waived_by_user: true, waive_reason: "Accepted for release 1.0 scope", waived_at_version: 2 }
  ],
  sections: [],
  baselines: [],
  spine_version: 1
})

const spineRecord = (overrides: Partial<SpineRecord> = {}): SpineRecord => ({ ...baseSpine(), projectId: PROJECT, ...overrides })

beforeEach(() => {
  cacheDb.reset()
  baselineDb.reset()
  changeDb.reset()
  userDb.reset()
  vi.mocked(spineRepository.get).mockReset()
  vi.mocked(spineRepository.listBaselineRefs).mockReset()
  vi.mocked(spineRepository.listBaselineRefs).mockResolvedValue([])
  vi.mocked(spineRepository.listChanges).mockReset()
  vi.mocked(spineRepository.listChanges).mockResolvedValue([])
})

describe("assemble()", () => {
  it("404 SPINE_NOT_FOUND khi chưa có Spine (review T3: không tự tạo Spine rỗng)", async () => {
    vi.mocked(spineRepository.get).mockResolvedValue(null)
    await expect(assemble(PROJECT, "Demo", 1)).rejects.toMatchObject({ statusCode: 404, code: "SPINE_NOT_FOUND" })
  })

  it("409 SPINE_VERSION_CONFLICT khi base_version lệch, không ghi cache", async () => {
    vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 3 }))
    await expect(assemble(PROJECT, "Demo", 2)).rejects.toMatchObject({ statusCode: 409, code: "SPINE_VERSION_CONFLICT" })
    expect(cacheDb.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it("200: ghép, cache theo spine_version, sections đếm cả 4 chương tổng hợp, watermark DRAFT", async () => {
    vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 5 }))
    const result = await assemble(PROJECT, "Demo", 5)

    expect(result.spine_version).toBe(5)
    expect(result.sections).toBeGreaterThan(0)
    expect(cacheDb.docs).toHaveLength(1)
    const cachedDoc = cacheDb.docs[0].doc as { watermark?: string; sections: unknown[]; version: string }
    expect(cachedDoc.watermark).toBe("DRAFT")
    expect(cachedDoc.version).toBe("v0.5")
    // 4 chương tổng hợp (group:2..5) phải có mặt trong tài liệu lưu cache
    const ids = (cachedDoc.sections as { id: string }[]).map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(["group:2", "group:3", "group:4", "group:5", "fixed:1"]))
    expect(ids).not.toContain("fixed:I")
  })

  it("review T8: assembleResponseSchema.sections KHÔNG đếm group:* (khác số section thật lưu trong cache)", async () => {
    vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 9 }))
    const result = await assemble(PROJECT, "Demo", 9)
    const cachedDoc = cacheDb.docs[0].doc as { sections: { id: string }[] }
    const groupCount = cachedDoc.sections.filter((s) => s.id.startsWith("group:")).length
    expect(groupCount).toBeGreaterThan(0)
    expect(result.sections).toBe(cachedDoc.sections.length - groupCount)
  })

  it("idempotent: gọi lại cùng spine_version không dựng lại (không gọi listChanges lần hai)", async () => {
    vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 7 }))
    await assemble(PROJECT, "Demo", 7)
    expect(spineRepository.listChanges).toHaveBeenCalledTimes(1)

    await assemble(PROJECT, "Demo", 7)
    expect(spineRepository.listChanges).toHaveBeenCalledTimes(1)
    expect(cacheDb.findOneAndUpdate).toHaveBeenCalledTimes(1)
  })

  describe("ảnh render_status=ok nhưng PNG tải lỗi — không còn '200 nhưng không cache' im lặng", () => {
    const diagram = { id: "D01", kind: "context" as const, section: "fixed:1", owner_kind: null, owner_id: null, puml: "@startuml\n@enduml", render_status: "ok" as const, source_hash: "h1", rendered_at: "2026-09-01T00:00:00.000Z" }
    const imagesOf = (doc: { sections: { blocks: { type: string; png?: unknown; caption?: string }[] }[] }) =>
      doc.sections.flatMap((s) => s.blocks.filter((b) => b.type === "image"))

    it("vẫn ghi cache (ảnh là tham chiếu) kèm missing_diagram_ids; findings có diagram_png_missing — cả khi trúng cache", async () => {
      vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 13, diagrams: [diagram] }))

      const result = await assemble(PROJECT, "Demo", 13, { loadDiagramPng: async () => null })
      expect(result.sections).toBeGreaterThan(0)
      expect(result.findings).toEqual([expect.objectContaining({ rule: "diagram_png_missing", path: "diagrams[id=D01]" })])
      expect(cacheDb.docs).toHaveLength(1)
      expect(cacheDb.docs[0].missing_diagram_ids).toEqual(["D01"])
      expect(imagesOf(cacheDb.docs[0].doc as Parameters<typeof imagesOf>[0]).map((b) => b.png)).toEqual(["diagram-ref:D01"])

      const again = await assemble(PROJECT, "Demo", 13, { loadDiagramPng: async () => null })
      expect(again.findings.map((f) => f.rule)).toEqual(["diagram_png_missing"])
      expect(cacheDb.docs[0].missing_diagram_ids).toEqual(["D01"])
    })

    it("PNG được khôi phục sau đó (không đổi spine_version) ⇒ lần assemble trúng cache hết báo thiếu, cache thu hẹp missing_diagram_ids", async () => {
      vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 13, diagrams: [diagram] }))
      await assemble(PROJECT, "Demo", 13, { loadDiagramPng: async () => null })

      const healed = await assemble(PROJECT, "Demo", 13, { loadDiagramPng: async () => "BASE64PNG" })
      expect(healed.findings).toEqual([])
      expect(cacheDb.docs).toHaveLength(1)
      expect(cacheDb.docs[0].missing_diagram_ids).toEqual([])
      expect(cacheDb.updateOne).toHaveBeenCalledTimes(1)
    })

    it("PNG rỗng tính là thiếu (writer không nhúng được) ⇒ placeholder + finding", async () => {
      vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 13, diagrams: [diagram] }))
      const result = await assemble(PROJECT, "Demo", 13, { loadDiagramPng: async () => "" })
      expect(result.findings.map((f) => f.rule)).toEqual(["diagram_png_missing"])
      const pending = imagesOf(await getDocument(PROJECT, "Demo", { source: "draft" }, { loadDiagramPng: async () => "" }))
      expect(pending[0].png).toBe(DIAGRAM_PLACEHOLDER_PNG)
    })

    it("đọc lại: chưa có PNG ⇒ placeholder + caption nêu rõ sơ đồ chưa render; PNG có sau ⇒ ảnh thật, cùng bản cache", async () => {
      vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 13, diagrams: [diagram] }))
      await assemble(PROJECT, "Demo", 13, { loadDiagramPng: async () => null })

      const pending = imagesOf(await getDocument(PROJECT, "Demo", { source: "draft" }, { loadDiagramPng: async () => null }))
      expect(pending).toHaveLength(1)
      expect(pending[0].png).toBe(DIAGRAM_PLACEHOLDER_PNG)
      expect(pending[0].caption).toBe("Figure — System Context Diagram — image pending: diagram D01 has not been rendered yet")

      const rendered = imagesOf(await getDocument(PROJECT, "Demo", { source: "draft" }, { loadDiagramPng: async () => "BASE64PNG" }))
      expect(rendered).toEqual([{ type: "image", png: "BASE64PNG", caption: "Figure — System Context Diagram" }])
      expect(cacheDb.docs).toHaveLength(1)
    })

    it("đủ PNG ⇒ findings không có diagram_png_missing, missing_diagram_ids rỗng", async () => {
      vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 14, diagrams: [diagram] }))
      const result = await assemble(PROJECT, "Demo", 14, { loadDiagramPng: async () => "BASE64PNG" })
      expect(result.findings.some((f) => f.rule === "diagram_png_missing")).toBe(false)
      expect(cacheDb.docs[0].missing_diagram_ids).toEqual([])
    })
  })

  describe("review T6 — cache không lưu base64 ảnh; đọc lại có ảnh", () => {
    const diagram = { id: "D01", kind: "context" as const, section: "fixed:1", owner_kind: null, owner_id: null, puml: "@startuml\n@enduml", render_status: "ok" as const, source_hash: "h1", rendered_at: "2026-09-01T00:00:00.000Z" }

    it("cache lưu diagram-ref:<id> thay vì base64; getDocument rehydrate PNG thật", async () => {
      vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 15, diagrams: [diagram] }))
      await assemble(PROJECT, "Demo", 15, { loadDiagramPng: async () => "BASE64PNG" })

      const cachedDoc = cacheDb.docs[0].doc as { sections: { blocks: { type: string; png?: string }[] }[] }
      const images = cachedDoc.sections.flatMap((s) => s.blocks.filter((b) => b.type === "image"))
      expect(images.length).toBeGreaterThan(0)
      expect(images.every((b) => typeof b.png === "string" && b.png?.startsWith("diagram-ref:"))).toBe(true)
      expect(JSON.stringify(cachedDoc)).not.toContain("BASE64PNG")

      const doc = await getDocument(PROJECT, "Demo", { source: "draft" }, { loadDiagramPng: async () => "BASE64PNG" })
      const rehydrated = doc.sections.flatMap((s) => s.blocks).filter((b) => b.type === "image")
      expect(rehydrated.some((b) => b.png === "BASE64PNG")).toBe(true)
    })
  })

  describe("review T10 — race upsert E11000", () => {
    it("findOneAndUpdate ném E11000 (writer khác vừa thắng) ⇒ đọc lại, không lộ lỗi", async () => {
      vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 17 }))
      cacheDb.findOneAndUpdate.mockImplementationOnce(async (filter: Doc) => {
        // mô phỏng request khác vừa ghi xong đúng lúc request này upsert
        cacheDb.docs.push({ _id: "cache-won-by-other", ...filter, assembled_at_version: 17, generated_at: new Date(), doc: { sections: [] } })
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 })
      })

      await expect(assemble(PROJECT, "Demo", 17)).resolves.toMatchObject({ spine_version: 17 })
      expect(cacheDb.docs).toHaveLength(1)
    })
  })

  describe("review Th2 — findings S-8.4 trả qua kết quả, không chỉ console.warn", () => {
    it("assemble() trả findings chứa dead_reference khi spine có tham chiếu chết", async () => {
      vi.mocked(spineRepository.get).mockResolvedValue(
        spineRecord({
          spine_version: 19,
          screens: [{ id: "S1", feature_id: "MISSING", name: "S", description: "", flow_to: [], is_popup: false, tabs: [], primary_function_id: null, queue_order: null, detail_status: "pending" }]
        })
      )
      const result = await assemble(PROJECT, "Demo", 19)
      expect(result.findings.some((f) => f.rule === "dead_reference")).toBe(true)
    })
  })

  describe("review T7 — §I hiển thị tên người ghi thay vì userId thô", () => {
    it("system ⇒ 'System'; user có tên ⇒ tên; user không còn ⇒ id rút gọn", async () => {
      changeDb.setRows([
        { projectId: PROJECT, txn: "t1", at: new Date("2026-09-01T00:00:00.000Z"), by: "650000000000000000000010", reason: "seed", op: "add", step_id: null, seq: 1 },
        { projectId: PROJECT, txn: "t2", at: new Date("2026-09-02T00:00:00.000Z"), by: "system", reason: "render", op: "set", step_id: null, seq: 2 },
        { projectId: PROJECT, txn: "t3", at: new Date("2026-09-03T00:00:00.000Z"), by: "650000000000000000000099deadbeef", reason: "manual", op: "set", step_id: null, seq: 3 }
      ])
      userDb.setRows([{ _id: "650000000000000000000010", name: "Alice", email: "alice@example.com" }])

      vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 21 }))
      await assemble(PROJECT, "Demo", 21)
      const doc = await getDocument(PROJECT, "Demo", { source: "draft" })

      expect(doc.recordOfChanges[0].in_charge).toBe("Alice")
      expect(doc.recordOfChanges[1].in_charge).toBe("System")
      expect(doc.recordOfChanges[2].in_charge).toBe("65000000…")
    })
  })
})

describe("getDocument() — source=draft", () => {
  it("chưa từng assemble ⇒ NoWorkingDraftError (409 NO_WORKING_DRAFT)", async () => {
    await expect(getDocument(PROJECT, "Demo", { source: "draft" })).rejects.toBeInstanceOf(NoWorkingDraftError)
    await expect(getDocument(PROJECT, "Demo", { source: "draft" })).rejects.toMatchObject({ statusCode: 409, code: "NO_WORKING_DRAFT" })
  })

  it("trả bản cache mới nhất theo spine_version", async () => {
    vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 1 }))
    await assemble(PROJECT, "Demo", 1)
    vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 2 }))
    await assemble(PROJECT, "Demo", 2)

    const doc = await getDocument(PROJECT, "Demo", { source: "draft" })
    expect(doc.version).toBe("v0.2")
  })

  it("flagsAppendix: cờ đỏ mở + waive đúng", async () => {
    vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 1 }))
    await assemble(PROJECT, "Demo", 1)
    const doc = await getDocument(PROJECT, "Demo", { source: "draft" })
    expect(doc.flagsAppendix?.redOpen).toHaveLength(1)
    expect(doc.flagsAppendix?.redOpen[0].id).toBe("FLG1")
    expect(doc.flagsAppendix?.waived).toHaveLength(1)
    expect(doc.flagsAppendix?.waived[0].waive_reason).toBe("Accepted for release 1.0 scope")
  })

  it("review T2: bản ghi cache hỏng ⇒ 422 RENDERED_DOCUMENT_INVALID, không phải 500 lộ ZodError", async () => {
    cacheDb.docs.push({ projectId: PROJECT, spine_version: 1, assembled_at_version: 1, generated_at: new Date(), doc: { not: "a rendered document" } })
    await expect(getDocument(PROJECT, "Demo", { source: "draft" })).rejects.toMatchObject({ statusCode: 422, code: "RENDERED_DOCUMENT_INVALID" })
  })
})

describe("getDocument() — source=baseline", () => {
  it("baseline_id không tồn tại/không hợp lệ ⇒ 404 BASELINE_NOT_FOUND", async () => {
    baselineDb.findOne.mockResolvedValue(null)
    await expect(getDocument(PROJECT, "Demo", { source: "baseline" })).rejects.toMatchObject({ statusCode: 404, code: "BASELINE_NOT_FOUND" })
    await expect(getDocument(PROJECT, "Demo", { source: "baseline", baseline_id: "not-an-object-id" })).rejects.toMatchObject({ statusCode: 404, code: "BASELINE_NOT_FOUND" })
  })

  it("dựng document từ Baseline.snapshot, không watermark, flagsAppendix chỉ có waived", async () => {
    baselineDb.findOne.mockResolvedValue({ _id: BASELINE_ID, projectId: PROJECT, version: "v1.0", at: new Date().toISOString(), checked_at_version: 9, waived_count: 1, snapshot: baseSpine() })

    const doc = await getDocument(PROJECT, "Demo", { source: "baseline", baseline_id: BASELINE_ID })
    expect(doc.source).toBe("baseline")
    expect(doc.watermark).toBeUndefined()
    expect(doc.version).toBe("v1.0")
    expect(doc.flagsAppendix?.redOpen).toEqual([])
    expect(doc.flagsAppendix?.staleCount).toBe(0)
    expect(doc.flagsAppendix?.waived).toHaveLength(1)
  })

  it("review T5: cache theo baseline._id — lần đọc thứ hai không dựng lại (Baseline.findOne chỉ gọi một lần)", async () => {
    baselineDb.findOne.mockResolvedValue({ _id: BASELINE_ID, projectId: PROJECT, version: "v1.0", at: new Date().toISOString(), checked_at_version: 9, waived_count: 1, snapshot: baseSpine() })

    await getDocument(PROJECT, "Demo", { source: "baseline", baseline_id: BASELINE_ID })
    await getDocument(PROJECT, "Demo", { source: "baseline", baseline_id: BASELINE_ID })

    const baselineCacheDocs = cacheDb.docs.filter((d) => d.baseline_id === BASELINE_ID)
    expect(baselineCacheDocs).toHaveLength(1)
  })

  it("baseline_id dạng BLnnn (mã của /baseline, /baselines) phân giải qua Spine.baselines[].snapshot_ref ⇒ cùng Baseline._id", async () => {
    vi.mocked(spineRepository.listBaselineRefs).mockResolvedValue([{ id: "BL001", snapshot_ref: BASELINE_ID }])
    baselineDb.findOne.mockResolvedValue({ _id: BASELINE_ID, projectId: PROJECT, version: "v1.0", at: new Date().toISOString(), checked_at_version: 9, waived_count: 0, snapshot: baseSpine() })

    const doc = await getDocument(PROJECT, "Demo", { source: "baseline", baseline_id: "BL001" })
    expect(doc.version).toBe("v1.0")
    expect(baselineDb.findOne).toHaveBeenCalledWith({ projectId: PROJECT, _id: BASELINE_ID }, null, expect.objectContaining({ lean: true }))
    // _id Mongo vẫn nhận như cũ, không cần đọc Spine; hai dạng id dùng chung một bản cache theo Baseline._id
    vi.mocked(spineRepository.listBaselineRefs).mockClear()
    await getDocument(PROJECT, "Demo", { source: "baseline", baseline_id: BASELINE_ID })
    expect(spineRepository.listBaselineRefs).not.toHaveBeenCalled()
    expect(cacheDb.docs.filter((d) => d.baseline_id === BASELINE_ID)).toHaveLength(1)
  })

  it("BLnnn không có trong Spine.baselines[], hoặc snapshot_ref không phải ObjectId ⇒ 404 BASELINE_NOT_FOUND, không tra Baseline", async () => {
    vi.mocked(spineRepository.listBaselineRefs).mockResolvedValue([{ id: "BL001", snapshot_ref: "x" }])
    await expect(getDocument(PROJECT, "Demo", { source: "baseline", baseline_id: "BL999" })).rejects.toMatchObject({ statusCode: 404, code: "BASELINE_NOT_FOUND" })
    await expect(getDocument(PROJECT, "Demo", { source: "baseline", baseline_id: "BL001" })).rejects.toMatchObject({ statusCode: 404, code: "BASELINE_NOT_FOUND" })
    expect(baselineDb.findOne).not.toHaveBeenCalled()
  })

  it("baseline thiếu PNG ⇒ vẫn cache dạng tham chiếu; trả placeholder; PNG có sau ⇒ đọc lại từ cùng cache ra ảnh thật (không placeholder vĩnh viễn)", async () => {
    const diagram = { id: "D01", kind: "context" as const, section: "fixed:1", owner_kind: null, owner_id: null, puml: "@startuml\n@enduml", render_status: "ok" as const, source_hash: "h1", rendered_at: "2026-09-01T00:00:00.000Z" }
    baselineDb.findOne.mockResolvedValue({ _id: BASELINE_ID, projectId: PROJECT, version: "v1.0", at: new Date().toISOString(), checked_at_version: 9, waived_count: 0, snapshot: { ...baseSpine(), diagrams: [diagram] } })
    const images = (doc: { sections: { blocks: { type: string; png?: unknown; caption?: string }[] }[] }) => doc.sections.flatMap((s) => s.blocks.filter((b) => b.type === "image"))

    const first = images(await getDocument(PROJECT, "Demo", { source: "baseline", baseline_id: BASELINE_ID }, { loadDiagramPng: async () => null }))
    expect(first).toEqual([{ type: "image", png: DIAGRAM_PLACEHOLDER_PNG, caption: "Figure — System Context Diagram — image pending: diagram D01 has not been rendered yet" }])
    const cached = cacheDb.docs.filter((d) => d.baseline_id === BASELINE_ID)
    expect(cached).toHaveLength(1)
    expect(cached[0].missing_diagram_ids).toEqual(["D01"])

    const second = images(await getDocument(PROJECT, "Demo", { source: "baseline", baseline_id: BASELINE_ID }, { loadDiagramPng: async () => "BASE64PNG" }))
    expect(second).toEqual([{ type: "image", png: "BASE64PNG", caption: "Figure — System Context Diagram" }])
    expect(baselineDb.findOne).toHaveBeenCalledTimes(2) // lần hai vẫn tra Baseline để lấy _id, nhưng không dựng lại (cache 1 bản)
    expect(cacheDb.docs.filter((d) => d.baseline_id === BASELINE_ID)).toHaveLength(1)
  })

  it("review T2: Baseline.snapshot hỏng ⇒ 422 BASELINE_SNAPSHOT_INVALID", async () => {
    baselineDb.findOne.mockResolvedValue({ _id: BASELINE_ID, projectId: PROJECT, version: "v1.0", at: new Date().toISOString(), checked_at_version: 9, waived_count: 0, snapshot: { not: "a spine" } })
    await expect(getDocument(PROJECT, "Demo", { source: "baseline", baseline_id: BASELINE_ID })).rejects.toMatchObject({ statusCode: 422, code: "BASELINE_SNAPSHOT_INVALID" })
  })
})

describe("getDraftMeta()", () => {
  it("chưa từng assemble ⇒ null", async () => {
    expect(await getDraftMeta(PROJECT)).toBeNull()
  })

  it("stale=true khi spine_version hiện tại khác assembled_at_version của cache", async () => {
    vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 23 }))
    await assemble(PROJECT, "Demo", 23)
    vi.mocked(spineRepository.get).mockResolvedValue(spineRecord({ spine_version: 24 }))

    expect(await getDraftMeta(PROJECT)).toEqual({ assembled_at_version: 23, spine_version: 24, stale: true })
  })
})

describe("_internal.buildNumberMap", () => {
  it("review T1: function screen-bound và non-screen trong cùng feature không trùng số, đúng thứ tự listSections", () => {
    const spine: Spine = {
      ...baseSpine(),
      features: [{ id: "F1", name: "Auth", order: 0 }],
      screens: [{ id: "S1", feature_id: "F1", name: "Login", description: "", flow_to: [], is_popup: false, tabs: [], primary_function_id: null, queue_order: 1, detail_status: "pending" }],
      functions: [
        { id: "FNA", screen_id: "S1", feature_id: "F1", order: 0, name: "Screen fn", trigger: "t", description: "d", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null },
        { id: "FNB", screen_id: null, feature_id: "F1", order: 0, name: "Non-screen fn", trigger: "t", description: "d", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }
      ]
    }
    const { numbers, hasUnassigned } = _internal.buildNumberMap(spine)
    expect(hasUnassigned).toBe(false)
    expect(numbers.get("feature:F1")).toBe("3.2")
    expect(numbers.get("function:FNA")).toBe("3.2.1")
    expect(numbers.get("function:FNB")).toBe("3.2.2")
  })

  it("review Th1: function feature_id chết gom vào mục Unassigned riêng, không trùng feature thật", () => {
    const spine: Spine = {
      ...baseSpine(),
      features: [{ id: "F1", name: "Auth", order: 0 }],
      functions: [
        { id: "FN1", screen_id: null, feature_id: "F1", order: 0, name: "Real", trigger: "t", description: "d", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null },
        { id: "FN2", screen_id: null, feature_id: "DEAD", order: 0, name: "Orphan", trigger: "t", description: "d", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }
      ]
    }
    const { numbers, unassignedNumber, hasUnassigned } = _internal.buildNumberMap(spine)
    expect(hasUnassigned).toBe(true)
    expect(unassignedNumber).toBe("3.4")
    expect(numbers.get("function:FN1")).toBe("3.2.1")
    expect(numbers.get("function:FN2")).toBe("3.4.1")
  })
})

describe("_internal.buildDocument — review C4/Th1 heading nhóm", () => {
  it("chèn group:2.2/3.1/4.2 trước section con đầu tiên; heading Unassigned Functions trước function mồ côi", async () => {
    const spine: Spine = { ...baseSpine(), functions: [...baseSpine().functions, { id: "FN9", screen_id: null, feature_id: "DEAD", order: 0, name: "Orphan", trigger: "t", description: "d", normal: [], abnormal: [], validations: [], business_rule_ids: [], priority: null }] }
    const doc = await _internal.buildDocument(
      { projectId: PROJECT, projectName: "Demo", spine, statusChanges: [], recordChanges: [], source: "draft", version: "v0.1" },
      { loadDiagramPng: async () => null, now: () => new Date("2026-09-15T00:00:00.000Z") }
    )
    const ids = doc.sections.map((s) => s.id)
    expect(ids.indexOf("group:2.2")).toBeGreaterThan(-1)
    expect(ids.indexOf("group:2.2")).toBeLessThan(ids.indexOf("fixed:2.2.1"))
    expect(ids.indexOf("group:3.1")).toBeLessThan(ids.indexOf("fixed:3.1.1"))
    expect(ids.indexOf("group:4.2")).toBeLessThan(ids.indexOf("fixed:4.2.1"))
    expect(ids).toContain("group:unassigned-functions")
    expect(ids.indexOf("group:unassigned-functions")).toBeLessThan(ids.indexOf("function:FN9"))
  })
})

describe("DoD1 — snapshot RenderedDocument từ fixture 19 màn", () => {
  it("snapshot ổn định (generatedAt cố định, ảnh thay bằng độ dài — không lưu base64 lớn)", async () => {
    const spine = spineSchema.parse(
      JSON.parse(readFileSync(new URL("../../../fixtures/spine-fixture-19-screens.json", import.meta.url), "utf8"))
    )
    const stubPng = makePng(2, 2).toString("base64")

    const doc = await _internal.buildDocument(
      { projectId: "650000000000000000000001", projectName: "FlintFlow", spine, statusChanges: [], recordChanges: [], source: "draft", version: "v0.1" },
      { loadDiagramPng: async () => stubPng, now: () => new Date("2026-09-15T00:00:00.000Z") }
    )

    const forSnapshot = {
      ...doc,
      sections: doc.sections.map((s) => ({
        ...s,
        blocks: s.blocks.map((b) => (b.type === "image" ? { ...b, png: typeof b.png === "string" ? b.png.length : b.png.byteLength } : b))
      }))
    }
    expect(forSnapshot).toMatchSnapshot()
  })
})
