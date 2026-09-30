# B-0 Intake

> Tài liệu cho người. **Không nạp lúc chạy** — luật thực thi nằm trong `../SKILL.md`.

## B-0.1 Brain Dump

FLF-221: mở đầu kiểu "kể hết → AI chỉ hỏi phần thiếu". User gõ ý tưởng vào ô chat là B-0.1 chạy (tin nhắn vào
transcript của step). FLF-232: vòng hỏi **không** hỏi `system_name` (server chỉ để B-2.3 hỏi — `askableFields`) mà hỏi `form_factor` +
`stakes` trong **một lượt hai thẻ** ("Nền tảng", "Mức độ"), lựa chọn khuyến nghị đầu tiên kèm lý do lấy từ ý tưởng,
bỏ thẻ nào user đã nói rõ. Lượt soạn ghi hai field theo điều user chọn/nói (không tạo giả định cho giá trị user đã
chọn; chỉ suy ra phần chưa ai nói, kèm giả định), và `notes` là tin nhắn cổng (2–4 câu) để user chốt ở cổng B-0.1. User bấm "Mình chưa có ý tưởng" (`intent: "no_idea"`) ⇒ vòng hỏi chỉ đưa 2–3 câu gợi mở bằng văn xuôi, không
thẻ lựa chọn, không "(Khuyến nghị)". B-0.2/B-0.3 không gọi model khi field đã có; B-0 không có phỏng vấn gộp đầu giai
đoạn.

Mục tiêu không phải là hỏi đúng câu, mà là **để user nói hết** rồi mới sắp xếp. Ba nguồn cùng lúc:
tin nhắn tự do, tài liệu upload (`document-context` đưa vào content guidance), và những gì đã có trong
`project{}` nếu project được tạo lại.

Sau khi nghe: đọc lại một bản tóm tắt ngắn để user xác nhận, rồi ghi **một `addendum[]` cho mỗi chủ đề
tách bạch**. Không gộp cả buổi nói thành một entry — entry to thì S-1 không tách ra được, và B-2.2 không
triage được từng phần.

## Tên hệ thống — `project.system_name` (FLF-177)

Tên **tiếng Anh** in lên boundary sơ đồ use case, sơ đồ ngữ cảnh và bìa/tiêu đề/tên file docx — tách khỏi
tên project làm việc (`Project.name` ở FE, không đồng bộ). FLF-232: **không** hỏi ở B-0.1 (câu đầu tiên sau khi
user kể ý tưởng không nên là đặt tên) mà hỏi ở **B-2.3**, khi vision/goals/phạm vi đã đủ để gợi ý cho hay:

- User đã tự nêu tên tiếng Anh từ trước ⇒ ghi `set project.system_name` ngay, B-2.3 không hỏi nữa.
- `system_name` còn null ở B-2.3 ⇒ hỏi một thẻ với 3–4 tên tiếng Anh ngắn (2–4 từ, Title Case, không thêm
  "System"/"App" cho đủ chữ, gợi ý đầu có lý do); chỉ ghi khi user đã chọn. Bước này không bao giờ tự Accept
  khi tên còn null (`quiet-step.ts`).
- Project cũ đã có tên ⇒ B-2.3 không hỏi; project đang giữa B-0/B-1 chưa có tên ⇒ được hỏi ở B-2.3.
- Chưa chốt ⇒ sơ đồ và tài liệu dùng tên project; từ S-2.5 có cờ vàng `system_name_missing`. User đổi sau
  bằng chat (op `set project.system_name`).

## Hai trường phân loại (B-0.2, B-0.3)

| Field | Giá trị | Ảnh hưởng về sau |
| --- | --- | --- |
| `form_factor` | **mảng**, phần tử đầu là nền tảng chính (`["web_app","mobile_app"]`); giá trị `web_app`, `mobile_app`, `desktop_app`, `api_service`, `cli`, `embedded` | S-4.1 hình dung màn; S-6.2 ngưỡng usability; S-7.2 common requirements |
| `stakes` | `internal`, `production`, `regulated` | S-6.3/S-6.4 lấy ngưỡng mặc định theo cột này; S-6.5 có cần mục tuân thủ không |

`stakes` là trường hay bị đoán nhất và cũng là trường đắt nhất khi đoán sai: `internal` cho một sản phẩm
có thanh toán thật kéo mọi ngưỡng NFR xuống quá thấp. Đoán thì phải kèm `assumptions[]`.

## Không hỏi "cách làm việc" (FLF-220, FLF-221)

`working_mode` (Coaching/Fast) đã bỏ: AI tự quyết hỏi nhiều hay ít, còn dừng để duyệt ở đâu là chế độ duyệt
trong menu cài đặt AI ("Mọi bước" / "Cuối giai đoạn"). Step "Cách làm việc" cũ chỉ còn ghi field này nên
đã bị bỏ khỏi registry ở FLF-221 — B-0 còn 3 step. Field `project.working_mode` còn trong schema (hợp đồng
đóng băng) nhưng không ai ghi hay đọc nữa.
