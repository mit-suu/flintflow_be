import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import { checkPlantUml } from "../../shared/diagram/compile-check.js"
import { isPlantUmlReachable } from "../../shared/diagram/plantuml.client.js"
import { allTargets, renderKind } from "./renderers/index.js"
import { compileWithFix, defaultDeps } from "./diagram.service.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const reachable = await isPlantUmlReachable()
if (!reachable) console.warn("\n[diagram] PlantUML không reachable — test render thật bị SKIP (docker compose up -d plantuml).\n")

describe.skipIf(!reachable)("renderer × PlantUML server thật (DoD T10)", () => {
  for (const target of allTargets(FIXTURE)) {
    it(`${target.kind}${target.owner_id ? `@${target.owner_id}` : ""} compile ok`, async () => {
      for (const part of renderKind(FIXTURE, target.kind, target.owner_id)) {
        const result = await checkPlantUml(part.puml)
        expect(result.ok, result.ok ? "" : `${result.error}\n${part.puml}`).toBe(true)
      }
    })
  }

  it(".puml hỏng không sửa được ⇒ ok=false kèm lỗi, không ném (DoD T10)", async () => {
    const broken = "@startuml\nentity \"User\" as E01\nE01 ||--o{{{ E02 :::\n@enduml\n"
    const result = await compileWithFix("erd", broken, { ...defaultDeps(), fix: async () => null })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.length).toBeGreaterThan(0)
  })
})
