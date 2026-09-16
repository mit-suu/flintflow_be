# B-0 Intake

> Tài liệu cho người. **Không nạp lúc chạy** — luật thực thi nằm trong `../SKILL.md`.

## B-0.1 Brain Dump

Mục tiêu không phải là hỏi đúng câu, mà là **để user nói hết** rồi mới sắp xếp. Ba nguồn cùng lúc:
tin nhắn tự do, tài liệu upload (`document-context` đưa vào content guidance), và những gì đã có trong
`project{}` nếu project được tạo lại.

Sau khi nghe: đọc lại một bản tóm tắt ngắn để user xác nhận, rồi ghi **một `addendum[]` cho mỗi chủ đề
tách bạch**. Không gộp cả buổi nói thành một entry — entry to thì S-1 không tách ra được, và B-2.2 không
triage được từng phần.

## Ba trường phân loại (B-0.2 đến B-0.4)

| Field | Giá trị | Ảnh hưởng về sau |
| --- | --- | --- |
| `form_factor` | `web_app`, `mobile_app`, `desktop_app`, `api_service`, `cli`, `embedded` | S-4.1 hình dung màn; S-6.2 ngưỡng usability; S-7.2 common requirements |
| `stakes` | `internal`, `production`, `regulated` | S-6.3/S-6.4 lấy ngưỡng mặc định theo cột này; S-6.5 có cần mục tuân thủ không |
| `working_mode` | `coaching`, `fast` | Số lượt hỏi mỗi phase, và gate từng step hay gộp cuối phase |

`stakes` là trường hay bị đoán nhất và cũng là trường đắt nhất khi đoán sai: `internal` cho một sản phẩm
có thanh toán thật kéo mọi ngưỡng NFR xuống quá thấp. Đoán thì phải kèm `assumptions[]`.

## Coaching hay Fast — nói gì với user

- **Coaching**: hỏi tới khi rõ, chốt từng step. Chậm hơn, tài liệu sát ý hơn.
- **Fast**: tối đa 2 lượt hỏi mỗi phase, chỗ thiếu điền mặc định hợp lý kèm giả định; user duyệt giả định
  một lượt ở B-2.1 và S-9.1.

Đừng chọn hộ. Câu hỏi đúng là "bạn muốn trả lời nhiều để tài liệu sát ý, hay muốn có bản nháp nhanh rồi
sửa sau?".
