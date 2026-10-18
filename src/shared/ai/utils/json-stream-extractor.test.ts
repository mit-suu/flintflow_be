import { describe, it, expect } from "vitest"
import { JsonStreamExtractor } from "./json-stream-extractor.js"

const streamOf = (chunks: string[]): { deltas: string; reply: string } => {
  const extractor = new JsonStreamExtractor()
  const deltas = chunks.map((chunk) => extractor.push(chunk)).join("")
  return { deltas, reply: extractor.finish().reply }
}

describe("JsonStreamExtractor", () => {
  it("chỉ phát chữ của `reply`, dừng ở dấu nháy đóng", () => {
    expect(streamOf(['{"re', 'ply": "Xin ', 'chào\\nbạn", "questions": []}']).deltas).toBe("Xin chào\nbạn")
  })

  it("escape \\uXXXX bị cắt giữa hai chunk vẫn ra đúng ký tự, không in chữ rác", () => {
    const { deltas, reply } = streamOf(['{"reply": "Kh\\u00', 'e1m b\\u1', 'ec7nh", "questions": []}'])
    expect(deltas).toBe("Khám bệnh")
    expect(reply).toBe("Khám bệnh")
  })
})
