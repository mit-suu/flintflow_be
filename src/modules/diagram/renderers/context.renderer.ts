/**
 * §1 System Context — source_fields: `project.system_name ?? project.name` · `actors[].name/.kind/.flows_in/.flows_out`
 * (srs-spine §7.1). Sơ đồ luồng dữ liệu mức 0 theo ký pháp Yourdon/DeMarco, dựng bằng SVG (hình học ở
 * `context-layout.ts`): MỘT hình tròn là hệ thống, mỗi actor một hộp chữ nhật nền `#7ACFF5`, mỗi luồng dữ liệu một đoạn
 * thẳng có đầu mũi tên đặc và nhãn danh từ dữ liệu dọc mũi tên. Không tiêu đề — tài liệu tự ghi chú thích ảnh.
 *
 * Mỗi phần tử của `flows_in` (actor → hệ thống) / `flows_out` (hệ thống → actor) là một mũi tên mang đúng một nhãn,
 * không giới hạn số lượng, không gộp. Một actor được có luồng một chiều (không ghép cặp), nhưng toàn sơ đồ phải có cả
 * chiều vào lẫn chiều ra. Skill S-2.3/S-3.x bắt buộc ghi luồng thật; nhãn dự phòng theo `kind` (DEFAULT_IN/DEFAULT_OUT)
 * chỉ để sơ đồ không bao giờ có mũi tên trơn khi Spine còn thiếu (dữ liệu cũ, model bỏ sót). Không lấy tên use case làm
 * nhãn vì đó là hành động, không phải dữ liệu.
 */

import type { Actor, ActorKind } from "../../spine/spine.types.js"
import { systemName } from "../../spine/system-name.js"
import { FILL } from "../../../shared/diagram/svg-kit.js"
import { Scene } from "../../../shared/diagram/svg-scene.js"
import type { Renderer } from "./common.js"
import { alias, byId, label, svgPart } from "./common.js"
import { buildContextLayout, LABEL_SIZE, NAME_LINE_HEIGHT, NAME_SIZE, type ContextActor } from "./context-layout.js"
import { DIAGRAM_LABELS, type DiagramLabels } from "./labels.js"

/** Nhãn dự phòng khi Spine thiếu luồng: chiều vào / chiều ra theo `kind` (bản tiếng Anh — `labels.ts`). */
export const DEFAULT_IN: Readonly<Record<ActorKind, string>> = DIAGRAM_LABELS.en.defaultIn
export const DEFAULT_OUT: Readonly<Record<ActorKind, string>> = DIAGRAM_LABELS.en.defaultOut

/** Từ nối ngắn viết thường trong Title Case (trừ từ đầu). */
const MINOR_WORDS = new Set(["and", "or", "of", "to", "for", "the", "a", "an", "in", "on", "via"])

/** Title Case cho nhãn luồng tiếng Anh: giữ nguyên từ đã có chữ hoa (`SRS`, `OTP`, `eKYC`), từ nối ngắn viết thường. */
export const titleCase = (text: string): string =>
  text
    .split(" ")
    .map((word, i) => {
      if (word !== word.toLowerCase()) return word
      if (i > 0 && MINOR_WORDS.has(word)) return word
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(" ")

const clean = (values: readonly string[] | undefined, format: (text: string) => string): string[] =>
  (values ?? []).map((v) => format(label(v))).filter((v) => v.length > 0)

/** Actor của sơ đồ, theo id: mỗi actor ít nhất một mũi tên có nhãn, toàn sơ đồ có cả chiều vào lẫn chiều ra. */
export const contextActors = (actors: readonly Actor[], labels: DiagramLabels = DIAGRAM_LABELS.en): ContextActor[] => {
  const { defaultIn, defaultOut } = labels
  // Chỉ nhãn tiếng Anh mới Title Case; tiếng Việt giữ nguyên
  const format = labels === DIAGRAM_LABELS.en ? titleCase : (text: string) => text
  const result = byId([...actors]).map((a) => {
    const flows = { id: a.id, name: label(a.name), kind: a.kind, inbound: clean(a.flows_in, format), outbound: clean(a.flows_out, format) }
    // Chưa có luồng nào: chiều chính theo kind — human/time gửi vào hệ thống, system nhận yêu cầu từ hệ thống
    if (flows.inbound.length > 0 || flows.outbound.length > 0) return flows
    return a.kind === "system" ? { ...flows, outbound: [defaultOut.system] } : { ...flows, inbound: [defaultIn[a.kind]] }
  })
  // Cả sơ đồ chỉ một chiều: thêm chiều thiếu cho actor đầu tiên theo thứ tự kind ưu tiên
  const first = (order: ActorKind[]): number => {
    for (const kind of order) {
      const i = result.findIndex((a) => a.kind === kind)
      if (i >= 0) return i
    }
    return 0
  }
  if (result.length > 0 && !result.some((a) => a.outbound.length > 0)) {
    const i = first(["human", "system", "time"])
    result[i] = { ...result[i], outbound: [defaultOut[result[i].kind]] }
  }
  if (result.length > 0 && !result.some((a) => a.inbound.length > 0)) {
    const i = first(["system", "human", "time"])
    result[i] = { ...result[i], inbound: [defaultIn[result[i].kind]] }
  }
  return result
}

/** Tên nhiều dòng giữa một hình: mỗi dòng một `text`, chính giữa theo chiều dọc. */
const centredLines = (scene: Scene, id: string, owner: string, cx: number, cy: number, lines: string[]): void => {
  lines.forEach((line, i) => {
    const y = cy + (i - (lines.length - 1) / 2) * NAME_LINE_HEIGHT
    scene.text(`${id}#name-${i}`, cx, y, line, { size: NAME_SIZE, bold: true, baseline: "central", owner })
  })
}

export const renderContext: Renderer = (spine, _ownerId, labels = DIAGRAM_LABELS.en) => {
  const name = label(systemName(spine.project)) || labels.system
  const layout = buildContextLayout(contextActors(spine.actors, labels), name)
  const scene = new Scene()

  // Luồng trước (hộp và vòng tròn vẽ đè đầu mút), nhãn do Scene đặt ở lớp trên cùng
  for (const edge of layout.edges) {
    const id = `${alias(edge.actorId)}_${edge.flow.toUpperCase()}_${edge.index}`
    scene.line(id, edge.from, edge.to, { name: edge.text })
    scene.arrow(id, "classic")
    if (edge.text !== "") scene.label(id, edge.text, { size: LABEL_SIZE })
  }
  for (const actor of layout.actors) {
    const id = alias(actor.id)
    const { x, y, w, h } = actor.box
    scene.rect(id, x, y, w, h, { fill: FILL, name: actor.name })
    centredLines(scene, id, id, x + w / 2, y + h / 2, actor.lines)
  }
  const { cx, cy, r, lines } = layout.circle
  scene.circle("SYSTEM", cx, cy, r, { fill: FILL, name })
  centredLines(scene, "SYSTEM", "SYSTEM", cx, cy, lines)

  return [svgPart(scene, { allowBends: false }, { kind: "context", section: "fixed:1", owner_kind: null, owner_id: null })]
}
