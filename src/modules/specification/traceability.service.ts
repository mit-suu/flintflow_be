/**
 * Task 2d — Traceability Service
 *
 * Parse sourceLinks từ AI response, validate excerpt có thực sự tồn tại
 * trong tài liệu gốc (substring match đơn giản), rồi lưu RequirementSourceLink.
 *
 * Thiết kế an toàn: mọi lỗi đều chỉ log warning, KHÔNG throw,
 * KHÔNG chặn việc lưu Section chính.
 */

import mongoose from "mongoose"
import { RequirementSourceLink } from "./requirement-source-link.model.js"
import { ProjectDocument } from "../project/project-document.model.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawSourceLink {
  documentId: string
  excerpt: string
}

// ─── Excerpt Validator ────────────────────────────────────────────────────────

/**
 * Validate excerpt có xuất hiện trong extractedText của document không.
 *
 * Điều chỉnh #4: kiểm tra substring match (hoặc gần khớp theo tỷ lệ ký tự).
 * - Nếu excerpt xuất hiện chính xác (case-insensitive) → valid
 * - Nếu không tìm thấy → loại bỏ, không lưu record, ghi log warning
 *
 * Không dùng fuzzy matching nâng cao — substring case-insensitive là đủ
 * cho giai đoạn này để tránh AI bịa đặt trích dẫn.
 */
const isExcerptValid = (excerpt: string, extractedText: string | null | undefined): boolean => {
  if (!extractedText) return false
  if (!excerpt || excerpt.trim().length < 10) return false  // excerpt quá ngắn không đủ tin cậy

  const excerptNorm = excerpt.trim().toLowerCase()
  const textNorm = extractedText.toLowerCase()

  return textNorm.includes(excerptNorm)
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Parse AI response sourceLinks, validate từng excerpt, lưu records hợp lệ.
 *
 * @param sectionId       - ObjectId của Section vừa được tạo/cập nhật
 * @param projectId       - ObjectId của Project (để điền vào record)
 * @param rawAiSourceLinks - Mảng raw sourceLinks từ AI response (có thể null/undefined nếu AI không trả)
 */
export const saveSourceLinks = async (
  sectionId: mongoose.Types.ObjectId,
  projectId: string,
  rawAiSourceLinks: RawSourceLink[] | null | undefined
): Promise<{ saved: number; rejected: number; skipped: number }> => {
  const stats = { saved: 0, rejected: 0, skipped: 0 }

  // Không có sourceLinks → bình thường, AI không trả → bỏ qua im lặng
  if (!rawAiSourceLinks || !Array.isArray(rawAiSourceLinks) || rawAiSourceLinks.length === 0) {
    return stats
  }

  // Lấy tất cả document IDs hợp lệ trong project (chỉ lấy những cái có extractedText)
  let projectDocuments: Array<{ _id: mongoose.Types.ObjectId; extractedText?: string | null; originalName?: string }> = []
  try {
    projectDocuments = await ProjectDocument.find(
      { projectId, parseStatus: "success" },
      { _id: 1, extractedText: 1, originalName: 1 }
    ).lean()
  } catch (err: any) {
    console.warn(`[Traceability] Failed to load project documents for validation: ${err?.message}`)
    return stats
  }

  const docMap = new Map(projectDocuments.map((d) => [d._id.toString(), d]))

  const linksToCreate: Array<{
    projectId: mongoose.Types.ObjectId
    sectionId: mongoose.Types.ObjectId
    documentId: mongoose.Types.ObjectId
    sourceExcerpt: string
  }> = []

  for (const link of rawAiSourceLinks) {
    // Validate cấu trúc cơ bản
    if (!link.documentId || !link.excerpt || typeof link.excerpt !== "string") {
      stats.skipped++
      continue
    }

    // Kiểm tra documentId có trong project không
    const doc = docMap.get(link.documentId.toString())
    if (!doc) {
      console.warn(
        `[Traceability] Rejected link: documentId="${link.documentId}" not found in project "${projectId}". Excerpt: "${link.excerpt.slice(0, 60)}..."`
      )
      stats.rejected++
      continue
    }

    // Điều chỉnh #4: Validate excerpt tồn tại trong extractedText gốc
    if (!isExcerptValid(link.excerpt, doc.extractedText)) {
      console.warn(
        `[Traceability] Rejected link: excerpt not found in "${doc.originalName}". AI may have hallucinated. Excerpt: "${link.excerpt.slice(0, 80)}..."`
      )
      stats.rejected++
      continue
    }

    linksToCreate.push({
      projectId: new mongoose.Types.ObjectId(projectId),
      sectionId,
      documentId: doc._id,
      sourceExcerpt: link.excerpt.trim()
    })
  }

  // Bulk create
  if (linksToCreate.length > 0) {
    try {
      await RequirementSourceLink.insertMany(linksToCreate, { ordered: false })
      stats.saved = linksToCreate.length
    } catch (err: any) {
      console.warn(`[Traceability] Failed to insertMany RequirementSourceLinks: ${err?.message}`)
      // Không throw — lỗi lưu traceability không chặn Section
    }
  }

  return stats
}

/**
 * Trích xuất sourceLinks từ AI response data.
 * AI có thể trả về sourceLinks là một mảng, hoặc không trả (undefined).
 * Hàm này safe với mọi shape của data.
 */
export const extractSourceLinksFromAiResponse = (aiResponseData: any): RawSourceLink[] | null => {
  if (!aiResponseData) return null

  const links = aiResponseData.sourceLinks
  if (!Array.isArray(links)) return null

  return links.filter(
    (l: any) => l && typeof l.documentId === "string" && typeof l.excerpt === "string"
  )
}
