/**
 * PNG sơ đồ theo ngôn ngữ trong GridFS thật (FLF-265 N1): tên file mang hash nguồn đã dịch, mỗi (sơ đồ, ngôn ngữ) giữ
 * `LOCALIZED_VERSIONS_KEPT` bản mới nhất, xoá sơ đồ xoá cả bản theo ngôn ngữ — không đụng sơ đồ / ngôn ngữ khác.
 */
import { describe, it, expect } from "vitest"
import "../../src/app.js"
import { LOCALIZED_VERSIONS_KEPT, gridFsDiagramStore } from "../../src/modules/diagram/diagram-file.store.js"

const PROJECT = "650000000000000000000abc"
const file = (text: string) => ({ data: Buffer.from(text), contentType: "image/png" })
const hash = (c: string) => c.repeat(16)

describe("gridFsDiagramStore — PNG theo ngôn ngữ", () => {
  it("lưu / đọc theo (sơ đồ, ngôn ngữ, hash); giữ bản mới nhất, không dọn sơ đồ hay ngôn ngữ khác", async () => {
    await gridFsDiagramStore.saveLocalized(PROJECT, "D02-2", "vi", hash("a"), file("other diagram"))
    await gridFsDiagramStore.saveLocalized(PROJECT, "D02", "en", hash("b"), file("other locale"))
    for (const c of ["1", "2", "3", "4"]) await gridFsDiagramStore.saveLocalized(PROJECT, "D02", "vi", hash(c), file(c))

    expect(await gridFsDiagramStore.loadLocalized(PROJECT, "D02", "vi", hash("1"))).toBeNull()
    for (const c of ["2", "3", "4"]) {
      expect((await gridFsDiagramStore.loadLocalized(PROJECT, "D02", "vi", hash(c)))?.data.toString(), c).toBe(c)
    }
    expect(LOCALIZED_VERSIONS_KEPT).toBe(3)
    expect((await gridFsDiagramStore.loadLocalized(PROJECT, "D02-2", "vi", hash("a")))?.contentType).toBe("image/png")
    expect(await gridFsDiagramStore.loadLocalized(PROJECT, "D02", "en", hash("b"))).not.toBeNull()

    // Lưu lại đúng hash cũ (vd baseline xem lại) ⇒ một bản, bản trùng tên cũ hơn bị dọn
    await gridFsDiagramStore.saveLocalized(PROJECT, "D02", "vi", hash("2"), file("2 again"))
    expect((await gridFsDiagramStore.loadLocalized(PROJECT, "D02", "vi", hash("2")))?.data.toString()).toBe("2 again")
  })

  it("remove xoá svg / png gốc + mọi PNG theo ngôn ngữ của đúng sơ đồ đó", async () => {
    await gridFsDiagramStore.save(PROJECT, "D05", "png", file("en"))
    await gridFsDiagramStore.saveLocalized(PROJECT, "D05", "vi", hash("c"), file("vi"))
    await gridFsDiagramStore.saveLocalized(PROJECT, "D05-2", "vi", hash("c"), file("keep"))

    await gridFsDiagramStore.remove(PROJECT, "D05")
    expect(await gridFsDiagramStore.load(PROJECT, "D05", "png")).toBeNull()
    expect(await gridFsDiagramStore.loadLocalized(PROJECT, "D05", "vi", hash("c"))).toBeNull()
    expect((await gridFsDiagramStore.loadLocalized(PROJECT, "D05-2", "vi", hash("c")))?.data.toString()).toBe("keep")
  })
})
