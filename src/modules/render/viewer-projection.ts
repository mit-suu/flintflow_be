import type { RenderedDocument } from "./rendered-document.types.js"
import type { PipelineProgressReport } from "../pipeline/pipeline-progress.js"

/**
 * Bản dành cho Viewer (UC-47/48, UC-20): không cờ (phụ lục cờ, số cờ đỏ), không trạng thái làm việc nội bộ
 * (chờ duyệt lại, "cũ"). Mục chưa xong vẫn là `draft` để FE ghi "chưa hoàn thiện".
 */
export const viewerDocument = (doc: RenderedDocument): RenderedDocument => {
  const { flagsAppendix: _flags, ...rest } = doc
  return {
    ...rest,
    sections: doc.sections.map(({ awaiting_reaccept: _awaiting, ...section }) =>
      section.status === "stale" ? { ...section, status: "draft" as const } : section
    )
  }
}

export const viewerProgress = (report: PipelineProgressReport): PipelineProgressReport => ({
  ...report,
  readiness: { ...report.readiness, red_open: 0, awaiting_reaccept: 0, stale: 0 },
  sections: report.sections.map((s) => ({ ...s, awaiting_reaccept: false, status: s.status === "stale" ? "draft" : s.status }))
})
