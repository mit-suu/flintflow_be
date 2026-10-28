import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CompileCheckResult } from "../../shared/diagram/compile-check.js"
import { LOCALIZED_VERSIONS_KEPT, createMemoryDiagramStore, localizedDiagramFileName } from "./diagram-file.store.js"
import {
  COMPILE_FAILURE_TTL_MS,
  TRANSPORT_FAILURE_TTL_MS,
  _resetLocalizedDiagramState,
  localizedDiagramHash,
  localizedDiagramPng,
  type DiagramSource,
  type LocalizedDiagramDeps
} from "./localized-diagram.service.js"

const PROJECT = "650000000000000000000001"
const PUML = '@startuml\nactor "Sinh viên" as A01\n@enduml\n'
const PNG = Buffer.from("png-vi")
const puml = (source: string): DiagramSource => ({ format: "puml", source })

const okCheck = (): CompileCheckResult => ({
  ok: true,
  method: "svg-scan",
  render: { format: "svg", data: Buffer.from("<svg/>"), contentType: "image/svg+xml", transport: "post", status: 200, diagnostics: {} }
})

const setup = (over: Partial<LocalizedDiagramDeps> = {}) => {
  let clock = 1_000_000
  const store = createMemoryDiagramStore()
  const deps: LocalizedDiagramDeps = {
    check: vi.fn(async () => okCheck()),
    renderPng: vi.fn(async () => PNG),
    renderSvgPng: vi.fn(async () => PNG),
    store,
    now: () => clock,
    ...over
  }
  return { deps, store, tick: (ms: number) => (clock += ms) }
}

beforeEach(() => _resetLocalizedDiagramState())

describe("localizedDiagramPng (FLF-265 N1)", () => {
  it("chưa có file ⇒ compile-check + vẽ PNG + lưu theo hash; lần sau đọc file, không vẽ lại", async () => {
    const { deps, store } = setup()
    expect(await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)).toBe(PNG.toString("base64"))
    expect(deps.check).toHaveBeenCalledWith(PUML)
    expect(store.files.has(localizedDiagramFileName(PROJECT, "D01", "vi", localizedDiagramHash("vi", PUML)))).toBe(true)

    expect(await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)).toBe(PNG.toString("base64"))
    expect(deps.check).toHaveBeenCalledTimes(1)
    expect(deps.renderPng).toHaveBeenCalledTimes(1)
  })

  it("hash theo (ngôn ngữ, nguồn): nguồn đổi ⇒ vẽ bản mới", async () => {
    expect(localizedDiagramHash("vi", PUML)).toHaveLength(16)
    expect(localizedDiagramHash("vi", PUML)).not.toBe(localizedDiagramHash("en", PUML))
    const { deps } = setup()
    await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)
    await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML.replace("Sinh viên", "Giảng viên")), deps)
    expect(deps.renderPng).toHaveBeenCalledTimes(2)
  })

  it("nhiều lượt đọc cùng lúc ⇒ một lượt vẽ", async () => {
    let release: (b: Buffer) => void = () => {}
    const { deps } = setup({ renderPng: vi.fn(() => new Promise<Buffer>((resolve) => (release = resolve))) })
    const calls = [1, 2, 3].map(() => localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps))
    await vi.waitFor(() => expect(deps.renderPng).toHaveBeenCalledTimes(1))
    release(PNG)
    expect(await Promise.all(calls)).toEqual([1, 2, 3].map(() => PNG.toString("base64")))
    expect(deps.check).toHaveBeenCalledTimes(1)
  })

  it("không compile được (cả lần thử lại) ⇒ null, nhớ COMPILE_FAILURE_TTL_MS rồi mới thử lại", async () => {
    const failed: CompileCheckResult = { ...okCheck(), ok: false, error: "Syntax Error?" }
    const { deps, store, tick } = setup({ check: vi.fn(async () => failed) })
    expect(await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)).toBeNull()
    expect(await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)).toBeNull()
    expect(deps.check).toHaveBeenCalledTimes(2)
    expect(deps.renderPng).not.toHaveBeenCalled()
    expect(store.files.size).toBe(0)
    tick(COMPILE_FAILURE_TTL_MS + 1)
    await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)
    expect(deps.check).toHaveBeenCalledTimes(4)
  })

  it("lỗi compile lần đầu (PlantUML vẽ trùng lúc) ⇒ thử lại một lần, được thì dùng", async () => {
    const failed: CompileCheckResult = { ...okCheck(), ok: false, error: "Syntax Error?" }
    const check = vi.fn(async () => okCheck()).mockImplementationOnce(async () => failed)
    const { deps } = setup({ check })
    expect(await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)).toBe(PNG.toString("base64"))
    expect(check).toHaveBeenCalledTimes(2)
  })

  it("nhiều sơ đồ cùng lúc ⇒ vẽ một hàng (PlantUML vẽ @startdot song song thì hỏng)", async () => {
    let running = 0
    let peak = 0
    const check = vi.fn(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
      return okCheck()
    })
    const { deps } = setup({ check })
    const pngs = await Promise.all(["D01", "D02", "D03", "D04"].map((id) => localizedDiagramPng(PROJECT, id, "vi", puml(`${PUML}' ${id}\n`), deps)))
    expect(pngs.every((p) => p === PNG.toString("base64"))).toBe(true)
    expect(check).toHaveBeenCalledTimes(4)
    expect(peak).toBe(1)
  })

  it("PlantUML không phản hồi ⇒ null, thử lại sau TRANSPORT_FAILURE_TTL_MS", async () => {
    const check = vi.fn(async (): Promise<CompileCheckResult> => {
      throw new TypeError("fetch failed")
    })
    const { deps, tick } = setup({ check })
    expect(await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)).toBeNull()
    tick(TRANSPORT_FAILURE_TTL_MS - 1)
    expect(await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)).toBeNull()
    expect(check).toHaveBeenCalledTimes(1)
    tick(2)
    check.mockImplementationOnce(async () => okCheck())
    expect(await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)).toBe(PNG.toString("base64"))
  })

  it("lưu file lỗi vẫn trả ảnh của lượt này; đọc store lỗi ⇒ vẽ lại", async () => {
    const { deps, store } = setup()
    store.saveLocalized = vi.fn(async () => {
      throw new Error("GridFS down")
    })
    expect(await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)).toBe(PNG.toString("base64"))
    store.loadLocalized = vi.fn(async () => {
      throw new Error("GridFS down")
    })
    expect(await localizedDiagramPng(PROJECT, "D01", "vi", puml(PUML), deps)).toBe(PNG.toString("base64"))
    expect(deps.renderPng).toHaveBeenCalledTimes(2)
  })
})

describe("localizedDiagramPng — format svg (FLF-339)", () => {
  it("svg ⇒ PNG bằng resvg, không compile-check, không gọi PlantUML; lưu theo hash nguồn", async () => {
    const { deps, store } = setup()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
    expect(await localizedDiagramPng(PROJECT, "D01", "vi", { format: "svg", source: svg }, deps)).toBe(PNG.toString("base64"))
    expect(deps.renderSvgPng).toHaveBeenCalledWith(svg)
    expect(deps.check).not.toHaveBeenCalled()
    expect(deps.renderPng).not.toHaveBeenCalled()
    expect(await store.loadLocalized(PROJECT, "D01", "vi", localizedDiagramHash("vi", svg))).not.toBeNull()
  })

  it("resvg ném ⇒ null (dùng ảnh gốc), không ném", async () => {
    const { deps } = setup({ renderSvgPng: vi.fn(async () => Promise.reject(new Error("bad svg"))) })
    expect(await localizedDiagramPng(PROJECT, "D01", "vi", { format: "svg", source: "<svg>" }, deps)).toBeNull()
  })
})

describe("memory store — PNG theo ngôn ngữ", () => {
  const file = (text: string) => ({ data: Buffer.from(text), contentType: "image/png" })

  it(`giữ ${LOCALIZED_VERSIONS_KEPT} bản mới nhất mỗi (sơ đồ, ngôn ngữ); sơ đồ / ngôn ngữ khác không bị dọn`, async () => {
    const store = createMemoryDiagramStore()
    await store.saveLocalized(PROJECT, "D02-2", "vi", "a".repeat(16), file("other diagram"))
    await store.saveLocalized(PROJECT, "D02", "en", "b".repeat(16), file("other locale"))
    for (const h of ["1", "2", "3", "4"]) await store.saveLocalized(PROJECT, "D02", "vi", h.repeat(16), file(h))
    expect(await store.loadLocalized(PROJECT, "D02", "vi", "1".repeat(16))).toBeNull()
    for (const h of ["2", "3", "4"]) expect((await store.loadLocalized(PROJECT, "D02", "vi", h.repeat(16)))?.data.toString()).toBe(h)
    // Lưu lại bản cũ ⇒ thành mới nhất, bản cũ nhất còn lại bị dọn
    await store.saveLocalized(PROJECT, "D02", "vi", "2".repeat(16), file("2"))
    await store.saveLocalized(PROJECT, "D02", "vi", "5".repeat(16), file("5"))
    expect(await store.loadLocalized(PROJECT, "D02", "vi", "3".repeat(16))).toBeNull()
    expect(await store.loadLocalized(PROJECT, "D02", "vi", "2".repeat(16))).not.toBeNull()
    expect(await store.loadLocalized(PROJECT, "D02-2", "vi", "a".repeat(16))).not.toBeNull()
    expect(await store.loadLocalized(PROJECT, "D02", "en", "b".repeat(16))).not.toBeNull()
  })

  it("remove xoá cả svg / png gốc lẫn mọi PNG theo ngôn ngữ của đúng sơ đồ đó", async () => {
    const store = createMemoryDiagramStore()
    await store.save(PROJECT, "D02", "png", file("en"))
    await store.saveLocalized(PROJECT, "D02", "vi", "1".repeat(16), file("vi"))
    await store.saveLocalized(PROJECT, "D02-2", "vi", "1".repeat(16), file("keep"))
    await store.remove(PROJECT, "D02")
    expect([...store.files.keys()]).toEqual([localizedDiagramFileName(PROJECT, "D02-2", "vi", "1".repeat(16))])
  })
})
