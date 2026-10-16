import { beforeEach, describe, expect, it, vi } from "vitest"
import mongoose from "mongoose"
import type { Spine } from "../spine/spine.types.js"

const docs = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
const sources = vi.hoisted(() => ({ upserts: [] as Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }>, rows: [] as Array<Record<string, unknown>> }))

const chain = (rows: () => unknown[]) => ({ select: () => ({ lean: async () => rows(), sort: () => ({ lean: async () => rows() }) }), sort: () => ({ lean: async () => rows() }) })

vi.mock("./project-document.model.js", () => ({
  ProjectDocument: {
    find: (filter: { docCode?: { $in: number[] }; _id?: { $in: string[] } }) =>
      chain(() =>
        docs.rows.filter((d) =>
          filter.docCode ? filter.docCode.$in.includes(d.docCode as number) : filter._id ? filter._id.$in.includes(String(d._id)) : true
        )
      )
  }
}))

vi.mock("./requirement-source.model.js", () => ({
  RequirementSource: {
    updateOne: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      sources.upserts.push({ filter, update })
    },
    find: () => chain(() => sources.rows)
  }
}))

const { captureSources, entityExists, entityPathOf, listSources, resolveParagraphs } = await import("./requirement-source.service.js")

const DOC_ID = new mongoose.Types.ObjectId()
const MINUTES = "Biên bản họp kick-off\n\nKhách hàng, người bán và admin dùng hệ thống.\n\nThanh toán xong trong 3 giây."

const spine = {
  project: { name: "Shop", vision: "Sell online" },
  functions: [{ id: "FN1" }],
  nfrs: [{ id: "N03" }],
  use_cases: [],
  actors: [{ id: "A01" }]
} as unknown as Spine

beforeEach(() => {
  docs.rows = [{ _id: DOC_ID, docCode: 1, extractedText: MINUTES, originalName: "bien-ban.docx" }]
  sources.upserts = []
  sources.rows = []
})

describe("entityPathOf", () => {
  it("cắt path field về phần tử", () => {
    expect(entityPathOf("functions[id=FN12].normal")).toBe("functions[id=FN12]")
    expect(entityPathOf("nfrs[id=N03]")).toBe("nfrs[id=N03]")
    expect(entityPathOf("project.vision")).toBe("project.vision")
    expect(entityPathOf("project.goals[=Grow]")).toBe("project.goals")
  })

  it("path không trỏ được phần tử ⇒ null", () => {
    for (const bad of ["functions[]", "permissions[screen_id=S1,role_id=R1,action=view]", "assumptions[id=AS1]", "steps[id=B-0.1]", "x"]) {
      expect(entityPathOf(bad), bad).toBeNull()
    }
  })
})

describe("entityExists", () => {
  it("phần tử có trong mảng hoặc field của project", () => {
    expect(entityExists(spine, "functions[id=FN1]")).toBe(true)
    expect(entityExists(spine, "functions[id=FN9]")).toBe(false)
    expect(entityExists(spine, "project.vision")).toBe(true)
    expect(entityExists(spine, "project.nope")).toBe(false)
  })
})

describe("resolveParagraphs", () => {
  it("tra mã ⇒ chữ đoạn; mã sai khuôn, tài liệu lạ, đoạn ngoài tầm bị bỏ", async () => {
    const out = await resolveParagraphs("p1", ["D1-P03", "d1-p02", "D2-P01", "D1-P09", "K1"])
    expect([...out.keys()].sort()).toEqual(["D1-P02", "D1-P03"])
    expect(out.get("D1-P03")).toEqual({ document_id: DOC_ID, para_id: "D1-P03", quote: "Thanh toán xong trong 3 giây." })
  })
})

describe("captureSources", () => {
  it("lưu nguồn của phần tử có thật, gộp mục cùng phần tử, bỏ mã bịa", async () => {
    const saved = await captureSources("p1", "S-6.4", spine, [
      { path: "nfrs[id=N03].statement", paras: ["D1-P03"] },
      { path: "nfrs[id=N03].threshold", paras: ["D1-P03", "D1-P99"] },
      { path: "actors[id=A01]", paras: ["D1-P02"] }
    ])
    expect(saved).toBe(2)
    const n03 = sources.upserts.find((u) => u.filter.entity_path === "nfrs[id=N03]")
    expect(n03?.update).toEqual({ $set: { refs: [{ document_id: DOC_ID, para_id: "D1-P03", quote: "Thanh toán xong trong 3 giây." }], step_id: "S-6.4" } })
  })

  it("phần tử không có trong Spine sau lô, hoặc không mã nào tra được ⇒ không lưu", async () => {
    const saved = await captureSources("p1", "S-5.4", spine, [
      { path: "functions[id=FN9]", paras: ["D1-P02"] },
      { path: "functions[id=FN1]", paras: ["D7-P01"] }
    ])
    expect(saved).toBe(0)
    expect(sources.upserts).toEqual([])
  })

  it("không có mục nào ⇒ không đụng DB", async () => {
    expect(await captureSources("p1", "S-1.1", spine, undefined)).toBe(0)
    expect(await captureSources("p1", "S-1.1", spine, [])).toBe(0)
  })
})

describe("listSources", () => {
  it("bỏ phần tử đã xoá khỏi Spine, kèm tên tài liệu (đã xoá ⇒ null)", async () => {
    const gone = new mongoose.Types.ObjectId()
    const at = new Date("2026-10-17T00:00:00.000Z")
    sources.rows = [
      { entity_path: "nfrs[id=N03]", step_id: "S-6.4", updatedAt: at, refs: [{ document_id: DOC_ID, para_id: "D1-P03", quote: "q" }] },
      { entity_path: "functions[id=FN1]", step_id: "S-5.4", updatedAt: at, refs: [{ document_id: gone, para_id: "D2-P01", quote: "q2" }] },
      { entity_path: "functions[id=FN9]", step_id: "S-5.4", updatedAt: at, refs: [] }
    ]
    expect(await listSources("p1", spine)).toEqual([
      { path: "nfrs[id=N03]", step_id: "S-6.4", updated_at: at.toISOString(), refs: [{ para_id: "D1-P03", document_id: String(DOC_ID), document_name: "bien-ban.docx", quote: "q" }] },
      { path: "functions[id=FN1]", step_id: "S-5.4", updated_at: at.toISOString(), refs: [{ para_id: "D2-P01", document_id: String(gone), document_name: null, quote: "q2" }] }
    ])
  })
})
