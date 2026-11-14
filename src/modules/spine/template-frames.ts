/**
 * FLF-413 — khung `<<Feature Name 1>>` / `<<Function Name 1>>` của mẫu bắt buộc (FPT Report3).
 *
 * Import file khung mẫu tạo phần tử Spine cho từng heading lạ của chương chức năng: `F-3.2` (tên = `<<Feature Name 1>>`),
 * `FR-3.2.1`… Đó là **chỗ điền** của mẫu, không phải dữ liệu (BF §3.1.1; chốt 12/11 phương án a):
 *
 * - P1: không đưa cho model, không bắn cờ, không mở vòng S-5 `@nonscreen` (`isTemplateFrame`).
 * - P2: accept S-4.1 (và S-4.4 cho chức năng không màn) ⇒ tính năng / chức năng thật **lấp vào khung** theo thứ tự file — khung
 *   giữ id (heading_map / layout / DocBlock không đổi), mang mọi field của phần tử thật, tham chiếu chuyển sang id khung, phần tử
 *   thật bị xoá. Khung không ai lấp ⇒ xoá (bản in bỏ heading). Phần thật dư ⇒ giữ nguyên, bản in lặp heading theo khung.
 *
 * Hàm thuần — lô trả về đi chung lô accept của cổng (một change log).
 */

import type { Feature, Spine, SpineFunction } from "./spine.types.js"
import type { Op } from "./op.types.js"
import { iterateReferences, type ReferenceHit } from "./reference-fields.js"
import { isPlaceholderText } from "../import/template-markers.js"

/** Phần tử khung: tên là chỗ điền của mẫu (`<<Feature Name 1>>`). Tên thật đã lấp ⇒ không còn là khung (chạy lại idempotent). */
export const isTemplateFrame = (el: { name?: string | null }): boolean => isPlaceholderText(el.name)

export const hasTemplateFrames = (spine: Pick<Spine, "features" | "functions">): boolean =>
  spine.features.some(isTemplateFrame) || spine.functions.some(isTemplateFrame)

/** Mục layout tối thiểu cần để xếp khung theo file và ghi nhãn change log. */
export interface FrameLayoutEntry {
  section_id: string
  heading_text: string
  number_label?: string
}

export interface FrameOptions {
  /** Layout của TemplateProfile (thứ tự file). Thiếu ⇒ xếp khung theo `order`. */
  layout?: readonly FrameLayoutEntry[]
  /**
   * Xoá khung chức năng còn trống dưới tính năng đã lấp. Accept S-4.1 để lại (S-4.4 còn sinh chức năng không màn — 03 #3);
   * accept S-4.4, hoặc S-4.4 đã xong / không có trong quy trình ⇒ xoá.
   */
  dropEmptyFunctionFrames: boolean
}

export interface FramePlan {
  ops: Op[]
  /** Cặp đã lấp: `frame` giữ id, `real` bị xoá. */
  filled: { kind: "feature" | "function"; frame: string; real: string }[]
  /** Khung bị xoá vì không ai lấp. */
  dropped: { kind: "feature" | "function"; id: string }[]
}

const EMPTY: FramePlan = { ops: [], filled: [], dropped: [] }
const EXCESS = 1_000_000

const sectionNumber = (entry: FrameLayoutEntry | undefined): string | null => {
  if (!entry) return null
  const label = entry.number_label?.trim().replace(/\.$/, "")
  if (label) return label
  return /^\s*(\d+(?:\.\d+)*)/.exec(entry.heading_text)?.[1] ?? null
}

const byOrder = <T extends { order: number }>(items: readonly T[], all: readonly T[]): T[] =>
  [...items].sort((a, b) => a.order - b.order || all.indexOf(a) - all.indexOf(b))

/** Chức năng màn trước, không màn sau — mỗi nhóm theo `order` (bất biến 5 đánh `order` theo nhóm). */
const functionOrder = (fns: readonly SpineFunction[], all: readonly SpineFunction[]): SpineFunction[] =>
  [...fns].sort(
    (a, b) => Number(a.screen_id === null) - Number(b.screen_id === null) || a.order - b.order || all.indexOf(a) - all.indexOf(b)
  )

/**
 * Lô lấp khung (01 §4). Không có khung ⇒ `[]` — dự án thường không đổi gì.
 *
 * Phần tử thật đã có heading riêng trong file (có trong layout — chế độ 4 / SRS viết dở) không lấp khung (03 #6): chỉ phần tử
 * **mới** soạn ở S-4.1 / S-4.4.
 */
export const templateFrameOps = (spine: Spine, options: FrameOptions): FramePlan => {
  if (!hasTemplateFrames(spine)) return EMPTY

  const layout = options.layout ?? []
  const position = new Map(layout.map((e, i) => [e.section_id, i]))
  const entryOf = new Map(layout.map((e) => [e.section_id, e]))
  const inLayout = (kind: "feature" | "function", id: string): boolean => position.has(`${kind}:${id}`)
  const filePos = (kind: "feature" | "function", el: { id: string; order: number }): number =>
    position.get(`${kind}:${el.id}`) ?? EXCESS + el.order

  // ─── ghép tính năng ──────────────────────────────────────────────
  const frameFeatures = [...spine.features.filter(isTemplateFrame)].sort((a, b) => filePos("feature", a) - filePos("feature", b))
  const freshFeatures = byOrder(
    spine.features.filter((f) => !isTemplateFrame(f) && !inLayout("feature", f.id)),
    spine.features
  )
  const featureMap = new Map<string, string>()
  frameFeatures.forEach((frame, i) => {
    const real = freshFeatures[i]
    if (real) featureMap.set(real.id, frame.id)
  })
  const filledFeatureFrames = new Set(featureMap.values())
  // Bất biến 2: không xoá phần tử cuối của `features` — chưa có tính năng thật nào thì khung ở lại (in như mục còn trống)
  const droppedFeatures = featureMap.size ? frameFeatures.filter((f) => !filledFeatureFrames.has(f.id)) : []
  const droppedFeatureIds = new Set(droppedFeatures.map((f) => f.id))

  // Tính năng đích của mỗi chức năng sau khi đổi id
  const finalFeature = (fn: SpineFunction): string => featureMap.get(fn.feature_id) ?? fn.feature_id

  // ─── ghép chức năng (trong từng tính năng đích) ──────────────────
  const fnMap = new Map<string, string>()
  const fnOrderKey = new Map<string, number>()
  const droppedFunctions: SpineFunction[] = []
  const byFeature = new Map<string, SpineFunction[]>()
  for (const fn of spine.functions) byFeature.set(finalFeature(fn), [...(byFeature.get(finalFeature(fn)) ?? []), fn])

  for (const [featureId, fns] of byFeature) {
    const frames = fns.filter(isTemplateFrame).sort((a, b) => filePos("function", a) - filePos("function", b))
    if (droppedFeatureIds.has(featureId)) {
      droppedFunctions.push(...frames)
      continue
    }
    // Khung tính năng chưa ai lấp mà vẫn giữ (chưa có tính năng thật) ⇒ khung chức năng của nó cũng giữ
    if (!frames.length || (frameFeatures.some((f) => f.id === featureId) && !filledFeatureFrames.has(featureId))) continue
    const fresh = functionOrder(
      fns.filter((f) => !isTemplateFrame(f) && !inLayout("function", f.id)),
      spine.functions
    )
    frames.forEach((frame, i) => {
      const real = fresh[i]
      if (real) {
        fnMap.set(real.id, frame.id)
        fnOrderKey.set(frame.id, i)
      } else if (options.dropEmptyFunctionFrames) {
        droppedFunctions.push(frame)
      }
    })
  }
  // Bất biến 2 cho `functions`: xoá hết khung mà không còn chức năng thật nào ⇒ giữ lại khung cuối (theo file)
  const survivingFns = spine.functions.length - fnMap.size - droppedFunctions.length
  if (survivingFns <= 0 && droppedFunctions.length) {
    const keep = droppedFunctions.find((f) => !droppedFeatureIds.has(f.feature_id)) ?? droppedFunctions[droppedFunctions.length - 1]
    droppedFunctions.splice(droppedFunctions.indexOf(keep), 1)
    if (droppedFeatureIds.has(keep.feature_id)) {
      const i = droppedFeatures.findIndex((f) => f.id === keep.feature_id)
      droppedFeatures.splice(i, 1)
      droppedFeatureIds.delete(keep.feature_id)
    }
  }

  if (!featureMap.size && !fnMap.size && !droppedFeatures.length && !droppedFunctions.length) return EMPTY

  const realFeatureById = new Map(spine.features.map((f) => [f.id, f]))
  const realFnById = new Map(spine.functions.map((f) => [f.id, f]))
  const mergedOwners = new Set([
    ...[...featureMap.keys()].map((id) => `features[id=${id}]`),
    ...[...fnMap.keys()].map((id) => `functions[id=${id}]`),
    ...droppedFunctions.map((f) => `functions[id=${f.id}]`),
    ...droppedFeatures.map((f) => `features[id=${f.id}]`)
  ])
  const ownedByRemoved = (ownerPath: string): boolean =>
    [...mergedOwners].some((o) => ownerPath === o || ownerPath.startsWith(`${o}.`))

  const ops: Op[] = []
  const reason = "FLF-413: điền vào khung của mẫu"

  // ─── 1. đổi tham chiếu thật → khung ──────────────────────────────
  const renameSection = (key: string): string | null => {
    if (key.startsWith("feature:")) return featureMap.has(key.slice(8)) ? `feature:${featureMap.get(key.slice(8))}` : null
    if (key.startsWith("function:")) return fnMap.has(key.slice(9)) ? `function:${fnMap.get(key.slice(9))}` : null
    return null
  }
  const renamePath = (path: string): string | null => {
    let out = path
    for (const [real, frame] of featureMap) out = out.split(`features[id=${real}]`).join(`features[id=${frame}]`)
    for (const [real, frame] of fnMap) out = out.split(`functions[id=${real}]`).join(`functions[id=${frame}]`)
    return out === path ? null : out
  }
  const renameId = (hit: ReferenceHit): string | null => {
    switch (hit.target) {
      case "features":
        return featureMap.get(hit.targetId) ?? null
      case "functions":
        return fnMap.get(hit.targetId) ?? null
      case "section_key":
        return renameSection(hit.targetId)
      case "path":
        return renamePath(hit.targetId)
      default:
        return null
    }
  }

  const manyGroups = new Map<string, { path: string; values: string[]; changed: boolean }>()
  const existingSections = new Set(spine.sections.map((s) => s.id))
  for (const hit of iterateReferences(spine)) {
    if (ownedByRemoved(hit.ownerPath)) continue
    const next = renameId(hit)
    if (hit.field.cardinality === "many") {
      const key = hit.field.path.split(".").pop()!.replace(/\[\]$/, "")
      const groupPath = `${hit.ownerPath}.${key}`
      const group = manyGroups.get(groupPath) ?? { path: groupPath, values: [], changed: false }
      group.values.push(next ?? hit.targetId)
      group.changed ||= next !== null
      manyGroups.set(groupPath, group)
      continue
    }
    if (next === null) continue
    if (hit.field.path === "sections[].id") {
      ops.push({ op: "remove", path: hit.ownerPath, reason })
      if (!existingSections.has(next)) {
        const section = spine.sections.find((s) => s.id === hit.targetId)
        ops.push({ op: "add", path: "sections[]", value: { ...section, id: next }, reason })
        existingSections.add(next)
      }
      continue
    }
    if (hit.field.path === "steps[].id") continue
    ops.push({ op: "set", path: hit.refPath, value: next, reason })
  }
  for (const g of manyGroups.values()) {
    if (g.changed) ops.push({ op: "set", path: g.path, value: [...new Set(g.values)], reason })
  }
  // Cờ trỏ phần tử bằng `target_id` (ngoài danh sách tham chiếu)
  for (const fl of spine.flags) {
    const next = fl.target_id ? (featureMap.get(fl.target_id) ?? fnMap.get(fl.target_id)) : undefined
    if (next && !ownedByRemoved(`flags[id=${fl.id}]`)) ops.push({ op: "set", path: `flags[id=${fl.id}].target_id`, value: next, reason })
  }
  // Hình đặt dưới mục của phần tử (`section = feature:F1` — class diagram, sequence)
  for (const d of spine.diagrams) {
    const next = renameSection(d.section)
    if (next) ops.push({ op: "set", path: `diagrams[id=${d.id}].section`, value: next, reason })
  }

  // ─── 2. khung mang field của phần tử thật ────────────────────────
  for (const [realId, frameId] of featureMap) {
    const real = realFeatureById.get(realId) as Feature
    const number = sectionNumber(entryOf.get(`feature:${frameId}`))
    const label = `Tính năng "${real.name}" điền vào ${number ? `mục ${number}` : "khung"} của mẫu`
    for (const [key, value] of Object.entries(real)) {
      if (key === "id" || key === "order") continue
      ops.push({ op: "set", path: `features[id=${frameId}].${key}`, value, reason: label })
    }
  }
  for (const [realId, frameId] of fnMap) {
    const real = realFnById.get(realId) as SpineFunction
    const frame = realFnById.get(frameId) as SpineFunction
    const number = sectionNumber(entryOf.get(`function:${frameId}`))
    const label = `Chức năng "${real.name}" điền vào ${number ? `mục ${number}` : "khung"} của mẫu`
    ops.push({
      op: "set",
      path: `functions[id=${frameId}]`,
      value: { ...real, id: frameId, feature_id: finalFeature(real), order: frame.order },
      reason: label
    })
  }

  // ─── 3. xoá phần tử thật đã lấp + khung thừa (chức năng trước — restrict) ─
  for (const realId of fnMap.keys()) ops.push({ op: "remove", path: `functions[id=${realId}]`, reason })
  for (const fn of droppedFunctions) ops.push({ op: "remove", path: `functions[id=${fn.id}]`, reason: "FLF-413: khung chức năng của mẫu không có chức năng nào điền" })
  for (const realId of featureMap.keys()) ops.push({ op: "remove", path: `features[id=${realId}]`, reason })
  for (const f of droppedFeatures) ops.push({ op: "remove", path: `features[id=${f.id}]`, reason: "FLF-413: khung tính năng của mẫu không có tính năng nào điền" })

  // ─── 4. thứ tự: khung theo file, phần dư sau khung cuối ──────────
  const removed = new Set([...featureMap.keys(), ...droppedFeatureIds])
  const featureKey = (f: Feature): number =>
    isTemplateFrame(f) ? filePos("feature", f) : inLayout("feature", f.id) ? filePos("feature", f) : EXCESS + f.order
  const featureRank = spine.features
    .filter((f) => !removed.has(f.id))
    .sort((a, b) => featureKey(a) - featureKey(b) || spine.features.indexOf(a) - spine.features.indexOf(b))
    .map((f) => f.id)
  ops.push({ op: "renumber", path: "features[]", value: featureRank, reason })

  const removedFns = new Set([...fnMap.keys(), ...droppedFunctions.map((f) => f.id)])
  const fnKey = (f: SpineFunction): number =>
    fnOrderKey.has(f.id) || isTemplateFrame(f) || inLayout("function", f.id) ? filePos("function", f) : EXCESS + f.order
  const fnRank = spine.functions
    .filter((f) => !removedFns.has(f.id))
    .sort((a, b) => fnKey(a) - fnKey(b) || spine.functions.indexOf(a) - spine.functions.indexOf(b))
    .map((f) => f.id)
  ops.push({ op: "renumber", path: "functions[]", value: fnRank, reason })

  return {
    ops,
    filled: [
      ...[...featureMap].map(([real, frame]) => ({ kind: "feature" as const, frame, real })),
      ...[...fnMap].map(([real, frame]) => ({ kind: "function" as const, frame, real }))
    ],
    dropped: [
      ...droppedFunctions.map((f) => ({ kind: "function" as const, id: f.id })),
      ...droppedFeatures.map((f) => ({ kind: "feature" as const, id: f.id }))
    ]
  }
}

/**
 * Model soạn S-4.1 không thấy khung (P1) nên đặt `order` tính năng mới từ 0 — trùng `order` của khung. Lô có thêm tính năng mà
 * Spine còn khung ⇒ nối `renumber features[]` (thứ tự tương đối giữ nguyên; accept S-4.1 xếp lại theo file).
 */
export const withFrameRenumber = (spine: Pick<Spine, "features" | "functions">, ops: readonly Op[]): Op[] => {
  if (!spine.features.some(isTemplateFrame)) return [...ops]
  const addsFeature = ops.some((o) => o.op === "add" && o.path === "features[]")
  if (!addsFeature || ops.some((o) => o.op === "renumber" && o.path === "features[]")) return [...ops]
  return [...ops, { op: "renumber", path: "features[]", reason: "FLF-413: tính năng mới cạnh khung của mẫu" }]
}
