import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine } from "../../spine/spine.types.js"
import { deploymentErrors } from "../../pipeline/op-validator.js"
import { deploymentSource, renderDeployment } from "./deployment.renderer.js"
import { renderKind } from "./index.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

describe("renderDeployment - một sơ đồ triển khai cho cả hệ thống (FLF-390)", () => {
  it("một hình puml ở §4.1, không chủ; không có nút ⇒ không có hình", () => {
    const parts = renderDeployment(FIXTURE)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ kind: "deployment", format: "puml", section: "fixed:4.1", owner_kind: null, owner_id: null })
    expect(renderDeployment({ ...FIXTURE, deployment_nodes: [], deployment_links: [] })).toEqual([])
    expect(renderKind(FIXTURE, "deployment")[0].source_hash).toMatch(/\w+/)
  })

  it("ký pháp: stereotype device / executionEnvironment, nút con lồng trong cha, component / artifact trong nút, đường có giao thức", () => {
    const src = deploymentSource(FIXTURE)
    expect(src.startsWith("@startuml\n")).toBe(true)
    expect(src.trimEnd().endsWith("@enduml")).toBe(true)
    expect(src).toContain('node "User Device" <<device>> as DN01 {')
    expect(src).toContain('  component "Web Browser" as DN01_C1')
    expect(src).toMatch(/node "Application Server" <<device>> as DN02 \{\n {2}node "Node\.js Runtime" <<executionEnvironment>> as DN03 \{\n {4}component "API Service" as DN03_C1\n {4}artifact "api-bundle\.js" as DN03_A1\n {2}\}\n\}/)
    expect(src).toContain('node "MongoDB Atlas" as DN04')
    expect(src).toContain("DN01 -- DN03 : HTTPS")
    expect(src).not.toContain("!include")
  })

  it("QLHS 11/11 bug #14: mô tả nút = dòng thứ hai in nghiêng dưới tên, không thành component", () => {
    const src = deploymentSource({
      deployment_nodes: [
        { id: "DN01", name: "Trình duyệt", kind: "device", parent_id: null, artifacts: [], components: [], description: "GV, phụ huynh" },
        { id: "DN02", name: "Proxy", kind: "node", parent_id: null, artifacts: [], components: [], description: 'a <b> "c"' }
      ],
      deployment_links: []
    })
    expect(src).toContain('node "Trình duyệt\\n<i>GV, phụ huynh</i>" <<device>> as DN01')
    expect(src).toContain("node \"Proxy\\n<i>a b 'c'</i>\" as DN02")
    expect(src).not.toContain("component")
  })

  it("cha không có / vòng cha ⇒ vẽ là nút gốc; đường trùng cặp / tự nối / nút không có bị bỏ", () => {
    const src = deploymentSource({
      deployment_nodes: [
        { id: "DN01", name: "A", kind: "node", parent_id: "DN02", artifacts: [], components: [] },
        { id: "DN02", name: "B", kind: "node", parent_id: "DN01", artifacts: [], components: [] },
        { id: "DN03", name: "C", kind: "device", parent_id: "DN99", artifacts: [], components: [] }
      ],
      deployment_links: [
        { from: "DN01", to: "DN03" },
        { from: "DN03", to: "DN01", protocol: "dup" },
        { from: "DN01", to: "DN01" },
        { from: "DN01", to: "DN99" }
      ]
    })
    expect(src).toContain('node "A" as DN01')
    expect(src).toContain('node "B" as DN02')
    expect(src).toContain('node "C" <<device>> as DN03')
    expect(src.match(/ -- /g)).toHaveLength(1)
  })
})

describe("deploymentErrors", () => {
  it("fixture hợp lệ", () => {
    expect(deploymentErrors(FIXTURE)).toEqual([])
  })

  it("bắt tên trùng, cha không có, thiết bị trong môi trường thực thi, vòng cha, đường hỏng", () => {
    const rules = deploymentErrors({
      ...FIXTURE,
      deployment_nodes: [
        { id: "DN01", name: "Server", kind: "device", parent_id: null, artifacts: [], components: [] },
        { id: "DN02", name: "server", kind: "execution_environment", parent_id: "DN01", artifacts: [], components: [] },
        { id: "DN03", name: "Phone", kind: "device", parent_id: "DN02", artifacts: [], components: [] },
        { id: "DN04", name: "Ghost child", kind: "node", parent_id: "DN99", artifacts: [], components: [] },
        { id: "DN05", name: "Loop A", kind: "node", parent_id: "DN06", artifacts: [], components: [] },
        { id: "DN06", name: "Loop B", kind: "node", parent_id: "DN05", artifacts: [], components: [] }
      ],
      deployment_links: [
        { from: "DN01", to: "DN03" },
        { from: "DN03", to: "DN01" },
        { from: "DN01", to: "DN01" },
        { from: "DN01", to: "DN98" }
      ]
    }).map((e) => e.rule)
    expect(new Set(rules)).toEqual(
      new Set([
        "deployment_node_name_duplicate",
        "deployment_parent_invalid",
        "deployment_parent_unknown",
        "deployment_parent_cycle",
        "deployment_link_duplicate",
        "deployment_link_self",
        "deployment_link_unknown"
      ])
    )
  })
})
