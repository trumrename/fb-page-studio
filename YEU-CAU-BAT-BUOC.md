# Yêu cầu bắt buộc và checklist hồi quy

Tài liệu này là bản ghi lâu dài cho các yêu cầu đã thống nhất trong dự án. Mỗi lần sửa hoặc build phải đọc và đối chiếu, không chỉ dựa vào lịch sử chat.

## 1. Kết nối và cấu hình

- Phân biệt rõ Meta App, Profile/Admin và Page; mọi danh sách phải hiển thị App nào, Admin nào, Page nào.
- Hỗ trợ App 1/App 2, OAuth đúng App và đúng redirect domain.
- Ngrok tích hợp trong EXE; token nhập/dán được, báo trạng thái rõ, không lộ token.
- Chrome thường và ChromePortable: chọn thư mục dữ liệu/profile bằng hộp Explorer đầy đủ ổ đĩa; quét hết profile trong thư mục đã chọn.
- Mọi bộ chọn thư mục media, posted, caption và Chrome đều dùng Explorer chuẩn. Không được dùng lại FolderBrowserDialog nhỏ.

## 2. Đăng bài và lịch

- Page đã tick, Page đang mở, tab đang dùng và toàn bộ điều khiển lịch lần cuối phải lưu bền vững; đổi tab, tải lại hoặc đóng/mở EXE không được tự bỏ chọn.
- Bấm một dòng Page phải mở đúng cấu hình và chọn rõ Page đó cho lần chạy; danh sách dựng lại không được lấy trạng thái từ checkbox DOM tạm thời.
- Cấu hình từng Page phải tự lưu khi thay đổi và phải flush trước khi chuyển Page/tab/đóng app; vẫn giữ nút Lưu ngay để người dùng chủ động xác nhận.
- Hai chế độ: từng App tuần tự và hai App so le.
- Nếu một App/nhóm thiếu Page thì tự rơi về logic tuần tự hợp lệ, không tạo slot giả.
- Thứ tự phải ghi rõ App → Admin/Profile → Page → bài thứ mấy.
- Hỗ trợ chạy ngay và hẹn giờ; không tạo lịch trong quá khứ.
- Tab Direct Local chỉ được giữ lịch ở máy: tool chờ đến `run_at` rồi gọi đăng trực tiếp. Tuyệt đối không đổi các task sau thành Facebook `scheduled_publish_time`.
- Direct Local có số bài, loại bài và gap riêng; không được đọc ngầm “Khung giờ/Số ngày tới” của chế độ Hẹn Facebook.
- Ở chế độ Hẹn Facebook theo khung giờ, tổng `Số bài/Page/ngày` chỉ bằng tổng số bài của các dòng khung; dòng sai/0 bài phải báo lỗi, không tự đoán.
- Tất cả giờ hiển thị theo giờ Việt Nam; có số bài/Page/ngày, khoảng giờ hoạt động, gap min/max và cooldown.
- Media chọn ngẫu nhiên có giãn cách; caption chọn lần lượt, hết vòng thì trộn rồi xoay vòng.
- Nhiều Page dùng chung một kho caption phải dùng chung một con trỏ nguyên tử; đăng thành công phải note caption vào lịch sử chống trùng và số caption còn lại phải trừ caption đã dùng trong cửa sổ anti-spam.

## 3. Theo dõi và báo cáo

- Dashboard có tiến trình %, thành công, lỗi, thông báo live và số tài nguyên live.
- Popup tiến trình không được spam: tối đa 3 popup, có nút đóng, tự hết hạn, gom nhiều cập nhật cùng lúc và không phát lại lịch sử cũ khi mở lại job.
- Lịch dự kiến và trạng thái Facebook phải phân biệt rõ: trực tiếp, hẹn giờ, Facebook đã nhận lịch, Facebook đã đăng.
- Xuất thông tin Page theo App và lịch sử đăng hằng ngày; tên file/EXE luôn có version chính xác.
- Theo dõi follower delta 1/3/7/30 ngày.

## 4. Updater và phát hành

- Version trong package.json, package-lock.json, EXE nhúng, pack-customer/VERSION.txt phải trùng.
- EXE giao khách và asset release phải có tên FB-Page-Studio-Desktop-vX.Y.Z.exe.
- Không dùng asset chung tên để tránh kẹt bản cũ; phải kiểm tra hash và cảnh báo khi bản cũ còn chạy.
- Trước release chạy đủ npm test, npm run build:desktop, npm run pack:customer, npm run release:verify.
- Không push/tag/release GitHub nếu chưa được người dùng đồng ý rõ.

## 5. Quy trình kiểm tra tối thiểu

1. Rà soát route/API, HTML/CSS, Electron IPC và đường dẫn đóng gói.
2. Chạy npm test và kiểm tra không có lỗi hồi quy tĩnh.
3. Mở giao diện mới, thử trực tiếp các thao tác quan trọng bằng dữ liệu giả.
4. Build EXE đúng version, đồng bộ gói khách và chạy cổng verify.
5. Báo rõ file nào đã đổi, test nào đã chạy, và phần nào chưa thể kiểm tra.

Test máy mới bắt buộc dùng database hoàn toàn sạch và xác nhận đủ cột `scheduled_publish_time`, `active_hours_json`, `active_hours_at`, `preferred_hours_json`. Phải thử thật chuỗi: chọn Page → sửa config → đổi tab → reload → đọc lại đúng Page/config/lịch.
