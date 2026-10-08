/**
 * Mở/lưu gói .docx (zip OOXML), đọc/ghi part XML, cập nhật `[Content_Types].xml` và rels.
 * FLF-171, plan §6 2A. Part XML được parse một lần rồi cache; `toBuffer()` ghi lại mọi part đã mở
 * (part không đụng giữ nguyên byte).
 */

import JSZip from "jszip"
import { NS, OoxmlError, parseXml, serializeXml } from "./xml.js"

/** Chặn zip bomb: tổng dung lượng giải nén tối đa. */
export const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024

export interface Relationship {
  id: string
  type: string
  target: string
}

/** `word/document.xml` ⇒ `word/_rels/document.xml.rels`; `""` (gốc gói) ⇒ `_rels/.rels`. */
export const relsPathOf = (partName: string): string => {
  const slash = partName.lastIndexOf("/")
  return `${partName.slice(0, slash + 1)}_rels/${partName.slice(slash + 1)}.rels`
}

type ZipEntryWithSize = JSZip.JSZipObject & { _data?: { uncompressedSize?: number } }

export class DocxPackage {
  private readonly parts = new Map<string, Document>()

  private constructor(private readonly zip: JSZip) {}

  static async load(data: Buffer | Uint8Array, opts: { maxUncompressedBytes?: number } = {}): Promise<DocxPackage> {
    const zip = await JSZip.loadAsync(data)
    const limit = opts.maxUncompressedBytes ?? MAX_UNCOMPRESSED_BYTES
    let total = 0
    zip.forEach((_path, entry) => {
      total += (entry as ZipEntryWithSize)._data?.uncompressedSize ?? 0
    })
    if (total > limit) throw new OoxmlError("PACKAGE_TOO_LARGE", `Gói giải nén ${total} byte vượt giới hạn ${limit}`)
    return new DocxPackage(zip)
  }

  has(name: string): boolean {
    return this.parts.has(name) || this.zip.file(name) !== null
  }

  partNames(): string[] {
    return Object.keys(this.zip.files).filter((n) => !this.zip.files[n].dir)
  }

  async xml(name: string): Promise<Document | null> {
    const cached = this.parts.get(name)
    if (cached) return cached
    const file = this.zip.file(name)
    if (!file) return null
    const doc = parseXml(await file.async("string"), name)
    this.parts.set(name, doc)
    return doc
  }

  /** Nội dung nhị phân của một part (ảnh `word/media/*`…) — không có ⇒ `null`. Mode 1 v3 phase 5 (T3). */
  async binary(name: string): Promise<Buffer | null> {
    const file = this.zip.file(name)
    return file ? file.async("nodebuffer") : null
  }

  async requireXml(name: string): Promise<Document> {
    const doc = await this.xml(name)
    if (!doc) throw new OoxmlError("PART_MISSING", `Thiếu part ${name}`)
    return doc
  }

  /** Tạo part XML mới + khai báo `Override` trong `[Content_Types].xml`. Part đã có ⇒ trả part cũ. */
  async addXmlPart(name: string, xml: string, contentType: string): Promise<Document> {
    const existing = await this.xml(name)
    if (existing) return existing
    const doc = parseXml(xml, name)
    this.parts.set(name, doc)
    const ct = await this.requireXml("[Content_Types].xml")
    const override = ct.createElementNS(NS.ct, "Override")
    override.setAttribute("PartName", `/${name}`)
    override.setAttribute("ContentType", contentType)
    ct.documentElement.appendChild(override)
    return doc
  }

  async relationships(ownerPart: string): Promise<Relationship[]> {
    const rels = await this.xml(relsPathOf(ownerPart))
    if (!rels) return []
    return Array.from(rels.getElementsByTagNameNS(NS.rels, "Relationship")).map((r) => ({
      id: r.getAttribute("Id") ?? "",
      type: r.getAttribute("Type") ?? "",
      target: r.getAttribute("Target") ?? ""
    }))
  }

  /** Thêm quan hệ từ `ownerPart` tới `target` (đường dẫn tương đối như Word ghi). Trả `Id` mới. */
  async addRelationship(ownerPart: string, type: string, target: string, idPrefix = "rIdFF"): Promise<string> {
    const path = relsPathOf(ownerPart)
    let rels = await this.xml(path)
    if (!rels) {
      rels = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS.rels}"/>`, path)
      this.parts.set(path, rels)
    }
    const used = new Set(Array.from(rels.getElementsByTagNameNS(NS.rels, "Relationship")).map((r) => r.getAttribute("Id")))
    let k = 1
    while (used.has(`${idPrefix}${k}`)) k++
    const rel = rels.createElementNS(NS.rels, "Relationship")
    rel.setAttribute("Id", `${idPrefix}${k}`)
    rel.setAttribute("Type", type)
    rel.setAttribute("Target", target)
    rels.documentElement.appendChild(rel)
    return `${idPrefix}${k}`
  }

  /** Part được `ownerPart` tham chiếu qua rels `id` (đường dẫn tuyệt đối trong gói). */
  async resolveRelationship(ownerPart: string, id: string): Promise<string | null> {
    const rel = (await this.relationships(ownerPart)).find((r) => r.id === id)
    if (!rel) return null
    if (rel.target.startsWith("/")) return rel.target.slice(1)
    const base = ownerPart.slice(0, ownerPart.lastIndexOf("/") + 1)
    const segments: string[] = []
    for (const seg of `${base}${rel.target}`.split("/")) {
      if (seg === "..") segments.pop()
      else if (seg !== ".") segments.push(seg)
    }
    return segments.join("/")
  }

  /** Tên part `word/<prefix><k>.xml` chưa dùng. */
  freePartName(prefix: string): string {
    let k = 1
    while (this.has(`word/${prefix}${k}.xml`)) k++
    return `word/${prefix}${k}.xml`
  }

  async toBuffer(): Promise<Buffer> {
    for (const [name, doc] of this.parts) this.zip.file(name, serializeXml(doc))
    return this.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  }
}
