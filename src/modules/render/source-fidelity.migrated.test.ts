import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RenderedDocument } from "./rendered-document.types.js"

const store = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  profile: null as Record<string, unknown> | null,
  importedVersion: { spine_snapshot: { marker: "imported" } } as Record<string, unknown> | null
}))

vi.mock("../project/project.model.js", () => ({ Project: { findById: () => ({ lean: async () => store.project }) } }))
vi.mock("../import/template-profile.model.js", () => ({
  TemplateProfile: {
    findOne: (query: Record<string, unknown>) => ({
      // truy vấn mốc đổi mẫu chỉ có kết quả khi profile đã ghi migrated_base_at
      lean: async () => (query.migrated_base_at && !store.profile?.migrated_base_at ? null : store.profile)
    })
  }
}))
vi.mock("../doc-version/doc-version.model.js", () => ({ DocVersion: { findOne: () => ({ sort: () => ({ lean: async () => store.importedVersion }) }) } }))

const { sourceFidelityFor, isSourceBasedProject } = await import("./source-fidelity.js")

const doc = (body: string): RenderedDocument => ({
  projectId: "p",
  projectName: "Demo",
  version: "v1.0",
  source: "draft",
  generatedAt: "2026-11-10T00:00:00Z",
  recordOfChanges: [],
  sections: [{ id: "fixed:1", number: "1", heading: "1. Intro", level: 1, blocks: [{ type: "paragraph", runs: [{ text: body }] }] }]
})

describe("sourceFidelityFor sau khi đổi mẫu", () => {
  beforeEach(() => {
    store.project = { start_kind: "existing", template_intent: "free", mode: "fpt", converted_from: null }
    store.profile = { source_file_ref: "new-base", target_structure: null, migrated_base_at: new Date("2026-11-10"), migrated_base_spine: { marker: "migrated" }, flow2_entry_spine: { marker: "flow2" } }
  })

  it("dự án mode 2 (chưa từng có file nền) đã đổi mẫu: dùng file mới làm nền, mốc nguyên vẹn là Spine lúc đổi mẫu", async () => {
    expect(await isSourceBasedProject("p")).toBe(true)
    const rendered: unknown[] = []
    const fidelity = await sourceFidelityFor("p", doc("same"), async (spine) => {
      rendered.push(spine)
      return doc("same")
    })
    expect(rendered).toEqual([{ marker: "migrated" }])
    expect(fidelity?.keepSource).toEqual(new Set(["fixed:1"]))
  })

  it("đã đổi mẫu: heading mục khung do mẫu đích đặt không làm mất nguyên vẹn; chưa đổi mẫu thì có", async () => {
    const renamed = doc("same")
    renamed.sections[0].heading = "1. Introduction"
    const fidelity = await sourceFidelityFor("p", renamed, async () => doc("same"))
    expect(fidelity?.keepSource).toEqual(new Set(["fixed:1"]))

    store.project = { start_kind: "existing", template_intent: "free", mode: "import", converted_from: null }
    store.profile = { source_file_ref: "file", target_structure: { resolved_mode: 1 }, migrated_base_at: null, flow2_entry_spine: null }
    const before = await sourceFidelityFor("p", renamed, async () => doc("same"))
    expect(before?.keepSource).toEqual(new Set())
  })

  it("mục sửa sau khi đổi mẫu không nguyên vẹn", async () => {
    const fidelity = await sourceFidelityFor("p", doc("edited later"), async () => doc("same"))
    expect(fidelity?.keepSource).toEqual(new Set())
  })

  it("chưa đổi mẫu, mode fpt: giữ đường cũ (không có file nền)", async () => {
    store.profile = { source_file_ref: "file", target_structure: { resolved_mode: 1 }, migrated_base_at: null }
    expect(await isSourceBasedProject("p")).toBe(false)
    expect(await sourceFidelityFor("p", doc("x"), async () => doc("x"))).toBeUndefined()
  })

  it("chưa đổi mẫu, chế độ 1: mốc vẫn là Spine lúc import", async () => {
    store.project = { start_kind: "existing", template_intent: "free", mode: "import", converted_from: null }
    store.profile = { source_file_ref: "file", target_structure: { resolved_mode: 1 }, migrated_base_at: null, flow2_entry_spine: null }
    const rendered: unknown[] = []
    await sourceFidelityFor("p", doc("x"), async (spine) => {
      rendered.push(spine)
      return doc("x")
    })
    expect(rendered).toEqual([{ marker: "imported" }])
  })
})
