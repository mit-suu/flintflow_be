/**
 * Đọc/ghi stamp FlintFlow trong `docProps/custom.xml` (I-1 nút 1.2, 6.2). FLF-171, plan §6 2A.
 * Tên property giống `render/docx-writer.ts` (mode 2) nên đọc được cả file do mode 2 xuất.
 */

import { STAMP_KINDS, STAMP_PROPERTY, type StampKind } from "../import/import.constants.js"
import type { DocxPackage } from "./package.js"
import { CONTENT_TYPE, NS, REL_TYPE } from "./xml.js"

export const CUSTOM_PROPS_PART = "docProps/custom.xml"
/** fmtid chuẩn của custom property do người dùng định nghĩa. */
const USER_DEFINED_FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"

export interface Stamp {
  project_id: string
  version: string | null
  source: string | null
  /** FLF-334 — file cũ không có ⇒ `null`; ghi mà bỏ trống (`undefined`) ⇒ xoá property cũ như `null`. */
  base_version?: string | null
  latest_cr?: string | null
  kind?: StampKind | null
}

const toKind = (value: string | undefined): StampKind | null => (STAMP_KINDS as readonly string[]).includes(value ?? "") ? (value as StampKind) : null

export const readCustomProperties = async (pkg: DocxPackage): Promise<Record<string, string>> => {
  const doc = await pkg.xml(CUSTOM_PROPS_PART)
  const out: Record<string, string> = {}
  if (!doc) return out
  for (const p of Array.from(doc.getElementsByTagNameNS(NS.cp, "property"))) {
    const name = p.getAttribute("name")
    if (name) out[name] = (p.textContent ?? "").trim()
  }
  return out
}

/** `null` nếu file không mang stamp FlintFlow (không có `flintflow_project_id`). */
export const readStamp = async (pkg: DocxPackage): Promise<Stamp | null> => {
  const props = await readCustomProperties(pkg)
  const projectId = props[STAMP_PROPERTY.project_id]
  if (!projectId) return null
  return {
    project_id: projectId,
    version: props[STAMP_PROPERTY.version] ?? null,
    source: props[STAMP_PROPERTY.source] ?? null,
    base_version: props[STAMP_PROPERTY.base_version] || null,
    latest_cr: props[STAMP_PROPERTY.latest_cr] || null,
    kind: toKind(props[STAMP_PROPERTY.kind])
  }
}

/** Ghi (thêm hoặc đè) stamp; tạo `custom.xml` + rels gốc + content type nếu chưa có. */
export const writeStamp = async (pkg: DocxPackage, stamp: Stamp): Promise<void> => {
  let doc = await pkg.xml(CUSTOM_PROPS_PART)
  if (!doc) {
    doc = await pkg.addXmlPart(
      CUSTOM_PROPS_PART,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="${NS.cp}" xmlns:vt="${NS.vt}"/>`,
      CONTENT_TYPE.customProperties
    )
    await pkg.addRelationship("", REL_TYPE.customProperties, CUSTOM_PROPS_PART)
  }
  const props = Array.from(doc.getElementsByTagNameNS(NS.cp, "property"))
  let pid = Math.max(1, ...props.map((p) => Number(p.getAttribute("pid")) || 0))
  const values: [string, string | null][] = [
    [STAMP_PROPERTY.project_id, stamp.project_id],
    [STAMP_PROPERTY.version, stamp.version],
    [STAMP_PROPERTY.source, stamp.source],
    [STAMP_PROPERTY.base_version, stamp.base_version ?? null],
    [STAMP_PROPERTY.latest_cr, stamp.latest_cr ?? null],
    [STAMP_PROPERTY.kind, stamp.kind ?? null]
  ]
  for (const [name, value] of values) {
    let p = props.find((x) => x.getAttribute("name") === name)
    if (value === null) {
      p?.parentNode?.removeChild(p)
      continue
    }
    if (!p) {
      p = doc.createElementNS(NS.cp, "property")
      p.setAttribute("fmtid", USER_DEFINED_FMTID)
      p.setAttribute("pid", String(++pid))
      p.setAttribute("name", name)
      doc.documentElement.appendChild(p)
    }
    while (p.firstChild) p.removeChild(p.firstChild)
    const v = doc.createElementNS(NS.vt, "vt:lpwstr")
    v.appendChild(doc.createTextNode(value))
    p.appendChild(v)
  }
}
