/**
 * diagram.service.ts
 * ─────────────────────────────────────────────────────────────────
 * renderer → compile-check → (sửa tự động ≤ 2 lần) → PlantUML SVG/PNG → GridFS → `diagrams[]`.
 *
 * - `.puml` lỗi sau 2 lần sửa ⇒ lưu text, `render_status = error` + `error` ⇒ cờ đỏ `render_error` (T09).
 *   KHÔNG ném ra API: lỗi render là dữ liệu, không phải ngoại lệ.
 * - Ghi `diagrams[]` qua op engine (T08), một transaction cho cả lô, `reason: "render"`. File SVG/PNG
 *   chỉ lưu SAU khi transaction ghi xong (409 thì không để lại file của lô thua); hình bị gỡ hoặc
 *   chuyển sang lỗi thì xoá file cũ.
 * - Hình không đổi (`source_hash` giống, đang `ok`) thì không compile lại, không ghi — trừ khi `force`
 *   (vd renderer đổi template mà dữ liệu nguồn không đổi).
 */

import * as repository from "../spine/spine.repository.js"
import { applyTransaction } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import type { Diagram, Spine, SpineRecord } from "../spine/spine.types.js"
import { UNHASHED_SOURCE_HASHES, computeSourceHash } from "../spine/source-hash.js"
import { checkPlantUml, type CompileCheckResult } from "../../shared/diagram/compile-check.js"
import { isPlantUmlReachable, renderPlantUml } from "../../shared/diagram/plantuml.client.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { CONTENT_TYPES, gridFsDiagramStore, type DiagramFileFormat, type DiagramFileStore, type StoredDiagramFile } from "./diagram-file.store.js"
import { allTargets, renderKind, type DiagramKind, type RenderTarget, type RenderedDiagramPart } from "./renderers/index.js"

export const DIAGRAM_NOT_FOUND = "DIAGRAM_NOT_FOUND"
/** Phases §4.1: compile-check → sửa → thử lại, tối đa 2 lần. */
export const MAX_FIX_ATTEMPTS = 2

export interface FixInput {
  kind: DiagramKind
  puml: string
  error: string
  line?: string
  attempt: number
}

/** Trả `.puml` đã sửa, hoặc null nếu không sửa được. */
export type FixPuml = (input: FixInput) => Promise<string | null>

export interface DiagramServiceDeps {
  check: (source: string) => Promise<CompileCheckResult>
  renderPng: (source: string) => Promise<Buffer>
  store: DiagramFileStore
  fix: FixPuml
  now: () => Date
}

/**
 * Mặc định KHÔNG tự sửa. Bỏ dòng báo lỗi (bản trước) làm hình mất actor/entity mà vẫn `ok` — sai lặng lẽ
 * tệ hơn cờ đỏ `render_error`. Sửa thật đi qua skill `render_fix` (model), T13 cắm qua `deps.fix`.
 */
export const noAutoFix: FixPuml = async () => null

export const defaultDeps = (): DiagramServiceDeps => ({
  check: checkPlantUml,
  renderPng: async (source) => (await renderPlantUml(source, "png")).data,
  store: gridFsDiagramStore,
  fix: noAutoFix,
  now: () => new Date()
})

type Compiled = { ok: true; puml: string; svg: Buffer } | { ok: false; puml: string; error: string }

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Compile-check + sửa tự động. Không bao giờ ném. */
export const compileWithFix = async (kind: DiagramKind, source: string, deps: DiagramServiceDeps): Promise<Compiled> => {
  let current = source
  let result: CompileCheckResult
  try {
    result = await deps.check(current)
  } catch (err) {
    return { ok: false, puml: source, error: `PlantUML server không phản hồi: ${message(err)}` }
  }

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS && !result.ok; attempt++) {
    const fixed = await deps.fix({ kind, puml: current, error: result.error, line: result.line, attempt }).catch(() => null)
    if (fixed === null || fixed === current) break
    try {
      const next = await deps.check(fixed)
      current = fixed
      result = next
    } catch (err) {
      return { ok: false, puml: source, error: `PlantUML server không phản hồi: ${message(err)}` }
    }
  }

  if (result.ok) return { ok: true, puml: current, svg: result.render.data }
  return { ok: false, puml: source, error: result.line ? `${result.error} (line ${result.line})` : result.error }
}

// ─── id ──────────────────────────────────────────────────────────

const PART_SUFFIX = /-\d+$/

const nextIdFactory = (diagrams: Diagram[]): (() => string) => {
  let n = Math.max(0, ...diagrams.map((d) => Number(/^D(\d+)/.exec(d.id)?.[1] ?? 0)))
  return () => `D${String(++n).padStart(2, "0")}`
}

const sameTarget = (d: Diagram, t: RenderTarget): boolean => d.kind === t.kind && (d.owner_id ?? null) === (t.owner_id ?? null)

/**
 * Id cho các phần của một target. Phần đầu **giữ nguyên id đang có**, dù id đó có hậu tố hay không;
 * các phần sau là `-2, -3`.
 *
 * Giữ id phần đầu là bắt buộc: baseline đã ký lưu tham chiếu `diagram-ref:<id>` trong snapshot và nạp
 * ảnh từ store **theo id, lúc đọc** (`assemble.service.rehydrateImages` — không tra `diagrams[]`). Id nào
 * biến mất thì `syncFiles` xoá file của nó và mọi baseline trỏ vào đó mất hình vĩnh viễn. Vì thế hình
 * một phần thành nhiều phần (`[D02]` ⇒ `[D02, D02-2]`) và hình đã tách sẵn theo lối cũ
 * (`[D02-1, D02-2]` ⇒ giữ nguyên) đều không gỡ id nào.
 */
const assignIds = (existing: Diagram[], count: number, nextId: () => string): string[] => {
  if (count === 0) return []
  const first = existing.find((d) => !PART_SUFFIX.test(d.id))?.id ?? existing[0]?.id ?? nextId()
  if (count === 1) return [first]
  const stem = first.replace(PART_SUFFIX, "")
  return [first, ...Array.from({ length: count - 1 }, (_, i) => `${stem}-${i + 2}`)]
}

// ─── render ──────────────────────────────────────────────────────

export interface RenderOptions {
  by: string
  step_id?: string | null
  /** Compile lại cả hình có `source_hash` không đổi. */
  force?: boolean
  deps?: Partial<DiagramServiceDeps>
}

export interface RenderResult {
  spine_version: number
  diagrams: Diagram[]
  /** Id hình đã compile lại trong lần gọi này. */
  rendered: string[]
  removed: string[]
}

const stripRecord = ({ projectId: _projectId, ...spine }: SpineRecord): Spine => spine

const loadSpine = async (projectId: string): Promise<SpineRecord> => {
  const record = await repository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", repository.SPINE_NOT_FOUND)
  return record
}

/**
 * So theo `source_hash`, không theo `puml`: `puml` lưu có thể là bản đã qua `deps.fix`, khác text renderer
 * sinh ra, nên so `puml` làm hình sửa được bị render lại (và tăng version) ở mọi lần gọi.
 */
const unchanged = (previous: Diagram | undefined, part: RenderedDiagramPart, force: boolean): previous is Diagram =>
  !force && previous !== undefined && previous.render_status === "ok" && previous.source_hash === part.source_hash

type OkCompiled = Extract<Compiled, { ok: true }>

const storeFiles = async (projectId: string, id: string, compiled: OkCompiled, deps: DiagramServiceDeps) => {
  await deps.store.save(projectId, id, "svg", { data: compiled.svg, contentType: CONTENT_TYPES.svg })
  try {
    await deps.store.save(projectId, id, "png", { data: await deps.renderPng(compiled.puml), contentType: CONTENT_TYPES.png })
  } catch (err) {
    // PNG chỉ phục vụ export; SVG đã có thì hình vẫn hợp lệ
    console.warn(`[diagram] Không render được PNG cho ${id}: ${message(err)}`)
  }
}

/** Sau khi `diagrams[]` đã ghi: lỗi lưu file không làm hỏng dữ liệu đã commit, chỉ báo log. */
const syncFiles = async (
  projectId: string,
  stored: { id: string; compiled: OkCompiled }[],
  removedIds: string[],
  deps: DiagramServiceDeps
) => {
  for (const { id, compiled } of stored) {
    await storeFiles(projectId, id, compiled, deps).catch((err: unknown) =>
      console.error(`[diagram] Không lưu được file cho ${id}: ${message(err)}`)
    )
  }
  for (const id of removedIds) {
    await deps.store.remove(projectId, id).catch((err: unknown) =>
      console.warn(`[diagram] Không xoá được file cũ của ${id}: ${message(err)}`)
    )
  }
}

/** Render một lô target trong MỘT transaction. */
export const renderDiagrams = async (projectId: string, targets: RenderTarget[], options: RenderOptions): Promise<RenderResult> => {
  const deps: DiagramServiceDeps = { ...defaultDeps(), ...options.deps }
  const record = await loadSpine(projectId)
  const spine = stripRecord(record)
  const nextId = nextIdFactory(spine.diagrams)
  const byExistingId = new Map(spine.diagrams.map((d) => [d.id, d]))

  const ops: Op[] = []
  const produced: Diagram[] = []
  const rendered: string[] = []
  const removed: string[] = []
  const toStore: { id: string; compiled: OkCompiled }[] = []
  /** Hình vừa chuyển sang lỗi: file cũ không còn đúng. */
  const errored: string[] = []

  for (const target of targets) {
    const existing = spine.diagrams.filter((d) => sameTarget(d, target)).sort((a, b) => (a.id < b.id ? -1 : 1))
    const parts = renderKind(spine, target.kind, target.owner_id)
    const ids = assignIds(existing, parts.length, nextId)

    for (const [i, part] of parts.entries()) {
      const id = ids[i]
      const previous = byExistingId.get(id)
      if (unchanged(previous, part, options.force ?? false)) {
        produced.push(previous)
        continue
      }

      const compiled = await compileWithFix(part.kind, part.puml, deps)
      const diagram: Diagram = {
        id,
        kind: part.kind,
        puml: compiled.puml,
        section: part.section,
        owner_kind: part.owner_kind,
        owner_id: part.owner_id,
        render_status: compiled.ok ? "ok" : "error",
        ...(compiled.ok ? {} : { error: compiled.error }),
        source_hash: part.source_hash,
        rendered_at: deps.now().toISOString()
      }
      if (compiled.ok) toStore.push({ id, compiled })
      else if (previous) errored.push(id)

      ops.push(previous ? { op: "set", path: `diagrams[id=${id}]`, value: diagram, reason: "render" } : { op: "add", path: "diagrams[]", value: diagram, reason: "render" })
      produced.push(diagram)
      rendered.push(id)
    }

    for (const old of existing) {
      if (ids.includes(old.id)) continue
      ops.push({ op: "remove", path: `diagrams[id=${old.id}]`, reason: "render: diagram split changed" })
      removed.push(old.id)
    }
  }

  if (ops.length === 0) return { spine_version: record.spine_version, diagrams: produced, rendered, removed }

  const result = await applyTransaction(projectId, {
    base_version: record.spine_version,
    ops,
    by: options.by,
    reason: "render",
    step_id: options.step_id ?? null
  })
  await syncFiles(projectId, toStore, [...removed, ...errored], deps)
  return { spine_version: result.spine_version, diagrams: produced, rendered, removed }
}

export const renderDiagram = (projectId: string, kind: DiagramKind, ownerId: string | null, options: RenderOptions) =>
  renderDiagrams(projectId, [{ kind, owner_id: ownerId }], options)

/** 4 hình cố định + wireframe cho mọi màn `signed_off`. */
export const renderAll = async (projectId: string, options: RenderOptions): Promise<RenderResult> => {
  const record = await loadSpine(projectId)
  return renderDiagrams(projectId, allTargets(stripRecord(record)), options)
}

/**
 * Vẽ lại mọi diagram khi PlantUML có mặt; không có (dev/test, sự cố) ⇒ `null` thay vì ghi hàng loạt `render_error`.
 * Lỗi vẽ chỉ ghi log — không chặn việc gọi (finalize import, ghi CR). Hình vẫn lệch thì cờ `diagram_stale` báo.
 */
export const renderAllIfAvailable = async (projectId: string, options: RenderOptions): Promise<RenderResult | null> => {
  try {
    if (!(await isPlantUmlReachable())) return null
    return await renderAll(projectId, options)
  } catch (err) {
    console.warn(`[diagram] vẽ lại diagram lỗi (project ${projectId}, by ${options.by}): ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** Hình cần vẽ lại: hash chưa tính hoặc lệch `source_fields` hiện tại. */
export const staleDiagrams = (spine: Spine): Diagram[] =>
  spine.diagrams.filter((d) => UNHASHED_SOURCE_HASHES.has(d.source_hash) || d.source_hash !== computeSourceHash(spine, d))

/**
 * Hình ĐÃ vẽ thành công nhưng dữ liệu nguồn đã đổi sau đó — đúng tập hợp mà luật cờ `diagram_stale` bắt.
 * Khác `staleDiagrams` ở chỗ bỏ qua hình chưa từng vẽ (hash rỗng/legacy): vẽ lại chúng tự động là đi làm
 * việc của step render, không phải sửa hậu quả của step vừa chạy (FLF-177 BUG-17).
 */
export const staleRenderedDiagrams = (spine: Spine): Diagram[] =>
  spine.diagrams.filter((d) => d.render_status === "ok" && !UNHASHED_SOURCE_HASHES.has(d.source_hash) && d.source_hash !== computeSourceHash(spine, d))

export const loadDiagramFile = async (
  projectId: string,
  diagramId: string,
  format: DiagramFileFormat,
  store: DiagramFileStore = gridFsDiagramStore
): Promise<StoredDiagramFile> => {
  const file = await store.load(projectId, diagramId, format)
  if (!file) throw new ApiError(404, `Chưa có file ${diagramId}.${format}`, DIAGRAM_NOT_FOUND)
  return file
}
