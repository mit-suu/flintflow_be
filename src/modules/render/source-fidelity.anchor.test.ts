import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RenderedDocument } from "./rendered-document.types.js"

const store = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  profile: null as Record<string, unknown> | null,
  /** Lần đổi mẫu đã áp dụng mới nhất (`null` = chưa có bản ghi). */
  migration: null as Record<string, unknown> | null
}))

vi.mock("../template-migration/template-migration.model.js", () => ({
  TemplateMigration: {
    findOne: () => ({ sort: () => ({ lean: async () => store.migration }) }),
    findById: (id: string) => ({ lean: async () => (store.migration && String(store.migration._id) === id ? store.migration : null) })
  }
}))

vi.mock("../project/project.model.js", () => ({ Project: { findById: () => ({ lean: async () => store.project }) } }))
vi.mock("../import/template-profile.model.js", () => ({
  TemplateProfile: {
    findOne: (query: Record<string, unknown>) => ({
      lean: async () => (query.migrated_base_at && !store.profile?.migrated_base_at ? null : store.profile)
    })
  }
}))
vi.mock("../doc-version/doc-version.model.js", () => ({
  DocVersion: { findOne: () => ({ sort: () => ({ lean: async () => ({ spine_snapshot: { marker: "imported" } }) }) }) }
}))

const { sourceFidelityFor, currentFidelityAnchor } = await import("./source-fidelity.js")

const doc = (body: string): RenderedDocument => ({
  projectId: "p", projectName: "Demo", version: "v1.0", source: "draft", generatedAt: "2026-11-10T00:00:00Z", recordOfChanges: [],
  sections: [{ id: "fixed:1", number: "1", heading: "1. Intro", level: 1, blocks: [{ type: "paragraph", runs: [{ text: body }] }] }]
})

const migratedProfile = { source_file_ref: "new-base", migrated_base_at: new Date("2026-11-10"), migrated_base_spine: { marker: "migrated" } }

beforeEach(() => {
  store.migration = null
  store.project = { start_kind: "existing", template_intent: "fixed", mode: "import", converted_from: null }
  store.profile = { source_file_ref: "file", target_structure: { resolved_mode: 1 }, migrated_base_at: null, flow2_entry_spine: null }
})

describe("mốc nguyên vẹn của version", () => {
  it("currentFidelityAnchor chốt mốc theo trạng thái dự án lúc đó", async () => {
    expect(await currentFidelityAnchor("p")).toEqual({ source_based: true, by_id: false, ref: null })
    // Đã đổi mẫu: tham chiếu tới migration (binding không nhúng Spine); chưa có bản ghi migration ⇒ nhúng như cũ
    store.profile = migratedProfile
    store.migration = { _id: "m1", anchor_spine: { marker: "anchor-of-migration" } }
    expect(await currentFidelityAnchor("p")).toEqual({ source_based: true, by_id: true, ref: { kind: "migration", id: "m1" } })
    store.migration = null
    expect(await currentFidelityAnchor("p")).toEqual({ source_based: true, by_id: true, spine: { marker: "migrated" } })
    store.project = { start_kind: "new", template_intent: "free", mode: "fpt", converted_from: null }
    store.profile = { source_file_ref: "file", target_structure: null, migrated_base_at: null }
    expect(await currentFidelityAnchor("p")).toEqual({ source_based: false, by_id: false, ref: null })
  })

  it("in lại version có mốc tham chiếu migration: lấy Spine mốc từ migration (bất biến), không từ profile hiện tại", async () => {
    store.profile = { ...migratedProfile, migrated_base_spine: { marker: "profile-now" } }
    store.migration = { _id: "m1", anchor_spine: { marker: "anchor-of-migration" } }
    const rendered: unknown[] = []
    await sourceFidelityFor("p", doc("same"), async (spine) => { rendered.push(spine); return doc("same") }, { anchor: { source_based: true, by_id: true, ref: { kind: "migration", id: "m1" } } })
    expect(rendered).toEqual([{ marker: "anchor-of-migration" }])
  })

  it("in lại version cũ sau đổi mẫu: dùng mốc của version, không dùng Spine lúc đổi mẫu", async () => {
    store.profile = migratedProfile
    const rendered: unknown[] = []
    const fidelity = await sourceFidelityFor("p", doc("same"), async (spine) => { rendered.push(spine); return doc("same") }, {
      anchor: { source_based: true, by_id: false, spine: null }
    })
    expect(rendered).toEqual([{ marker: "imported" }])
    expect(fidelity?.keepSource).toEqual(new Set(["fixed:1"]))
  })

  it("mốc nói version không có file nền ⇒ không giữ nguyên văn, dù profile hiện tại đã có file nền mới", async () => {
    store.profile = migratedProfile
    expect(await sourceFidelityFor("p", doc("x"), async () => doc("x"), { anchor: { source_based: false, by_id: false, spine: null } })).toBeUndefined()
  })

  it("mốc đã đổi mẫu mang Spine riêng và neo theo section_id", async () => {
    const renamed = doc("same")
    renamed.sections[0].heading = "1. Introduction"
    const rendered: unknown[] = []
    const fidelity = await sourceFidelityFor("p", renamed, async (spine) => { rendered.push(spine); return doc("same") }, {
      anchor: { source_based: true, by_id: true, spine: { marker: "anchor-spine" } as never }
    })
    expect(rendered).toEqual([{ marker: "anchor-spine" }])
    expect(fidelity?.keepSource).toEqual(new Set(["fixed:1"]))
  })

  it("version cũ chưa có mốc: lần đổi mẫu xảy ra sau khi tạo version bị bỏ qua", async () => {
    store.profile = { ...migratedProfile, flow2_entry_spine: null, target_structure: { resolved_mode: 1 } }
    const rendered: unknown[] = []
    await sourceFidelityFor("p", doc("x"), async (spine) => { rendered.push(spine); return doc("x") }, { versionCreatedAt: new Date("2026-11-01") })
    expect(rendered).toEqual([{ marker: "imported" }])
    // Version tạo sau lần đổi mẫu ⇒ theo mốc đổi mẫu hiện tại
    const after: unknown[] = []
    await sourceFidelityFor("p", doc("x"), async (spine) => { after.push(spine); return doc("x") }, { versionCreatedAt: new Date("2026-11-20") })
    expect(after).toEqual([{ marker: "migrated" }])
  })
})
