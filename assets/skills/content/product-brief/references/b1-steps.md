# B-1 — sáu bước của Product Brief

> Tài liệu cho người. **Không nạp lúc chạy** — bảng thực thi nằm trong `../SKILL.md`.

Nội dung sáu bước kế thừa từ prompt `assets/prompts/chat_discovery.md` (bản cũ), nhưng khác ở chỗ quan
trọng nhất: **bản cũ để mọi thứ trong JSON tin nhắn và để LLM tự đánh giá đã đủ hay chưa**; bản này ghi
thẳng vào Spine và để **user** chốt ở gate.

| Bước | Câu hỏi cốt lõi | Ghi vào đâu |
| --- | --- | --- |
| B-1.1 | Vấn đề gốc là gì, vì sao là bây giờ, thành công trông ra sao | `project.vision`, `project.goals[]`, addendum `fixed:1` |
| B-1.2 | Ai dùng, họ đang cố hoàn thành việc gì | addendum `fixed:2.1` (một entry mỗi persona) |
| B-1.3 | Vì sao dùng cái này thay vì cách đang làm | addendum `fixed:1` |
| B-1.4 | Bản đầu tiên có gì, và dứt khoát chưa có gì | addendum `fixed:1`, `fixed:3.1.2` |
| B-1.5 | Đo bằng con số nào thì biết là được | addendum `fixed:4.2.2`, `fixed:4.2.3` |
| B-1.6 | Rủi ro, giả định, câu hỏi còn treo | `other_requirements[]` + `assumptions[]` |

## Goals phải là kết quả

Sai: "có nút export", "dùng AI". Đúng: "rút thời gian ra bản SRS đạt chuẩn từ vài tuần xuống một ngày".
Phép thử: nếu câu đó vẫn đúng khi đổi hoàn toàn cách làm, đó là goal; nếu nó chết theo một tính năng cụ
thể, đó là feature — cho vào addendum `fixed:3.1.2`.

## `content` và `content_en`

`content` giữ nguyên chữ của user (thường tiếng Việt) để B-2.2 triage đúng ý họ; `content_en` là bản
tiếng Anh sẽ được render vào tài liệu. Dịch lúc ghi, không để dành — đọc lại sau một tuần thì không giữ
được đúng sắc thái nữa.

## B-1.5 có số hay không

Người dùng hiếm khi có KPI sẵn. Không ép. Ghi cái họ nói ("phải nhanh"), rồi ghi một `assumptions[]` nói
rõ con số sẽ dùng làm mặc định ở S-6 nếu không ai sửa. Như vậy S-6.3/S-6.4 có chỗ bấu, và user vẫn thấy
được mình chưa quyết.
