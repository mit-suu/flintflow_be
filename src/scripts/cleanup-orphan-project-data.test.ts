import { describe, expect, it } from "vitest"
import mongoose from "mongoose"
import { findOrphans, type OrphanSource } from "./cleanup-orphan-project-data.js"
import { projectScopedModels } from "../modules/project/project-scoped-models.js"

const ALIVE = "64b000000000000000000001"
const SOFT_DELETED = "64b000000000000000000002"
const GONE = "64b000000000000000000003"
const GONE_2 = "64b000000000000000000004"

const source = (modelName: string, docs: Record<string, number>): OrphanSource & { filters: unknown[] } => {
  const filters: unknown[] = []
  return {
    modelName,
    filters,
    distinct: async () => Object.keys(docs).map((id) => new mongoose.Types.ObjectId(id)),
    countDocuments: async (filter) => {
      filters.push(filter)
      const ids = ((filter.projectId as { $in: unknown[] }).$in ?? []).map(String)
      return ids.reduce((sum, id) => sum + (docs[id] ?? 0), 0)
    }
  }
}

describe("cleanup-orphan-project-data (QLHS #1–#2)", () => {
  // `existing` lấy từ collection `projects` thô ⇒ có cả dự án đã xoá mềm
  const existing = new Set([ALIVE, SOFT_DELETED])

  it("chỉ báo projectId không còn trong `projects`; dự án xoá mềm không phải mồ côi", async () => {
    const stepruns = source("StepRun", { [ALIVE]: 4, [SOFT_DELETED]: 2, [GONE]: 36 })
    const spines = source("Spine", { [ALIVE]: 1 })
    const chats = source("ChatSession", { [GONE]: 1, [GONE_2]: 2 })

    const reports = await findOrphans([stepruns, spines, chats], existing)

    expect(reports).toEqual([
      { modelName: "StepRun", projectIds: [GONE], documents: 36 },
      { modelName: "ChatSession", projectIds: [GONE, GONE_2], documents: 3 }
    ])
    expect(spines.filters).toEqual([])
  })

  it("document thiếu projectId (null) không bị tính là mồ côi", async () => {
    const spines: OrphanSource = { modelName: "Spine", distinct: async () => [null, new mongoose.Types.ObjectId(GONE)], countDocuments: async () => 1 }
    expect(await findOrphans([spines], existing)).toEqual([{ modelName: "Spine", projectIds: [GONE], documents: 1 }])
  })

  it("--project giới hạn vào một dự án", async () => {
    const chats = source("ChatSession", { [GONE]: 1, [GONE_2]: 2 })
    expect(await findOrphans([chats], existing, GONE_2)).toEqual([{ modelName: "ChatSession", projectIds: [GONE_2], documents: 2 }])
    expect(await findOrphans([chats], existing, ALIVE)).toEqual([])
  })

  it("danh sách collection theo dự án có đủ các collection purge cũ bỏ sót", () => {
    const names = projectScopedModels().map((model) => model.modelName)
    expect(names).toEqual(expect.arrayContaining(["StepRun", "SpineEmbedding", "SpineLock", "Spine", "ChatSession", "Change"]))
    expect(new Set(names).size).toBe(names.length)
    // Lịch sử credit / thanh toán thuộc tổ chức — không được nằm trong danh sách xoá theo dự án
    expect(names).not.toEqual(expect.arrayContaining(["CreditTransaction"]))
  })
})
