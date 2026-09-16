import { describe, it, expect } from "vitest"
import { Schema } from "mongoose"
import { z } from "zod"
import { Spine } from "./spine.model.js"
import { Change } from "./change.model.js"
import { Baseline } from "./baseline.model.js"
import { Usage } from "./usage.model.js"
import { ChatSession } from "../project/chat-session.model.js"
import { changeSchema, spineRecordSchema, usageSchema } from "./spine.schema.js"

const PROJECT = "650000000000000000000001"
const DB_ONLY = new Set(["_id", "__v", "createdAt", "updatedAt"])

// ─── so khớp field giữa model viết tay và zod ────────────────────

const unwrapObject = (s: z.ZodType): z.ZodObject | null => {
  if (s instanceof z.ZodObject) return s
  if (s instanceof z.ZodArray) return unwrapObject(s.element as z.ZodType)
  if (s instanceof z.ZodNullable || s instanceof z.ZodOptional) return unwrapObject(s.unwrap() as z.ZodType)
  return null
}

const topLevelPaths = (schema: Schema): string[] =>
  [...new Set(Object.keys(schema.paths).map((p) => p.split(".")[0]))].filter((k) => !DB_ONLY.has(k)).sort()

const expectSameFields = (zod: z.ZodType, schema: Schema, at: string): void => {
  const obj = unwrapObject(zod)
  if (!obj) throw new Error(`${at} không phải object`)

  expect(topLevelPaths(schema), at).toEqual(Object.keys(obj.shape).sort())

  for (const [key, child] of Object.entries(obj.shape)) {
    if (!unwrapObject(child as z.ZodType)) continue
    const sub: unknown = (schema.path(key) as unknown as { schema?: unknown }).schema
    expect(sub instanceof Schema, `${at}.${key} phải là subschema`).toBe(true)
    expectSameFields(child as z.ZodType, sub as Schema, `${at}.${key}`)
  }
}

describe("model khớp zod (không trôi field)", () => {
  it("Spine ⇔ spineRecordSchema, đệ quy mọi subdocument", () => {
    expectSameFields(spineRecordSchema, Spine.schema, "spine")
  })

  it("Change ⇔ changeSchema, Usage ⇔ usageSchema", () => {
    expectSameFields(changeSchema, Change.schema, "change")
    expectSameFields(usageSchema, Usage.schema, "usage")
  })
})

describe("Spine model", () => {
  it("document mới có spine_version 1, mảng rỗng, không lưu status/progressPercent", () => {
    const doc = new Spine({ projectId: PROJECT })
    expect(doc.validateSync()).toBeUndefined()
    expect(doc.spine_version).toBe(1)
    expect(doc.actors).toHaveLength(0)
    expect(doc.progress?.elicit_turns_this_phase).toBe(0)
    expect(Spine.schema.path("progressPercent")).toBeUndefined()
    expect(Spine.schema.get("strict")).toBe(true)
  })

  it("enum sai bị validate chặn", () => {
    const doc = new Spine({
      projectId: PROJECT,
      actors: [{ id: "A01", name: "X", kind: "robot", description: "" }]
    })
    expect(doc.validateSync()?.errors["actors.0.kind"]).toBeDefined()
  })

  it("projectId unique", () => {
    expect(Spine.schema.indexes()).toContainEqual([{ projectId: 1 }, { unique: true }])
  })
})

describe("collection tách riêng", () => {
  it("Change: unique (projectId, seq), thiếu field bắt buộc bị chặn", () => {
    expect(Change.schema.indexes()).toContainEqual([{ projectId: 1, seq: 1 }, { unique: true }])
    const errors = new Change({ projectId: PROJECT }).validateSync()?.errors ?? {}
    expect(Object.keys(errors).sort()).toEqual(["at", "by", "op", "path", "seq", "txn"])
  })

  it("Baseline: snapshot bắt buộc", () => {
    const doc = new Baseline({ projectId: PROJECT, version: "v1.0", at: new Date(), checked_at_version: 3 })
    expect(doc.validateSync()?.errors.snapshot).toBeDefined()
  })

  it("Usage: state chỉ nhận reserved|deducted|refunded, có index dọn reserved quá hạn", () => {
    const doc = new Usage({
      projectId: PROJECT,
      userId: PROJECT,
      step_id: "S-2.1",
      call_kind: "draft",
      attempt: 1,
      state: "pending",
      expires_at: new Date()
    })
    expect(doc.validateSync()?.errors.state).toBeDefined()
    expect(Usage.schema.indexes()).toContainEqual([{ state: 1, expires_at: 1 }, {}])
  })
})

describe("ChatSession.is_pipeline", () => {
  it("mặc định false và có partial unique index mỗi project", () => {
    expect(new ChatSession({ projectId: PROJECT }).is_pipeline).toBe(false)
    expect(ChatSession.schema.indexes()).toContainEqual([
      { projectId: 1 },
      { unique: true, partialFilterExpression: { is_pipeline: true }, name: "uniq_pipeline_session_per_project" }
    ])
  })
})
