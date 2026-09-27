# B-0 Intake

> Tài liệu cho người. **Không nạp lúc chạy** — luật thực thi nằm trong `../SKILL.md`.

## B-0.1 Brain Dump

Mục tiêu không phải là hỏi đúng câu, mà là **để user nói hết** rồi mới sắp xếp. Ba nguồn cùng lúc:
tin nhắn tự do, tài liệu upload (`document-context` đưa vào content guidance), và những gì đã có trong
`project{}` nếu project được tạo lại.

Sau khi nghe: đọc lại một bản tóm tắt ngắn để user xác nhận, rồi ghi **một `addendum[]` cho mỗi chủ đề
tách bạch**. Không gộp cả buổi nói thành một entry — entry to thì S-1 không tách ra được, và B-2.2 không
triage được từng phần.

## Tên hệ thống — `project.system_name` (FLF-177)

Tên **tiếng Anh** in lên boundary sơ đồ use case, sơ đồ ngữ cảnh và bìa/tiêu đề/tên file docx — tách khỏi
tên project làm việc (`Project.name` ở FE, không đồng bộ). Hỏi ngay ở B-0.1:

- User đã có tên tiếng Anh ⇒ ghi `set project.system_name`.
- Chưa có tên, hoặc chỉ có tên tiếng Việt ⇒ gợi ý 2–3 tên tiếng Anh ngắn (2–4 từ, Title Case, không thêm
  "System"/"App" cho đủ chữ) cho user chọn; chỉ ghi khi user đã chọn.
- Chưa chốt ⇒ sơ đồ và tài liệu dùng tên project; từ S-2.5 có cờ vàng `system_name_missing`. User đổi sau
  bằng chat (op `set project.system_name`).

## Hai trường phân loại (B-0.2, B-0.3)

| Field | Giá trị | Ảnh hưởng về sau |
| --- | --- | --- |
| `form_factor` | `web_app`, `mobile_app`, `desktop_app`, `api_service`, `cli`, `embedded` | S-4.1 hình dung màn; S-6.2 ngưỡng usability; S-7.2 common requirements |
| `stakes` | `internal`, `production`, `regulated` | S-6.3/S-6.4 lấy ngưỡng mặc định theo cột này; S-6.5 có cần mục tuân thủ không |

`stakes` là trường hay bị đoán nhất và cũng là trường đắt nhất khi đoán sai: `internal` cho một sản phẩm
có thanh toán thật kéo mọi ngưỡng NFR xuống quá thấp. Đoán thì phải kèm `assumptions[]`.

## Không hỏi "cách làm việc" (FLF-220, FLF-221)

`working_mode` (Coaching/Fast) đã bỏ: AI tự quyết hỏi nhiều hay ít, còn dừng để duyệt ở đâu là chế độ duyệt
trong menu cài đặt AI ("Mọi bước" / "Cuối giai đoạn"). Step "Cách làm việc" cũ chỉ còn ghi field này nên
đã bị bỏ khỏi registry ở FLF-221 — B-0 còn 3 step. Field `project.working_mode` còn trong schema (hợp đồng
đóng băng) nhưng không ai ghi hay đọc nữa.
