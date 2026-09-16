# B-2 — chốt Brief trước khi mở S-1

> Tài liệu cho người. **Không nạp lúc chạy** — luật thực thi nằm trong `../SKILL.md`.

## B-2.1 Assumption Sweep

Trình mọi `assumptions[status=unconfirmed]`. Hai cách duyệt, cùng hợp lệ:

- **lẻ**: từng giả định một — dùng khi giả định chạm bất biến hoặc nuôi ngưỡng NFR (4.2.2, 4.2.3), vì
  sai một cái là sai cả một chương.
- **lô**: duyệt cả nhóm một lần — dùng cho phần còn lại, nhất là ở `working_mode: fast`.

`rejected` không phải là "xoá". Giả định bị từ chối nghĩa là **giá trị đang dựa trên nó sai**: phải nói
rõ chỗ nào cần sửa, hoặc mở một `other_requirements[kind=open_question]`.

## B-2.2 Addendum Triage

Ba lựa chọn cho mỗi `addendum[]`:

| Quyết định | Làm gì |
| --- | --- |
| **Giữ** | Sửa `target_section` nếu sai, để nguyên nội dung |
| **Để dành** | Đổi `target_section` sang `fixed:5.4` — S-7.4 sẽ nhặt nó thành Other Requirement. B-2.2 chỉ được ghi `addendum[]`/`assumptions[]` (step registry), nên "để dành" là **đổi đích**, không phải chuyển collection |
| **Bỏ** | Xoá — chỉ khi nội dung *sai*, không phải khi "chưa làm bản này" |

Đây là lúc rẻ nhất để sửa `target_section`. Sau S-2, một addendum trỏ sai section nghĩa là nội dung đó
không bao giờ tới tay step cần nó — và không có gì báo lỗi, nó chỉ đơn giản không xuất hiện.

## B-2.3 Three-Lens Review

Ba lăng kính, mỗi cái một đoạn ngắn, tự định nghĩa trước khi dùng:

- **Skeptic** — điều gì làm sản phẩm này thất bại; chỗ nào đang khẳng định mà không có bằng chứng.
- **Opportunity** — brief đang nói nhỏ hơn thực tế ở đâu; giá trị nào chỉ cách một bước.
- **Contextual** — lĩnh vực, `stakes` và `form_factor` hàm ý điều gì mà chưa ai nói ra.

Phát hiện nào cũng phải thành op (`other_requirements[]` hoặc `assumptions[]`). Ba đoạn văn hay mà không
đổi Spine thì bước này vô nghĩa.

Gate của B-2.3 là **Approve** của UC 2.5: chấp nhận ở đây mở S-1. Đây là điểm không quay lại rẻ nữa —
sau đó Brief đã thành cấu trúc, sửa phải đi qua change flow.
