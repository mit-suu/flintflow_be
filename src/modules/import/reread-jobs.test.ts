/**
 * FLF-360 — op ghi phần đọc lại từ ảnh sơ đồ vào Spine đã có bản 0.1 (hàm thuần). Áp qua op engine thật (`planTransaction`)
 * để chắc mọi op hợp lệ: path theo khoá (`blocks[image_ref=…]`), bất biến, schema.
 */
import { describe, expect, it } from "vitest"
import { planTransaction } from "../spine/op-engine.js"
import { originalDiagramHash } from "../spine/original-diagram.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Flag, Spine } from "../spine/spine.types.js"
import type { EntityItem } from "./extracted-entities.js"
import { imageRereadOps, rereadOps, touchedPath } from "./reread-jobs.js"

const flag = (over: Partial<Flag>): Flag =>
  ({
    id: "FL001",
    level: "yellow",
    rule_id: "import_image_unread",
    section_id: "fixed:2.2.1",
    target_id: "B0010",
    message: 'Ảnh trong mục "Use Case Diagram" không đọc được thành dữ liệu (AI đọc ảnh đang quá tải, chưa đọc được) — đã giữ ảnh gốc',
    remediation_step: "C-1",
    opened_at_version: 1,
    resolved_at: null,
    waived_by_user: false,
    waive_reason: null,
    waived_at_version: null,
    ...over
  }) as Flag

const spine = (): Spine => {
  const empty = createEmptySpine({ name: "FAP" })
  return {
    ...empty,
    actors: [
      { id: "A01", name: "Lecturer", kind: "human", description: "Teaches classes." },
      { id: "A02", name: "Student", kind: "human", description: "" }
    ],
    use_cases: [{ id: "UC01", name: "Take Attendance", actor_ids: ["A01"], description: "Mark students.", includes: [], extends: [], function_ids: [] }],
    custom_sections: [
      { id: "CS01", heading: "", level: 2, source: "import", blocks: [{ kind: "image", text: "Use Cases — Lecturer", rows: null, image_ref: "word/media/image1.png", diagram: { kind: "usecase", source_hash: "inferred" } }] }
    ],
    flags: [flag({}), flag({ id: "FL002", target_id: "B0099" })]
  } as Spine
}

const item = (entity: string, id: string | null, value: Record<string, unknown>): EntityItem => ({ entity, id, value, confidence: 0.7, field_confidence: {}, source_block_ids: ["B0010"], origin: "vision" })

const apply = (s: Spine, ops: ReturnType<typeof rereadOps>) => planTransaction(s, { base_version: s.spine_version, ops, by: "import" }, { startSeq: 1 }).spine

describe("FLF-360 rereadOps — phần đọc lại từ ảnh vào Spine đã có", () => {
  it("phần tử đã có: nối thêm quan hệ (ghi bằng tên hay mã khác dạng), không ghi đè field đã có chữ; điền field đang trống", () => {
    const s = spine()
    const ops = rereadOps(s, [
      item("use_cases", "UC01", { actor_ids: ["Student", "A-01"], description: "Drawn from the diagram" }),
      item("actors", "A02", { description: "Learner of FAP." })
    ])
    const after = apply(s, ops)
    expect(after.use_cases[0]).toMatchObject({ actor_ids: ["A01", "A02"], description: "Mark students." })
    expect(after.actors.find((a) => a.id === "A02")?.description).toBe("Learner of FAP.")
    expect(ops.every((o) => o.reason)).toBe(true)
  })

  it("phần tử mới (use case chỉ có trên hình) ⇒ thêm như import, tham chiếu actor phân giải theo tên", () => {
    const s = spine()
    const after = apply(s, rereadOps(s, [item("use_cases", "UC02", { name: "View Timetable", actor_ids: ["Student"] })]))
    expect(after.use_cases.map((u) => [u.id, u.actor_ids])).toEqual([
      ["UC01", ["A01"]],
      ["UC02", ["A02"]]
    ])
  })

  it("phần tử mới + phần tử cũ nối tới nó trong cùng một ảnh (use case cũ nối thêm actor mới) ⇒ quan hệ phân giải được", () => {
    const s = spine()
    const after = apply(s, rereadOps(s, [item("actors", "A03", { name: "Guest", kind: "human" }), item("use_cases", "UC01", { actor_ids: ["Guest"] })]))
    expect(after.actors.map((a) => a.id)).toEqual(["A01", "A02", "A03"])
    expect(after.use_cases[0].actor_ids).toEqual(["A01", "A03"])
  })

  it("không có gì mới ⇒ không op", () => {
    expect(rereadOps(spine(), [item("use_cases", "UC01", { actor_ids: ["Lecturer"] })])).toEqual([])
  })
})

describe("FLF-360 imageRereadOps — dữ liệu + gắn sơ đồ gốc + đóng cờ của đúng ảnh", () => {
  it("khối ảnh gắn diagram loại thật với hash dữ liệu SAU lô; chỉ đóng cờ import_image_unread của ảnh đó", () => {
    const s = spine()
    const read = { status: "read" as const, kind: "usecase" as const, items: [item("use_cases", "UC01", { actor_ids: ["Student"] })], usageId: "u1" }
    const ops = imageRereadOps(s, read, { block_id: "B0010", image_ref: "word/media/image1.png" }, "2026-11-06T10:00:00.000Z")
    const after = apply(s, ops)
    expect(after.custom_sections[0].blocks[0].diagram).toEqual({ kind: "usecase", source_hash: originalDiagramHash(after, "usecase") })
    expect(after.flags.map((f) => [f.id, f.resolved_at])).toEqual([
      ["FL001", "2026-11-06T10:00:00.000Z"],
      ["FL002", null]
    ])
  })

  it("ảnh đọc ra không phải 4 loại sơ đồ gốc (\"other\") ⇒ không gắn diagram, vẫn đóng cờ (đã đọc, không còn quá tải)", () => {
    const s = spine()
    const ops = imageRereadOps(s, { status: "read", kind: "other", items: [], usageId: "u1" }, { block_id: "B0010", image_ref: "word/media/image1.png" }, "2026-11-06T10:00:00.000Z")
    expect(ops.map((o) => o.path)).toEqual(["flags[id=FL001].resolved_at"])
  })
})

describe("FLF-360 touchedPath — path cho dấu đoạn FLF-366", () => {
  it("op thêm phần tử ⇒ path theo id; op khác giữ nguyên", () => {
    expect(touchedPath({ op: "add", path: "actors[]", value: { id: "A03", name: "Guest" } })).toBe("actors[id=A03]")
    expect(touchedPath({ op: "add", path: "screens[id=S1].flow_to[]", value: { to: "S2" } })).toBe("screens[id=S1].flow_to[]")
    expect(touchedPath({ op: "set", path: "use_cases[id=UC01].actor_ids", value: ["A01"] })).toBe("use_cases[id=UC01].actor_ids")
  })
})
