import { v2 as cloudinary } from "cloudinary"
// Import để chạy `cloudinary.config` một lần (cấu hình nằm ở module upload)
import "../../shared/utils/cloudinary.js"

/**
 * Xoá file gốc của tài liệu upload trên Cloudinary (upload dùng `resource_type: "raw"`).
 *
 * Best-effort: lỗi mạng/credential chỉ ghi log, không chặn việc xoá record trong DB — để lại một file mồ
 * côi trên Cloudinary rẻ hơn để lại một record trỏ tới tài liệu user đã xoá. Trả `true` khi Cloudinary
 * xác nhận đã xoá hoặc file vốn không còn.
 */
export const destroyDocumentAsset = async (publicId: string | null | undefined): Promise<boolean> => {
  if (!publicId) return false
  try {
    const result: unknown = await cloudinary.uploader.destroy(publicId, { resource_type: "raw", invalidate: true })
    const status = typeof result === "object" && result !== null && "result" in result ? result.result : null
    return status === "ok" || status === "not found"
  } catch (err) {
    console.warn(`[ProjectDocument] Không xoá được asset Cloudinary '${publicId}':`, err)
    return false
  }
}
