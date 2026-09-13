import { describe, it, expect, beforeAll } from "vitest"
import { encodePlantUml, isPlantUmlReachable } from "./plantuml.client.js"
import { checkPlantUml } from "./compile-check.js"

const VALID = `@startuml
Alice -> Bob : hello
@enduml`

// Cố tình sai: `-->>>>` không phải mũi tên hợp lệ, và thiếu @enduml.
const BROKEN = `@startuml
Alice -->>>> : xxx
`

describe("encodePlantUml (thuần, không cần server)", () => {
  it("sinh chuỗi chỉ gồm alphabet riêng của PlantUML", () => {
    const encoded = encodePlantUml(VALID)

    expect(encoded.length).toBeGreaterThan(0)
    expect(encoded).toMatch(/^[0-9A-Za-z_-]+$/)
  })

  it("cùng input cho cùng output (ổn định ⇒ source_hash dùng được)", () => {
    expect(encodePlantUml(VALID)).toBe(encodePlantUml(VALID))
  })
})

describe("PlantUML probe (cần server)", () => {
  let reachable = false

  beforeAll(async () => {
    reachable = await isPlantUmlReachable()

    if (!reachable) {
      console.warn(
        "\n[probe] PlantUML không reachable — bỏ qua probe test.\n" +
          "        Chạy `docker compose up -d plantuml` rồi `npm test` lại để\n" +
          "        trả lời câu hỏi thực nghiệm: header hay svg-scan phát hiện lỗi?\n"
      )
    }
  })

  it("diagram HỢP LỆ phải compile được", async () => {
    if (!reachable) return

    const result = await checkPlantUml(VALID)

    console.log(
      `[probe] valid  → ok=${result.ok} transport=${result.render.transport} ` +
        `method=${result.method}`
    )
    expect(result.ok).toBe(true)
  })

  it("diagram SAI phải bị phát hiện, dù server trả HTTP 200", async () => {
    if (!reachable) return

    const result = await checkPlantUml(BROKEN)

    console.log(
      `[probe] broken → ok=${result.ok} transport=${result.render.transport} ` +
        `method=${result.method} ` +
        `headerError=${result.render.diagnostics.error ?? "(none)"}`
    )

    // Đây là điểm cốt lõi: nếu assertion này fail thì cách phát hiện lỗi hiện
    // tại KHÔNG dùng được với tag image đang ghim, và cờ `render_error` sẽ
    // không bao giờ bắn. Phải sửa SVG_ERROR_MARKERS hoặc đổi tag, không phải
    // nới assertion.
    expect(result.ok).toBe(false)
  })
})
