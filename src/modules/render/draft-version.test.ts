import { describe, it, expect } from "vitest"
import { draftVersionLabel, unreleasedChangeCount } from "./draft-version.js"
import type { Baseline } from "../spine/spine.types.js"

const baseline = (version: string, at: string): Baseline => ({
  id: "BL1",
  version,
  type: "generated",
  doc_version: null,
  at,
  snapshot_ref: "snap",
  checked_at_version: 900,
  waived_count: 0
})

const change = (txn: string, path: string, at: string) => ({ txn, path, at })

describe("draftVersionLabel - FLF-295", () => {
  it("chưa có baseline ⇒ v0, không lộ spine_version", () => {
    expect(draftVersionLabel({ baselines: [] }, [change("t1", "use_cases[id=UC27].name", "2026-10-17T10:00:00.000Z")])).toBe("v0")
  })

  it("có baseline, chưa sửa gì sau đó ⇒ đúng version baseline", () => {
    const spine = { baselines: [baseline("v1.0", "2026-10-17T10:00:00.000Z")] }
    expect(draftVersionLabel(spine, [change("t0", "actors[id=A01].name", "2026-10-16T09:00:00.000Z")])).toBe("v1.0")
  })

  it("đếm theo lô sửa nội dung sau lúc ký; lô hệ thống (cờ, sơ đồ) không tính", () => {
    const spine = { baselines: [baseline("v1.0", "2026-10-17T10:00:00.000Z")] }
    const changes = [
      change("t1", "use_cases[id=UC27]", "2026-10-17T11:00:00.000Z"),
      change("t1", "use_cases[id=UC27].actor_ids", "2026-10-17T11:00:00.000Z"),
      change("t2", "flags[id=FLG9]", "2026-10-17T11:00:01.000Z"),
      change("t3", "diagrams[id=usecase].hash", "2026-10-17T11:00:02.000Z")
    ]
    expect(unreleasedChangeCount(changes, "2026-10-17T10:00:00.000Z")).toBe(1)
    expect(draftVersionLabel(spine, changes)).toBe("v1.0 + 1 change")
    expect(draftVersionLabel(spine, [...changes, change("t4", "screens[id=S20]", "2026-10-17T12:00:00.000Z")])).toBe("v1.0 + 2 changes")
  })
})

describe("unreleasedChangeCount - đổi mẫu (Lỗi #4, BF L113)", () => {
  const since = "2026-11-20T10:00:00.000Z"
  const spine = { baselines: [baseline("0.1", since)] }
  const apply = [
    change("template-migration:abc123", "custom_sections[id=CS09]", "2026-11-20T11:00:00.000Z"),
    change("template-migration:abc123:revert", "custom_sections[id=CS02].blocks", "2026-11-20T11:00:00.000Z")
  ]
  const undo = [change("template-migration:abc123:undo", "custom_sections[id=CS09]", "2026-11-20T12:00:00.000Z")]
  const cr = change("t-cr", "nfrs[id=NFR-06]", "2026-11-20T13:00:00.000Z")

  it("áp dụng + hoàn tác ⇒ triệt tiêu, về đúng version baseline", () => {
    expect(draftVersionLabel(spine, [...apply, ...undo])).toBe("0.1")
  })

  it("chỉ áp dụng (kể cả lô :revert) ⇒ +1 change", () => {
    expect(draftVersionLabel(spine, apply)).toBe("0.1 + 1 change")
  })

  it("áp dụng + hoàn tác + 1 CR ⇒ +1 change", () => {
    expect(draftVersionLabel(spine, [...apply, ...undo, cr])).toBe("0.1 + 1 change")
  })

  it("áp dụng trước khi ký, hoàn tác sau ⇒ hoàn tác là một thay đổi", () => {
    const before = apply.map((c) => ({ ...c, at: "2026-11-19T11:00:00.000Z" }))
    expect(draftVersionLabel(spine, [...before, ...undo])).toBe("0.1 + 1 change")
  })

  it("hai lần đổi mẫu, một lần bị hoàn tác ⇒ chỉ đếm lần còn lại", () => {
    const other = change("template-migration:def456", "custom_sections[id=CS10]", "2026-11-20T14:00:00.000Z")
    expect(unreleasedChangeCount([...apply, ...undo, other], since)).toBe(1)
  })
})
