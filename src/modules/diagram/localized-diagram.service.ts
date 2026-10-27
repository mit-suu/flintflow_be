/**
 * localized-diagram.service.ts
 * ─────────────────────────────────────────────────────────────────
 * PNG của sơ đồ theo ngôn ngữ tài liệu (FLF-265 N1) — đường vẽ riêng, KHÔNG ghi Spine.
 *
 * Nguồn đã dịch (`render/localized-diagrams.ts`) ⇒ hash ⇒ tra file `<diagramId>.<locale>.<hash>.png`; chưa có thì
 * compile-check + vẽ PNG trên PlantUML (`format = puml`) hoặc resvg (`format = svg`, không compile-check) rồi lưu. Gọi từ lượt dựng tài liệu (`assemble.service`, GET /document + export):
 * không gọi model, không tiêu credit (D9) — chỉ PlantUML self-host, như lúc vẽ bản gốc.
 *
 * - Hash theo (ngôn ngữ, nguồn): nguồn đổi (sửa Spine, thêm bản dịch) ⇒ file mới; bản cũ được store dọn.
 * - Nhiều lượt đọc cùng cần một ảnh ⇒ chung một lượt vẽ (`inFlight`); mọi lượt vẽ đi một hàng (`inLane`) — PlantUML vẽ
 *   `@startdot` song song thì hỏng ngẫu nhiên.
 * - Vẽ hỏng ⇒ `null` (tài liệu dùng ảnh gốc) và nhớ một lúc để lượt đọc kế không vẽ lại ngay: nguồn sai cú pháp nhớ
 *   `COMPILE_FAILURE_TTL_MS`, PlantUML không phản hồi nhớ `TRANSPORT_FAILURE_TTL_MS`.
 */

import { createHash } from "node:crypto"
import { checkPlantUml, type CompileCheckResult } from "../../shared/diagram/compile-check.js"
import { renderPlantUml } from "../../shared/diagram/plantuml.client.js"
import { svgToPng } from "../../shared/diagram/svg-to-png.js"
import type { Diagram } from "../spine/spine.types.js"
import { CONTENT_TYPES, gridFsDiagramStore, type DiagramFileStore } from "./diagram-file.store.js"

export interface LocalizedDiagramDeps {
  check: (source: string) => Promise<CompileCheckResult>
  renderPng: (source: string) => Promise<Buffer>
  renderSvgPng: (svg: string) => Promise<Buffer>
  store: DiagramFileStore
  now: () => number
}

export const defaultLocalizedDiagramDeps = (): LocalizedDiagramDeps => ({
  check: checkPlantUml,
  renderPng: async (source) => (await renderPlantUml(source, "png")).data,
  renderSvgPng: svgToPng,
  store: gridFsDiagramStore,
  now: () => Date.now()
})

/** Nguồn hình theo ngôn ngữ: engine + nguồn (text PlantUML hoặc markup SVG). */
export type DiagramSource = Pick<Diagram, "format" | "source">

export const COMPILE_FAILURE_TTL_MS = 10 * 60_000
export const TRANSPORT_FAILURE_TTL_MS = 30_000

/** Hash của nguồn sơ đồ đã dịch — một phần tên file PNG theo ngôn ngữ. */
export const localizedDiagramHash = (locale: string, source: string): string =>
  createHash("sha256").update(`${locale}\n${source}`).digest("hex").slice(0, 16)

const inFlight = new Map<string, Promise<Buffer | null>>()
/** Khoá lượt vẽ hỏng ⇒ thời điểm hết nhớ. */
const failedUntil = new Map<string, number>()

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * PlantUML server (image `jetty`) vẽ `@startdot` song song thì lỗi cú pháp ngẫu nhiên — đo trên FAP 2026-10-13: 8/12 lượt
 * hỏng khi chạy song song, 0/24 khi tuần tự (24 sơ đồ ~1,5 s). Mọi lượt vẽ bản theo ngôn ngữ đi một hàng, như
 * `diagram.service#renderDiagrams` vẽ bản gốc tuần tự.
 */
let lane: Promise<unknown> = Promise.resolve()
const inLane = <T>(task: () => Promise<T>): Promise<T> => {
  const run = lane.then(task, task)
  lane = run.catch(() => undefined)
  return run
}

/** Compile-check; lỗi cú pháp thử lại một lần — lượt vẽ bản gốc của request khác chạy cùng lúc cũng gây lỗi kiểu này. */
const checkTwice = async (puml: string, deps: LocalizedDiagramDeps): Promise<CompileCheckResult> => {
  const first = await deps.check(puml)
  return first.ok ? first : deps.check(puml)
}

const remember = (key: string, until: number, now: number): void => {
  for (const [k, t] of failedUntil) if (t <= now) failedUntil.delete(k)
  failedUntil.set(key, until)
}

const compileAndStore = async (
  projectId: string,
  diagramId: string,
  locale: string,
  hash: string,
  diagram: DiagramSource,
  deps: LocalizedDiagramDeps
): Promise<Buffer | null> => {
  const key = `${projectId}:${diagramId}:${locale}:${hash}`
  let png: Buffer
  try {
    // svg: không compile-check (bản dịch lỗi bố cục đã bị `localizeDiagrams` loại); vẫn đi một hàng để không dồn CPU
    const drawn = await inLane(async () => {
      if (diagram.format === "svg") return { ok: true as const, png: await deps.renderSvgPng(diagram.source) }
      const checked = await checkTwice(diagram.source, deps)
      return checked.ok ? { ok: true as const, png: await deps.renderPng(diagram.source) } : checked
    })
    if (!drawn.ok) {
      console.warn(`[diagram] Bản ${locale} của ${diagramId} (project ${projectId}) không compile được — dùng ảnh gốc: ${drawn.error}`)
      remember(key, deps.now() + COMPILE_FAILURE_TTL_MS, deps.now())
      return null
    }
    png = drawn.png
  } catch (err) {
    console.warn(`[diagram] Không vẽ được bản ${locale} của ${diagramId} (project ${projectId}): ${message(err)}`)
    remember(key, deps.now() + TRANSPORT_FAILURE_TTL_MS, deps.now())
    return null
  }
  // Lưu hỏng không làm mất ảnh của lượt này — lượt sau vẽ lại
  await deps.store
    .saveLocalized(projectId, diagramId, locale, hash, { data: png, contentType: CONTENT_TYPES.png })
    .catch((err: unknown) => console.warn(`[diagram] Không lưu được bản ${locale} của ${diagramId} (project ${projectId}): ${message(err)}`))
  return png
}

/**
 * PNG (base64) của nguồn sơ đồ `diagram` theo `locale`: file đã có ⇒ đọc; chưa có ⇒ vẽ + lưu. Không vẽ được ⇒ `null` —
 * người gọi dùng ảnh gốc. Không bao giờ ném.
 */
export const localizedDiagramPng = async (
  projectId: string,
  diagramId: string,
  locale: string,
  diagram: DiagramSource,
  deps: LocalizedDiagramDeps = defaultLocalizedDiagramDeps()
): Promise<string | null> => {
  const hash = localizedDiagramHash(locale, diagram.source)
  const stored = await deps.store.loadLocalized(projectId, diagramId, locale, hash).catch(() => null)
  if (stored && stored.data.length > 0) return stored.data.toString("base64")

  const key = `${projectId}:${diagramId}:${locale}:${hash}`
  if ((failedUntil.get(key) ?? 0) > deps.now()) return null
  let task = inFlight.get(key)
  if (!task) {
    task = compileAndStore(projectId, diagramId, locale, hash, diagram, deps).finally(() => inFlight.delete(key))
    inFlight.set(key, task)
  }
  const png = await task
  return png ? png.toString("base64") : null
}

/** Chỉ cho test: quên các lượt vẽ hỏng đã nhớ. */
export const _resetLocalizedDiagramState = (): void => {
  failedUntil.clear()
  inFlight.clear()
}
