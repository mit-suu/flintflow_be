/**
 * FLF-480 (B13): "Gửi lại gói làm mất lý do vòng Yêu cầu sửa" — `submitPackage` ghi đè `baseline_submission` mỗi lần
 * gửi lại nên lý do vòng trước chỉ còn ở change log. `getPackage` phải dựng lại `rounds` từ đó.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Hoisted mocks (review-package.service phụ thuộc nhiều module khác) ─────

const state = vi.hoisted(() => ({ record: null as Record<string, unknown> | null }))
const changeLog = vi.hoisted(() => [] as { path: string; value: unknown; at: string; by: string; seq: number }[])

vi.mock("../../shared/db/transaction.js", () => ({
  runInTransaction: vi.fn(async (cb: (session?: unknown) => unknown) => cb()),
  sessionOptions: vi.fn(() => ({})),
  TRANSACTION_UNAVAILABLE: Symbol("TRANSACTION_UNAVAILABLE")
}))

vi.mock("../template-migration/migration-guard.js", () => ({
  assertNoMigrationRunning: vi.fn().mockResolvedValue(undefined)
}))

vi.mock("../notification/notification.service.js", () => ({
  notify: vi.fn().mockResolvedValue(null)
}))

vi.mock("../organization/membership.model.js", () => ({
  Membership: {
    find: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }) })
  }
}))

vi.mock("../import/mode1-guard.js", () => ({
  mode1RuleProfileFor: vi.fn().mockResolvedValue({})
}))

vi.mock("../spine/flags.service.js", () => ({
  recompute: vi.fn().mockResolvedValue({ checked_at_version: 5, flags: [] })
}))

vi.mock("../change-request/change-request.model.js", () => ({
  ChangeRequest: { find: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }) }
}))

// Không có bản release nào — mọi change kể "từ đầu" đều tính vào rounds.
vi.mock("./doc-version.service.js", () => ({
  listDocVersions: vi.fn().mockResolvedValue([{ version: "0.1", kind: "cr_revision", cr_ids: ["CR-01"], createdAt: new Date(0) }])
}))

vi.mock("../spine/spine.repository.js", () => ({
  get: vi.fn(async () => state.record),
  listChanges: vi.fn(async () => changeLog),
  SPINE_NOT_FOUND: "SPINE_NOT_FOUND",
  SPINE_VERSION_CONFLICT: "SPINE_VERSION_CONFLICT"
}))

vi.mock("../spine/op-engine.js", () => ({
  applyTransaction: vi.fn(async (_projectId: string, args: { base_version: number; ops: { path: string; value: unknown }[]; by: string }) => {
    for (const op of args.ops) {
      changeLog.push({ path: op.path, value: op.value, at: new Date().toISOString(), by: args.by, seq: changeLog.length + 1 })
      if (op.path === "baseline_submission") state.record!.baseline_submission = op.value
    }
    state.record!.spine_version = args.base_version + 1
    return { spine_version: state.record!.spine_version }
  })
}))

// ── Import under test (sau mọi vi.mock) ────────────────────────────────────
import { submitPackage, requestChanges, getPackage } from "./review-package.service.js"

const BA = { projectId: "p1", projectName: "Project Alpha", orgId: "o1", userId: "u-ba" }
const LEAD = { ...BA, userId: "u-lead" }

describe("FLF-480 (B13): rounds giữ lý do các vòng Yêu cầu sửa trước", () => {
  beforeEach(() => {
    changeLog.length = 0
    state.record = { spine_version: 1, baseline_submission: null, flags: [] }
  })

  it("gửi gói ⇒ yêu cầu sửa (lý do A) ⇒ gửi lại ⇒ rounds[0].reason === A", async () => {
    await submitPackage(BA, state.record!.spine_version as number)
    await requestChanges(LEAD, { base_version: state.record!.spine_version as number, reason: "A" })
    await submitPackage(BA, state.record!.spine_version as number)

    const pkg = await getPackage("p1")
    expect(pkg.status).toBe("pending")
    expect(pkg.rounds).toHaveLength(1)
    expect(pkg.rounds[0]).toMatchObject({ decided_by: "u-lead", reason: "A" })
  })

  it("2 vòng yêu cầu sửa liên tiếp ⇒ rounds có cả 2, mới nhất trước", async () => {
    await submitPackage(BA, state.record!.spine_version as number)
    await requestChanges(LEAD, { base_version: state.record!.spine_version as number, reason: "A" })
    await submitPackage(BA, state.record!.spine_version as number)
    await requestChanges(LEAD, { base_version: state.record!.spine_version as number, reason: "B" })
    await submitPackage(BA, state.record!.spine_version as number)

    const pkg = await getPackage("p1")
    expect(pkg.rounds.map((r) => r.reason)).toEqual(["B", "A"])
  })

  it("Lead vừa yêu cầu sửa, chưa gửi lại ⇒ vòng đó hiện ở submission, KHÔNG lặp lại trong rounds", async () => {
    await submitPackage(BA, state.record!.spine_version as number)
    await requestChanges(LEAD, { base_version: state.record!.spine_version as number, reason: "A" })

    const pkg = await getPackage("p1")
    expect(pkg.status).toBe("changes_requested")
    expect(pkg.submission?.reason).toBe("A")
    expect(pkg.rounds).toHaveLength(0)
  })

  it("chưa từng bị yêu cầu sửa ⇒ rounds rỗng", async () => {
    await submitPackage(BA, state.record!.spine_version as number)
    const pkg = await getPackage("p1")
    expect(pkg.rounds).toEqual([])
  })
})
