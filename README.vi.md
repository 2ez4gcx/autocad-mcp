# AutoCAD MCP

[English](README.md) | **Tiếng Việt**

![AutoCAD MCP: yêu cầu bằng lời, AI vẽ trực tiếp trong bản vẽ AutoCAD đang mở](docs/images/hero.png)

AutoCAD MCP cho phép Claude làm việc trực tiếp trên bản vẽ đang mở trong AutoCAD. Việc chính của nó là triển khai bản vẽ: từ ảnh scan/ảnh chụp mặt bằng, bản phác tay, ảnh render hoặc mô hình 3D, Claude vẽ thành bản vẽ 2D hoàn chỉnh, đúng layer (tường giao nhau gọn với hatch vật liệu, cửa đi/cửa sổ cắt vào tường, cột, trục định vị có ký hiệu, cầu thang, phòng có diện tích đo từ tường, chuỗi kích thước, ký hiệu, khung tên và xuất PDF). Từ chính mặt bằng đó nó dựng mặt đứng, mặt cắt, vẽ chi tiết bê tông cốt thép (dầm, cột, móng) kèm bảng thống kê thép, và bộ hồ sơ thiết kế nội thất: mặt bằng bố trí nội thất, mặt bằng lát sàn, mặt bằng trần đèn, triển khai mặt đứng từng vách, chi tiết đồ gỗ và bảng thống kê vật liệu hoàn thiện. Ngoài ra nó đọc bản vẽ, bóc khối lượng theo layer/block và kiểm tra lỗi bản vẽ.

Cách hoạt động giống [SketchUp MCP](https://github.com/2ez4gcx/sketchup-mcp): một extension cho Claude Desktop (`.mcpb`, chạy trên Node.js có sẵn trong Claude Desktop) và một add-in nhỏ chạy bên trong AutoCAD (**ACAD MCP Bridge**, add-in .NET). Không cần cài Python hay Node.js.

Phiên bản: **1.2.0** - [tải tại Releases](https://github.com/2ez4gcx/autocad-mcp/releases/latest). Có trong [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.2ez4gcx/autocad-mcp) chính thức với tên `io.github.2ez4gcx/autocad-mcp`.

## Tính năng

53 tool. Chiều dài theo đơn vị bản vẽ (mm với bản vẽ hệ mét), diện tích m², góc độ (ngược chiều kim đồng hồ từ trục +X).

| Nhóm | Tool |
|---|---|
| Đọc & khối lượng | `ping`, `drawing_info`, `list_layers`, `list_blocks`, `query_entities`, `selection_info`, `quantity_takeoff`, `check_drawing` |
| Tiêu chuẩn | `setup_layers`, `setup_styles` |
| Vẽ & sửa | `draw_plan`, `draw_entities`, `define_block`, `transform_entities`, `set_properties`, `delete_entities`, `select_entities`, `undo`, `purge_drawing` |
| Mặt đứng, mặt cắt & kết cấu | `draw_elevation`, `draw_section`, `draw_roof_plan`, `draw_door_schedule`, `draw_stair_detail`, `draw_finish_quantities`, `draw_structure_plan`, `draw_beam_schedule`, `draw_structure_notes`, `draw_structure_detail`, `rebar_schedule`, `structural_calc`, `draw_quantity_schedule` |
| Thiết kế nội thất | `draw_furniture_plan`, `draw_floor_finish_plan`, `draw_wall_finish_plan`, `draw_ceiling_plan`, `draw_interior_elevation`, `draw_joinery_detail`, `material_schedule` |
| Ảnh & nguồn 3D | `view_image`, `attach_image`, `import_drawing`, `screenshot`, `set_view` |
| Khung tên & file | `create_layout`, `draw_cover_sheet`, `draw_drawing_list`, `export_pdf`, `save_drawing`, `open_drawing`, `new_drawing` |
| Lập trình | `run_lisp` |
| Cài đặt | `install_autocad_bridge` |

Điểm chính:

- **Hỏi trước khi giả định**: trước khi vẽ, Claude liệt kê những gì yêu cầu chưa nói rõ (kích thước không đọc được, cao độ, mái, vật liệu, nội thất, kích thước kết cấu...) kèm giá trị nó định dùng, bạn đồng ý hoặc sửa rồi mới vẽ. `draw_plan`, `draw_elevation`, `draw_section`, `draw_structure_detail` và các tool vẽ nội thất có `dry_run=true` để liệt kê các giá trị mặc định sẽ dùng mà chưa vẽ, và mỗi kết quả đều báo lại các giá trị đã tự giả định (`assumed`).
- **Cả mặt bằng trong một bước** (`draw_plan`): Claude mô tả mặt bằng bằng mm đọc được từ ảnh (trục tường và chiều dày, ô cửa theo tường và khoảng cách, cột, trục, phòng, cầu thang, cao độ, ký hiệu mặt cắt, hướng bắc), tool vẽ tất cả trong một bước Undo:
  - các đoạn tường được hợp khối nên chỗ giao chữ L, T, X luôn gọn; mỗi vật liệu một hatch (gạch, bê tông, block, gạch nhẹ, đá, đặc);
  - cửa đi (1 cánh, 2 cánh, trượt), cửa sổ, lỗ mở được cắt vào tường, có cánh, cung mở và nét kính;
  - cột được cắt khỏi tường và tô đặc; có thể đặt cột tại mọi giao điểm trục;
  - trục có ký hiệu hai đầu (1, 2, 3... theo phương ngang, A, B, C... theo phương dọc), chuỗi kích thước bên ngoài (ô cửa, khoảng trục, kích thước tổng) ở các cạnh bạn chọn;
  - **diện tích phòng được đo từ tường, không bao giờ gõ tay**: mỗi phòng chỉ cần một điểm bên trong; nhãn ghi tên và diện tích đo được (tên dài hơn bề rộng phòng tự xuống hai dòng, nhãn luôn nằm trong phòng, không đè lên tường), đường bao kín đặt trên layer `A-AREA` (không in) để bóc khối lượng; khoảng kín chưa đặt tên phòng cũng được báo lại.
- **Mặt đứng, mặt cắt dựng từ mặt bằng** (`draw_elevation`, `draw_section`): dùng chung mô tả với `draw_plan` nên luôn khớp với mặt bằng. Cao độ (sàn, sân, đỉnh tường, đầu cửa đi, bậu và đầu cửa sổ, móng) và mái (mái dốc hai mái theo hướng nóc bất kỳ, độ dốc, độ vươn, hoặc mái bằng có tường chắn; nhiều mái, ví dụ mái sảnh) chỉ khai báo một lần.
  - mặt đứng từ mọi phía: tường, cột gần nhất che phía sau, bỏ nét khuất, mái thể hiện phía diềm (sóng ngói) hoặc đầu hồi, cửa có khuôn, đường cốt nền và mặt đất, ký hiệu cao độ, chuỗi kích thước chiều cao, ký hiệu trục kèm khoảng trục, tên hình vẽ;
  - mặt cắt theo ký hiệu mặt cắt trên mặt bằng (hoặc đường cắt bất kỳ): sàn, mái, lanh tô và dầm dưới sàn tại mọi tường bị cắt tô đặc (poché, `beam_depth` mặc định 300), trần từng phòng ở đúng cao độ hoàn thiện có giật cấp và ty treo lên sàn, thẻ mã trần và mã sàn, cao độ ở cả hai bên có đường dóng ra từ công trình, tường bị cắt có hatch và lanh tô trên ô cửa đi qua, móng có bê tông lót, sàn và lớp đất đắp, sàn hiên ra tới cột, mái bị cắt, tường/cửa nhìn thấy phía sau, tên phòng, cao độ và trục;
  - chi tiết trang trí thấy trong ảnh (cửa sổ đầu hồi, ốp gỗ, chóp mái) thêm bằng `draw_entities` trên layer `A-ELEV`.
- **Ba bộ hồ sơ, ba file riêng**: Kiến trúc (KT), Kết cấu (KC) và Nội thất (NT) là ba bản vẽ riêng, như một văn phòng thiết kế phát hành.
  - Mỗi bộ được tạo bằng `new_drawing` từ cùng một mô tả mặt bằng.
  - Mỗi bộ có danh mục bản vẽ riêng (`draw_drawing_list`, tờ KT-00 / KC-00 / NT-00), số tờ riêng và hạng mục riêng trên khung tên (KIẾN TRÚC, KẾT CẤU, NỘI THẤT).
  - Các công cụ kết cấu và nội thất làm việc được trong file không có mặt bằng kiến trúc: AutoCAD tính đường bao phòng từ mô tả mặt bằng mà không vẽ ra (`draw_plan rooms_only`).
  - Ví dụ: `examples/Nha-pho-5x18-KT.pdf`, `-KC.pdf`, `-NT.pdf`.
- **Mặt bằng mái** (`draw_roof_plan`), cho mái bằng:
  - tường mái và tum của tầng trên cùng, có trục và kích thước;
  - mái tum (hatch), sân thượng;
  - phễu thu kèm mũi tên dốc i=2%, ống thoát nước mưa;
  - cao độ sân thượng, đỉnh tường mái và mái tum;
  - ghi chú chống thấm, láng vữa tạo dốc và ống thoát nước.
- **Tờ bìa** (`draw_cover_sheet`): "HỒ SƠ BẢN VẼ <bộ>", giai đoạn, công trình, hạng mục, chủ đầu tư, đơn vị thiết kế, tổng thầu, địa điểm, ngày; mỗi bộ mở đầu bằng tờ bìa và danh mục bản vẽ.
- **Bảng thống kê cửa đi, cửa sổ** (`draw_door_schedule`):
  - mỗi loại cửa (theo ký hiệu, loại và kích thước, trên mọi tầng) được vẽ mặt đứng với khung, cánh, chiều mở (nét đứt gặp nhau ở phía bản lề) và kính;
  - kích thước rộng, cao, cao bậu, ký hiệu và số lượng;
  - bảng: ký hiệu, loại, R x C, cao bậu, số lượng theo tầng, vật liệu.
- **Chi tiết cầu thang** (`draw_stair_detail`), cho thang chữ U:
  - mặt bằng thang từng loại tầng (tầng đầu, các tầng điển hình gộp lại, tầng đến) tỷ lệ 1/50, có tường xung quanh, đánh số bậc, kích thước vế thang / chiếu nghỉ / bề rộng (n x b), cao độ sàn và chiếu nghỉ, trục và ký hiệu mặt cắt;
  - mặt cắt 1-1 dọc vế thang: vế bị cắt với bản thang BTCT và chiếu nghỉ, vế nhìn thấy phía sau, sàn và tường bị cắt, tay vịn và thanh đứng, kích thước bậc (n x h) từng vế, chiều cao tầng và cao độ;
  - ghi chú cấu tạo bậc thang và chiếu nghỉ, kèm 2h + b;
  - chi tiết bậc thang, tay vịn tỷ lệ 1/20 (đá granite, vữa, bậc xây gạch, bản thang, lớp trát, tay vịn, thanh đứng), vẽ riêng: đặt chung một tờ bằng `create_layout views`.
- **Bảng tính kết cấu sơ bộ** (`structural_calc`), kỹ sư kết cấu có chứng chỉ hành nghề phải kiểm tra, tính lại và ký xác nhận:
  - tải trọng theo TCVN 2737:2023: cấu tạo sàn, hoạt tải theo phòng (phòng ở 1,5, sảnh và cầu thang 3, ban công 2 kN/m² …), tường ngăn, tường trên dầm đã trừ lỗ cửa, trọng lượng bản thân;
  - tải sàn truyền vào dầm (bản kê 4 cạnh hình thang / tam giác, bản dầm), dầm liên tục với hoạt tải đặt toàn bộ / nhịp lẻ / nhịp chẵn, mô men gối biên qL²/24;
  - tính cốt thép chịu uốn và cốt đai theo TCVN 5574:2018 (αm, ξ ≤ ξR, As, chọn thép; đai vùng gối và giữa nhịp); thép đã tính chuyển sang `draw_beam_schedule`;
  - tải trọng cột từng tầng xuống móng (cột đặt trên sàn truyền tải vào dầm đỡ), khả năng chịu lực cột, diện tích móng theo áp lực đất;
  - tờ bảng tính (vật liệu, tải trọng sàn, cấu tạo sàn, dầm, cột và móng, giả thiết) kèm ô xác nhận: người tính, kiểm tra, chủ trì kết cấu (họ tên, số chứng chỉ, chữ ký, ngày); xuất CSV cho Excel;
  - `xlsx_path`: file Excel bảng tính sống: số liệu nhập ở ô màu vàng (vật liệu, chiều dày và trọng lượng riêng các lớp, hệ số vượt tải, hoạt tải, áp lực đất, kích thước cột và móng, q, thép chọn), còn lại là công thức (g, p, M, αm, ξ, As, kiểm tra, bước đai, khả năng chịu lực cột, diện tích móng): sửa số liệu là bảng tự tính lại.
- **Bảng thống kê cốt thép và bảng tổng hợp khối lượng** (`draw_quantity_schedule`):
  - thống kê thép toàn bộ hồ sơ: móng, cột, giằng móng và dầm theo thép đã tính, sàn và cầu thang theo cấu tạo; tính nối chồng và neo, khối lượng bằng công thức trong bảng, tổng theo đường kính, tự chia trang;
  - bảng tổng hợp khối lượng vật tư có diễn giải: bê tông lót, bê tông và ván khuôn móng, cổ cột, giằng móng, cột từng tầng, dầm, sàn, cầu thang; cốt thép theo nhóm; tường xây theo chiều dày (m², m³) đã trừ cửa; trát tường trong, ngoài, trát trần; xuất CSV cho Excel;
  - `xlsx_path`: toàn bộ file Excel kết cấu (bảng tính, thống kê thép có công thức khối lượng, khối lượng vật tư là công thức của phần diễn giải).
- **Khối lượng hoàn thiện kiến trúc** (`draw_finish_quantities`): lát nền theo loại gạch, ốp tường, len chân tường; bả matit, sơn tường trong, tường ngoài (các mặt tường không có phòng phía bên đó, chân tường, tường mái) và trần; trần thạch cao; chống thấm sàn vệ sinh, ban công, sân thượng; láng vữa tạo dốc và mái tum; đá granite bậc thang, lan can tay vịn cầu thang, lan can ban công; cửa đi, cửa sổ theo loại. Phòng và vật liệu lấy theo bộ nội thất. Bảng có khối lượng từng tầng, xuất CSV và file Excel mỗi tầng một cột, cột tổng là công thức.
- **Bộ kết cấu** (`draw_structure_plan`, `draw_beam_schedule`, `draw_structure_notes`):
  - `draw_structure_plan floor=foundation` vẽ mặt bằng móng: móng đơn M1 dưới cột (nét khuất), giằng móng GM dưới tường tầng 1, kích thước và cao độ đáy móng;
  - `draw_structure_plan` vẽ mặt bằng kết cấu từng sàn (tầng 2, 3 … và mái):
    - dầm theo tường chịu lực của tầng dưới (tường dưới 150 mm xây trên sàn), tên theo sàn (D2.1 …, DM.1 cho mái), có b x h và số lượng;
    - cột tại nút tường;
    - bề dày sàn, sàn vệ sinh và ban công hạ 50 (hatch), ô thang gạch chéo;
    - trục có ký hiệu và kích thước.

    Kích thước là sơ bộ (h = nhịp/12, làm tròn lên 50, trong khoảng 300-700) và được báo là giả định để kỹ sư kết cấu xác nhận.
  - `draw_beam_schedule` vẽ cho mỗi loại dầm mặt cắt GỐI và NHỊP, có cánh sàn, cao độ FL, thép và đai, tên "DẦM D2.1 (200x400) - SL: 02".
  - `draw_structure_notes` vẽ ghi chú chung dạng bảng:
    - vật liệu (B20 / B15 / B7,5, CB240-T / CB300-V);
    - lớp bê tông bảo vệ theo cấu kiện;
    - chiều dài neo và nối theo đường kính;
    - lanh tô điển hình theo nhịp;
    - các ghi chú đánh số.

    Mặc định theo TCVN 5574:2018, giá trị nào cũng thay được.
- **Chi tiết kết cấu** (`draw_structure_detail`, `rebar_schedule`): mặt cắt có thép chủ và cốt đai móc 135°, dầm nhiều nhịp (thép dưới, thép trên, thép mũ gối theo tỷ lệ nhịp, đai dày ở gối và thưa giữa nhịp, mặt cắt 1-1 và 2-2), móng đơn có lưới thép, thép chờ cột, đai và cao độ; số hiệu thép có đường dẫn, mỗi loại thanh khác nhau một số hiệu. Mỗi chi tiết trả về các dòng thống kê; `rebar_schedule` gộp thành bảng thống kê cốt thép (số thanh, tổng chiều dài, khối lượng d²/162 kg/m theo từng dòng, từng đường kính và tổng) dạng bảng trong bản vẽ và CSV. Kích thước và thép do kỹ sư kết cấu quyết định: tool vẽ, không tính toán, và cảnh báo khi thép không đủ khoảng hở.
- **Thiết kế nội thất** (dựng từ mặt bằng của `draw_plan`; mã vật liệu giống SketchUp MCP: FL sàn, SK len, WL tường, CL trần, JN đồ gỗ đóng tại chỗ, FN nội thất rời, SN thiết bị vệ sinh, EQ thiết bị, LT đèn, mỗi mã một quy cách):
  - `draw_furniture_plan`: bản sao mặt bằng tỷ lệ 1:50 với thư viện đồ nội thất (giường, tab đầu giường, tủ áo, sofa, bàn ghế, bàn làm việc, kệ tivi, tủ bếp dưới/trên có chậu rửa và bếp, máy hút mùi, tủ lạnh, máy giặt, bồn cầu, lavabo, khu tắm đứng, bồn tắm, tủ giày, kệ sách) đặt sát một vách của phòng theo khoảng cách, thẻ mã không đè nhau, tên phòng tự dời ra chỗ trống không đè đồ và cung mở cửa, ký hiệu hướng nhìn mặt đứng A-D;
  - `draw_floor_finish_plan`: ron gạch hoặc ván sàn đúng kích thước thật của từng phòng (gạch căn giữa phòng hoặc từ một điểm, ván lệch 1/3), không đè tên phòng, thẻ mã và bảng chú thích kèm diện tích từng loại sàn;
  - `draw_floor_finish_plan` thể hiện thêm các chi tiết cần cho thi công:
    - nẹp chuyển tiếp inox dưới cửa ở chỗ đổi vật liệu hoặc cao độ sàn;
    - ở khu vệ sinh và ngoài trời: phễu thu (đặt trong khu tắm nếu có), mũi tên dốc "i=1%", ghi chú sàn hạ 20 mm (vệ sinh) hoặc 50 mm (ngoài trời);
    - cách lát (LÁT TỪ TÂM);
  - `draw_wall_finish_plan`: mặt bằng hoàn thiện tường:
    - dải vật liệu chạy dọc mặt trong từng bức tường theo kiểu hoàn thiện (sơn: 1 nét; gạch ốp: 2 nét có vạch mạch gạch), ngắt ở cửa đi và cửa sổ;
    - dải gạch ốp bếp sau tủ bếp dưới;
    - mỗi phòng một thẻ mã, ghi chiều cao ốp;
    - bảng chú thích kèm diện tích từng loại vật liệu tường;
  - `draw_ceiling_plan`: trần giật cấp dọc tường có nét giật cấp và đèn LED hắt, downlight trong dải giật cấp (hoặc lưới đèn), đèn ốp trần hoặc đèn thả trên bàn ăn, thẻ trần (cao độ trên, mã dưới), bảng ký hiệu đèn kèm số lượng.
    - `mode=finish`: mặt bằng hoàn thiện trần (vật liệu, cao độ, kích thước dải giật cấp, bảng chú thích trần kèm diện tích; không có đèn);
    - `mode=lighting`: mặt bằng bố trí đèn (đèn và bảng ký hiệu; không có thẻ cao độ);
  - mỗi mặt bằng nội thất có khối GHI CHÚ chung: đơn vị, kiểm tra kích thước thực tế, duyệt mẫu vật liệu. Thêm theo từng loại mặt bằng: mạch gạch và độ dốc sàn; lớp sơn, lớp ốp tường; tấm trần và lỗ thăm trần; định vị đèn. Có thể thay bằng ghi chú của bạn;
  - `draw_interior_elevation`: triển khai từng vách của phòng nhìn từ trong: tường, sàn, trần bị cắt (cả dải giật cấp), cửa đi, cửa sổ của vách, đồ gỗ và nội thất sát vách (hình chiếu đứng) và ở góc phòng (hình chiếu cạnh) là block (mỗi loại, kích thước, hướng nhìn một block `NT_MD_...` / `NT_MB_...`) có wipeout dưới đường bao để đồ phía trước che đồ phía sau, ron gạch ốp, gạch ốp bếp, len chân tường, chuỗi kích thước và ghi chú vật liệu có đường dẫn;
  - `draw_joinery_detail`: tủ bếp (tủ dưới có cánh, ngăn kéo, khoang chậu; tủ trên theo từng đoạn, máy hút mùi, gạch ốp) hoặc tủ áo: mặt đứng 1:10 với các mô-đun, chiều mở cánh, tay nắm, mặt cắt 1-1 qua thùng tủ với chiều dày ván và ghi chú vật liệu; lấy thẳng từ tủ đã đặt trên mặt bằng;
  - `material_schedule`: sàn và trần theo m², len theo m (trừ cửa đi), tường theo m² (trừ cửa và phần ốp bếp), nội thất, đồ gỗ, thiết bị vệ sinh, thiết bị, đèn theo số lượng, mỗi mã một dòng kèm phòng; bảng trong bản vẽ và CSV.
  Vật liệu mặc định theo loại phòng (phòng khô gạch porcelain 600x600, sơn nước, trần thạch cao giật cấp; WC gạch chống trơn, gạch ốp đến trần, trần chống ẩm; sân không trần) và mỗi kết quả đều liệt kê các giá trị đã tự giả định.
- **Nhà nhiều tầng** (`draw_plan` với `floors`): mỗi tầng có tường riêng (hoặc giữ tường tầng dưới), cửa, cầu thang, ban công, phòng và mái riêng. Mặc định tầng 1 cao 3600, các tầng trên 3300, sàn dày 120. Tường mái được chép từ tường tầng dưới với chiều cao riêng. Thang chữ U ghi LÊN ở tầng 1, LÊN/XUỐNG ở tầng giữa, XUỐNG ở tầng trên cùng. Ban công có mép sàn và lan can.
  Mặt bằng các tầng đặt cạnh nhau. Mặt đứng và mặt cắt chồng đủ các tầng: cao độ từng tầng và tường mái, lan can ban công, lỗ sàn ô thang, thang cắt dọc vế. Các công cụ nội thất nhận `floor`.
- **Block, field và multileader, không chỉ là nét vẽ**:
  - cửa đi, cửa sổ, cửa lùa là block, mỗi kích thước một block (`MCP_CUA_DI_900`, `MCP_CUA_DI_2C_1400`, `MCP_CUA_SO_1200_220`), chèn xoay hoặc lật theo hướng mở, có thuộc tính mã, loại, chiều rộng;
  - đồ nội thất và thiết bị vệ sinh là block theo loại và kích thước (`NT_<mã>_<loại>_<rộng>x<sâu>`, thuộc tính mã, tên, kích thước);
  - đèn (`MCP_DEN_*`), thẻ mã, thẻ trần, ký hiệu trục, cao độ, mặt cắt, hướng bắc, ký hiệu hướng nhìn mặt đứng nội thất, số hiệu thép và khung tên cũng là block, giá trị là thuộc tính. `quantity_takeoff group_by=block` đếm được kèm giá trị, sửa bằng ATTEDIT hoặc bảng Properties.

  Block được định nghĩa ở lần dùng đầu tiên. API AutoCAD không cho tạo dynamic block, nên mỗi kích thước là một định nghĩa riêng.
  Nhãn phòng ghi diện tích bằng field liên kết với đường bao `A-AREA` của phòng: kéo đường bao rồi REGEN hoặc UPDATEFIELD.
  Ghi chú vật liệu ở mặt đứng nội thất:
  - là multileader mà nội dung là block thẻ: mã đóng khung, mô tả ngắn bên dưới;
  - xếp một hàng phía trên mặt đứng, riêng sàn và len chân tường đặt một hàng bên dưới;
  - đường dẫn nét đứt, theo đúng thứ tự đối tượng nên không đường nào cắt nhau.

  Chi tiết đồ gỗ vẫn dùng cột multileader chữ.
  Thẻ đồ nội thất và cửa hình lục giác, thẻ vật liệu hình chữ nhật. Tên mỗi hình vẽ được gạch chân, kèm "TỶ LỆ: 1/50".
  Bảng thống kê vật liệu hiện block ký hiệu của đồ và đèn cạnh mã.
- **Layer chuyên nghiệp** (`setup_layers`): bộ layer kiến trúc kiểu AIA/NCS với nét in cho máy in đen trắng và mô tả tiếng Việt hoặc tiếng Anh: `S-GRID` (CENTER), `S-COLS`, `A-WALL` (0.5 mm), `A-WALL-PATT`, `A-DOOR`, `A-GLAZ`, `A-OPEN`, `A-FLOR-STRS`, `A-FURN`, `A-FLOR-FIXT`, `A-AREA` (không in), `A-ANNO-ROOM`, `A-ANNO-TEXT`, `A-ANNO-DIMS`, `A-ANNO-SYMB`, `A-ANNO-TTLB`, `A-ANNO-NOTE`, `A-ELEV`, `A-SECT`, `A-FLOR-CASE`, `A-CLNG`, `E-LITE`, `A-DETL`, `S-CONC`, `S-REBR`, `S-REBR-STIR`, `X-IMAGE` (không in)... Nếu bản vẽ đã có hệ layer riêng thì làm theo hệ đó (`draw_plan` nhận bảng đối chiếu vai trò -> tên layer).
- **Style theo tỷ lệ in** (`setup_styles`): đơn vị mm, kiểu chữ TrueType `MCP-ARIAL` (tiếng Việt không bao giờ ra dấu `?`), kiểu kích thước `MCP-1-<tỷ lệ>` với gạch xiên kiến trúc, chữ nằm trên đường kích thước, kiểu leader, chữ trong bảng và LTSCALE.
- **Làm việc từ ảnh**: `view_image` cho Claude xem một file ảnh, có thể cắt phóng to một vùng (để đọc số kích thước) và lưới tọa độ pixel; `attach_image` chèn ảnh vào bản vẽ làm nền mờ trên layer `X-IMAGE`, hiệu chỉnh tỷ lệ bằng hai pixel của một kích thước đã biết và đặt đúng một điểm (ví dụ giao trục A-1); `draw_entities` nhận tọa độ pixel của ảnh (`image_handle`) để đồ lại; `screenshot` kết xuất bản vẽ ngầm (nền trắng, không đổi màn hình của bạn) để Claude so với ảnh gốc.
- **Từ mô hình 3D**: đọc kích thước trong mô hình (ví dụ bằng SketchUp MCP) rồi vẽ lại bằng `draw_plan`, hoặc `import_drawing` một file DWG/DXF 2D xuất ra (mặt bằng, mặt cắt, mặt đứng) với tiền tố layer, rồi làm sạch và ghi chú.
- **Mọi loại đối tượng** (`draw_entities`): line, polyline có cung, hình chữ nhật, tròn, cung, ellipse, spline, điểm, text và mtext, hatch (có đảo), kích thước thẳng/xiên/góc/bán kính/đường kính, chuỗi kích thước kèm kích thước tổng, multileader, block có thuộc tính (cả từ file DWG), bảng. Một lô là một bước Undo; nếu một đối tượng sai thì không vẽ gì và lỗi chỉ rõ đối tượng nào.
- **Sửa** theo handle: di chuyển, sao chép (lặp), xoay, tỷ lệ, đối xứng, mảng chữ nhật/tròn, offset (về phía một điểm hoặc hai bên), phá khối (giữ giá trị thuộc tính); đổi thuộc tính, nội dung chữ, giá trị attribute.
- **Khối lượng** (`quantity_takeoff`): theo layer, block hoặc loại: số lượng, chiều dài (m), diện tích đường bao kín (m²), diện tích hatch (m²), số block kèm thống kê giá trị thuộc tính; xuất CSV cho Excel (`csv_format=semicolon` cho Excel cài định dạng Việt Nam/châu Âu: dấu `;` và phẩy thập phân).
- **Kiểm tra bản vẽ** (`check_drawing`): đối tượng trùng chồng (làm khối lượng gấp đôi), polyline trông kín nhưng chưa kín, đường bao hở trên layer diện tích, chữ tiếng Việt dùng font SHX (ra dấu `?`), thiếu font, xref/ảnh mất đường dẫn, đối tượng trên Defpoints, kích thước bị gõ đè số, đối tượng nằm quá xa, đối tượng trên layer 0, màu/nét/độ dày không ByLayer, layer không theo chuẩn đặt tên.
- **Field**:
  - diện tích phòng là field của đường bao phòng;
  - trong bảng thống kê vật liệu, khối lượng sàn và trần là field công thức, cộng diện tích các đường bao phòng;
  - các cột tổng của bảng thống kê thép (số thanh, chiều dài, trọng lượng từng dòng, theo đường kính, tổng cộng) là công thức của bảng: sửa số thanh hay chiều dài ngay trong bảng thì trọng lượng tự tính lại;
  - tỷ lệ trên khung tên là field của tỷ lệ viewport, ký hiệu bản vẽ là field của tên layout.

  Số thập phân dùng dấu phẩy.
- **Khung tên** (`create_layout`, `export_pdf`): layout khổ A0-A4 với `DWG To PDF.pc3` và `monochrome.ctb`, khung bản vẽ theo lề ISO/TCVN (lề trái 20 mm).
  - Khổ A3-A0 nằm ngang dùng khung tên dải dọc như hồ sơ thi công ở Việt Nam, gồm: bảng sửa đổi, ghi chú, chủ đầu tư, dự án, hạng mục, tư vấn thiết kế, chủ nhiệm, chủ trì, thiết kế, kiểm tra, tên bản vẽ, số hợp đồng, phiên bản, giai đoạn, ký hiệu bản vẽ, tỷ lệ, ngày. Dọc chân tờ có dòng ghi chú chung.
  - `views` đặt nhiều khung nhìn trên một tờ, mỗi khung một vùng model với tỷ lệ riêng (mặt bằng 1/100 kèm chi tiết 1/25, ba mặt bằng tầng cạnh nhau): xếp theo hàng, thẳng chân, canh giữa vùng vẽ; ô tỷ lệ của khung tên ghi "NHƯ HÌNH" khi các tỷ lệ khác nhau.
  - `title_block.style=bottom` cho khung tên 180 mm ở góc dưới, dùng cho khổ A4 và khổ đứng.
  - Cả hai đều là block có thuộc tính.
  - Khung nhìn khóa ở tỷ lệ chuẩn tự chọn cho vừa, đặt phía trên hoặc bên trái khung tên, chỗ nào chứa vừa hình vẽ (cảnh báo nếu tỷ lệ đã chọn làm cắt mất hình). `export_pdf` in các layout ra một file PDF nhiều trang (layout khác khổ giấy thì mỗi khổ một file, ví dụ `bo_A3.pdf`, `bo_A1.pdf`), hoặc in một vùng model space theo tỷ lệ.
- **Xuất file** (`save_drawing`, `screenshot save_path`): DWG 2018/2013/2010/2007/2004/2000 và DXF; `copy=true` (mặc định khi lưu bản cũ hoặc DXF) ghi một bản sao để gửi đi, bản vẽ đang mở giữ nguyên, ngược lại là Save As; ảnh PNG của bản vẽ tới 4096 px.
- **`run_lisp`**: khi không có tool phù hợp, Claude chạy AutoLISP (kết quả trả về dạng JSON) trong một nhóm Undo. Code không ghi ra đĩa nên AutoCAD không hỏi bảo mật (SECURELOAD).
- **Mỗi lần sửa bản vẽ là một bước Undo** (`MCP_<TÊN TOOL>` trong danh sách Undo của AutoCAD).
- **Lệnh trong AutoCAD**: `MCPSTATUS`, `MCPSTART`, `MCPSTOP`, `MCPPORT`, `MCPLOG`.

## Cách hoạt động

```
Claude Desktop
    |  MCP qua stdio
    v
autocad-mcp-1.2.0.mcpb        server MCP Node.js, chạy trên Node có sẵn trong Claude Desktop
    |  mỗi lệnh một yêu cầu JSON, TCP 127.0.0.1:9877 (chỉ trong máy)
    v
ACAD MCP Bridge               add-in .NET trong AutoCAD (bundle tự nạp), chạy lệnh trên luồng chính của AutoCAD
    |  AutoCAD .NET API
    v
bản vẽ đang mở
```

Bridge chạy bên trong AutoCAD (không điều khiển qua COM từ bên ngoài): mỗi lệnh chạy trên luồng chính trong một lần khóa tài liệu, nhanh với bản vẽ lớn, an toàn, và mỗi lệnh là một bước Undo.

## Yêu cầu

- **Claude Desktop** (bản mới, có *Settings > Extensions*).
- **AutoCAD 2021, 2022, 2023 hoặc 2024** bản đầy đủ (hoặc bản chuyên ngành như AutoCAD Architecture; **không dùng được AutoCAD LT** vì LT không nạp add-in .NET) trên **Windows 10/11**. Đã thử trên AutoCAD 2024. AutoCAD 2025 trở đi chạy .NET 8, cần bridge build riêng (chưa có).
- Chỉ khi tự build: Node.js 18+, trình biên dịch C# của Visual Studio Build Tools và AutoCAD 2021-2024.

## Cài đặt

1. **Cài extension vào Claude Desktop**: tải `autocad-mcp-1.2.0.mcpb` và `AcadMcpBridge-1.2.0.bundle.zip` ở [bản phát hành mới nhất](https://github.com/2ez4gcx/autocad-mcp/releases/latest), rồi vào *Settings > Extensions*, kéo thả file `.mcpb` vào cửa sổ (hoặc *Advanced settings > Install Extension...*), bấm *Install*. Bản build chưa ký số nên Claude Desktop có thể cảnh báo.
2. **Cài bridge vào AutoCAD**: trong một cuộc trò chuyện mới, nhờ Claude *"Cài ACAD MCP Bridge vào AutoCAD"* (tool `install_autocad_bridge`). Tool chép `AcadMcpBridge.bundle` vào `%APPDATA%\Autodesk\ApplicationPlugins`, AutoCAD tự nạp khi khởi động. Cài tay: giải nén `AcadMcpBridge-1.2.0.bundle.zip` vào thư mục đó.
3. **Khởi động lại AutoCAD.** Add-in chưa được ký số: khi AutoCAD hỏi về `AcadMcpBridge-1.2.0.dll`, chọn **Always Load**. Mỗi bản bridge mới là một file mới nên sau khi cập nhật AutoCAD sẽ hỏi lại một lần. (Muốn không bao giờ bị hỏi, có thể thêm thư mục bundle vào *Options > Files > Trusted Locations* nếu chính sách IT cho phép.) Gõ `MCPSTATUS` trong AutoCAD, phải thấy `ACAD MCP Bridge v1.2.0: RUNNING on 127.0.0.1:9877`. Sau đó nhờ Claude *"Ping AutoCAD"*.

Tùy chọn ở *Settings > Extensions > AutoCAD MCP > Configure*: cổng bridge (mặc định 9877; nếu đổi thì gõ `MCPPORT` trong AutoCAD cho khớp) và thời gian chờ mỗi lệnh (mặc định 120 giây).

Cập nhật: cài `.mcpb` mới, nhờ Claude cài lại bridge, khởi động lại AutoCAD.

## Một phiên làm việc điển hình: vẽ mặt bằng từ ảnh

> Đây là ảnh scan mặt bằng tầng 1 (D:/DuAn/scan.jpg). Vẽ lại trong AutoCAD tỷ lệ 1:100 với layer chuẩn, đầy đủ kích thước và diện tích phòng, rồi dàn trang A3 và xuất PDF.

Claude sẽ: xem ảnh (`view_image`, phóng to vùng có số kích thước), tạo layer và style, chèn ảnh làm nền đã hiệu chỉnh tỷ lệ, vẽ mặt bằng bằng `draw_plan`, thêm nội thất, thiết bị vệ sinh, ghi chú bằng `draw_entities`, so sánh bằng `screenshot`, sửa chỗ khác biệt, chạy `check_drawing`, tạo layout và PDF.

Ba bộ hồ sơ nhà phố 5x18 m, 3 tầng + tum, mỗi bộ một bản vẽ riêng như văn phòng thiết kế phát hành:
- kiến trúc [`examples/Nha-pho-5x18-KT.pdf`](examples/Nha-pho-5x18-KT.pdf): danh mục, mặt bằng, mặt đứng, mặt cắt;
- kết cấu [`examples/Nha-pho-5x18-KC.pdf`](examples/Nha-pho-5x18-KC.pdf): danh mục, ghi chú chung, mặt bằng kết cấu sàn tầng 2, tầng 3, tum, mái, bảng mặt cắt dầm;
- nội thất [`examples/Nha-pho-5x18-NT.pdf`](examples/Nha-pho-5x18-NT.pdf): danh mục, bố trí nội thất, hoàn thiện sàn, tường, trần, bố trí đèn, mặt đứng nội thất, bảng vật liệu.

File DWG nằm cùng thư mục.

Một bộ hồ sơ hoàn chỉnh từ một ảnh (không kèm ảnh gốc): [`examples/Nha-6x15-ho-so.pdf`](examples/Nha-6x15-ho-so.pdf) (6 tờ A3: mặt bằng, bốn mặt đứng, mặt cắt A-A và B-B tỷ lệ 1:100, dầm, cột, móng và bảng thống kê thép tỷ lệ 1:25), bộ nội thất [`examples/Nha-6x15-noi-that.pdf`](examples/Nha-6x15-noi-that.pdf) (10 tờ: mặt bằng bố trí nội thất, lát sàn, trần đèn 1:50, triển khai mặt đứng phòng ngủ, bếp, WC 1:30, chi tiết tủ bếp và tủ áo 1:10, bảng vật liệu hoàn thiện; CSV [`examples/Nha-6x15-vat-lieu.csv`](examples/Nha-6x15-vat-lieu.csv)), tất cả trong bản vẽ [`examples/Nha-6x15-ho-so.dwg`](examples/Nha-6x15-ho-so.dwg).

Thêm câu lệnh mẫu: [`mcpb/release-docs/SAMPLE_PROMPTS.md`](mcpb/release-docs/SAMPLE_PROMPTS.md).

## Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| `Cannot connect to AutoCAD` | Gõ `MCPSTATUS` trong AutoCAD. Báo lệnh không tồn tại: cài bridge rồi khởi động lại AutoCAD (và cho phép DLL). STOPPED: gõ `MCPSTART`. Cổng 9877 bị chương trình khác dùng: `MCPPORT`. |
| AutoCAD hỏi về `AcadMcpBridge-...dll` nhưng bridge không chạy | Đã chọn *Do Not Load*: AutoCAD nhớ lựa chọn đó trong cả phiên. Khởi động lại AutoCAD và chọn *Always Load*. |
| Mỗi lần xuất PDF mất khoảng 30 giây | Bản thân AutoCAD in chậm khi máy in mặc định của Windows là máy in mạng không phản hồi (lệnh PLOT gốc cũng chậm như vậy). Chọn máy in mặc định là máy cục bộ (ví dụ *Microsoft Print to PDF*) hoặc ẩn máy in hệ thống trong AutoCAD (*Options > Plot and Publish*). |
| `install_autocad_bridge` báo lỗi | Có AutoCAD khác đang giữ file: đóng hết AutoCAD rồi chạy lại. |

## Bảo mật

Bridge chỉ nghe trên 127.0.0.1, không có xác thực (giống các bridge MCP cục bộ khác): mọi chương trình chạy dưới tài khoản Windows của bạn đều gửi lệnh được, kể cả `run_lisp`. Gõ `MCPSTOP` trong AutoCAD để tắt khi không dùng.

## Tự build

```bat
cd mcpb
npm ci
npm run build    :: biên dịch bridge, đóng gói server, tạo dist/autocad-mcp-<version>.mcpb
npm test         :: test bộ máy vẽ mặt bằng + smoke test server
```

## Giấy phép

MIT, xem [LICENSE](LICENSE).
