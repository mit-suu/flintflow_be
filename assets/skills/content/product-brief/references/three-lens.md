# Three-Lens Review — cách hỏi

> Tài liệu cho người. **Không nạp lúc chạy**.

Ba lăng kính không phải ba mục để điền cho đủ. Mỗi cái là một cách đọc lại toàn bộ brief.

## Skeptic

- Câu nào trong brief là **khẳng định** chứ không phải quan sát? ("người dùng sẽ thích", "thị trường
  đang cần")
- Nếu sản phẩm này ra mắt và thất bại, lý do khả dĩ nhất là gì? Lý do đó đã nằm trong
  `other_requirements[kind=risk]` chưa?
- Con số nào trong B-1.5 chưa ai đo bao giờ?
- Phần nào của MVP thực ra phụ thuộc vào một bên thứ ba mà brief chưa nhắc?

## Opportunity

- Có nhóm người dùng nào được hưởng lợi mà brief chưa kể tên?
- Dữ liệu sản phẩm này tạo ra có giá trị gì ngoài chính nó?
- Cái gì đang bị xếp "chưa làm" nhưng thực ra rẻ hơn user nghĩ?
- Nếu bỏ một ràng buộc trong B-1.4 thì mở ra được gì?

## Contextual

- `stakes` hàm ý gì về pháp lý, lưu vết, dữ liệu cá nhân?
- `form_factor` hàm ý gì về offline, kích thước màn, quyền hệ điều hành?
- Lĩnh vực này có quy ước gì mà người trong ngành coi là hiển nhiên nên không nói?
- Ai khác **phải** duyệt sản phẩm này trước khi nó lên production?

## Kết quả

Mỗi câu trả lời "có" ở trên là một op. `risk` cho cái có thể xảy ra và gây hại; `open_question` cho cái
cần người khác quyết; `assumption` cho cái đang tạm tin. Không có op thì lăng kính đó chưa được dùng.
