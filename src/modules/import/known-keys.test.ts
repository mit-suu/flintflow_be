import { describe, expect, it } from "vitest"
import type { EntityItem } from "./extracted-entities.js"
import { KNOWN_KEYS_CHARS, knownKeysText, scopeKnownKeys } from "./known-keys.js"

const item = (entity: string, id: string | null, value: Record<string, unknown> = {}): EntityItem => ({
  entity,
  id,
  value,
  confidence: 0.9,
  field_confidence: {},
  source_block_ids: ["B0001"],
  origin: "deterministic"
})

const KNOWN: EntityItem[] = [
  item("actors", "A01", { name: "Learner" }),
  item("actors", "A02", { name: "Admin" }),
  item("use_cases", "UC-01", { name: "Register account" }),
  item("use_cases", "UC-02", { name: "Log in" }),
  item("business_rules", "BR-01", { statement: "Passwords must have at least 8 characters." }),
  item("business_rules", "BR-02", { statement: "Refunds within 7 days." }),
  item("entities", "E01", { name: "SubscriptionPlan" }),
  item("glossary", "G01", { term: "Course" }),
  item("project", null, { vision: "x" })
]

const ids = (items: EntityItem[]) => items.map((it) => it.id)

describe("scopeKnownKeys — known_keys theo lượt gọi", () => {
  it("chỉ phần tử được nhắc (mã theo idKey, mention, tên) + loại luôn gửi; phần tử không liên quan bị bỏ", () => {
    const out = scopeKnownKeys(KNOWN, { provisional: [], section: [], text: "The learner registers (uc01) and must follow BR-01.", always: ["actors"] })
    // mã viết lệch dạng ("uc01") vẫn khớp UC-01; BR-02, UC-02, E01, G01 không ai nhắc
    expect(ids(out)).toEqual(["UC-01", "BR-01", "A01", "A02"])
  })

  it("mention của block khớp dù chữ không ghi mã; tên khác quy ước đặt tên khớp theo compactKey; thuật ngữ khớp theo term", () => {
    const out = scopeKnownKeys(KNOWN, { provisional: [], section: [], text: "Each subscription_plans row belongs to a course.", mentions: [{ id: "BR02" }] })
    expect(ids(out)).toEqual(["BR-02", "E01", "G01"])
  })

  it("tên so theo từ: 'Log in' không khớp chữ 'catalog in…' / 'login'", () => {
    expect(ids(scopeKnownKeys(KNOWN, { provisional: [], section: [], text: "Browse the catalog index" }))).toEqual([])
    expect(ids(scopeKnownKeys(KNOWN, { provisional: [], section: [], text: "Users log in with email" }))).toEqual(["UC-02"])
  })

  it("thứ tự ưu tiên: phần tử tạm của section → phần tử của section → mã → tên → loại luôn gửi; bỏ trùng entity|id", () => {
    const fn = item("functions", "FR-3.2.1", { name: "Register account" })
    const feature = item("features", "F-3.2", { name: "Authentication" })
    const own = item("screens", "SCR-01", { name: "Login screen" })
    const out = scopeKnownKeys([...KNOWN, fn, feature, own], {
      provisional: [fn, feature],
      section: [own, fn],
      text: "Learner opens Log in (BR-01)",
      always: ["actors"]
    })
    expect(ids(out)).toEqual(["FR-3.2.1", "F-3.2", "SCR-01", "BR-01", "A01", "UC-02", "A02"])
  })

  it("trần ký tự cứng: cắt theo thứ tự ưu tiên, tất định; mặc định ~4k ký tự", () => {
    const many = Array.from({ length: 500 }, (_, i) => item("actors", `A${String(i + 1).padStart(3, "0")}`, { name: `Actor number ${i + 1}` }))
    const scope = { provisional: [], section: [many[499]], text: "", always: ["actors"] }
    const out = scopeKnownKeys(many, scope)
    expect(out[0].id).toBe("A500")
    expect(knownKeysText(out).length).toBeLessThanOrEqual(KNOWN_KEYS_CHARS)
    expect(out.length).toBeLessThan(many.length)
    expect(ids(scopeKnownKeys(many, scope))).toEqual(ids(out))
    expect(ids(scopeKnownKeys(many, scope, 70))).toEqual(["A500", "A001"])
  })

  it("phần tử của section không có tên (ảnh chỉ thêm `kind`) ⇒ in tên theo phần tử cùng khoá đã biết", () => {
    const visionOnly = item("actors", "A01", { kind: "human" })
    const out = scopeKnownKeys(KNOWN, { provisional: [], section: [visionOnly], text: "" })
    expect(knownKeysText(out)).toBe("actors: A01 (Learner)")
    expect(visionOnly.value).toEqual({ kind: "human" })
  })

  it("knownKeysText: mỗi loại một dòng theo thứ tự xuất hiện, kèm tên; rỗng ⇒ (none yet)", () => {
    expect(knownKeysText([KNOWN[2], KNOWN[0], KNOWN[3], KNOWN[4]])).toBe("use_cases: UC-01 (Register account), UC-02 (Log in)\nactors: A01 (Learner)\nbusiness_rules: BR-01")
    expect(knownKeysText([])).toBe("(none yet)")
    expect(knownKeysText([KNOWN[8]])).toBe("(none yet)")
  })
})
