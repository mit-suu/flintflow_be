import { describe, expect, it } from "vitest"
import { placeOnGrid } from "./orthogonal-place.js"

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `N${i}`)

describe("placeOnGrid", () => {
  it("cha ở hàng trên con; mỗi nút một ô; tất định", () => {
    const nodes = ids(5)
    const links: [string, string][] = [["N0", "N1"], ["N0", "N2"], ["N1", "N3"], ["N2", "N4"]]
    const cells = placeOnGrid(nodes, links, 6)
    for (const [a, b] of links) expect(cells.get(a)!.row).toBeLessThan(cells.get(b)!.row)
    expect(new Set([...cells.values()].map((c) => `${c.row},${c.col}`)).size).toBe(5)
    expect([...placeOnGrid(nodes, links, 6)]).toEqual([...cells])
  })

  it("chu trình, tự nối, cạnh trùng và id lạ không làm hỏng; mọi nút có ô riêng", () => {
    const cells = placeOnGrid(ids(4), [["N0", "N1"], ["N1", "N2"], ["N2", "N0"], ["N3", "N3"], ["N0", "N1"], ["N0", "X"]], 6)
    expect(cells.size).toBe(4)
    expect(new Set([...cells.values()].map((c) => `${c.row},${c.col}`)).size).toBe(4)
  })

  it("nút gốc chỉ có cạnh đi ra kéo sát nút con thấp nhất", () => {
    // N0 → N1 → N2 → N3 (chuỗi), N4 → N3: N4 nằm ngay trên N3, không ở hàng 0
    const cells = placeOnGrid(ids(5), [["N0", "N1"], ["N1", "N2"], ["N2", "N3"], ["N4", "N3"]], 6)
    expect(cells.get("N4")!.row).toBe(cells.get("N3")!.row - 1)
  })

  it("thành phần liên thông xếp dải theo bề rộng tối đa; nút cô lập cũng có ô", () => {
    const cells = placeOnGrid(ids(10), [], 4)
    expect(cells.size).toBe(10)
    expect(Math.max(...[...cells.values()].map((c) => c.col))).toBeLessThan(4)
    expect(Math.max(...[...cells.values()].map((c) => c.row))).toBe(2)
  })

  it("không nút ⇒ rỗng", () => {
    expect(placeOnGrid([], [], 4).size).toBe(0)
  })
})
