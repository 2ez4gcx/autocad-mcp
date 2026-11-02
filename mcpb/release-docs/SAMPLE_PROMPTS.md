# AutoCAD MCP - sample prompts / câu lệnh mẫu

## Setup / Cài đặt

- Install the ACAD MCP Bridge in AutoCAD. / Cài ACAD MCP Bridge vào AutoCAD.
- Ping AutoCAD and tell me which drawing is open. / Ping AutoCAD, đang mở bản vẽ nào?

## From an image / Từ hình ảnh

- Here is a scan of a ground floor plan: D:/Project/scan.jpg. Read all printed dimensions, then draw it at 1:100 with standard layers, door and window tags, room names with measured areas and full exterior dimensions. Compare with the scan and fix any difference.
- Đây là ảnh mặt bằng D:/DuAn/scan.jpg. Đọc hết các số kích thước rồi vẽ lại tỷ lệ 1:100, layer chuẩn, ký hiệu cửa, tên phòng kèm diện tích đo từ tường, đủ 3 lớp kích thước ngoài. So với ảnh và sửa chỗ sai.
- Vẽ ngôi nhà trong ảnh này: kích thước 6x15 m, tường bao 200, tường ngăn 100. Vẽ mặt bằng tầng 1 có nội thất và mặt đứng chính theo ảnh.
- Attach D:/Project/sketch.png as a faded underlay so that the corner of grid A-1 is at 0,0 and the 6000 dimension of the sketch is 6000 mm, then trace the furniture outlines over it.
- Chèn ảnh D:/DuAn/phac.jpg làm nền mờ, hiệu chỉnh theo kích thước 4200 trên ảnh, rồi đồ lại các đường bao nội thất.

## From a 3D model / Từ mô hình 3D

- Read the room sizes and openings of the SketchUp model (SketchUp MCP), then draw the floor plan in AutoCAD with draw_plan at 1:50.
- Import D:/Export/elevation_front.dwg (a 2D export of SketchUp) with the layer prefix X-SU-, clean it up onto A-ELEV layers and add levels and dimensions.

## Drafting / Triển khai

- Set up layers and styles for 1:50 in Vietnamese. / Tạo layer và style cho tỷ lệ 1:50, mô tả tiếng Việt.
- Add a door schedule table next to the plan with all door tags, sizes and counts. / Thêm bảng thống kê cửa cạnh mặt bằng.
- Define a block "BED-1600" with attributes CODE and SIZE, then place it in both bedrooms. / Tạo block giường có thuộc tính rồi đặt vào 2 phòng ngủ.
- Make an A3 sheet "KT-01" with the title block (project NHÀ Ở GIA ĐÌNH, drawing MẶT BẰNG TẦNG 1) and export a PDF to D:/Out/KT-01.pdf.

## Quantities and checks / Khối lượng và kiểm tra

- Take off the quantities by layer and save a CSV for Excel. / Bóc khối lượng theo layer, xuất CSV.
- Count the blocks with their attribute values. / Đếm block kèm giá trị thuộc tính.
- Check the drawing and fix the duplicates and the polylines that should be closed. / Kiểm tra bản vẽ, xóa đối tượng trùng và đóng các polyline hở.
- Find walls drawn as one thick line and redraw them with two faces. / Tìm tường vẽ 1 nét dày và vẽ lại đúng 2 nét.
