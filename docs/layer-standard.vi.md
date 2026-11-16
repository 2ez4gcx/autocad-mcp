# Chuẩn hóa layer bản vẽ của người khác

Tài liệu lập ngày 13/11/2026. Công cụ: `standardize_layers` (máy chủ `mcpb/src/layers.mjs`, cầu nối `bridge/src/LayerTools.cs`).

## 1. Vấn đề, đo trên 13 bản vẽ thật

Mười ba bản vẽ kiến trúc và kết cấu do các văn phòng khác lập (công trình công nghiệp và văn phòng; không nêu tên dự án), tổng 234 671 đối tượng:

- **1 487 layer**, mỗi bản vẽ 47 đến 263 layer.
- **Cùng một thứ nằm trên nhiều layer**: kích thước nằm trên `DIM`, `Kich thuoc`, `A- Dimension`, `0-dim`, `X- Dim`, `KICHTHUOC`, `KHICHTHUOC`, `00-Kichthuoc`, `net kich thuoc`…; tường trên `TUONG`, `WALL`, `A-Wall`, `<tên xref>$0$A-Wall`.
- **Một layer chứa nhiều thứ**: layer `TEXT` có 7 478 chữ nhưng cũng có 1 854 đường thẳng và 1 830 MText; layer `DIM` có 4 939 kích thước và 2 521 đường thẳng.
- **Layer đặt theo nét bút, không theo nội dung**: `0.3`, `0.09`, `T0.13`, `manh`, `NET-THAY`, `netcat`, `medium`, `02`…
- **Vẽ trên layer 0**: 32 304 đối tượng; ở một bản vẽ kết cấu là 65% số đối tượng.
- **Gán màu, nét, độ dày trực tiếp cho từng đối tượng** thay vì theo layer: 64 702 đối tượng; ở một bản vẽ là 78%.
- **Tên khối vô nghĩa** do sao chép (`A$C206177D3`, `SADASAS`, `FGFGFG`); tên layer có tiền tố xref đã bind (`…$0$`), có tiếng Trung.

Đổi tên layer theo một bảng tra (như LAYTRANS của AutoCAD) không đủ, vì nội dung một layer không thuần một loại.

## 2. Cách làm

Mỗi đối tượng được xếp vào một layer chuẩn theo **nó là gì**, theo thứ tự:

1. **Loại đối tượng khi loại đã nói rõ**: kích thước luôn về layer kích thước, viewport về layer khung nhìn, ảnh về layer ảnh, dù đang nằm ở đâu.
2. **Mục đích đọc từ tên layer**: tiếng Việt có dấu hay không dấu, tiếng Anh, tiếng Trung, mã kiểu AIA (`A-Wall`, `A-Text-VN`, `A-Door-Iden`). Tiền tố xref đã bind được bỏ. Ghi chú đứng trước đối tượng (một nhãn cửa là ký hiệu, không phải cửa); tên ghép đứng trước tên đơn (`thép đai` trước `thép`).
   - Trên layer có mục đích, chữ về layer chữ cùng mục đích, hatch về layer hatch của mục đích đó (`tường` → `A-WALL-PATT`), khối về mục đích của khối nếu layer chỉ là chữ, kích thước hay nét.
3. **Khối theo tên rồi theo nội dung**: cửa, cửa sổ, thiết bị vệ sinh, nội thất, ký hiệu trục, cao độ, mặt cắt, khung tên, bu lông… Khối tên vô nghĩa mà có thuộc tính: ít đối tượng là ký hiệu, nhiều đối tượng là khung tên.
4. **Nét của đối tượng khi tên không nói gì** (layer 0, layer đặt theo nét bút, tên lạ): chữ, ghi chú, hatch theo loại. Đường nét theo **độ dày khi in**: dày (≥ 0,35) về nét cắt, mảnh về nét chi tiết. Độ dày in lấy từ bảng in `.ctb` của các layout (bút cố định theo màu), không có thì theo lineweight của đối tượng, của layer, hay LWDEFAULT.

**Bản vẽ kiến trúc hay kết cấu** đọc từ tên file (KT, KC, KCB) hoặc từ nội dung. Bản vẽ kết cấu dùng `S-ANNO-*`, `S-DETL*`, `S-CONC-PATT`.

**Giữ nguyên bản in** (mặc định): màu, nét, độ dày gán riêng được trả về ByLayer, trừ chỗ layer chuẩn sẽ in khác. Khác nghĩa là khác **cấp nét** (rất mảnh, mảnh, vừa, dày) hoặc đổi nét liền thành nét đứt và ngược lại; chỉ ở đó đối tượng giữ độ dày cũ. `keep_look: false` lấy hoàn toàn độ dày của chuẩn.

**Không động vào**: layer 0 bên trong khối (đúng quy ước khối), Defpoints, layer của xref đang tham chiếu, layer tên "không in" (`Nplt`).

**Thực hiện**:

- Layer mà toàn bộ nội dung về cùng một layer chuẩn chưa có thì được đổi tên, giữ trạng thái đóng băng theo viewport. Các layer còn lại được chuyển từng đối tượng trong model, layout và định nghĩa khối; thuộc tính đi theo khối.
- Đối tượng trong khối kích thước và bảng về layer 0.
- Layer rỗng bị purge. Layer đích lấy màu, nét, độ dày và cách viết tên của chuẩn.
- Tất cả trong một bước Undo. Sau đó công cụ đọc lại bản vẽ để xác nhận số đối tượng theo từng không gian và loại không đổi.

## 3. Kết quả trên 13 bản vẽ (bản sao)

| Bản vẽ | Loại | Layer trước → sau | Số đối tượng còn đủ |
|---|---|---|---|
| Bản vẽ 1 | KT | 230 → 41 | đủ |
| Bản vẽ 2 | KT | 263 → 41 | đủ |
| Bản vẽ 3 | KC | 132 → 23 | đủ |
| Bản vẽ 4 | KC | 63 → 22 | đủ |
| Bản vẽ 5 | KT | 47 → 20 | đủ |
| Bản vẽ 6 | KC | 146 → 36 | đủ |
| Bản vẽ 7 | KT | 126 → 24 | đủ |
| Bản vẽ 8 | KC | 102 → 23 | đủ |
| Bản vẽ 9 | KT | 52 → 23 | đủ |
| Bản vẽ 10 | KC | 106 → 23 | đủ |
| Bản vẽ 11 | KT | 62 → 20 | đủ |
| Bản vẽ 12 | KT | 53 → 17 | đủ |
| Bản vẽ 13 | KC | 105 → 21 | đủ |

- Tổng số layer giảm từ 1 487 xuống 334. Loại bản vẽ (kiến trúc hay kết cấu) được nhận đúng cả 13 file, dù bản sao đã đổi tên.
- Cả 13 file chạy hàng loạt trong 108 giây.
- In thử một tờ trước và sau khi giữ bản in: lượng mực 13,41 so với 13,60, khác 0,25% số điểm ảnh. Nếu lấy độ dày của chuẩn thì khác 2,1% (hatch mảnh đi).

## 4. Cách dùng

1. Mở bản vẽ, gọi `standardize_layers` (chạy thử, không đổi gì) với `csv_path`. File CSV liệt kê từng layer: số đối tượng, mục đích, đọc từ đâu, sẽ chuyển sang đâu.
2. Chỗ nào không đồng ý thì ghi vào cột `to` (tên layer, `keep` hoặc để trống), đưa lại bằng `mapping_csv`, hoặc dùng `mapping`.
3. Gọi lại với `apply: true`, rồi lưu bản vẽ.
4. Nhiều file: dùng `files` và `out_dir`. Mỗi file mở chỉ đọc, lưu thành file mới `<tên>-layer.dwg`; file gốc không bao giờ bị ghi.
5. Chuẩn riêng của công ty: `standard`, dạng danh sách hoặc file CSV `name;color;linetype;lineweight;plot;role;description`. Vai trò nào có trong chuẩn thì dùng layer của chuẩn.

## 5. Giới hạn

- Đọc mục đích từ tên là quy tắc, không phải hiểu nghĩa: tên lạ (`CB`, `MAU`, `9A`) đi theo loại đối tượng và độ dày in. Bản chạy thử cho thấy layer nào được đọc từ tên, layer nào theo nội dung, để người dùng sửa.
- Đường nét không có mục đích rõ chỉ chia được nét cắt và nét chi tiết. Muốn biết đó là tường hay đồ đạc thì phải nhận dạng hình (bước sau: đọc mặt bằng cũ thành mô tả công trình).
- Viewport đang đóng băng một layer bị gộp sẽ hiện nội dung đã gộp; công cụ có cảnh báo.
- Layer còn bị tham chiếu (bộ lọc, trạng thái layer) được giữ và liệt kê.
- Bảng in `.ctb` riêng của công ty phải nằm trong thư mục Plot Styles hoặc cạnh bản vẽ mới đọc được bút; không có thì so theo lineweight.
