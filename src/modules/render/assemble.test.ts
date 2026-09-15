import { describe, expect, it, vi, beforeEach } from "vitest"
import type { Spine, SpineRecord } from "../spine/spine.types.js"

const cacheDb = vi.hoisted(() => {
  type Doc = Record<string, unknown>
  const docs: Doc[] = []
  const findOne = vi.fn(async (filter: Doc, _p: unknown, options: { sort?: Record<string, number> } = {}) => {
    const rows = docs.filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v))
    if (options.sort?.spine_version === -1) return [...rows].sort((a, b) => Number(b.spine_version) - Number(a.spine_version))[0] ?? null
    return rows[0] ?? null
  })
  const findOneAndUpdate = vi.fn(async (filter: Doc, update: { $set: Doc }) => {
    const existing = docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v))
    if (existing) {
      Object.assign(existing, update.$set)
      return existing
    }
    const created = { ...filter, ...update.$set }
    docs.push(created)
    return created
  })
  const reset = () => {
    docs.length = 0
    findOne.mockClear()
    findOneAndUpdate.mockClear()
  }
  return { docs, findOne, findOneAndUpdate, reset }
})

const baselineDb = vi.hoisted(() => {
  const findOne = vi.fn()
  return { findOne, reset: () => findOne.mockReset() }
})

vi.mock("./rendered-document.model.js", () => ({ RenderedDocumentCache: { findOne: cacheDb.findOne, findOneAndUpdate: cacheDb.findOneAndUpdate } }))
vi.mock("../spine/baseline.model.js", () => ({ Baseline: { findOne: baselineDb.findOne } }))
vi.mock("../spine/spine.repository.js", () => ({
  getOrCreate: vi.fn(),
  listChanges: vi.fn(),
  SPINE_VERSION_CONFLICT: "SPINE_VERSION_CONFLICT"
}))

import * as spineRepository from "../spine/spine.repository.js"
import { assemble, getDocument, NoWorkingDraftError } from "./assemble.service.js"

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
  vi.mocked(spineRepository.getOrCreate).mockReset()
  vi.mocked(spineRepository.listChanges).mockReset()
  vi.mocked(spineRepository.listChanges).mockResolvedValue([])
})

describe("assemble()", () => {
  it("409 SPINE_VERSION_CONFLICT khi base_version lệch, không ghi cache", async () => {
    vi.mocked(spineRepository.getOrCreate).mockResolvedValue(spineRecord({ spine_version: 3 }))
    await expect(assemble(PROJECT, "Demo", 2)).rejects.toMatchObject({ statusCode: 409, code: "SPINE_VERSION_CONFLICT" })
    expect(cacheDb.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it("200: ghép, cache theo spine_version, sections đếm cả 4 chương tổng hợp, watermark DRAFT", async () => {
    vi.mocked(spineRepository.getOrCreate).mockResolvedValue(spineRecord({ spine_version: 5 }))
    const result = await assemble(PROJECT, "Demo", 5)

    expect(result.spine_version).toBe(5)
    expect(result.sections).toBeGreaterThan(0)
    expect(cacheDb.docs).toHaveLength(1)
    const cachedDoc = cacheDb.docs[0].doc as { watermark?: string; sections: unknown[]; version: string }
    expect(cachedDoc.watermark).toBe("DRAFT")
    expect(cachedDoc.version).toBe("v0.5")
    // 4 chương tổng hợp (group:2..5) phải có mặt
    const ids = (cachedDoc.sections as { id: string }[]).map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(["group:2", "group:3", "group:4", "group:5", "fixed:1"]))
    expect(ids).not.toContain("fixed:I")
  })

  it("idempotent: gọi lại cùng spine_version không dựng lại (không gọi listChanges lần hai)", async () => {
    vi.mocked(spineRepository.getOrCreate).mockResolvedValue(spineRecord({ spine_version: 7 }))
    await assemble(PROJECT, "Demo", 7)
    expect(spineRepository.listChanges).toHaveBeenCalledTimes(1)

    await assemble(PROJECT, "Demo", 7)
    expect(spineRepository.listChanges).toHaveBeenCalledTimes(1)
    expect(cacheDb.findOneAndUpdate).toHaveBeenCalledTimes(1)
  })
})

describe("getDocument() — source=draft", () => {
  it("chưa từng assemble ⇒ NoWorkingDraftError (409 NO_WORKING_DRAFT)", async () => {
    await expect(getDocument(PROJECT, "Demo", { source: "draft" })).rejects.toBeInstanceOf(NoWorkingDraftError)
    await expect(getDocument(PROJECT, "Demo", { source: "draft" })).rejects.toMatchObject({ statusCode: 409, code: "NO_WORKING_DRAFT" })
  })

  it("trả bản cache mới nhất theo spine_version", async () => {
    vi.mocked(spineRepository.getOrCreate).mockResolvedValue(spineRecord({ spine_version: 1 }))
    await assemble(PROJECT, "Demo", 1)
    vi.mocked(spineRepository.getOrCreate).mockResolvedValue(spineRecord({ spine_version: 2 }))
    await assemble(PROJECT, "Demo", 2)

    const doc = await getDocument(PROJECT, "Demo", { source: "draft" })
    expect(doc.version).toBe("v0.2")
  })

  it("flagsAppendix: cờ đỏ mở + waive đúng", async () => {
    vi.mocked(spineRepository.getOrCreate).mockResolvedValue(spineRecord({ spine_version: 1 }))
    await assemble(PROJECT, "Demo", 1)
    const doc = await getDocument(PROJECT, "Demo", { source: "draft" })
    expect(doc.flagsAppendix?.redOpen).toHaveLength(1)
    expect(doc.flagsAppendix?.redOpen[0].id).toBe("FLG1")
    expect(doc.flagsAppendix?.waived).toHaveLength(1)
    expect(doc.flagsAppendix?.waived[0].waive_reason).toBe("Accepted for release 1.0 scope")
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
})
