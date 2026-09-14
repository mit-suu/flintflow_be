/**
 * path-resolver.ts
 * ─────────────────────────────────────────────────────────────────
 * Parse và phân giải path theo khoá (srs-spine.md §1). Không bao giờ theo chỉ số.
 *
 * Ngữ pháp:
 *   path     := segment ("." segment)*
 *   segment  := key selector?
 *   key      := [A-Za-z_][A-Za-z0-9_]*
 *   selector := "[]"                  đích là chính mảng (add, renumber)
 *             | "[=" value "]"        phần tử vô hướng: flow_to[=S08]
 *             | "[" k=v ("," k=v)* "]"  phần tử object: permissions[screen_id=S3,role_id=R1,action=create]
 *
 * Giá trị selector được phép chứa `.`, `:`, `@`, `-` (ví dụ `sections[id=fixed:3.1.1]`,
 * `steps[id=S-5.1@S07]`), không được chứa `,` `]` `[`. So khớp bằng `String(el[k]) === v`.
 * `actors[1]` bị từ chối (`index_selector_forbidden`).
 */

import type { RejectRule } from "./op.types.js"

export class PathError extends Error {
  readonly rule: RejectRule
  readonly path: string

  constructor(rule: RejectRule, path: string, message: string) {
    super(message)
    this.rule = rule
    this.path = path
  }
}

// ─── parse ───────────────────────────────────────────────────────

export type Selector =
  | { kind: "append" }
  | { kind: "scalar"; value: string }
  | { kind: "match"; pairs: [string, string][] }

export interface Segment {
  key: string
  selector?: Selector
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*/
const INDEX_RE = /^\s*-?\d+\s*$/

const parseSelector = (raw: string, path: string): Selector => {
  if (raw === "") return { kind: "append" }
  if (INDEX_RE.test(raw)) {
    throw new PathError("index_selector_forbidden", path, `Không được dùng chỉ số mảng [${raw}] — dùng khoá, ví dụ [id=...]`)
  }
  if (raw.startsWith("=")) {
    const value = raw.slice(1)
    if (value === "") throw new PathError("path_invalid", path, "Selector [=] thiếu giá trị")
    return { kind: "scalar", value }
  }
  const pairs = raw.split(",").map((part): [string, string] => {
    const eq = part.indexOf("=")
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1)
    if (eq <= 0 || !KEY_RE.test(k) || KEY_RE.exec(k)?.[0] !== k || v === "") {
      throw new PathError("path_invalid", path, `Selector không hợp lệ: [${raw}]`)
    }
    return [k, v]
  })
  return { kind: "match", pairs }
}

export const parsePath = (path: string): Segment[] => {
  const segments: Segment[] = []
  let rest = path

  while (true) {
    const key = KEY_RE.exec(rest)?.[0]
    if (!key) throw new PathError("path_invalid", path, `Path không hợp lệ: "${path}"`)
    rest = rest.slice(key.length)

    let selector: Selector | undefined
    if (rest.startsWith("[")) {
      const close = rest.indexOf("]")
      if (close < 0) throw new PathError("path_invalid", path, `Thiếu "]" trong path "${path}"`)
      const raw = rest.slice(1, close)
      if (raw.includes("[")) throw new PathError("path_invalid", path, `Selector lồng nhau không được hỗ trợ: "${path}"`)
      selector = parseSelector(raw, path)
      rest = rest.slice(close + 1)
    }
    segments.push(selector ? { key, selector } : { key })

    if (rest === "") break
    if (!rest.startsWith(".")) throw new PathError("path_invalid", path, `Path không hợp lệ: "${path}"`)
    rest = rest.slice(1)
  }

  for (const [i, seg] of segments.entries()) {
    const last = i === segments.length - 1
    if (!last && (seg.selector?.kind === "append" || seg.selector?.kind === "scalar")) {
      throw new PathError("path_invalid", path, `Selector [] / [=v] chỉ được ở cuối path: "${path}"`)
    }
  }
  return segments
}

// ─── format ──────────────────────────────────────────────────────

const formatSelector = (selector: Selector): string => {
  switch (selector.kind) {
    case "append":
      return "[]"
    case "scalar":
      return `[=${selector.value}]`
    case "match":
      return `[${selector.pairs.map(([k, v]) => `${k}=${v}`).join(",")}]`
  }
}

export const formatPath = (segments: Segment[]): string =>
  segments.map((s) => s.key + (s.selector ? formatSelector(s.selector) : "")).join(".")

/** Selector chuẩn cho một phần tử: `[id=X]` nếu có id, `[=v]` nếu vô hướng. */
export const selectorFor = (element: unknown): Selector | null => {
  if (typeof element === "string" || typeof element === "number" || typeof element === "boolean") {
    return { kind: "scalar", value: String(element) }
  }
  if (isRecord(element) && typeof element.id === "string") return { kind: "match", pairs: [["id", element.id]] }
  return null
}

/** `screens[id=S07].flow_to[=S08]` → `screens[id=S07].flow_to[]`. Path không kết thúc bằng selector phần tử ⇒ null. */
export const parentArrayPath = (path: string): string | null => {
  const segments = parsePath(path)
  const last = segments[segments.length - 1]
  if (!last.selector || last.selector.kind === "append") return null
  return formatPath([...segments.slice(0, -1), { key: last.key, selector: { kind: "append" } }])
}

// ─── resolve ─────────────────────────────────────────────────────

export type Resolved =
  | {
      kind: "field"
      parent: Record<string, unknown>
      key: string
      value: unknown
      exists: boolean
      /** Path chuẩn hoá: mọi selector phần tử có id đổi thành `[id=...]`. */
      canonical: string
      /** Khoá định danh của phần tử cha (id + trường trong selector) — op không được đổi. */
      lockedKeys: string[]
    }
  | {
      kind: "element"
      parent: unknown[]
      key: number
      value: unknown
      exists: true
      canonical: string
      /** Trường dùng làm khoá của chính phần tử này. */
      lockedKeys: string[]
    }
  | {
      kind: "append"
      parent: unknown[]
      key: number
      value: undefined
      exists: false
      canonical: string
      lockedKeys: []
    }

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const findIndices = (arr: unknown[], selector: Exclude<Selector, { kind: "append" }>): number[] => {
  const hits: number[] = []
  arr.forEach((el, i) => {
    const ok =
      selector.kind === "scalar"
        ? !isRecord(el) && String(el) === selector.value
        : isRecord(el) && selector.pairs.every(([k, v]) => k in el && String(el[k]) === v)
    if (ok) hits.push(i)
  })
  return hits
}

const lockedKeysOf = (element: unknown, selector: Selector): string[] => {
  const keys = new Set<string>()
  if (isRecord(element) && "id" in element) keys.add("id")
  if (selector.kind === "match") for (const [k] of selector.pairs) keys.add(k)
  return [...keys]
}

/**
 * Phân giải `path` trên `root`. Ném `PathError` khi path sai cú pháp, không tồn tại,
 * hoặc khớp nhiều phần tử. Field cuối được phép chưa tồn tại (`exists=false`) —
 * ví dụ `nfrs[id=N01].metric` tuỳ chọn; key lạ bị `spineSchema` chặn cuối lô.
 */
export const resolve = (root: unknown, path: string): Resolved => {
  const segments = parsePath(path)
  const canonical: Segment[] = []
  let node: unknown = root
  let lockedKeys: string[] = []

  for (const [i, seg] of segments.entries()) {
    const last = i === segments.length - 1
    if (!isRecord(node)) throw new PathError("path_not_resolved", path, `Không phân giải được "${path}"`)

    if (!seg.selector) {
      canonical.push({ key: seg.key })
      if (last) {
        return {
          kind: "field",
          parent: node,
          key: seg.key,
          value: node[seg.key],
          exists: Object.prototype.hasOwnProperty.call(node, seg.key),
          canonical: formatPath(canonical),
          lockedKeys
        }
      }
      node = node[seg.key]
      lockedKeys = []
      continue
    }

    const arr = node[seg.key]
    if (!Array.isArray(arr)) {
      throw new PathError("path_not_resolved", path, `"${formatPath([...canonical, { key: seg.key }])}" không phải mảng`)
    }

    if (seg.selector.kind === "append") {
      canonical.push(seg)
      return { kind: "append", parent: arr, key: arr.length, value: undefined, exists: false, canonical: formatPath(canonical), lockedKeys: [] }
    }

    const hits = findIndices(arr, seg.selector)
    if (hits.length === 0) throw new PathError("path_not_resolved", path, `Không tìm thấy phần tử cho "${path}"`)
    if (hits.length > 1) throw new PathError("path_ambiguous", path, `Selector khớp ${hits.length} phần tử: "${path}"`)

    const element = arr[hits[0]]
    canonical.push({ key: seg.key, selector: selectorFor(element) ?? seg.selector })
    const keys = lockedKeysOf(element, seg.selector)

    if (last) {
      return { kind: "element", parent: arr, key: hits[0], value: element, exists: true, canonical: formatPath(canonical), lockedKeys: keys }
    }
    node = element
    lockedKeys = keys
  }

  // parsePath luôn trả ≥ 1 segment nên không tới đây
  throw new PathError("path_invalid", path, `Path rỗng`)
}

/** Như `resolve` nhưng trả null thay vì ném. */
export const tryResolve = (root: unknown, path: string): Resolved | null => {
  try {
    return resolve(root, path)
  } catch (err) {
    if (err instanceof PathError) return null
    throw err
  }
}
