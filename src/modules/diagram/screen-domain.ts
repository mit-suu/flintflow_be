/**
 * Domain mặc định của mockup màn (FLF-410): file SRS import ghi rõ URL sản phẩm ⇒ điền sẵn `Project.screenTheme.domain`
 * một lần lúc hoàn tất import (`finalize.service` quét chữ của file bằng `domainFromText`). Chỉ điền khi domain đang `null`,
 * không gọi model, không đoán từ tên dự án. Dự án tạo mới: domain trống tới khi người dùng tự nhập (sản phẩm chưa có
 * website thật nên brief hiếm khi có URL).
 */

import mongoose from "mongoose"
import { domainFromText } from "../../shared/diagram/screen-theme.js"
import { Project } from "../project/project.model.js"

/** Ghi domain nếu còn trống. Trả domain đã ghi, hoặc null khi không ghi gì. */
export const fillScreenDomain = async (projectId: string, text: string): Promise<string | null> => {
  const domain = domainFromText(text)
  if (!domain || mongoose.connection.readyState !== 1 || !mongoose.isValidObjectId(projectId)) return null
  const res = await Project.updateOne({ _id: projectId, "screenTheme.domain": null }, { $set: { "screenTheme.domain": domain } })
  return res.modifiedCount > 0 ? domain : null
}
