/**
 * System Sequence Diagram — message actor ↔ `:System` của một function (UML 2.5 Sequence, hộp đen; IEEE 830 Annex A.4
 * stimulus / response). source_fields: `functions[].name/.screen_id/.interactions` · `actors[].name/.kind` của các đầu
 * message (srs-spine §7.1). Dựng bằng PlantUML (`format = puml`).
 *
 * MỖI FUNCTION CẦN SƠ ĐỒ CÓ MỘT HÌNH (`owner_kind = function`, `owner_id` = id function, `section = function:<id>`).
 * Lifeline chỉ gồm: actor người (stick figure, bên trái), `:System`, actor hệ thống ngoài (`kind` system / time, bên phải
 * — trừ actor ngoài gửi stimulus, đứng bên trái như actor người);
 * không Frontend / Backend / Repository. Quy tắc suy từ dữ liệu, không bịa:
 * - Function có hình khi `needsSequence`: có từ 2 message và (có actor ngoài, hoặc có nhánh lỗi / guard, hoặc không thuộc màn).
 * - Request có response quay về người gửi ở phía sau ⇒ đồng bộ (`->`, mũi tên đặc); không có ⇒ bất đồng bộ (`->>`, mũi
 *   tên hở). Response luôn nét đứt (`-->>`). Mỗi request đồng bộ mở activation bar của bên nhận, response đóng nó; bar mở
 *   trước một khung `alt` / `opt` trải qua mọi operand và đóng sau khung (PlantUML không mở lại bar ở operand kế).
 * - Nhánh `abnormal` (cần `guard`) gom thành `alt`: các message lỗi liền nhau cùng guard là một operand; phần luồng chính
 *   sau đó là operand `else` (lồng tiếp nếu còn nhánh lỗi sau). Message `normal` có `guard` liền nhau ⇒ `opt`. Spine chưa
 *   có dữ liệu `loop` nên không sinh `loop`.
 * - Số message: stimulus (request từ actor, hoặc message đầu tiên) là `1`, `2`…; mọi message sau đó cho tới stimulus kế
 *   tiếp (kể cả response) là `n.1`, `n.2`… liên tục qua các operand.
 */

import type { Actor, FunctionInteraction, Spine, SpineFunction } from "../../spine/spine.types.js"
import { SYSTEM_LIFELINE } from "../../spine/spine.schema.js"
import type { RenderedPart, Renderer } from "./common.js"
import { alias, byId, label, puml } from "./common.js"
import { DIAGRAM_LABELS, type DiagramLabels } from "./labels.js"

const SYSTEM_ALIAS = "SSD_SYSTEM"

/**
 * Theme Visual Paradigm viết thẳng vào nguồn (`!include` bị cấm: PlantUML server không đọc được file).
 * `dpi 192`: PNG gấp đôi mặc định, nét như ảnh SVG khi phóng to trong tài liệu. Nhãn căn theo chiều mũi tên
 * (`direction`) + lifeline cách rộng: căn giữa làm nhãn dài chờm lên đầu mũi tên và viền khung `alt`.
 */
const THEME: readonly string[] = [
  "skinparam defaultFontName Arial",
  "skinparam defaultFontSize 13",
  "skinparam defaultFontColor #000000",
  "skinparam shadowing false",
  "skinparam roundCorner 0",
  "skinparam ArrowColor #000000",
  "skinparam ArrowThickness 1.2",
  "skinparam BackgroundColor #FFFFFF",
  "skinparam ActorBackgroundColor #7ACFF5",
  "skinparam ActorBorderColor #000000",
  "skinparam ParticipantBackgroundColor #7ACFF5",
  "skinparam ParticipantBorderColor #000000",
  "skinparam SequenceLifeLineBorderColor #000000",
  "skinparam SequenceLifeLineBackgroundColor #7ACFF5",
  "skinparam SequenceLifeLineBorderThickness 1",
  "skinparam SequenceGroupBackgroundColor #FFFFFF",
  "skinparam SequenceGroupBorderColor #000000",
  "skinparam SequenceGroupBorderThickness 1.2",
  "skinparam SequenceGroupFontStyle plain",
  "skinparam SequenceGroupHeaderFontStyle bold",
  "skinparam SequenceGroupBodyBackgroundColor transparent",
  "skinparam dpi 192",
  "skinparam ParticipantPadding 30",
  "skinparam maxMessageSize 220",
  "skinparam sequenceMessageAlign direction",
  "hide footbox"
]

const isExternal = (actor: Actor | undefined): boolean => actor !== undefined && actor.kind !== "human"

/** Function có sơ đồ riêng khi sơ đồ nói thêm điều mà bảng luồng thường / bất thường chưa nói (xem đầu file). */
export const needsSequence = (fn: SpineFunction, actors: readonly Actor[]): boolean => {
  const interactions = fn.interactions ?? []
  if (interactions.length < 2) return false
  const byActor = new Map(actors.map((a) => [a.id, a]))
  const touchesExternal = interactions.some((i) => isExternal(byActor.get(i.from)) || isExternal(byActor.get(i.to)))
  return touchesExternal || interactions.some((i) => i.flow === "abnormal" || text(i.guard) !== "") || fn.screen_id === null
}

const text = (value: string | undefined): string => (value ?? "").replace(/\s+/g, " ").trim()

/** Request có response quay về người gửi ở phía sau ⇒ đồng bộ. */
const isSynchronous = (list: readonly FunctionInteraction[], index: number): boolean => {
  const request = list[index]
  return request.kind === "request" && list.slice(index + 1).some((r) => r.kind === "response" && r.from === request.to && r.to === request.from)
}

interface Built {
  lines: string[]
  /** Activation đang mở (alias lifeline), cũ → mới. */
  open: string[]
  stimulus: number
  sub: number
}

const buildBody = (list: readonly FunctionInteraction[], aliasOf: (id: string) => string, labels: DiagramLabels): string[] => {
  const state: Built = { lines: [], open: [], stimulus: 0, sub: 0 }
  const guardOf = (i: FunctionInteraction): string => text(i.guard) || (i.flow === "abnormal" ? labels.errorGuard : "")
  const emit = (depth: number, line: string): void => void state.lines.push(`${"  ".repeat(depth)}${line}`)

  /** `floor`: activation ở vị trí nhỏ hơn không được đóng ở đây (message trong `opt` không đóng activation bên ngoài). */
  const message = (i: FunctionInteraction, depth: number, floor: number): void => {
    const asked = list.indexOf(i)
    const starts = (i.kind === "request" && i.from !== SYSTEM_LIFELINE) || state.stimulus === 0
    if (starts) {
      state.stimulus += 1
      state.sub = 0
    } else state.sub += 1
    const number = starts ? String(state.stimulus) : `${state.stimulus}.${state.sub}`
    const sync = isSynchronous(list, asked)
    const arrow = i.kind === "response" ? "-->>" : sync ? "->" : "->>"
    emit(depth, `${aliasOf(i.from)} ${arrow} ${aliasOf(i.to)} : ${number}: ${text(i.message)}`)
    if (i.kind === "request" && sync) {
      state.open.push(aliasOf(i.to))
      emit(depth, `activate ${aliasOf(i.to)}`)
    } else if (i.kind === "response") {
      const owner = aliasOf(i.from)
      let at = -1
      state.open.forEach((a, k) => {
        if (a === owner && k >= floor) at = k
      })
      if (at >= 0) {
        state.open.splice(at, 1)
        emit(depth, `deactivate ${owner}`)
      }
    }
  }

  /** Đóng mọi activation còn mở từ vị trí `floor` (mới nhất trước). */
  const close = (depth: number, floor: number): void => {
    while (state.open.length > floor) emit(depth, `deactivate ${state.open.pop()}`)
  }

  /**
   * `floor`: activation ở vị trí nhỏ hơn thuộc phần bao ngoài và chỉ đóng sau khung (PlantUML tính activation theo thứ tự
   * văn bản, không mở lại được ở operand kế) nên thanh activation của bên nhận trải qua mọi operand của `alt` / `opt`.
   */
  const render = (items: readonly FunctionInteraction[], depth: number, floor: number): void => {
    let at = 0
    while (at < items.length) {
      const item = items[at]
      if (item.flow === "abnormal") {
        const end = items.findIndex((x, k) => k > at && x.flow !== "abnormal")
        const run = items.slice(at, end < 0 ? items.length : end)
        const rest = end < 0 ? [] : items.slice(end)
        const operands: FunctionInteraction[][] = []
        for (const x of run) {
          const last = operands[operands.length - 1]
          if (last && guardOf(last[0]) === guardOf(x)) last.push(x)
          else operands.push([x])
        }
        const outer = state.open.length
        operands.forEach((operand, k) => {
          emit(depth, `${k === 0 ? "alt" : "else"} ${guardOf(operand[0])}`)
          operand.forEach((x) => message(x, depth + 1, outer))
          close(depth + 1, outer)
        })
        if (rest.length > 0) {
          emit(depth, `else ${labels.elseGuard}`)
          render(rest, depth + 1, outer)
          close(depth + 1, outer)
        }
        emit(depth, "end")
        return
      }
      const guard = text(item.guard)
      if (guard !== "") {
        let end = at
        while (end < items.length && items[end].flow === "normal" && text(items[end].guard) === guard) end += 1
        emit(depth, `opt ${guard}`)
        const inner = state.open.length
        items.slice(at, end).forEach((x) => message(x, depth + 1, inner))
        close(depth + 1, inner)
        emit(depth, "end")
        at = end
        continue
      }
      message(item, depth, floor)
      at += 1
    }
  }

  render(list, 0, 0)
  close(0, 0)
  return state.lines
}

/** Nguồn `.puml` của một function. */
export const sequenceSource = (spine: Spine, fn: SpineFunction, labels: DiagramLabels = DIAGRAM_LABELS.en): string => {
  const list = fn.interactions ?? []
  const actors = new Map(spine.actors.map((a) => [a.id, a]))
  const ends = [...new Set(list.flatMap((i) => [i.from, i.to]))].filter((id) => id !== SYSTEM_LIFELINE)
  const ordered = byId(ends.map((id) => ({ id })))
  // Bên gửi stimulus đứng bên trái `:System` dù là actor ngoài (lịch, cổng thanh toán gọi vào); actor ngoài còn lại bên phải
  const stimulus = list[0]?.from
  const humans = ordered.filter(({ id }) => !isExternal(actors.get(id)) || id === stimulus)
  const externals = ordered.filter(({ id }) => isExternal(actors.get(id)) && id !== stimulus)
  const nameOf = (id: string): string => label(text(actors.get(id)?.name) || id)
  const aliasOf = (id: string): string => (id === SYSTEM_LIFELINE ? SYSTEM_ALIAS : alias(id))
  const declarations = [
    ...humans.map(({ id }) => `${isExternal(actors.get(id)) ? "participant" : "actor"} ":${nameOf(id)}" as ${aliasOf(id)}`),
    `participant ":${label(labels.system)}" as ${SYSTEM_ALIAS}`,
    ...externals.map(({ id }) => `participant ":${nameOf(id)}" as ${aliasOf(id)}`)
  ]
  return puml("@startuml", [...THEME, ...declarations, ...buildBody(list, aliasOf, labels)], "@enduml")
}

export const renderSequence: Renderer = (spine, _ownerId, labels = DIAGRAM_LABELS.en): RenderedPart[] =>
  byId(spine.functions)
    .filter((fn) => needsSequence(fn, spine.actors))
    .map((fn) => ({
      kind: "sequence" as const,
      section: `function:${fn.id}`,
      owner_kind: "function",
      owner_id: fn.id,
      format: "puml" as const,
      source: sequenceSource(spine, fn, labels)
    }))
