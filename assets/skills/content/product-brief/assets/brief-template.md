# Product Brief — khung đọc lại

> Mẫu để **đọc lại brief cho user xác nhận** ở cuối B-1 và ở B-2.3. Không phải section của SRS: brief
> không render thành chương nào, nó nuôi `project{}` và `addendum[]`.

**project.name** · form_factor · stakes · working_mode

## 1. Vision

project.vision

## 2. Mục tiêu

project.goals[] — 3 đến 6 dòng, mỗi dòng một kết quả

## 3. Vấn đề và cơ hội

addendum có target_section = fixed:1, chủ đề problem / why-now

## 4. Người dùng mục tiêu

addendum có target_section = fixed:2.1 (một entry mỗi persona)

## 5. Giá trị cốt lõi và khác biệt

addendum có target_section = fixed:1, chủ đề value

## 6. Phạm vi bản đầu

addendum có target_section thuộc {fixed:1, fixed:3.1.2}, chủ đề scope / feature

## 7. Chỉ số thành công

addendum có target_section thuộc {fixed:4.2.2, fixed:4.2.3}

## 8. Rủi ro, giả định, câu hỏi mở

other_requirements[] theo kind

## 9. Giả định chưa xác nhận

assumptions[status=unconfirmed] — đây là danh sách B-2.1 đưa ra cho user duyệt

---

Mọi mục ở trên đọc thẳng từ Spine. Một mục trống nghĩa là bước tương ứng chưa ghi op — đó là dấu hiệu
cần quay lại, không phải chuyện để điền sau.
