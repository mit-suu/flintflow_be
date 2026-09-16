import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi, beforeEach } from "vitest"

/** Store trong bộ nhớ thay model Mongoose — cùng ngữ nghĩa op-engine.test.ts (T08). */
const db = vi.hoisted(() => {
  type Doc = Record<string, unknown>
  type Filter = Record<string, unknown>
  const spines: Doc[] = []
  const changes: Doc[] = []
  const baselines: Doc[] = []
  let baselineSeq = 0
  const copy = <X>(x: X): X => structuredClone(x)
  const matches = (doc: Doc, filter: Filter): boolean =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key]
      if (typeof expected === "object" && expected !== null) {
        const e = expected as { $gte?: number; $lte?: number; $in?: unknown[] }
        if (e.$in) return e.$in.map(String).includes(String(actual))
        const n = Number(actual)
        return (e.$gte === undefined || n >= e.$gte) && (e.$lte === undefined || n <= e.$lte)
      }
      return String(actual) === String(expected)
    })
  const bySeq = (a: Doc, b: Doc) => Number(a.seq) - Number(b.seq)
  const Spine = {
    findOne: async (filter: Filter) => copy(spines.find((s) => matches(s, filter)) ?? null),
    exists: async (filter: Filter) => (spines.some((s) => matches(s, filter)) ? { _id: "x" } : null),
    findOneAndUpdate: async (filter: Filter, update: { $set?: Doc; $setOnInsert?: Doc }, options: { upsert?: boolean } = {}) => {
      const doc = spines.find((s) => matches(s, filter))
      if (doc) {
        Object.assign(doc, copy(update.$set ?? {}))
        return copy(doc)
      }
      if (!options.upsert) return null
      const created = { _id: "spine", ...filter, ...copy(update.$setOnInsert ?? {}) }
      spines.push(created)
      return copy(created)
    }
  }
  const Change = {
    findOne: async (filter: Filter, _p: unknown, options: { sort?: { seq?: number } } = {}) => {
      const rows = changes.filter((c) => matches(c, filter)).sort(bySeq)
      return copy((options.sort?.seq === -1 ? rows[rows.length - 1] : rows[0]) ?? null)
    },
    find: async (filter: Filter) => changes.filter((c) => matches(c, filter)).sort(bySeq).map(copy),
    insertMany: async (docs: Doc[]) => {
      if (docs.some((d) => changes.some((c) => String(c.projectId) === String(d.projectId) && c.seq === d.seq))) {
        throw Object.assign(new Error("E11000"), { code: 11000 })
      }
      changes.push(...docs.map(copy))
      return docs.map(copy)
    },
    deleteMany: async (filter: Filter) => {
      for (let i = changes.length - 1; i >= 0; i--) if (matches(changes[i], filter)) changes.splice(i, 1)
      return {}
    }
  }
  const Baseline = {
    create: async (doc: Doc) => {
      // Unique (projectId, version) như index thật
      if (baselines.some((b) => String(b.projectId) === String(doc.projectId) && b.version === doc.version)) {
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 })
      }
      const created = { _id: `bl${++baselineSeq}`, ...copy(doc) }
      baselines.push(created)
      return created
    },
    findById: async (id: string) => copy(baselines.find((b) => b._id === id) ?? null),
    deleteOne: async (filter: { _id: string }) => {
      const i = baselines.findIndex((b) => b._id === filter._id)
      if (i >= 0) baselines.splice(i, 1)
      return { deletedCount: i >= 0 ? 1 : 0 }
    }
  }
  const reset = () => {
    spines.length = 0
    changes.length = 0
    baselines.length = 0
    baselineSeq = 0
  }
  return { Spine, Change, Baseline, spines, changes, baselines, reset }
})

vi.mock("../../spine/spine.model.js", () => ({ Spine: db.Spine }))
vi.mock("../../spine/change.model.js", () => ({ Change: db.Change }))
vi.mock("../../spine/baseline.model.js", () => ({ Baseline: db.Baseline }))

const notifyMock = vi.hoisted(() => ({ notify: vi.fn(async () => null), notifyAdmins: vi.fn(async () => 0) }))
vi.mock("../../notification/notification.service.js", () => notifyMock)

import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine } from "../../spine/spine.types.js"
import * as repo from "../../spine/spine.repository.js"
import * as flagsService from "../../spine/flags.service.js"
import { applyTransaction } from "../../spine/op-engine.js"
import { BaselineBlockedError, listBaselines, nextBaselineVersion, signOff } from "./baseline.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const PROJECT = "650000000000000000000004"
const USER = "650000000000000000000013"

/**
 * Cờ đỏ phải là cờ THẬT: `signOff` quét lại tất định trước khi ký, nên cờ nhét tay vào `flags[]` mà
 * check không sinh ra sẽ bị chính lượt quét đó đóng. Dùng một giả định chưa xác nhận — luật
 * `unconfirmed_assumption` (đỏ, chỉ chạy ở S-9, waive được) là đúng loại điều kiện chặn baseline.
 */
const withUnconfirmedAssumption = (spine: Spine): void => {
  spine.assumptions.push({
    id: "AS900",
    path: "actors[id=A01].name",
    statement: "Tên actor chính lấy theo cách gọi nội bộ, chưa hỏi lại khách hàng.",
    rationale: "Brief không nói rõ.",
    origin_step_id: "S-3.1",
    status: "unconfirmed",
    confirmed_at: null
  })
}

const seed = async (mutate: (spine: Spine) => void = () => {}): Promise<void> => {
  const spine = structuredClone(FIXTURE)
  mutate(spine)
  await repo.getOrCreate(PROJECT)
  db.spines[0] = { _id: "spine", projectId: PROJECT, ...spine }
}

const version = async (): Promise<number> => (await repo.get(PROJECT))!.spine_version

beforeEach(() => {
  db.reset()
  notifyMock.notify.mockClear()
})

describe("nextBaselineVersion", () => {
  it("đánh số theo thứ tự ký, hậu tố -conditional khi có waive", () => {
    expect(nextBaselineVersion([], 0)).toBe("v1.0")
    expect(nextBaselineVersion([], 2)).toBe("v1.0-conditional")
    expect(nextBaselineVersion([{ id: "BL001" } as never], 0)).toBe("v1.1")
    expect(nextBaselineVersion([{ id: "BL001" } as never, { id: "BL002" } as never], 1)).toBe("v1.2-conditional")
  })
})

describe("signOff — điều kiện ký là cờ đỏ = 0, không phải phần trăm", () => {
  it("fixture sạch cờ đỏ ⇒ v1.0, snapshot lưu, step S-9.5 accepted, có notify", async () => {
    await seed()
    const result = await signOff(PROJECT, USER, { base_version: await version() })

    expect(result.baseline.version).toBe("v1.0")
    expect(result.baseline.waived_count).toBe(0)
    expect(result.baseline.snapshot_ref).toBeTruthy()

    // Snapshot là bản sao sâu, parse lại được bằng chính spineSchema
    const stored = await db.Baseline.findById(result.baseline.snapshot_ref)
    expect(spineSchema.safeParse((stored as { snapshot: unknown }).snapshot).success).toBe(true)

    const after = (await repo.get(PROJECT))!
    expect(after.baselines).toHaveLength(1)
    expect(after.steps.find((s) => s.id === "S-9.5")?.status).toBe("accepted")
    expect(notifyMock.notify).toHaveBeenCalledTimes(1)
  })

  it("luật chỉ chạy ở S-9 mở cờ đỏ ⇒ 422 BASELINE_BLOCKED kèm danh sách, không ghi baseline", async () => {
    await seed(withUnconfirmedAssumption)

    const err = await signOff(PROJECT, USER, { base_version: await version() }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BaselineBlockedError)
    expect((err as BaselineBlockedError).statusCode).toBe(422)
    expect((err as BaselineBlockedError).code).toBe("BASELINE_BLOCKED")
    expect((err as BaselineBlockedError).flags.map((f) => f.rule_id)).toContain("unconfirmed_assumption")

    expect((await repo.get(PROJECT))!.baselines).toHaveLength(0)
    expect(db.baselines, "không để lại snapshot mồ côi").toHaveLength(0)
  })

  it("waive cờ đó rồi ký ⇒ v1.0-conditional, waived_count = 1", async () => {
    await seed(withUnconfirmedAssumption)

    // Lượt ký đầu bị chặn nhưng đã mở cờ — waive chính cờ vừa mở, rồi ký lại
    await expect(signOff(PROJECT, USER, { base_version: await version() })).rejects.toBeInstanceOf(BaselineBlockedError)
    const opened = (await repo.get(PROJECT))!.flags.find((f) => f.rule_id === "unconfirmed_assumption" && f.resolved_at === null)!
    await flagsService.waive(PROJECT, opened.id, "Giả định này chốt ở bản sau, khách hàng đã đồng ý", USER)

    const result = await signOff(PROJECT, USER, { base_version: await version() })
    expect(result.baseline.version).toBe("v1.0-conditional")
    expect(result.baseline.waived_count).toBe(1)
    expect(result.waived.map((f) => f.id)).toEqual([opened.id])
  })

  it("ký lần hai ra v1.1, cả hai snapshot cùng tồn tại", async () => {
    await seed()
    const first = await signOff(PROJECT, USER, { base_version: await version() })
    const second = await signOff(PROJECT, USER, { base_version: await version() })

    expect([first.baseline.version, second.baseline.version]).toEqual(["v1.0", "v1.1"])
    expect([first.baseline.id, second.baseline.id]).toEqual(["BL001", "BL002"])
    expect(db.baselines).toHaveLength(2)
    expect((await repo.get(PROJECT))!.baselines).toHaveLength(2)
  })

  it("base_version lệch ⇒ 409, không quét, không ghi", async () => {
    await seed()
    await expect(signOff(PROJECT, USER, { base_version: 999 })).rejects.toMatchObject({
      statusCode: 409,
      code: "SPINE_VERSION_CONFLICT"
    })
    expect(db.baselines).toHaveLength(0)
  })

  it("Spine đổi giữa lúc quét và lúc ký ⇒ 409; quét lại rồi ký thì được", async () => {
    await seed()

    // Chen một transaction vào đúng giữa: recompute xong thì version đã lệch
    const realGet = repo.get
    const spy = vi.spyOn(repo, "get")
    let calls = 0
    spy.mockImplementation(async (projectId: string) => {
      const record = await realGet(projectId)
      calls += 1
      // lần gọi thứ 2 = ngay sau recompute, trước khi kiểm cờ
      if (calls === 2) {
        await applyTransaction(PROJECT, {
          base_version: record!.spine_version,
          ops: [{ op: "set", path: "actors[id=A01].name", value: "Người khác sửa" }],
          by: "someone-else"
        })
      }
      return record
    })

    await expect(signOff(PROJECT, USER, { base_version: await realGet(PROJECT).then((r) => r!.spine_version) })).rejects.toMatchObject({
      statusCode: 409,
      code: "SPINE_VERSION_CONFLICT"
    })
    spy.mockRestore()

    expect(db.baselines, "không để lại snapshot mồ côi").toHaveLength(0)

    const retried = await signOff(PROJECT, USER, { base_version: await version() })
    expect(retried.baseline.version).toBe("v1.0")
  })

  it("không gọi model và không ghi usage[] — hết credit vẫn ký được", async () => {
    await seed()
    // `signOff` không import ai-action/meter; kiểm bằng cách không mock chúng mà vẫn chạy trọn.
    const result = await signOff(PROJECT, USER, { base_version: await version() })
    expect(result.baseline.checked_at_version).toBeGreaterThan(0)
  })
})

describe("listBaselines", () => {
  it("trả đúng mảng baselines[] của Spine theo thứ tự ký", async () => {
    await seed()
    await signOff(PROJECT, USER, { base_version: await version() })
    await signOff(PROJECT, USER, { base_version: await version() })

    const list = await listBaselines(PROJECT)
    expect(list.map((b) => b.version)).toEqual(["v1.0", "v1.1"])
  })

  it("project chưa có Spine ⇒ 404 SPINE_NOT_FOUND", async () => {
    await expect(listBaselines("650000000000000000000099")).rejects.toMatchObject({ code: "SPINE_NOT_FOUND" })
  })
})
