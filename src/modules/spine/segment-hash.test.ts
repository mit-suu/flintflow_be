/**
 * FLF-366 — dấu đoạn nguyên văn + cờ vàng văn xuôi gốc nhắc tới phần tử đã đổi. Hàm thuần.
 */
import { describe, expect, it } from "vitest"
import { originalTextMentionsChanged } from "./deterministic-check.js"
import { rehashSegments, sectionItemKeys, segmentHash, segmentItemHash, segmentKeyOfPath, type SectionSegments } from "./segment-hash.js"
import { createEmptySpine } from "./spine.repository.js"
import type { Spine } from "./spine.types.js"

const spine = (): Spine => {
  const empty = createEmptySpine({ name: "FAP" })
  return {
    ...empty,
    project: { ...empty.project, vision: "FAP manages attendance." },
    actors: [
      { id: "A01", name: "Student", kind: "human", description: "Learner." },
      { id: "A02", name: "Email Service", kind: "system", description: "Mail." }
    ],
    use_cases: [{ id: "UC-01", name: "Take attendance", actor_ids: ["A01"], description: "", includes: [], extends: [], function_ids: [] }],
    business_rules: [
      { id: "BR-01", tier: "detail", statement: "One check-in per slot", source_validation_ids: [] },
      { id: "BR-02", tier: "high", statement: "Attendance is mandatory", source_validation_ids: [] }
    ],
    custom_sections: [{ id: "CS01", heading: "", level: 2, source: "import", blocks: [{ kind: "paragraph", text: "Each Student checks in; see UC-01.", rows: null, image_ref: null }] }]
  } as Spine
}

describe("segmentItemHash / segmentHash", () => {
  it("gồm tên phần tử được tham chiếu (đổi tên actor ⇒ dấu use case đổi); không gồm thứ tự; phần tử đã xoá ⇒ khác", () => {
    const s = spine()
    const uc = segmentItemHash(s, "use_cases:UC-01")
    expect(segmentItemHash({ ...s, actors: s.actors.map((a) => (a.id === "A01" ? { ...a, name: "Learner" } : a)) }, "use_cases:UC-01")).not.toBe(uc)
    // actor khác (không được tham chiếu) đổi ⇒ không ảnh hưởng
    expect(segmentItemHash({ ...s, actors: s.actors.map((a) => (a.id === "A02" ? { ...a, name: "Mailer" } : a)) }, "use_cases:UC-01")).toBe(uc)
    const features = [{ id: "F-1", name: "Auth", order: 0 }]
    expect(segmentItemHash({ ...s, features }, "features:F-1")).toBe(segmentItemHash({ ...s, features: [{ ...features[0], order: 5 }] }, "features:F-1"))
    expect(segmentItemHash({ ...s, use_cases: [] }, "use_cases:UC-01")).not.toBe(uc)
    expect(segmentItemHash(s, "project:vision")).not.toBe(segmentItemHash({ ...s, project: { ...s.project, vision: "Other" } }, "project:vision"))
    // thứ tự khoá không ảnh hưởng dấu đoạn
    expect(segmentHash(s, ["business_rules:BR-01", "use_cases:UC-01"])).toBe(segmentHash(s, ["use_cases:UC-01", "business_rules:BR-01"]))
  })

  it("sectionItemKeys theo phần tử mục đó in ra: mục 1 chỉ BR cấp cao + actor không phải người + field project; 5.1 chỉ BR chi tiết", () => {
    expect(sectionItemKeys(spine(), "fixed:1")).toEqual(["project:vision", "project:goals", "project:release_scope", "business_rules:BR-02", "actors:A02"])
    expect(sectionItemKeys(spine(), "fixed:5.1")).toEqual(["business_rules:BR-01"])
    expect(sectionItemKeys(spine(), "feature:F-1")).toEqual([])
  })

  it("segmentKeyOfPath: đường dẫn op ⇒ khoá phần tử", () => {
    expect(segmentKeyOfPath("business_rules[id=BR-01].statement")).toBe("business_rules:BR-01")
    expect(segmentKeyOfPath("project.vision")).toBe("project:vision")
    expect(segmentKeyOfPath("flags[]")).toBeNull()
  })

  it("rehashSegments chỉ cập nhật đoạn / known của phần tử vừa ghi", () => {
    const s = spine()
    const records: SectionSegments[] = [
      {
        section_id: "fixed:5.1",
        parts: [{ kind: "spine", items: ["business_rules:BR-01"], source_hash: segmentHash(s, ["business_rules:BR-01"]), blocks: [], mentions: [] }],
        known: [{ key: "business_rules:BR-01", hash: segmentItemHash(s, "business_rules:BR-01") }]
      }
    ]
    const next = { ...s, business_rules: s.business_rules.map((r) => (r.id === "BR-01" ? { ...r, statement: "Changed" } : r)) }
    expect(rehashSegments(records, next, new Set(["actors:A01"]))).toEqual(records)
    const fresh = rehashSegments(records, next, new Set(["business_rules:BR-01"]))[0]
    expect(fresh.parts[0]).toMatchObject({ source_hash: segmentHash(next, ["business_rules:BR-01"]) })
    expect(fresh.known).toEqual([{ key: "business_rules:BR-01", hash: segmentItemHash(next, "business_rules:BR-01") }])
  })
})

describe("original_text_mentions_changed", () => {
  const records: SectionSegments[] = [
    {
      section_id: "fixed:1",
      parts: [
        {
          kind: "original",
          custom_id: "CS01",
          diagrams: [],
          mentions: [
            { path: "actors[id=A01]", array: "actors", id: "A01", name: "Student" },
            { path: "use_cases[id=UC-01]", array: "use_cases", id: "UC-01", name: null }
          ]
        }
      ],
      known: []
    }
  ]

  it("không đổi ⇒ không cờ; đổi tên actor ⇒ cờ vàng nêu tên cũ / mới; xoá use case được nhắc theo mã ⇒ cờ", () => {
    expect(originalTextMentionsChanged(spine(), records)).toEqual([])
    const renamed = { ...spine(), actors: spine().actors.map((a) => (a.id === "A01" ? { ...a, name: "Learner" } : a)) }
    const flags = originalTextMentionsChanged(renamed, records)
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ level: "yellow", rule_id: "original_text_mentions_changed", section_id: "fixed:1", target_id: "actors[id=A01]" })
    expect(flags[0].message).toContain('"Student"')
    expect(flags[0].message).toContain('"Learner"')
    const removed = { ...spine(), use_cases: [] }
    expect(originalTextMentionsChanged(removed, records).map((f) => f.target_id)).toEqual(["use_cases[id=UC-01]"])
  })

  it("đoạn văn đã sửa qua CR, không còn nhắc tên cũ ⇒ không cờ", () => {
    const renamed = { ...spine(), actors: spine().actors.map((a) => (a.id === "A01" ? { ...a, name: "Learner" } : a)) }
    const edited = { ...renamed, custom_sections: [{ ...renamed.custom_sections[0], blocks: [{ kind: "paragraph" as const, text: "Each Learner checks in; see UC-01.", rows: null, image_ref: null }] }] }
    expect(originalTextMentionsChanged(edited, records)).toEqual([])
  })
})
