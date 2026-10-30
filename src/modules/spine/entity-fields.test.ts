import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { entitiesOfFeature, entityGroups } from "./entity-features.js"
import { planTransaction } from "./op-engine.js"
import { resolve } from "./path-resolver.js"
import { findDeadReferences } from "./reference-fields.js"
import { computeSourceHash, renderedDiagramHash } from "./source-hash.js"
import { spineSchema } from "./spine.schema.js"
import type { Entity, Spine } from "./spine.types.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const txn = (ops: unknown[]) => ({ ops, by: "u", txn: "t" }) as unknown as Parameters<typeof planTransaction>[1]
const entityOf = (spine: Spine, id: string): Entity => spine.entities.find((e) => e.id === id)!
const mutate = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}

describe("entities[].attributes / feature_ids — schema", () => {
  it("fixture có hai field; Spine cũ thiếu cả hai vẫn hợp lệ (đọc như [])", () => {
    expect(entityOf(FIXTURE, "E01").attributes?.[0]).toEqual({ name: "email", kind: "key", required: true })
    expect(entityOf(FIXTURE, "E01").feature_ids).toEqual(["F1", "F2", "F5", "F6"])
    const old = structuredClone(FIXTURE) as unknown as { entities: Record<string, unknown>[] }
    for (const e of old.entities) {
      delete e.attributes
      delete e.feature_ids
    }
    const parsed = spineSchema.parse(old)
    expect(entitiesOfFeature(parsed, "F1")).toEqual([])
    expect(entityGroups(parsed)).toEqual([])
  })

  it("thuộc tính strict: kind lạ, tên rỗng, key lạ bị từ chối", () => {
    const bad = (attr: unknown) => {
      const s = structuredClone(FIXTURE) as unknown as { entities: { attributes: unknown[] }[] }
      s.entities[0].attributes = [attr]
      return spineSchema.safeParse(s).success
    }
    expect(bad({ name: "x", kind: "plain", required: true })).toBe(true)
    expect(bad({ name: "x", kind: "string", required: true })).toBe(false)
    expect(bad({ name: "  ", kind: "plain", required: true })).toBe(false)
    expect(bad({ name: "x", kind: "plain", required: true, type: "string" })).toBe(false)
    expect(bad({ name: "x", kind: "plain" })).toBe(false)
  })
})

describe("entity-features", () => {
  it("entity theo feature (sắp theo id), feature không tồn tại ⇒ rỗng", () => {
    expect(entitiesOfFeature(FIXTURE, "F4").map((e) => e.id)).toEqual(["E02", "E03", "E08", "E09", "E11"])
    expect(entitiesOfFeature(FIXTURE, "F9")).toEqual([])
    expect(entitiesOfFeature(FIXTURE, null)).toEqual([])
  })

  it("nhóm theo thứ tự feature; chỉ feature có entity; feature_ids chết không tạo nhóm", () => {
    expect(entityGroups(FIXTURE).map((g) => g.featureId)).toEqual(["F1", "F2", "F3", "F4", "F5", "F6"])
    const s = mutate((x) => {
      x.features = x.features.filter((f) => f.id !== "F1")
    })
    expect(entityGroups(s).map((g) => g.featureId)).not.toContain("F1")
  })
})

describe("op engine — attributes", () => {
  it("path chọn thuộc tính theo tên; sửa required / description, không đổi tên", () => {
    expect(resolve(FIXTURE, "entities[id=E01].attributes[name=email]")).toMatchObject({ kind: "element", value: { name: "email", kind: "key" } })
    const plan = planTransaction(FIXTURE, txn([{ op: "set", path: "entities[id=E01].attributes[name=avatar].required", value: true }]), { startSeq: 1 })
    expect(entityOf(plan.spine, "E01").attributes?.find((a) => a.name === "avatar")?.required).toBe(true)
    expect(() => planTransaction(FIXTURE, txn([{ op: "set", path: "entities[id=E01].attributes[name=avatar].name", value: "photo" }]), { startSeq: 1 })).toThrow()
  })

  it("set cả mảng thuộc tính được (khác mảng thực thể có id); trùng tên giữ cái đầu", () => {
    const next = [
      { name: "email", kind: "key", required: true },
      { name: "email", kind: "plain", required: false },
      { name: "phone", kind: "plain", required: false }
    ]
    const plan = planTransaction(FIXTURE, txn([{ op: "set", path: "entities[id=E01].attributes", value: next }]), { startSeq: 1 })
    expect(entityOf(plan.spine, "E01").attributes).toEqual([next[0], next[2]])
  })

  it("add thuộc tính mới; trùng tên bị từ chối; remove theo tên", () => {
    const added = planTransaction(FIXTURE, txn([{ op: "add", path: "entities[id=E01].attributes[]", value: { name: "locale", kind: "plain", required: false } }]), { startSeq: 1 })
    expect(entityOf(added.spine, "E01").attributes?.slice(-1)[0]).toEqual({ name: "locale", kind: "plain", required: false })
    expect(() => planTransaction(FIXTURE, txn([{ op: "add", path: "entities[id=E01].attributes[]", value: { name: "email", kind: "plain", required: true } }]), { startSeq: 1 })).toThrow()
    const removed = planTransaction(FIXTURE, txn([{ op: "remove", path: "entities[id=E01].attributes[name=avatar]" }]), { startSeq: 1 })
    expect(entityOf(removed.spine, "E01").attributes?.map((a) => a.name)).toEqual(["email", "display name", "account status"])
  })

  it("thuộc tính sai kind bị schema chặn cuối lô", () => {
    expect(() => planTransaction(FIXTURE, txn([{ op: "add", path: "entities[id=E01].attributes[]", value: { name: "x", kind: "string", required: true } }]), { startSeq: 1 })).toThrow()
  })
})

describe("op engine — feature_ids", () => {
  it("feature_ids là khoá tham chiếu: id chết ⇒ dead_reference; xoá feature gỡ id khỏi feature_ids (cascade pull)", () => {
    const dead = mutate((s) => (entityOf(s, "E03").feature_ids = ["F3", "F99"]))
    expect(findDeadReferences(dead).map((h) => h.refPath)).toContain("entities[id=E03].feature_ids[=F99]")
    expect(findDeadReferences(FIXTURE).filter((h) => h.field.path === "entities[].feature_ids[]")).toEqual([])

    const orphanFeature = mutate((s) => {
      s.features.push({ id: "F7", name: "Extra", order: 6 })
      entityOf(s, "E04").feature_ids = ["F3", "F7"]
    })
    const plan = planTransaction(orphanFeature, txn([{ op: "remove", path: "features[id=F7]" }]), { startSeq: 1 })
    expect(entityOf(plan.spine, "E04").feature_ids).toEqual(["F3"])
  })

  it("xoá feature còn màn / function ⇒ vẫn bị bất biến 3 từ chối (restrict), feature_ids không che", () => {
    expect(() => planTransaction(FIXTURE, txn([{ op: "remove", path: "features[id=F1]" }]), { startSeq: 1 })).toThrow()
  })
})

describe("source hash — class và ERD với attributes", () => {
  const cls = (owner: string) => ({ kind: "class" as const, owner_id: owner })

  it("class: hash theo từng feature — đổi thuộc tính / tên entity / tên feature của feature đó làm cũ, feature khác thì không", () => {
    const base = renderedDiagramHash(FIXTURE, cls("F3"))
    expect(renderedDiagramHash(structuredClone(FIXTURE), cls("F3"))).toBe(base)
    const attr = mutate((s) => (entityOf(s, "E04").attributes = [{ name: "session code", kind: "key", required: false }]))
    expect(renderedDiagramHash(attr, cls("F3"))).not.toBe(base)
    expect(renderedDiagramHash(attr, cls("F5"))).toBe(renderedDiagramHash(FIXTURE, cls("F5")))
    const renamed = mutate((s) => (s.features.find((f) => f.id === "F3")!.name = "Workspace"))
    expect(renderedDiagramHash(renamed, cls("F3"))).not.toBe(base)
    expect(renderedDiagramHash(renamed, cls("F4"))).toBe(renderedDiagramHash(FIXTURE, cls("F4")))
  })

  it("class: mô tả entity và entity thuộc feature khác không đổi hash; quan hệ sang feature khác không tính", () => {
    const base = renderedDiagramHash(FIXTURE, cls("F3"))
    expect(renderedDiagramHash(mutate((s) => (entityOf(s, "E04").description = "other")), cls("F3"))).toBe(base)
    // E10 (UsageRecord) chỉ thuộc F5 — đổi tên nó không động tới hình F3
    expect(renderedDiagramHash(mutate((s) => (entityOf(s, "E10").name = "Usage")), cls("F3"))).toBe(base)
    // E03 (Spine) → E04 (ChatSession) đều thuộc F3: đổi động từ làm cũ
    expect(renderedDiagramHash(mutate((s) => (entityOf(s, "E02").relation_verbs = { E03: "owns", E04: "opens" })), cls("F3"))).not.toBe(base)
  })

  it("class: thêm feature_ids cho entity làm hình feature đó cũ; engine svg@1 (hash khác hash dữ liệu thô)", () => {
    const base = renderedDiagramHash(FIXTURE, cls("F6"))
    const more = mutate((s) => (entityOf(s, "E04").feature_ids = ["F3", "F6"]))
    expect(renderedDiagramHash(more, cls("F6"))).not.toBe(base)
    expect(base).not.toBe(computeSourceHash(FIXTURE, cls("F6")))
  })

  it("ERD: thuộc tính (tên, kind) làm hình cũ; Spine không có thuộc tính ⇒ hash như trước (hình cũ không stale)", () => {
    const erd = { kind: "erd" as const, owner_id: null }
    const stripped = mutate((s) => s.entities.forEach((e) => delete e.attributes))
    const withEmpty = mutate((s) => s.entities.forEach((e) => (e.attributes = [])))
    expect(computeSourceHash(withEmpty, erd)).toBe(computeSourceHash(stripped, erd))
    expect(computeSourceHash(FIXTURE, erd)).not.toBe(computeSourceHash(stripped, erd))
    const keyChanged = mutate((s) => (entityOf(s, "E01").attributes![0].kind = "plain"))
    expect(computeSourceHash(keyChanged, erd)).not.toBe(computeSourceHash(FIXTURE, erd))
    // `required` / mô tả thuộc tính không vẽ lên ERD
    const requiredChanged = mutate((s) => (entityOf(s, "E01").attributes![0].required = false))
    expect(computeSourceHash(requiredChanged, erd)).toBe(computeSourceHash(FIXTURE, erd))
  })
})
