import mongoose from "mongoose"
import { describe, it, expect } from "vitest"
import { ImportedDocument } from "./imported-document.model.js"
import { DocBlock } from "./doc-block.model.js"
import { TemplateProfile } from "./template-profile.model.js"
import { ExtractionDraft } from "./extraction-draft.model.js"
import { FieldAnchor } from "./field-anchor.model.js"
import { ReuploadDiff } from "./reupload-diff.model.js"

const oid = () => new mongoose.Types.ObjectId()

describe("model import — index", () => {
  it("DocBlock: unique (projectId, doc_version, block_id) + tra khoá theo CR", () => {
    expect(DocBlock.schema.indexes()).toContainEqual([{ projectId: 1, doc_version: 1, block_id: 1 }, { unique: true }])
    expect(DocBlock.schema.indexes()).toContainEqual([{ projectId: 1, locked_by_cr: 1 }, {}])
  })

  it("mỗi project một TemplateProfile; FieldAnchor unique theo entity_path; ExtractionDraft unique theo section", () => {
    expect(TemplateProfile.schema.indexes()).toContainEqual([{ projectId: 1 }, { unique: true }])
    expect(FieldAnchor.schema.indexes()).toContainEqual([{ projectId: 1, entity_path: 1 }, { unique: true }])
    expect(ExtractionDraft.schema.indexes()).toContainEqual([{ import_id: 1, section_id: 1 }, { unique: true }])
  })

  it("ImportedDocument và ReuploadDiff lấy bản mới nhất theo project", () => {
    expect(ImportedDocument.schema.indexes()).toContainEqual([{ projectId: 1, createdAt: -1 }, {}])
    expect(ReuploadDiff.schema.indexes()).toContainEqual([{ projectId: 1, createdAt: -1 }, {}])
  })
})

describe("model import — mặc định và ràng buộc", () => {
  it("ImportedDocument mới: status uploaded, không pause, không stamp", () => {
    const doc = new ImportedDocument({
      projectId: oid(),
      sha256: "a".repeat(64),
      original_name: "srs.docx",
      size: 100,
      preflight: { status: "accepted", issues: [] },
      created_by: oid()
    })
    expect(doc.validateSync()).toBeUndefined()
    expect(doc.status).toBe("uploaded")
    expect(doc.paused).toBeNull()
    expect(doc.stamp).toBeNull()
    expect(doc.extract_cursor).toBeNull()
  })

  it("ImportedDocument từ chối status / mã preflight / lý do pause lạ", () => {
    const base = { projectId: oid(), sha256: "a".repeat(64), original_name: "x.docx", size: 1, created_by: oid() }
    expect(new ImportedDocument({ ...base, preflight: { status: "accepted" }, status: "done" }).validateSync()?.errors.status).toBeDefined()
    expect(new ImportedDocument({ ...base, preflight: { status: "rejected", issues: [{ code: "VIRUS", message: "x" }] } }).validateSync()).toBeDefined()
    expect(new ImportedDocument({ ...base, preflight: { status: "accepted" }, paused: { reason: "tired", at: new Date() } }).validateSync()).toBeDefined()
  })

  it("DocBlock: neo có bookmark (neo chính) và para_id (neo phụ) mặc định null; editable mặc định true", () => {
    const block = new DocBlock({
      projectId: oid(),
      doc_version: "0.0",
      block_id: "B0001",
      kind: "heading",
      level: 1,
      anchor: { xml_path: "body/p[0]", ordinal: 0 },
      text: "1 Product Overview",
      text_hash: "abc123"
    })
    expect(block.validateSync()).toBeUndefined()
    expect(block.anchor.bookmark).toBeNull()
    expect(block.anchor.para_id).toBeNull()
    expect(block.editable).toBe(true)
    expect(block.locked_by_cr).toBeNull()
    expect(new DocBlock({ ...block.toObject(), kind: "textbox" }).validateSync()?.errors.kind).toBeDefined()
  })

  it("TemplateProfile: confidence trong [0, 1], detected_by thuộc danh sách", () => {
    const entry = { block_id: "B0002", heading_text: "2.1 Actors", section_id: "fixed:2.1", confidence: 0.92, detected_by: "numbering_pattern" }
    expect(new TemplateProfile({ projectId: oid(), doc_version: "0.0", heading_map: [entry] }).validateSync()).toBeUndefined()
    expect(new TemplateProfile({ projectId: oid(), doc_version: "0.0", heading_map: [{ ...entry, confidence: 1.4 }] }).validateSync()).toBeDefined()
    expect(new TemplateProfile({ projectId: oid(), doc_version: "0.0", heading_map: [{ ...entry, detected_by: "guess" }] }).validateSync()).toBeDefined()
  })

  it("ExtractionDraft: field phải ghi origin (deterministic | ai)", () => {
    const field = { path: "actors[id=A01].name", value: "Student", confidence: 0.95, source_block_ids: ["B0010"] }
    expect(new ExtractionDraft({ projectId: oid(), import_id: oid(), section_id: "fixed:2.1", fields: [{ ...field, origin: "ai" }] }).validateSync()).toBeUndefined()
    expect(new ExtractionDraft({ projectId: oid(), import_id: oid(), section_id: "fixed:2.1", fields: [field] }).validateSync()).toBeDefined()
  })

  it("ReuploadDiff: change thuộc added | removed | modified | moved", () => {
    const base = { projectId: oid(), sha256: "b".repeat(64), original_name: "x.docx", against_version: "0.1", created_by: oid() }
    expect(new ReuploadDiff({ ...base, blocks: [{ block_id: null, change: "added", after: "x" }] }).validateSync()).toBeUndefined()
    expect(new ReuploadDiff({ ...base, blocks: [{ block_id: "B0001", change: "renamed" }] }).validateSync()).toBeDefined()
  })
})
