import { describe, it, expect } from "vitest"
import { viewerDocument, viewerProgress } from "./viewer-projection.js"
import type { RenderedDocument } from "./rendered-document.types.js"
import type { PipelineProgressReport } from "../pipeline/pipeline-progress.js"

const doc: RenderedDocument = {
  projectId: "p1",
  projectName: "Lumen",
  version: "0.3",
  source: "draft",
  watermark: "DRAFT",
  generatedAt: "2026-10-23T00:00:00.000Z",
  sections: [
    { id: "s1", number: "1", heading: "Intro", level: 1, status: "accepted", blocks: [] },
    { id: "s2", number: "2", heading: "Scope", level: 1, status: "stale", awaiting_reaccept: true, blocks: [] }
  ],
  recordOfChanges: [],
  flagsAppendix: { redOpen: [{ id: "FL1", rule_id: "R1", section: "s2", message: "x" }], staleCount: 1, waived: [] }
}

describe("viewerDocument (UC-47)", () => {
  it("bỏ phụ lục cờ và trạng thái làm việc nội bộ, giữ nội dung", () => {
    const out = viewerDocument(doc)
    expect(out.flagsAppendix).toBeUndefined()
    expect(out.sections[1]).toEqual({ id: "s2", number: "2", heading: "Scope", level: 1, status: "draft", blocks: [] })
    expect(out.sections[0]?.status).toBe("accepted")
    expect(out.watermark).toBe("DRAFT")
  })
})

describe("viewerDocument - đường dẫn phần tử (FLF-443)", () => {
  it("bỏ entity_path / row_entity_paths / item_entity_paths ở mọi block, giữ nguyên phần còn lại", () => {
    const withPaths: RenderedDocument = {
      ...doc,
      sections: [
        {
          id: "s1",
          number: "1",
          heading: "Intro",
          level: 1,
          blocks: [
            { type: "paragraph", runs: [{ text: "p" }], entity_path: "actors[id=A1]" },
            { type: "bullet_list", items: [[{ text: "a" }], [{ text: "b" }]], item_entity_paths: ["nfrs[id=N1]", null] },
            { type: "numbered_list", items: [[{ text: "a" }]], item_entity_paths: [null] },
            { type: "table", header: [[{ text: "h" }]], rows: [[[{ text: "r" }]]], row_entity_paths: ["screens[id=S1]"] },
            { type: "heading", level: 2, text: "H" }
          ]
        }
      ]
    }
    const out = viewerDocument(withPaths)
    expect(out.sections[0]?.blocks).toEqual([
      { type: "paragraph", runs: [{ text: "p" }] },
      { type: "bullet_list", items: [[{ text: "a" }], [{ text: "b" }]] },
      { type: "numbered_list", items: [[{ text: "a" }]] },
      { type: "table", header: [[{ text: "h" }]], rows: [[[{ text: "r" }]]] },
      { type: "heading", level: 2, text: "H" }
    ])
    // bản gốc không bị sửa tại chỗ (Lead / Analyst vẫn thấy path)
    expect(withPaths.sections[0]?.blocks[0]).toHaveProperty("entity_path", "actors[id=A1]")
  })
})

describe("viewerProgress (UC-20)", () => {
  it("Viewer không thấy cờ đỏ / mục cũ", () => {
    const report = {
      readiness: { accepted_pct: 50, awaiting_reaccept: 1, red_open: 3, stale: 1 },
      progress: { done: 1, total: 2, current_phase: null, current_step: null, show_percent: true },
      sections: [{ id: "s2", status: "stale", awaiting_reaccept: true, required: true, derived: false }]
    } as PipelineProgressReport
    const out = viewerProgress(report)
    expect(out.readiness).toEqual({ accepted_pct: 50, awaiting_reaccept: 0, red_open: 0, stale: 0 })
    expect(out.sections[0]).toMatchObject({ status: "draft", awaiting_reaccept: false, required: true })
  })
})
