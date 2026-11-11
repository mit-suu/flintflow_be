import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Spine } from "./spine.types.js"
import {
  diagramKey,
  inferDiagramKind,
  isOriginalStale,
  keptOriginalKinds,
  originalDiagramValue,
  originalKey,
  originalSectionOf,
  ownerOfSection
} from "./original-diagram.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8")))

describe("FLF-390: sơ đồ gốc gắn phần tử (sequence ↔ function, activity ↔ use case)", () => {
  it("khoá ẩn theo function chủ; loại một hình giữ khoá theo loại", () => {
    expect(originalKey("sequence", "FN001")).toBe("sequence@FN001")
    expect(originalKey("activity", "UC02")).toBe("activity@UC02")
    expect(originalKey("usecase", "FN001")).toBe("usecase")
    expect(diagramKey({ kind: "activity", owner_id: "UC03" })).toBe("activity@UC03")
    expect(diagramKey({ kind: "erd", owner_id: null })).toBe("erd")
  })

  it("mục của hình: sequence ⇒ mục function; activity ⇒ đặc tả use case; giá trị ghi lên khối ảnh mang owner_id", () => {
    expect(originalSectionOf({ kind: "sequence", owner_id: "FN001" })).toBe("function:FN001")
    expect(originalSectionOf({ kind: "activity", owner_id: "UC02" })).toBe("fixed:2.2.2")
    expect(originalSectionOf({ kind: "erd" })).toBe("fixed:3.1.5")
    expect(originalDiagramValue(FIXTURE, "activity", "UC02")).toMatchObject({ kind: "activity", owner_id: "UC02" })
    expect(originalDiagramValue(FIXTURE, "usecase", "FN001")).not.toHaveProperty("owner_id")
  })

  it("chỉ hình của use case đó được ẩn; đổi luồng của use case khác không làm hình lệch", () => {
    const value = originalDiagramValue(FIXTURE, "activity", "UC02")
    const spine: Spine = { ...FIXTURE, custom_sections: [{ id: "C1", heading: "x", level: 2, source: "import", blocks: [{ kind: "image", text: "", rows: null, image_ref: "media/1.png", diagram: value }] }] }
    expect([...keptOriginalKinds(spine)]).toEqual(["activity@UC02"])
    expect(isOriginalStale(spine, value)).toBe(false)
    const otherChanged: Spine = { ...spine, use_cases: spine.use_cases.map((u) => (u.id === "UC03" ? { ...u, activity_nodes: [{ id: "UC03-AN1", kind: "initial" }] } : u)) }
    expect(isOriginalStale(otherChanged, value)).toBe(false)
    const ownChanged: Spine = { ...spine, use_cases: spine.use_cases.map((u) => (u.id === "UC02" ? { ...u, activity_flows: [] } : u)) }
    expect(isOriginalStale(ownChanged, value)).toBe(true)
  })

  it("suy loại ảnh chưa đọc được: sequence chỉ trong mục function; activity không suy (không biết use case chủ)", () => {
    expect(inferDiagramKind("function:FN001", "Figure 4 - Sequence diagram: Log in")).toBe("sequence")
    expect(inferDiagramKind("function:FN001", "Hình 5: Sơ đồ hoạt động đăng nhập")).toBeNull()
    expect(inferDiagramKind("fixed:2.2.2", "Figure 4 - Sequence diagram: Log in")).toBeNull()
    expect(inferDiagramKind("fixed:2.2.1", "(none)")).toBe("usecase")
    expect(ownerOfSection("function:FN001")).toBe("FN001")
    expect(ownerOfSection("fixed:1")).toBeNull()
  })
})
