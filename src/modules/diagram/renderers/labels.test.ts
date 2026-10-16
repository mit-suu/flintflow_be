import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine } from "../../spine/spine.types.js"
import { RENDERERS, allTargets, renderKind } from "./index.js"
import { DIAGRAM_LABELS, diagramLabelsFor } from "./labels.js"
import { isFunctionTable } from "./screen-layout.renderer.js"
import { screenFlowTitleOf } from "./screen-flow.renderer.js"
import { MAX_USE_CASES_PER_DIAGRAM } from "./usecase.renderer.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)
const mutate = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}
const VI = DIAGRAM_LABELS.vi

describe("nhãn máy trên sơ đồ theo ngôn ngữ (FLF-265 N1)", () => {
  it("không truyền nhãn ⇒ đúng bản tiếng Anh (hình ghi vào Spine không đổi)", () => {
    for (const target of allTargets(FIXTURE)) {
      const kind = target.kind
      expect(RENDERERS[kind](FIXTURE, target.owner_id, DIAGRAM_LABELS.en), kind).toEqual(RENDERERS[kind](FIXTURE, target.owner_id))
    }
  })

  it("diagramLabelsFor: vi / vi-VN ⇒ tiếng Việt; thiếu / lạ ⇒ tiếng Anh", () => {
    expect(diagramLabelsFor("vi")).toBe(VI)
    expect(diagramLabelsFor("vi-VN")).toBe(VI)
    expect(diagramLabelsFor(undefined)).toBe(DIAGRAM_LABELS.en)
    expect(diagramLabelsFor("fr")).toBe(DIAGRAM_LABELS.en)
  })

  it("ngữ cảnh: tên hệ thống dự phòng + mũi tên dự phòng theo kind", () => {
    const spine = mutate((s) => {
      s.project.name = ""
      s.project.system_name = null
      s.actors.forEach((a) => {
        delete a.flows_in
        delete a.flows_out
      })
    })
    const [part] = RENDERERS.context(spine, null, VI)
    expect(part.puml).toContain(`label="${VI.system}"`)
    expect(part.puml).toContain(VI.defaultIn.human)
    expect(part.puml).toContain(VI.defaultOut.system)
    expect(part.puml).not.toContain(DIAGRAM_LABELS.en.defaultIn.human)
  })

  it("use case tách phần: tiêu đề theo ngôn ngữ; ký pháp UML giữ nguyên", () => {
    const actor = FIXTURE.actors.find((a) => a.kind === "human")!
    const spine = mutate((s) => {
      s.use_cases = Array.from({ length: MAX_USE_CASES_PER_DIAGRAM + 5 }, (_, i) => ({
        id: `UC${String(i + 1).padStart(2, "0")}`,
        name: `Use case ${i + 1}`,
        description: "",
        actor_ids: [actor.id],
        includes: i === 1 ? ["UC01"] : [],
        function_ids: [],
        extends: []
      }))
    })
    const parts = RENDERERS.usecase(spine, null, VI)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts[0].puml).toContain(`title ${VI.useCasesTitle(actor.name)}`)
    expect(parts.map((p) => p.puml).join("\n")).toContain(": <<include>>")
  })

  it("luồng màn: tiêu đề theo actor, (pop-up), chưa có màn", () => {
    const parts = RENDERERS.screen_flow(FIXTURE, null, VI)
    // Chia phần theo actor (id), không theo chữ ⇒ cùng số phần với bản tiếng Anh
    expect(parts).toHaveLength(renderKind(FIXTURE, "screen_flow").length)
    const titles = parts.map((p) => screenFlowTitleOf(p.puml))
    expect(titles.length).toBeGreaterThan(1)
    for (const title of titles) expect(title).toMatch(/^Luồng màn hình của /)
    const popupWithTabs = mutate((s) => {
      s.screens[1].is_popup = true
      s.screens[1].tabs = ["One", "Two"]
    })
    expect(RENDERERS.screen_flow(popupWithTabs, null, VI).map((p) => p.puml).join("\n")).toContain(`\\n${VI.popup}"`)
    expect(RENDERERS.screen_flow(mutate((s) => (s.screens = [])), null, VI)[0].puml).toContain(`NO_SCREENS [label="${VI.noScreens}"]`)
  })

  it("ERD: động từ mặc định và 'chưa có thực thể' theo ngôn ngữ; động từ của Spine giữ nguyên", () => {
    const withVerb = mutate((s) => {
      const e = s.entities.find((x) => x.relations.length > 0)!
      e.relation_verbs = { [e.relations[0]]: "chứa" }
    })
    const puml = RENDERERS.erd(withVerb, null, VI)[0].puml
    expect(puml).toContain('relationship "chứa"')
    expect(puml).toContain(`relationship "${VI.relationVerb}"`)
    expect(puml).not.toContain('relationship "has"')
    expect(RENDERERS.erd(mutate((s) => (s.entities = [])), null, VI)[0].puml).toContain(`entity "${VI.noEntities}" as NO_ENTITIES`)
  })

  it("bảng function: tiêu đề cột + 'chưa có chức năng'; isFunctionTable nhận bảng mọi ngôn ngữ", () => {
    const owner = allTargets(FIXTURE).find((t) => t.kind === "screen_layout")!.owner_id
    const vi = RENDERERS.screen_layout(FIXTURE, owner, VI)[0].puml
    expect(vi).toContain(`<b>${VI.functionColumn} | <b>${VI.descriptionColumn}`)
    expect(isFunctionTable(vi)).toBe(true)
    expect(isFunctionTable(renderKind(FIXTURE, "screen_layout", owner)[0].puml)).toBe(true)
    const empty = mutate((s) => (s.functions = s.functions.filter((f) => f.screen_id !== owner)))
    expect(RENDERERS.screen_layout(empty, owner, VI)[0].puml).toContain(`- | ${VI.noFunctions}`)
    expect(isFunctionTable("@startsalt\n{+\n  [ OK ]\n}\n@endsalt\n")).toBe(false)
  })
})
