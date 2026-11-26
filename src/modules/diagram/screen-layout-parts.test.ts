import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, vi } from "vitest"
import { spineSchema } from "../spine/spine.schema.js"
import type { Spine } from "../spine/spine.types.js"
import { screenActorSets } from "../spine/screen-actors.js"
import { renderedDiagramHash } from "../spine/source-hash.js"
import type { RenderContext } from "../../shared/diagram/erd-notation.js"
import type { ScreenEnvelope } from "./screen-spec.js"
import { SIGNUP_SPEC } from "./screen-spec.samples.js"
import type { DrawLayout } from "./screen-layout.ai.js"
import { screenLayoutParts } from "./screen-layout-parts.js"
import { screenSpecOf } from "./renderers/screen-mockup.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const BOTH: RenderContext = { screenTheme: { primaryColor: "#3F5591", domain: null, platforms: ["web", "mobile"] } }
const envelope = (platforms: ("web" | "mobile")[]): ScreenEnvelope => ({ spec: { ...SIGNUP_SPEC, platforms }, screenImages: null, primaryColor: null })

/** Gán `platforms` cho actor người của `ids` (mặc định cả bốn actor người của fixture). */
const withActors = (platforms?: ("web" | "mobile")[], ids: readonly string[] = ["A01", "A02", "A03", "A04"]): Spine => ({
  ...FIXTURE,
  actors: FIXTURE.actors.map((a) => (platforms && ids.includes(a.id) ? { ...a, platforms } : a))
})

const run = (spine: Spine, drawLayout: DrawLayout, existing: Spine["diagrams"] = []) =>
  screenLayoutParts({ projectId: "P", userId: "U", spine, screenId: "S01", context: BOTH, existing, force: false, specOnly: false, drawLayout })

describe("screenLayoutParts - nền tảng theo actor dùng màn (FLF-493)", () => {
  it("màn của actor mobile chỉ ra một hình Mobile dù model không thu hẹp; model chỉ được hỏi phạm vi mobile", async () => {
    const drawLayout = vi.fn<DrawLayout>(async () => envelope(["web", "mobile"]))
    const parts = (await run(withActors(["mobile"]), drawLayout))!
    expect(drawLayout).toHaveBeenCalledWith(expect.objectContaining({ platforms: ["mobile"] }))
    expect(parts).toHaveLength(1)
    expect(screenSpecOf(parts[0].source)?.platform).toBe("mobile")
  })

  it("actor chưa khai nền tảng ⇒ giữ hành vi cũ, vẽ cả Web và Mobile", async () => {
    const parts = (await run(withActors(), vi.fn(async () => envelope(["web", "mobile"]))))!
    expect(parts).toHaveLength(2)
  })

  it("spec đã lưu với phạm vi rộng hơn vẫn vẽ theo phạm vi mới của màn, không gọi model", async () => {
    // Vẽ lúc actor chưa khai nền tảng ⇒ hai hình, spec lưu phạm vi rộng
    const first = (await run(withActors(), vi.fn(async () => envelope(["web", "mobile"]))))!
    const stored = first.map((p, i) => ({ ...p, id: `D${i}`, render_status: "ok", source_hash: "cu" })) as unknown as Spine["diagrams"]
    const drawLayout = vi.fn<DrawLayout>(async () => envelope(["web", "mobile"]))
    const redrawn = (await run(withActors(["mobile"]), drawLayout, stored))!
    expect(drawLayout).not.toHaveBeenCalled()
    expect(redrawn).toHaveLength(1)
    expect(screenSpecOf(redrawn[0].source)?.platform).toBe("mobile")
  })
})

describe("hash screen_layout - nền tảng theo actor (FLF-493)", () => {
  const hash = (spine: Spine, screenId: string) => renderedDiagramHash(spine, { kind: "screen_layout", owner_id: screenId }, undefined, BOTH)

  it("actor không khai nền tảng ⇒ hash y như trước; khai đủ cả hai = đúng theme ⇒ cũng không đổi", () => {
    expect(hash(withActors(), "S01")).toBe(hash(FIXTURE, "S01"))
    expect(hash(withActors(["web", "mobile"]), "S01")).toBe(hash(FIXTURE, "S01"))
  })

  it("đổi platforms của actor ⇒ chỉ hash màn có actor đó đổi", () => {
    const mobile = withActors(["mobile"])
    const changed: Spine = { ...mobile, actors: mobile.actors.map((a) => (a.id === "A01" ? { ...a, platforms: ["web" as const] } : a)) }
    const users = screenActorSets(FIXTURE)
    const withA01 = FIXTURE.screens.map((s) => s.id).filter((id) => users.get(id)?.includes("A01"))
    const without = FIXTURE.screens.map((s) => s.id).filter((id) => users.get(id)?.length && !users.get(id)?.includes("A01"))
    expect(withA01.length).toBeGreaterThan(0)
    expect(without.length).toBeGreaterThan(0)
    for (const id of withA01) expect(hash(changed, id)).not.toBe(hash(mobile, id))
    for (const id of without) expect(hash(changed, id)).toBe(hash(mobile, id))
  })
})
