/**
 * Tiêu đề heading file upload hiển thị trên các màn luồng upload (FLF-362: bước 3 "Đọc file & tạo bản gốc", báo cáo thiếu
 * sót): **bỏ số mục** — số gõ tay ("1. Giới thiệu" ⇒ "Giới thiệu", "3.2.1 UC-01 …" ⇒ "UC-01 …") và không ghép số Word tự
 * đánh — cho cả file khung FPT lẫn IEEE. Bản xem / xuất Mode 1 vẫn in đúng số của file (`render/layout-sections.ts`).
 */

import { splitHeadingNumber } from "./text-similarity.js"

export const plainHeading = (text: string): string => splitHeadingNumber(text.trim()).title
