/**
 * FLF-339 — migration `diagrams[].puml` → `source` + `format` chạy trên Mongo thật (in-memory replica set): dry-run không
 * ghi, apply không tăng `spine_version`, chạy lại không còn gì, revert trả dạng cũ; ghi qua repository không để lại `puml`.
 */
import { describe, it, expect, beforeEach } from "vitest"
import mongoose from "mongoose"
import { readFixtureJson } from "../setup.js"
import { Spine as SpineModel } from "../../src/modules/spine/spine.model.js"
import * as repository from "../../src/modules/spine/spine.repository.js"
import { migrateDiagramSource } from "../../src/scripts/migrate-diagram-source.js"

const PROJECT = new mongoose.Types.ObjectId()

type RawDiagram = Record<string, unknown>
const rawDiagrams = async (): Promise<RawDiagram[]> =>
  ((await SpineModel.collection.findOne({ projectId: PROJECT }))?.diagrams ?? []) as RawDiagram[]
const rawVersion = async () => (await SpineModel.collection.findOne({ projectId: PROJECT }))?.spine_version

/** Spine như trong DB trước FLF-339: `diagrams[].puml`, không `format` / `source`. */
const seedLegacy = async () => {
  const spine = readFixtureJson<Record<string, unknown>>("spine-fixture-19-screens.json")
  const diagrams = (spine.diagrams as RawDiagram[]).map(({ format: _f, source, ...rest }) => ({ ...rest, puml: source }))
  await SpineModel.collection.insertOne({ ...spine, diagrams, projectId: PROJECT, spine_version: 7 })
  repository.clearReadCache()
}

describe("migrate-diagram-source (integration)", () => {
  beforeEach(seedLegacy)

  it("code mới đọc được doc chưa migrate", async () => {
    const record = await repository.get(String(PROJECT))
    expect(record?.diagrams.every((d) => d.format === "puml" && d.source.startsWith("@start"))).toBe(true)
  })

  it("dry-run đếm đúng, không ghi", async () => {
    const report = await migrateDiagramSource("dry-run")
    expect(report).toMatchObject({ docs: 1, diagrams: 5, updated: 0 })
    expect((await rawDiagrams()).every((d) => "puml" in d && !("source" in d))).toBe(true)
  })

  it("apply ⇒ raw không còn puml, có format + source, spine_version giữ nguyên; chạy lại ⇒ 0 doc", async () => {
    const before = await rawDiagrams()
    expect(await migrateDiagramSource("apply")).toMatchObject({ docs: 1, diagrams: 5, updated: 1, skipped: 0 })
    const after = await rawDiagrams()
    expect(after.every((d) => !("puml" in d) && d.format === "puml")).toBe(true)
    expect(after.map((d) => d.source)).toEqual(before.map((d) => d.puml))
    expect(await rawVersion()).toBe(7)
    expect(await migrateDiagramSource("apply")).toMatchObject({ docs: 0, updated: 0 })
  })

  it("revert ⇒ raw có puml, không source / format", async () => {
    await migrateDiagramSource("apply")
    expect(await migrateDiagramSource("revert")).toMatchObject({ docs: 1, updated: 1, svg: 0 })
    const raw = await rawDiagrams()
    expect(raw.every((d) => typeof d.puml === "string" && !("source" in d) && !("format" in d))).toBe(true)
    expect(await rawVersion()).toBe(7)
  })

  it("ghi qua repository ⇒ raw không có key puml (model không default puml)", async () => {
    const record = await repository.get(String(PROJECT))
    if (!record) throw new Error("thiếu Spine")
    await repository.saveWithVersion(record, record.spine_version)
    const raw = await rawDiagrams()
    expect(raw.every((d) => !("puml" in d) && d.format === "puml" && typeof d.source === "string")).toBe(true)
    expect(await rawVersion()).toBe(8)
  })
})
