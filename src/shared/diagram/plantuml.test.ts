import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { encodePlantUml, isPlantUmlReachable, probePlantUml, renderPlantUml } from "./plantuml.client.js"
import { checkPlantUml } from "./compile-check.js"
import { env } from "../../config/env.js"

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

// Kiểm server lúc thu thập test: không có server thì test hiện "skipped" trong báo cáo,
// không pass im lặng như `if (!reachable) return`.
const reachable = await isPlantUmlReachable()
if (!reachable) {
  console.warn(
    "\n[probe] PlantUML không reachable — probe test bị SKIP.\n" +
      "        Chạy `docker compose up -d plantuml` rồi `npm test` lại để\n" +
      "        trả lời câu hỏi thực nghiệm: header hay svg-scan phát hiện lỗi?\n"
  )
}

describe.skipIf(!reachable)("PlantUML probe (cần server)", () => {
  it("diagram HỢP LỆ phải compile được", async () => {
    const result = await checkPlantUml(VALID)

    console.log(`[probe] valid  → ok=${result.ok} transport=${result.render.transport} method=${result.method}`)
    expect(result.ok).toBe(true)
  })

  it("diagram SAI phải bị phát hiện, dù server trả HTTP 200", async () => {
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

  it("@startdot SAI (Screens Flow vẽ bằng DOT) phải bị phát hiện — server trả 200 + text `Error:`, không phải SVG", async () => {
    const result = await checkPlantUml("@startdot\ndigraph g {\n  A -> ;\n}\n@enddot\n")
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("syntax error")
    expect((await checkPlantUml("@startdot\ndigraph g {\n  A -> B;\n}\n@enddot\n")).ok).toBe(true)
  })
})

// Không cần server: mock `fetch` để dựng đúng các phản hồi khó tạo thật —
// một server lạ chiếm cổng PlantUML và trả JSON kèm HTTP 200.
describe("renderPlantUml chỉ nhận phản hồi ảnh (fetch mock)", () => {
  const fetchMock = vi.fn()

  const response = (status: number, contentType: string, body: string) =>
    new Response(body, { status, headers: { "Content-Type": contentType } })

  beforeEach(() => {
    env.PLANTUML_BASE_URL = "http://localhost:8080"
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("200 application/json ⇒ ném lỗi, không trả buffer rác", async () => {
    fetchMock.mockImplementation(() => response(200, "application/json", '{"message":"hello"}'))

    await expect(renderPlantUml(VALID)).rejects.toThrow(/không phải PlantUML/)
    // POST rơi xuống GET rồi mới ném ⇒ cả hai đường đều bị chặn.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("404 HTML ⇒ lỗi nói rõ cổng bị chiếm, không chỉ 'HTTP 404'", async () => {
    fetchMock.mockImplementation(() => response(404, "text/html", "<html>Not Found</html>"))

    // Server lạ thường không có route /svg/<enc> ⇒ đây mới là hình dạng hay gặp nhất.
    await expect(renderPlantUml(VALID)).rejects.toThrow(/không phải PlantUML/)
  })

  it("content-type viết hoa vẫn được nhận là ảnh", async () => {
    fetchMock.mockImplementation(() => response(200, "Image/SVG+XML", "<svg/>"))

    await expect(renderPlantUml(VALID)).resolves.toMatchObject({ status: 200 })
  })

  it("200 image/svg+xml ⇒ trả kết quả bình thường", async () => {
    fetchMock.mockImplementation(() => response(200, "image/svg+xml", "<svg/>"))

    const result = await renderPlantUml(VALID)

    expect(result.transport).toBe("post")
    expect(result.status).toBe(200)
    expect(result.data.toString()).toBe("<svg/>")
  })

  it("400 kèm ảnh lỗi ⇒ vẫn trả kết quả để compile-check kết luận", async () => {
    fetchMock.mockImplementation(() => response(400, "image/svg+xml", "<svg>syntax error</svg>"))

    const result = await renderPlantUml(BROKEN)

    expect(result.status).toBe(400)
    expect(result.data.toString()).toContain("syntax error")
  })

  it("compile-check: 200 image/svg+xml nhưng thân là text lỗi của dot ⇒ ok=false kèm dòng lỗi", async () => {
    fetchMock.mockImplementation(() => response(200, "image/svg+xml", "Error: <stdin>: syntax error in line 2 near ';'\n"))

    const result = await checkPlantUml("@startdot\ndigraph g {\n  A -> ;\n}\n@enddot\n")

    expect(result).toMatchObject({ ok: false, method: "svg-scan" })
    expect(result.ok === false && result.error).toContain("syntax error in line 2")
  })

  it("isPlantUmlReachable = false khi server trả JSON", async () => {
    fetchMock.mockImplementation(() => response(200, "application/json", "{}"))

    await expect(isPlantUmlReachable()).resolves.toBe(false)
  })

  it("isPlantUmlReachable = true khi server render ra ảnh", async () => {
    fetchMock.mockImplementation(() => response(200, "image/svg+xml", "<svg/>"))

    await expect(isPlantUmlReachable()).resolves.toBe(true)
  })

  // Cảnh báo [startup] cần biết hỏng kiểu gì: "dựng PlantUML lên" là lời khuyên
  // sai khi cổng đang bị một tiến trình khác chiếm.
  it("probePlantUml phân biệt cổng bị chiếm với không ai nghe", async () => {
    fetchMock.mockImplementation(() => response(200, "application/json", "{}"))
    await expect(probePlantUml()).resolves.toMatchObject({
      ok: false,
      reason: "not_plantuml",
      detail: expect.stringContaining("application/json")
    })

    fetchMock.mockImplementation(() => Promise.reject(new Error("fetch failed: ECONNREFUSED")))
    await expect(probePlantUml()).resolves.toMatchObject({
      ok: false,
      reason: "unreachable",
      detail: expect.stringContaining("ECONNREFUSED")
    })

    fetchMock.mockImplementation(() => response(200, "image/svg+xml", "<svg/>"))
    await expect(probePlantUml()).resolves.toEqual({ ok: true })
  })
})
