/**
 * Render lại sơ đồ use case của dự án cũ, chạy một lần.
 *
 * Cách dùng:
 *   npm run rerender:usecase -- --dry-run     # chỉ liệt kê project và số hình, không ghi
 *   npm run rerender:usecase                  # render lại thật
 *
 * Vì sao cần: `source-hash.ts` chỉ hash `actors[]` + `use_cases[]`, không hash code vẽ. Dự án có
 * ≤ 20 use case và `render_status: "ok"` vì thế không bao giờ tự vẽ lại, và `diagram_stale` cũng
 * không bắn — không tín hiệu nào báo rằng `.puml` đang lưu là bản sai chuẩn cũ (mũi tên trên cạnh
 * actor, actor nối thẳng vào use case mở rộng).
 *
 * Dự án ĐÃ tách hình từ trước (`diagrams[]` có `D02-1`, `D02-2`) cũng phải chạy: `assignIds` giữ nguyên
 * id phần đầu nên mọi phần đều trùng id cũ và trùng `source_hash` (hash tính theo TARGET, mọi phần chung
 * một giá trị) ⇒ `unchanged()` giữ nguyên `.puml` sai chuẩn cũ. `force: true` là đường duy nhất thoát.
 *
 * Hai tuỳ chọn BẮT BUỘC khi gọi `renderDiagram`:
 * - `force: true` — `source_hash` không đổi nên nếu không ép thì không có gì được compile lại;
 * - `step_id: "S-3.6"` — `section-status.ts` chỉ miễn trừ change có `step_id` thuộc step sở hữu
 *   section, thiếu nó thì `fixed:2.2.1` bị đánh `stale` và S-9.5 bắn cờ đỏ.
 *
 * Script không ghi thẳng Spine: mọi thay đổi đi qua `renderDiagram` → `applyTransaction`.
 */
import { pathToFileURL } from "node:url"
import type { RenderResult } from "../modules/diagram/diagram.service.js"

export const RERENDER_STEP_ID = "S-3.6"
export const RERENDER_ACTOR = "migration"

/** Project có Spine kèm ít nhất một hình use case. */
export interface RerenderTarget {
  projectId: string
  diagrams: number
}

export type RenderFn = (
  projectId: string,
  kind: "usecase",
  ownerId: null,
  options: { by: string; force: boolean; step_id: string }
) => Promise<RenderResult>

export interface RerenderDeps {
  listTargets: () => Promise<RerenderTarget[]>
  render: RenderFn
}

export interface RerenderRow {
  projectId: string
  rendered: string[]
  removed: string[]
  error: string | null
}

export interface RerenderSummary {
  projects: number
  rendered: number
  failed: number
  rows: RerenderRow[]
}

/** Một project lỗi chỉ được ghi lại, không làm dừng cả lượt. */
export const rerenderUseCaseDiagrams = async (deps: RerenderDeps, options: { dryRun: boolean }): Promise<RerenderSummary> => {
  const targets = await deps.listTargets()
  const rows: RerenderRow[] = []

  for (const target of targets) {
    if (options.dryRun) {
      rows.push({ projectId: target.projectId, rendered: [], removed: [], error: null })
      continue
    }
    try {
      const result = await deps.render(target.projectId, "usecase", null, {
        by: RERENDER_ACTOR,
        force: true,
        step_id: RERENDER_STEP_ID
      })
      rows.push({ projectId: target.projectId, rendered: result.rendered, removed: result.removed, error: null })
    } catch (err) {
      rows.push({
        projectId: target.projectId,
        rendered: [],
        removed: [],
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      })
    }
  }

  return {
    projects: targets.length,
    rendered: rows.reduce((n, r) => n + r.rendered.length, 0),
    failed: rows.filter((r) => r.error !== null).length,
    rows
  }
}

export const renderReport = (targets: RerenderTarget[], summary: RerenderSummary, dryRun: boolean): string => {
  const byId = new Map(targets.map((t) => [t.projectId, t.diagrams]))
  const lines = summary.rows.map((r) => {
    const before = `${r.projectId} (${byId.get(r.projectId) ?? 0} hình)`
    if (dryRun) return `  - ${before}`
    if (r.error) return `  - ${before} ❌ ${r.error}`
    return `  - ${before} → ${r.rendered.join(", ") || "(không có hình nào)"}${r.removed.length > 0 ? ` · gỡ ${r.removed.join(", ")}` : ""}`
  })
  const head = dryRun
    ? `Dry-run: ${summary.projects} project sẽ được render lại, không ghi gì.`
    : `${summary.projects} project · ${summary.rendered} hình render lại · ${summary.failed} lỗi.`
  return [head, ...lines].join("\n")
}

const main = async (): Promise<void> => {
  const dryRun = process.argv.slice(2).includes("--dry-run")
  const [{ default: mongoose }, { env }, { renderDiagram }] = await Promise.all([
    import("mongoose"),
    import("../config/env.js"),
    import("../modules/diagram/diagram.service.js")
  ])

  // Không dùng connectDB: nó còn khởi tạo replica set và tài khoản admin — script không được có tác dụng phụ đó
  await mongoose.connect(env.MONGO_URI)
  console.log(`🟢 Connected to MongoDB${dryRun ? " (dry-run: không ghi)" : ""}`)

  try {
    const listTargets = async (): Promise<RerenderTarget[]> => {
      const docs = await mongoose.connection
        .collection("spines")
        .find({ "diagrams.kind": "usecase" }, { projection: { projectId: 1, "diagrams.kind": 1 } })
        .toArray()
      return docs.map((d) => ({
        projectId: String(d.projectId),
        diagrams: (Array.isArray(d.diagrams) ? d.diagrams : []).filter((x: { kind?: string }) => x.kind === "usecase").length
      }))
    }

    const targets = await listTargets()
    const summary = await rerenderUseCaseDiagrams({ listTargets: async () => targets, render: renderDiagram }, { dryRun })
    console.log(renderReport(targets, summary, dryRun))
    if (summary.failed > 0) process.exitCode = 1
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("❌ Render lại sơ đồ use case lỗi:", err)
    process.exit(1)
  })
}
