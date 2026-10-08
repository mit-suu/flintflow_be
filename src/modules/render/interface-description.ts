/**
 * Mục "Interface" của §3.x.y mẫu FPT (FLF-214): mô tả giao diện màn bằng lời, đọc từ wireframe salt đã vẽ
 * (`diagrams[kind=screen_layout]`) — luôn khớp với hình, không gọi model.
 *
 * `Login screen: Email input, Password input (masked), Remember me checkbox, Forgot password? link, Log in button.`
 *
 * Chỉ nhận dạng các widget của skill `renderer/screen-layout` (bảng cú pháp ở SKILL.md): ô nhập `"…"` (nhãn là dòng
 * chữ ngay trên), nút `[ … ]`, link `<u>…</u>`, checkbox `[ ] …`, radio `( ) …`, dropdown `^…^`, bảng `{#`, tab `{/`.
 * Hình không phải wireframe (bảng Function | Description của Spine cũ) ⇒ `null`, người gọi dùng mô tả màn.
 *
 * FLF-265: câu theo ngôn ngữ tài liệu — tiếng Việt `Màn hình Login: ô nhập Email, nút Log in.`. Widget giữ dạng có
 * cấu trúc (loại + chữ trên widget), chỉ lúc in mới ghép theo ngôn ngữ; chữ trên widget lấy nguyên từ puml (tiếng Anh).
 * Mọi điều kiện ghép (nhãn cho ô nhập, khoảng giá trị) vẫn so trên câu tiếng Anh ⇒ bản tiếng Anh không đổi.
 */

import type { Spine } from "../spine/spine.types.js"
import { VI_WIDGET_LABELS, VI_WIDGET_NOTES, interfaceSentence, isVietnamese } from "./labels.js"

type Screen = Spine["screens"][number]

const clean = (text: string): string => text.replace(/<\/?[a-z]+(:[^>]*)?>/gi, "").replace(/\s+/g, " ").trim()

/** Widget nhận dạng được — `name` / `label` / `items` / `content` là chữ trên wireframe, giữ nguyên. */
type Widget =
  | { kind: "checkbox" | "option" | "button" | "link" | "dropdown"; name: string }
  | { kind: "input"; label?: string; placeholder?: string; masked: boolean; range?: boolean }
  | { kind: "tabs" | "table"; items: string[] }
  // Khung `{+` chỉ chứa chữ: vùng giữ chỗ (`Map area`); có nhãn ngay trên ⇒ `owner` (`Location (map area)`)
  | { kind: "area"; content: string; owner?: string }
  | { kind: "text_area"; label: string }
  | { kind: "text"; text: string }

const areaEn = (content: string): string => (/\barea$/i.test(content) ? content : `${content} area`)
const areaVi = (content: string): string => `${VI_WIDGET_LABELS.area} ${content.replace(/\s*\barea$/i, "") || content}`

/** Câu tiếng Anh của widget — đúng chuỗi trước FLF-265. */
const widgetEn = (w: Widget): string => {
  switch (w.kind) {
    case "checkbox":
    case "option":
    case "button":
    case "link":
      return `${w.name} ${w.kind}`
    case "dropdown":
      return `${w.name || "selection"} dropdown`
    case "input": {
      const base = w.label ? (w.masked ? `${w.label} input (masked)` : `${w.label} input`) : w.masked ? "masked input" : `input "${w.placeholder ?? ""}"`
      return w.range ? `${base} (range)` : base
    }
    case "tabs":
      return `tabs (${w.items.join(", ")})`
    case "table":
      return w.items.length > 0 ? `table (${w.items.join(", ")})` : "table"
    case "area":
      return w.owner ? `${w.owner} (${areaEn(w.content).toLowerCase()})` : areaEn(w.content)
    case "text_area":
      return `${w.label} text area`
    case "text":
      return `"${w.text}" text`
  }
}

/** Câu tiếng Việt: tên loại đứng trước chữ trên widget (`nút Log in`, `ô nhập Password (ẩn)`). */
const widgetVi = (w: Widget): string => {
  switch (w.kind) {
    case "checkbox":
    case "option":
    case "button":
    case "link":
      return `${VI_WIDGET_LABELS[w.kind]} ${w.name}`
    case "dropdown":
      return w.name ? `${VI_WIDGET_LABELS.dropdown} ${w.name}` : VI_WIDGET_LABELS.dropdown
    case "input": {
      const notes = [w.masked ? VI_WIDGET_NOTES.masked : "", w.range ? VI_WIDGET_NOTES.range : ""].filter(Boolean)
      const name = w.label ?? (w.masked ? "" : `"${w.placeholder ?? ""}"`)
      return [VI_WIDGET_LABELS.input, name, notes.length > 0 ? `(${notes.join(", ")})` : ""].filter(Boolean).join(" ")
    }
    case "tabs":
    case "table":
      return w.items.length > 0 ? `${VI_WIDGET_LABELS[w.kind]} (${w.items.join(", ")})` : VI_WIDGET_LABELS[w.kind]
    case "area":
      return w.owner ? `${w.owner} (${areaVi(w.content).toLowerCase()})` : areaVi(w.content)
    case "text_area":
      return `${VI_WIDGET_LABELS.text_area} ${w.label}`
    case "text":
      return `${VI_WIDGET_LABELS.text} "${w.text}"`
  }
}

/** Một ô salt ⇒ widget, hoặc chữ thường (`text`) để làm nhãn cho ô nhập ngay sau. */
type Cell = { widget: Widget } | { text: string } | null

const cellOf = (raw: string): Cell => {
  const cell = raw.trim()
  if (!cell || cell === "." || cell === ".." || /^[-=~.]{2,}$/.test(cell)) return null
  let m: RegExpExecArray | null
  if ((m = /^\[( |x|X)\]\s*(.+)$/.exec(cell))) return { widget: { kind: "checkbox", name: clean(m[2]) } }
  if ((m = /^\(( |x|X)\)\s*(.+)$/.exec(cell))) return { widget: { kind: "option", name: clean(m[2]) } }
  if ((m = /^\[(.+)\]$/.exec(cell))) return { widget: { kind: "button", name: clean(m[1]) } }
  if ((m = /^\^(.*)\^$/.exec(cell))) return { widget: { kind: "dropdown", name: clean(m[1]) } }
  if ((m = /^<u>(.+)<\/u>$/i.exec(cell))) return { widget: { kind: "link", name: clean(m[1]) } }
  if ((m = /^"(.*)"$/.exec(cell))) {
    return { widget: /^\.+$/.test(m[1].trim()) ? { kind: "input", masked: true } : { kind: "input", masked: false, placeholder: clean(m[1]) } }
  }
  if (/^<b>/i.test(cell)) return { text: clean(cell) }
  const text = clean(cell)
  return text ? { text } : null
}

/** Chữ nối giữa hai ô của một khoảng giá trị: `Price "…" to "…"`. */
const RANGE_JOINER = /^(to|-|–|~|and)$/i

/**
 * Ô nhập / dropdown lấy dòng chữ đứng ngay trước làm nhãn: `Email` + `"john@…"` ⇒ `Email input`,
 * `Location` + `^All districts^` ⇒ `Location dropdown`; `Price "…" to "…"` ⇒ `Price input (range)`.
 */
const labelled = (cells: Cell[]): Widget[] => {
  const out: Widget[] = []
  let label: string | null = null
  // Điều kiện ghép so trên câu tiếng Anh như trước FLF-265 — giữ đúng hành vi cũ, kể cả ca biên
  const lastEn = (): string => (out.length > 0 ? widgetEn(out[out.length - 1]) : "")
  for (const cell of cells) {
    if (cell === null) continue
    if ("text" in cell) {
      if (label) out.push({ kind: "text", text: label })
      label = cell.text
      continue
    }
    const widget = cell.widget
    const input = /^(masked input|input ")/.test(widgetEn(widget))
    const last = out[out.length - 1]
    if (input && label && RANGE_JOINER.test(label) && / input$/.test(lastEn()) && last?.kind === "input") {
      out[out.length - 1] = { ...last, range: true }
    } else if (input && label) out.push(widget.kind === "input" ? { ...widget, label } : { kind: "input", label, masked: false })
    else if (input) out.push(widget)
    else if (label && / dropdown$/.test(widgetEn(widget))) out.push({ kind: "dropdown", name: label })
    else {
      if (label) out.push({ kind: "text", text: label })
      out.push(widget)
    }
    label = null
  }
  if (label) out.push({ kind: "text", text: label })
  return out
}

/** Widget có cấu trúc theo thứ tự trên màn; `null` nếu `puml` không phải wireframe salt. */
const parseWireframe = (puml: string, screenName: string): Widget[] | null => {
  if (!puml.startsWith("@startsalt") || puml.includes("<b>Function | <b>Description")) return null
  const lines = puml.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim())
  const cells: Cell[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^@(start|end)salt/.test(line) || /^[{}]$/.test(line) || /^\{[\^!SI-]*$/.test(line) || /^\{\^"/.test(line)) continue
    // Hàng đệm quanh nội dung khung ngoài (`padFrame` của screen-layout.ai): `{ . | . | {` … `} | . | . }`
    if (/^\{(\s*\.\s*\|)+\s*\{$/.test(line) || /^\}(\s*\|\s*\.)+\s*\}$/.test(line)) continue
    if (line.startsWith("{/")) {
      const tabs = line.replace(/^\{\/|\}$/g, "").split("|").map(clean).filter(Boolean)
      if (tabs.length > 0) cells.push({ widget: { kind: "tabs", items: tabs } })
      continue
    }
    if (line.startsWith("{#")) {
      // Hàng tiêu đề nằm cùng dòng `{# A | B` hoặc ở dòng kế tiếp
      const rest = line.slice(2).trim()
      const header = (rest || lines[i + 1] || "").split("|").map(clean).filter(Boolean)
      cells.push({ widget: { kind: "table", items: header } })
      while (i < lines.length && !lines[i].endsWith("}")) i++
      continue
    }
    // Khung `{+` chỉ chứa chữ (không widget): ô nhập nhiều dòng nếu có nhãn ngay trên, không thì vùng giữ chỗ
    // (`Map area`, `Photo gallery`). Khung chứa widget (khung ngoài của màn) thì đọc tiếp từng dòng bên trong.
    if (line.startsWith("{+")) {
      let end = i
      let depth = 0
      for (let j = i; j < lines.length; j++) {
        depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length
        if (depth <= 0) {
          end = j
          break
        }
      }
      const inner = [line.slice(2).replace(/\}$/, ""), ...lines.slice(i + 1, end), end > i ? lines[end].replace(/\}$/, "") : ""]
        .map((l) => l.trim())
        .filter((l) => l && l !== ".")
      const plain = end > i || line.endsWith("}")
      if (plain && inner.length > 0 && inner.every((l) => { const c = cellOf(l); return c !== null && "text" in c })) {
        const previous = cells[cells.length - 1]
        const content = clean(inner[0])
        const placeholder = /\b(map|image|photo|picture|gallery|chart|video)\b/i.test(content)
        if (previous && "text" in previous) {
          cells[cells.length - 1] = {
            widget: placeholder ? { kind: "area", content, owner: previous.text } : { kind: "text_area", label: previous.text }
          }
        } else {
          cells.push({ widget: { kind: "area", content } })
        }
        i = end
        continue
      }
      if (line === "{+") continue
    }
    if (line.startsWith("{") && line.endsWith("}")) {
      for (const part of line.slice(1, -1).split("|")) cells.push(cellOf(part))
      continue
    }
    const cell = cellOf(line)
    // Tên màn / tên hệ thống ở đầu trang không phải nội dung
    if (cell && "text" in cell && (cell.text === screenName || cell.text === cell.text.toUpperCase())) continue
    cells.push(cell)
  }
  const widgets = labelled(cells)
  return widgets.length > 0 ? widgets : null
}

/**
 * Danh sách widget theo thứ tự trên màn, in theo ngôn ngữ (mặc định tiếng Anh); `null` nếu `puml` không phải
 * wireframe salt.
 */
export const wireframeWidgets = (puml: string, screenName: string, language?: string): string[] | null =>
  parseWireframe(puml, screenName)?.map(isVietnamese(language) ? widgetVi : widgetEn) ?? null

/**
 * Câu mô tả giao diện màn; không có wireframe ⇒ mô tả màn (`screens[].description`); không có gì ⇒ `null`.
 * `language` (FLF-265): chữ nối + tên loại widget theo ngôn ngữ; tên màn, chữ trên widget, mô tả màn giữ nguyên.
 */
export const describeInterface = (spine: Spine, screen: Screen, language?: string): string | null => {
  const layout = spine.diagrams.find((d) => d.kind === "screen_layout" && d.owner_id === screen.id && d.render_status === "ok")
  const widgets = layout ? wireframeWidgets(layout.puml, screen.name, language) : null
  if (widgets) return interfaceSentence(language, screen.name, screen.is_popup, `${widgets.join(", ")}.`)
  return screen.description.trim() ? interfaceSentence(language, screen.name, screen.is_popup, screen.description.trim()) : null
}
