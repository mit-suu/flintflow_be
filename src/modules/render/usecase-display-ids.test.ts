import { describe, expect, it } from "vitest"
import { displayUseCaseId, useCaseDisplayIds } from "./usecase-display-ids.js"

const ucs = (ids: string[]) => ({ use_cases: ids.map((id) => ({ id })) }) as unknown as Parameters<typeof useCaseDisplayIds>[0]

describe("useCaseDisplayIds (FLF-420)", () => {
  it("id có lỗ sau khi xoá ⇒ mã hiển thị liên tục theo thứ tự use case", () => {
    const map = useCaseDisplayIds(ucs(["UC01", "UC03", "UC04", "UC05", "UC07", "UC10", "UC14", "UC15"]))
    expect([...map.values()]).toEqual(["UC01", "UC02", "UC03", "UC04", "UC05", "UC06", "UC07", "UC08"])
    expect(displayUseCaseId(map, "UC14")).toBe("UC07")
  })

  it("theo thứ tự mảng, không theo id", () => {
    expect([...useCaseDisplayIds(ucs(["UC09", "UC02"])).values()]).toEqual(["UC01", "UC02"])
    expect(useCaseDisplayIds(ucs(["UC09", "UC02"])).get("UC09")).toBe("UC01")
  })

  it("≥ 100 use case ⇒ 3 chữ số cho mọi mã", () => {
    const map = useCaseDisplayIds(ucs(Array.from({ length: 120 }, (_, i) => `X${i}`)))
    expect(map.get("X0")).toBe("UC001")
    expect(map.get("X119")).toBe("UC120")
  })

  it("id không có trong bảng / không có bảng ⇒ giữ id", () => {
    expect(displayUseCaseId(useCaseDisplayIds(ucs(["UC01"])), "UC99")).toBe("UC99")
    expect(displayUseCaseId(undefined, "UC-05")).toBe("UC-05")
  })
})
