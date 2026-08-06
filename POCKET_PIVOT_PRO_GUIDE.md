# POCKET PIVOT PRO — Hướng dẫn vận hành

> **Thị trường:** HOSE (Cổ phiếu Việt Nam)
> **Khung thời gian:** Daily
> **Vốn tối thiểu khuyến nghị:** 500 triệu VND
> **Cập nhật:** 2026-05-27

---

## MỤC LỤC

1. [Triết lý chiến lược](#1-triết-lý-chiến-lược)
2. [Danh sách 17 mã giao dịch](#2-danh-sách-17-mã-giao-dịch)
3. [Điều kiện vào lệnh](#3-điều-kiện-vào-lệnh)
4. [Điều kiện thoát lệnh](#4-điều-kiện-thoát-lệnh)
5. [Quản lý vốn](#5-quản-lý-vốn)
6. [Quy trình vận hành hàng ngày](#6-quy-trình-vận-hành-hàng-ngày)
7. [Kết quả backtest](#7-kết-quả-backtest)
8. [Quản lý rủi ro](#8-quản-lý-rủi-ro)
9. [Câu hỏi thường gặp](#9-câu-hỏi-thường-gặp)
10. [Files công cụ](#10-files-công-cụ)

---

## 1. Triết lý chiến lược

**Pocket Pivot** là tín hiệu xuất hiện khi một cổ phiếu bứt phá tăng với khối lượng lớn bất thường — lớn hơn bất kỳ ngày giảm nào trong 10 phiên trước. Đây là dấu hiệu tổ chức/smart money đang gom hàng.

**Điểm khác biệt của phiên bản PRO:**
- Lọc thêm xu hướng MA20 và MA100 (chỉ mua khi xu hướng rõ ràng)
- Lọc FOMO (không mua khi giá đã bứt phá quá xa MA20)
- Tách hai nhóm thoát lệnh theo đặc tính từng mã
- Quản lý vốn slot-based (tối đa N lệnh đồng thời)

**Không phải chiến lược scalping.** Mỗi tín hiệu nắm giữ trung bình 13–30 phiên. Ra khoảng 25–30 tín hiệu/năm trên toàn bộ 17 mã.

---

## 2. Danh sách 17 mã giao dịch

### Group A — Momentum Runners (thoát: Hold 30 phiên)

| Mã | Ngành | PF lịch sử |
|----|-------|-----------|
| VND | Chứng khoán | 9.82 |
| PDR | Bất động sản | 17.67 |
| FTS | Chứng khoán | 4.92 |
| VIX | Chứng khoán | 4.98 |
| CTG | Ngân hàng | ~3.5 |
| SSI | Chứng khoán | ~3.2 |
| STB | Ngân hàng | ~3.0 |
| KDH | Bất động sản | ~2.8 |
| ACB | Ngân hàng | ~2.7 |
| BID | Ngân hàng | ~2.6 |

> Đặc điểm: Sau tín hiệu thường chạy dài, không pullback sâu. Giữ đủ 30 phiên mang lại kết quả tốt hơn thoát sớm.

### Group B — MA20 Trailing (thoát: Close < MA20)

| Mã | Ngành | PF lịch sử |
|----|-------|-----------|
| CII | Bất động sản | 11.10 |
| VCI | Chứng khoán | 4.55 |
| SHB | Ngân hàng | 3.10 |
| LPB | Ngân hàng | ~2.8 |
| MBB | Ngân hàng | ~2.6 |
| HDB | Ngân hàng | ~2.5 |
| DXG | Bất động sản | ~2.3 |

> Đặc điểm: Hay pullback về MA20 sau tín hiệu. Giữ cứng 30 phiên sẽ thua — cần trailing stop.

---

## 3. Điều kiện vào lệnh

Cần đủ **TẤT CẢ 8 điều kiện** trong cùng một phiên:

```
┌─────┬─────────────────────────────────────────────────┬──────────────────┐
│  #  │ Điều kiện                                       │ Tham số          │
├─────┼─────────────────────────────────────────────────┼──────────────────┤
│ C1  │ Nến tăng: Close > Open                          │ —                │
│ C2  │ Volume > Max(DownVol 10 phiên) × 1.5            │ VOL_MULT = 1.5   │
│ C3  │ Close > MA20 VÀ MA20 > MA100                    │ MA20, MA100      │
│ C4  │ MA20 tăng ≥ 0.5% so với 5 phiên trước          │ SLOPE = 0.5%     │
│ C5  │ Trong 3 phiên trước có ít nhất 1 nến đỏ        │ PREV_RED = 3     │
│ C6  │ Độ rộng nến ≤ ATR(21) × 3.5                    │ ATR = 21         │
│ C7  │ Open ≤ MA20 × 1.10 (không mua khi đã bứt xa)   │ FOMO = 10%       │
│ C8  │ MA100 > MA100 phiên trước (trend dài hạn tăng)  │ —                │
└─────┴─────────────────────────────────────────────────┴──────────────────┘
```

**Lưu ý quan trọng:**
- Nếu thiếu **bất kỳ** điều kiện nào → BỎ QUA tín hiệu
- C7 là bộ lọc FOMO: nếu giá mở cửa đã cao hơn MA20 quá 10% → không mua đuổi
- C8 đảm bảo xu hướng dài hạn còn tích cực

---

## 4. Điều kiện thoát lệnh

### Group A — Hold 30 phiên

```
Vào ngày N → Thoát cuối phiên ngày N+30
Không có stop loss cứng.
Không thoát sớm dù giá kéo về.
```

### Group B — MA20 Trailing Stop

```
Mỗi phiên sau khi vào lệnh: kiểm tra Close so với MA20
  Nếu Close < MA20 → Thoát lệnh ngay phiên đó
  Nếu Close ≥ MA20 → Giữ tiếp
  Nếu sau 30 phiên chưa chạm MA20 → Thoát theo thời gian
```

### Breakeven Stop (tùy chọn, khuyến nghị cho vốn lớn)

```
Nếu giá tăng đến Entry × 1.10 (+10%):
  → Kích hoạt Breakeven
  → Nếu giá kéo về Entry × 1.01 (+1%) → Thoát hòa vốn
```

> Breakeven stop làm giảm nhẹ PF nhưng loại bỏ các lệnh thua lớn (-20% đến -30%). Phù hợp khi đang trong giai đoạn drawdown.

---

## 5. Quản lý vốn

### Quy tắc cốt lõi

```
Position% × Max_Slots ≤ 100%
(Không bao giờ để toàn bộ vốn đồng thời vào risk)
```

### Bảng Profile

```
┌─────────────────────┬──────┬───────┬─────────┬──────────────┬───────────┐
│ Profile             │ Pos% │ Slots │ Max Exp │ Return 10Y   │ DD tệ nhất│
├─────────────────────┼──────┼───────┼─────────┼──────────────┼───────────┤
│ Thận trọng          │  20% │   3   │   60%   │   +332%      │   -14%    │
│ Cân bằng ✓ tốt nhất│  25% │   4   │  100%   │   +541%      │   -18%    │
│ Tích cực            │  33% │   3   │  100%   │   +684%      │   -21%    │
│ Không khuyến nghị  │  50% │   2   │  100%   │  +1233%      │   -28%    │
└─────────────────────┴──────┴───────┴─────────┴──────────────┴───────────┘
```

### Khuyến nghị: Profile Cân bằng (25% × 4 slots)

- Mỗi lệnh: phân bổ **25% vốn hiện tại** (không phải vốn ban đầu)
- Tối đa **4 lệnh đồng thời**
- Nếu đang có 4 lệnh mở → bỏ qua tín hiệu mới, chờ lệnh cũ đóng
- Ưu tiên Group A trước Group B nếu cùng phiên có nhiều tín hiệu

### Ví dụ thực tế (vốn 500 triệu)

```
Vốn hiện tại: 500,000,000 VND
Lệnh 1: 25% × 500M = 125M → Còn 375M
Lệnh 2: 25% × 375M = 93.75M → Còn 281M
Lệnh 3: 25% × 281M = 70.3M → Còn 211M
Lệnh 4: 25% × 211M = 52.7M → Còn 158M (buffer)
```

---

## 6. Quy trình vận hành hàng ngày

### Sau 15:15 — Kết thúc phiên giao dịch

```
BƯỚC 1: Kiểm tra lệnh đang mở
─────────────────────────────
□ Group A: Đếm số phiên đã nắm giữ
  → Đủ 30 phiên? → Đặt lệnh bán ngày mai
□ Group B: So sánh Close hôm nay với MA20
  → Close < MA20? → Đặt lệnh bán ngày mai

BƯỚC 2: Scan tín hiệu mới
─────────────────────────────
□ Chạy script scan (hoặc kiểm tra trên TradingView)
□ Lọc mã nào thỏa đủ 8 điều kiện C1-C8
□ Kiểm tra: đang có < 4 lệnh mở?
  → Có → Lên kế hoạch vào lệnh ngày mai
  → Không → Bỏ qua, ghi chú theo dõi

BƯỚC 3: Chuẩn bị lệnh cho ngày mai
─────────────────────────────────────
□ Tính position size: 25% × vốn hiện tại
□ Giá vào: Mở cửa hoặc limit tại Close hôm nay ±1%
□ Ghi nhật ký: mã, ngày vào, giá vào, nhóm (A/B), ngày thoát dự kiến
```

### Trong phiên (nếu có thời gian)

```
□ Không cần theo dõi liên tục
□ Chỉ check nếu có tin tức lớn bất thường về mã đang nắm
□ KHÔNG thoát sớm vì cảm xúc khi thấy lời/lỗ
```

---

## 7. Kết quả backtest

> Backtest 10 năm (2015–2025), 17 tickers, commission 0.3% round-trip

### Tổng quan (Portfolio 25% × 4 slots)

| Metric | Giá trị |
|--------|---------|
| Tổng lệnh thực hiện | 235 |
| Tín hiệu bỏ lỡ (hết slot) | 283 |
| Win Rate | 55% |
| Profit Factor | 2.84 |
| Avg gain/lệnh | +5.22% |
| **Total Return 10 năm** | **+541%** |
| **Max DD portfolio** | **-18%** |
| Losing streak tệ nhất | 10 lệnh |

### Phân tích DD thực vs DD aggregate

```
DD aggregate (báo cáo) = -47%  ← đây là tính trên vốn đặt cọc mỗi lệnh
DD portfolio (thực tế) = -18%  ← đây mới là DD thực trên toàn bộ vốn

Vì mỗi lệnh chỉ dùng 25% vốn, DD thực = DD aggregate × position%
```

---

## 8. Quản lý rủi ro

### Các rủi ro chính và cách xử lý

| Rủi ro | Mức độ | Cách xử lý |
|--------|--------|-----------|
| Losing streak 10 lệnh | Thấp (~2-3 năm/lần) | Giữ nguyên hệ thống, không thay đổi tham số |
| DD portfolio -18% | Chấp nhận được | Đây là bình thường, không thoát toàn bộ |
| Tin xấu đột ngột | Trung bình | Chấp nhận lỗ theo đúng quy tắc thoát |
| Hết thanh khoản | Thấp | 17 mã được chọn đều có thanh khoản tốt |

### Điều KHÔNG làm

```
✗ KHÔNG đặt hard stop loss cứng (giảm PF nhiều hơn giảm DD)
✗ KHÔNG mở lệnh thứ 5 khi đang có 4 lệnh
✗ KHÔNG thoát sớm Group A vì giá kéo về (đây là bình thường)
✗ KHÔNG mua thêm khi đang lỗ (averaging down)
✗ KHÔNG thay đổi tham số sau khi thua vài lệnh
✗ KHÔNG áp dụng cho mã ngoài danh sách 17 (chưa được validate)
```

### Dấu hiệu hệ thống còn hoạt động tốt

```
✓ Win Rate trong 20 lệnh gần nhất > 45%
✓ Profit Factor rolling 50 lệnh > 1.5
✓ Không có lệnh nào lỗ > 25%
```

---

## 9. Câu hỏi thường gặp

**Q: Tại sao không dùng stop loss?**
> Backtest cho thấy hard stop loss luôn làm giảm PF nhiều hơn mức giảm DD. Mẫu tín hiệu của chiến lược này có WR=55% và avg gain > avg loss — không cần cắt lỗ cứng. Stop loss chỉ làm tăng số lệnh thua nhỏ mà không bảo vệ khỏi lệnh thua lớn (vì tín hiệu xuất hiện tại giai đoạn giá đã breakout).

**Q: Losing streak 10 lệnh có bình thường không?**
> Với WR=55%, xác suất thua 10 lệnh liên tiếp là ~0.1% — rất hiếm nhưng có xảy ra trong 10 năm. Ở 25%/lệnh và compound, 10 lệnh thua liên tiếp mất ~-6.7% tổng vốn (không phải -18% DD vì DD tính đỉnh xuống đáy, không phải 10 lệnh liên tiếp thua).

**Q: Có thể thêm mã mới vào danh sách không?**
> Được, nhưng cần chạy backtest ít nhất 5 năm trước khi add. Chỉ giữ mã có PF > 2.0 và ít nhất 20 tín hiệu trong lịch sử.

**Q: Khi nào nên dừng chiến lược?**
> Xem xét dừng nếu: PF rolling 50 lệnh < 1.2 kéo dài 3 tháng, hoặc thay đổi lớn trong cấu trúc thị trường (VN-Index thay đổi biên độ, thuế mới, v.v.).

**Q: 20-30%/mã có quá rủi ro không?**
> Không, nếu giới hạn tối đa 4 lệnh đồng thời. DD thực tế -18% trong 10 năm là mức chấp nhận được với return +541%.

---

## 10. Files công cụ

Tất cả files tại: `C:\Users\ADMIN\tradingview-mcp\`

| File | Mục đích | Cách dùng |
|------|----------|-----------|
| `pocket_pivot_strategy.pine` | Chiến lược Pine Script v6 cho TradingView | Load vào Pine Editor, Apply to chart |
| `backtest_pocketpivot2.py` | Backtest cơ bản — kết quả per-ticker | `python backtest_pocketpivot2.py` |
| `backtest_optimize.py` | Grid search tham số — 1440 combo | `python backtest_optimize.py` |
| `backtest_breakeven.py` | Test Breakeven Stop | `python backtest_breakeven.py` |
| `backtest_dd_analysis.py` | Phân tích DD thực vs aggregate | `python backtest_dd_analysis.py` |
| `backtest_sma_trail.py` | So sánh Hold vs SMA20 Trail | `python backtest_sma_trail.py` |
| `backtest_portfolio.py` | Simulation portfolio vốn chung | `python backtest_portfolio.py` |

### Cài đặt môi trường

```bash
pip install requests pandas numpy
# Yahoo Finance API — không cần API key
# Data: https://query1.finance.yahoo.com/v8/finance/chart/{TICKER}.VN
```

---

## THAM SỐ TỐI ƯU (tham chiếu nhanh)

```python
# Signal parameters
VOL_LENGTH   = 10       # Lookback volume
VOL_MULT     = 1.5      # Volume multiplier
MA_FAST      = 20       # MA nhanh
MA_SLOW      = 100      # MA chậm
ATR_PERIOD   = 21       # ATR period
ATR_MULT     = 3.5      # ATR distance filter
OPEN_FOMO    = 10.0     # FOMO filter (%)
SLOPE_PCT    = 0.5      # MA20 slope filter (%)
PREV_RED     = 3        # Lookback nến đỏ

# Exit parameters
GROUP_A_HOLD = 30       # Hold bars
GROUP_B_MAX  = 30       # Max hold (trail fallback)

# Portfolio parameters
POSITION_PCT = 0.25     # 25% vốn/lệnh
MAX_SLOTS    = 4        # Tối đa 4 lệnh đồng thời
COMMISSION   = 0.003    # 0.3% round-trip
```

---

*Chiến lược này được phát triển và tối ưu hoá qua backtest 10 năm (2015–2025) trên 35 mã HOSE. Kết quả quá khứ không đảm bảo tương lai. Luôn quản lý rủi ro và không đầu tư vượt quá khả năng chịu đựng tổn thất.*
