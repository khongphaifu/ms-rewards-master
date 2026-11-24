/**
 * Danh sách từ khóa tìm kiếm tự nhiên phong phú (Việt - Anh)
 * Giúp mô phỏng tìm kiếm Bing như người dùng thật, tránh bị Microsoft gắn cờ bot
 */

export const WORD_LIST = [
  // Khoa học & Công nghệ
  "trí tuệ nhân tạo là gì",
  "xu hướng công nghệ 2026",
  "cách lập trình python cơ bản",
  "ngôn ngữ rust có gì đặc biệt",
  "nguyên lý hoạt động của máy tính lượng tử",
  "khám phá kính thiên văn james webb",
  "năng lượng tái tạo và điện gió",
  "công nghệ pin thể rắn tương lai",
  "an ninh mạng và bảo mật dữ liệu cá nhân",
  "cách tối ưu hóa windows 11 mượt mà",
  "tìm hiểu về điện toán đám mây azure",
  "sự khác biệt giữa ram và rom",
  "công nghệ màn hình oled và microled",
  "xe điện tự hành cấp độ 4",
  "ứng dụng blockchain trong đời sống",
  "cách viết prompt hiệu quả cho ai",
  "lịch sử ra đời của internet",
  "robot hình người tân tiến nhất",
  "thuật toán tìm kiếm hoạt động thế nào",
  "cách sao lưu dữ liệu an toàn",

  // Thiên nhiên & Vũ trụ
  "hố đen vũ trụ lớn nhất từng được phát hiện",
  "nguồn gốc của các vì sao",
  "hành tinh nào gần mặt trời nhất",
  "bí ẩn đáy biển sâu mariana",
  "loài động vật thông minh nhất thế giới",
  "hiện tượng cực quang bắc cực xảy ra khi nào",
  "núi lửa lớn nhất trên trái đất",
  "rừng mưa nhiệt đới amazon",
  "chu kỳ sống của bướm đêm",
  "hóa thạch khủng long cổ xưa nhất",
  "tại sao bầu trời có màu xanh",
  "nguyên nhân tạo ra thủy triều",
  "các loài chim di cư xa nhất",
  "sự phân bố của rạn san hô",
  "khí hậu tại sa mạc sahara",

  // Du lịch & Địa lý
  "thắng cảnh đẹp nhất việt nam",
  "kinh nghiệm du lịch sapa mùa thu",
  "ẩm thực đường phố hà nội",
  "vẻ đẹp vịnh hạ long di sản thế giới",
  "những bãi biển đẹp nhất đà nẵng",
  "địa điểm tham quan ở tokyo nhật bản",
  "tháp eiffel paris pháp",
  "văn hóa ẩm thực ý và pizza",
  "núi fuji cao bao nhiêu mét",
  "kỳ quan thế giới đấu trường colosseum",
  "thành phố cổ venice nước ý",
  "cách xin visa du lịch châu âu",
  "các hòn đảo đẹp nhất đông nam á",
  "vườn quốc gia phong nha kẻ bàng",
  "lễ hội hoa anh đào diễn ra vào tháng mấy",

  // Sức khỏe & Đời sống
  "lợi ích của việc uống đủ 2 lít nước mỗi ngày",
  "chế độ ăn eat clean cho người mới bắt đầu",
  "bài tập yoga giãn cơ trước khi ngủ",
  "cách cải thiện chất lượng giấc ngủ sâu",
  "thực phẩm giàu vitamin c tăng đề kháng",
  "lợi ích của việc chạy bộ buổi sáng",
  "cách quản lý thời gian hiệu quả pomodoro",
  "mẹo sắp xếp bàn làm việc gọn gàng",
  "cách pha cà phê cold brew ngon tại nhà",
  "tại sao nên đọc sách mỗi ngày",
  "kỹ năng giao tiếp trong môi trường công sở",
  "cách giải tỏa căng thẳng sau giờ làm",
  "các loại trà thảo mộc tốt cho sức khỏe",
  "tập thể dục tại nhà không cần dụng cụ",
  "cách duy trì thói quen tích cực lâu dài",

  // Lịch sử & Văn hóa
  "lịch sử các triều đại việt nam",
  "nguồn gốc của tết nguyên đán cổ truyền",
  "bí ẩn kim tự tháp ai cập cổ đại",
  "nền văn minh lúa nước sông hồng",
  "nghệ thuật tranh đông hồ truyền thống",
  "lễ hội đền hùng mùng mười tháng ba",
  "sự phát triển của thời kỳ phục hưng",
  "các vĩ nhân thay đổi thế giới",
  "kiến trúc chùa một cột thăng long",
  "nguồn gốc ngày quốc tế phụ nữ",

  // English queries (đa dạng hóa nguồn tìm kiếm)
  "best productivity apps for windows",
  "how does artificial intelligence work",
  "healthy breakfast recipes easy",
  "top travel destinations 2026",
  "difference between edge and chrome",
  "space exploration milestones",
  "history of computer science",
  "simple meditation techniques for beginners",
  "how to grow indoor plants",
  "world geography quiz facts",
  "famous modern architecture buildings",
  "quantum physics explained simply",
  "best books to read this year",
  "weather forecast tips and tricks",
  "renewable green energy solutions"
];

let usedIndices = new Set();

export const getRandomWord = () => {
  if (usedIndices.size >= WORD_LIST.length) {
    usedIndices.clear(); // Reset khi đã dùng hết danh sách
  }
  let index;
  do {
    index = Math.floor(Math.random() * WORD_LIST.length);
  } while (usedIndices.has(index));
  usedIndices.add(index);
  return WORD_LIST[index];
};

export const getRandomWords = (count) => {
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push(getRandomWord());
  }
  return result;
};
