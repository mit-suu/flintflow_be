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

describe("draftVersionLabel — FLF-295", () => {
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
