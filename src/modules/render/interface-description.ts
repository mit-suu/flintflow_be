/**
 * Mục "Interface" của §3.x.y mẫu FPT (FLF-214): mô tả giao diện màn bằng lời, đọc từ wireframe salt đã vẽ
 * (`diagrams[kind=screen_layout]`) — luôn khớp với hình, không gọi model.
 *
 * `Login screen: Email input, Password input (masked), Remember me checkbox, Forgot password? link, Log in button.`
 *
 * Chỉ nhận dạng các widget của skill `renderer/screen-layout` (bảng cú pháp ở SKILL.md): ô nhập `"…"` (nhãn là dòng
 * chữ ngay trên), nút `[ … ]`, link `<u>…</u>`, checkbox `[ ] …`, radio `( ) …`, dropdown `^…^`, bảng `{#`, tab `{/`.
 * Hình không phải wireframe (bảng Function | Description của Spine cũ) ⇒ `null`, người gọi dùng mô tả màn.
 */

import type { Spine } from "../spine/spine.types.js"

type Screen = Spine["screens"][number]

const clean = (text: string): string => text.replace(/<\/?[a-z]+(:[^>]*)?>/gi, "").replace(/\s+/g, " ").trim()

/** Một ô salt ⇒ mô tả widget, hoặc chữ thường (`text`) để làm nhãn cho ô nhập ngay sau. */
type Cell = { widget: string } | { text: string } | null

const cellOf = (raw: string): Cell => {
  const cell = raw.trim()
  if (!cell || cell === "." || cell === ".." || /^[-=~.]{2,}$/.test(cell)) return null
  let m: RegExpExecArray | null
  if ((m = /^\[( |x|X)\]\s*(.+)$/.exec(cell))) return { widget: `${clean(m[2])} checkbox` }
  if ((m = /^\(( |x|X)\)\s*(.+)$/.exec(cell))) return { widget: `${clean(m[2])} option` }
  if ((m = /^\[(.+)\]$/.exec(cell))) return { widget: `${clean(m[1])} button` }
  if ((m = /^\^(.*)\^$/.exec(cell))) return { widget: `${clean(m[1]) || "selection"} dropdown` }
  if ((m = /^<u>(.+)<\/u>$/i.exec(cell))) return { widget: `${clean(m[1])} link` }
  if ((m = /^"(.*)"$/.exec(cell))) return { widget: /^\.+$/.test(m[1].trim()) ? "masked input" : `input "${clean(m[1])}"` }
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
const labelled = (cells: Cell[]): string[] => {
  const out: string[] = []
  let label: string | null = null
  for (const cell of cells) {
    if (cell === null) continue
    if ("text" in cell) {
      if (label) out.push(`"${label}" text`)
      label = cell.text
      continue
    }
    const input = /^(masked input|input ")/.test(cell.widget)
    if (input && label && RANGE_JOINER.test(label) && / input$/.test(out[out.length - 1] ?? "")) {
      out[out.length - 1] = `${out[out.length - 1]} (range)`
    } else if (input && label) out.push(cell.widget === "masked input" ? `${label} input (masked)` : `${label} input`)
    else if (input) out.push(cell.widget === "masked input" ? "masked input" : cell.widget)
    else if (label && / dropdown$/.test(cell.widget)) out.push(`${label} dropdown`)
    else {
      if (label) out.push(`"${label}" text`)
      out.push(cell.widget)
    }
    label = null
  }
  if (label) out.push(`"${label}" text`)
  return out
}

/** Danh sách widget theo thứ tự trên màn; `null` nếu `puml` không phải wireframe salt. */
export const wireframeWidgets = (puml: string, screenName: string): string[] | null => {
  if (!puml.startsWith("@startsalt") || puml.includes("<b>Function | <b>Description")) return null
  const lines = puml.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim())
  const cells: Cell[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^@(start|end)salt/.test(line) || /^[{}]$/.test(line) || /^\{[\^!SI-]*$/.test(line) || /^\{\^"/.test(line)) continue
    if (line.startsWith("{/")) {
      const tabs = line.replace(/^\{\/|\}$/g, "").split("|").map(clean).filter(Boolean)
      if (tabs.length > 0) cells.push({ widget: `tabs (${tabs.join(", ")})` })
      continue
    }
    if (line.startsWith("{#")) {
      // Hàng tiêu đề nằm cùng dòng `{# A | B` hoặc ở dòng kế tiếp
      const rest = line.slice(2).trim()
      const header = (rest || lines[i + 1] || "").split("|").map(clean).filter(Boolean)
      cells.push({ widget: header.length > 0 ? `table (${header.join(", ")})` : "table" })
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
        const area = /\barea$/i.test(content) ? content : `${content} area`
        if (previous && "text" in previous) {
          cells[cells.length - 1] = { widget: placeholder ? `${previous.text} (${area.toLowerCase()})` : `${previous.text} text area` }
        } else {
          cells.push({ widget: area })
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

/** Câu mô tả giao diện màn; không có wireframe ⇒ mô tả màn (`screens[].description`); không có gì ⇒ `null`. */
export const describeInterface = (spine: Spine, screen: Screen): string | null => {
  const kind = screen.is_popup ? "pop-up" : "screen"
  const layout = spine.diagrams.find((d) => d.kind === "screen_layout" && d.owner_id === screen.id && d.render_status === "ok")
  const widgets = layout ? wireframeWidgets(layout.puml, screen.name) : null
  if (widgets) return `${screen.name} ${kind}: ${widgets.join(", ")}.`
  return screen.description.trim() ? `${screen.name} ${kind}: ${screen.description.trim()}` : null
}
