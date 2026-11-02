/**
 * Migration `screens[].flow_to` mảng id → mảng cạnh `{ to, trigger?, guard? }` chạy trên Mongo thật (in-memory replica set):
 * code mới đọc được doc chưa migrate, dry-run không ghi, apply không tăng `spine_version`, chạy lại không còn gì, revert
 * trả mảng id; ghi qua repository lưu dạng cạnh.
 */
import { describe, it, expect, beforeEach } from "vitest"
import mongoose from "mongoose"
import { readFixtureJson } from "../setup.js"
import { Spine as SpineModel } from "../../src/modules/spine/spine.model.js"
import * as repository from "../../src/modules/spine/spine.repository.js"
import { migrateFlowEdges } from "../../src/scripts/migrate-flow-edges.js"

const PROJECT = new mongoose.Types.ObjectId()

type RawScreen = { id: string; flow_to: unknown[] }
const rawScreens = async (): Promise<RawScreen[]> => ((await SpineModel.collection.findOne({ projectId: PROJECT }))?.screens ?? []) as RawScreen[]
const rawVersion = async () => (await SpineModel.collection.findOne({ projectId: PROJECT }))?.spine_version

/** Spine như trong DB trước khi `flow_to` là mảng cạnh: mỗi phần tử là chuỗi id màn đích. */
const seedLegacy = async () => {
  const spine = readFixtureJson<{ screens: RawScreen[] }>("spine-fixture-19-screens.json")
  const screens = spine.screens.map((s) => ({ ...s, flow_to: s.flow_to.map((e) => (e as { to: string }).to) }))
  await SpineModel.collection.insertOne({ ...spine, screens, projectId: PROJECT, spine_version: 7 })
  repository.clearReadCache()
}
const edgeCount = 25

describe("migrate-flow-edges (integration)", () => {
  beforeEach(seedLegacy)

  it("code mới đọc được doc chưa migrate: cạnh chỉ có `to`", async () => {
    const record = await repository.get(String(PROJECT))
    expect(record?.screens.find((s) => s.id === "S01")?.flow_to).toEqual([{ to: "S02" }, { to: "S03" }, { to: "S05" }, { to: "S14" }])
  })

  it("dry-run đếm đúng, không ghi", async () => {
    const report = await migrateFlowEdges("dry-run")
    expect(report).toMatchObject({ docs: 1, edges: edgeCount, updated: 0 })
    expect((await rawScreens()).every((s) => s.flow_to.every((e) => typeof e === "string"))).toBe(true)
  })

  it("apply ⇒ raw là { to }, spine_version giữ nguyên; chạy lại ⇒ 0 doc", async () => {
    expect(await migrateFlowEdges("apply")).toMatchObject({ docs: 1, edges: edgeCount, updated: 1, skipped: 0 })
    const s01 = (await rawScreens()).find((s) => s.id === "S01")
    expect(s01?.flow_to).toEqual([{ to: "S02" }, { to: "S03" }, { to: "S05" }, { to: "S14" }])
    expect(await rawVersion()).toBe(7)
    expect(await migrateFlowEdges("apply")).toMatchObject({ docs: 0, updated: 0 })
  })

  it("revert ⇒ raw là mảng id", async () => {
    await migrateFlowEdges("apply")
    expect(await migrateFlowEdges("revert")).toMatchObject({ docs: 1, updated: 1, labelled: 0 })
    expect((await rawScreens()).find((s) => s.id === "S01")?.flow_to).toEqual(["S02", "S03", "S05", "S14"])
    expect(await rawVersion()).toBe(7)
  })

  it("ghi qua repository ⇒ raw lưu cạnh object, giữ trigger / guard", async () => {
    const record = await repository.get(String(PROJECT))
    if (!record) throw new Error("thiếu Spine")
    record.screens.find((s) => s.id === "S01")!.flow_to[2] = { to: "S05", trigger: "Submit credentials", guard: "OTP valid" }
    await repository.saveWithVersion(record, record.spine_version)
    expect((await rawScreens()).find((s) => s.id === "S01")?.flow_to).toContainEqual({ to: "S05", trigger: "Submit credentials", guard: "OTP valid" })
    expect(await rawVersion()).toBe(8)
  })
})
