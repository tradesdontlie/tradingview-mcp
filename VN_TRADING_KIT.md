# VN TRADING KIT — Cổ Phiếu HOSE
> Cập nhật: 27/05/2026 | Vốn: 60,000,000 VND | Risk: 1–2%/lệnh

---

## 1. WATCHLIST — 22 MÃ (Backtest-Validated)

### Nhóm 1 — Dùng được CẢ 2 chiến lược (7 mã)
| Mã  | PP PRO PF | Sweep PF | PP Mode   | Ghi chú           |
|-----|-----------|----------|-----------|-------------------|
| SHB | cao       | ≥2.0     | Hold/Trail| Bank tầm trung    |
| VIX | cao       | ≥2.0     | Hold/Trail| Chứng khoán       |
| FTS | 6.39 🏆   | ≥2.0     | Hold 30b  | Best PP PRO stock |
| FRT | cao       | ≥2.0     | Hold/Trail| Bán lẻ            |
| VCI | cao       | ≥2.0     | Hold/Trail| Chứng khoán       |
| MBB | cao       | ≥2.0     | Hold/Trail| Bank lớn          |
| ACB | cao       | ≥2.0     | Hold/Trail| Bank lớn          |

### Nhóm 2 — PP PRO only (9 mã)
| Mã  | PP PRO PF | PP Mode    | Sweep PF (yếu) |
|-----|-----------|------------|----------------|
| PDR | 28.81 🏆  | Trail MA20 | <2.0           |
| VND | 10.05     | Trail MA20 | <2.0           |
| CII | 9.25      | Hold 30b   | <2.0           |
| SSI | cao       | Hold/Trail | <2.0           |
| DXG | cao       | Hold/Trail | <2.0           |
| BID | cao       | Hold/Trail | <2.0           |
| CTG | cao       | Hold/Trail | <2.0           |
| LPB | cao       | Hold/Trail | <2.0           |
| KDH | cao       | Hold/Trail | <2.0           |

### Nhóm 3 — Liquidity Sweep only (6 mã)
| Mã  | Sweep PF | Sweep WR | PP PRO PF (yếu) |
|-----|----------|----------|-----------------|
| PNJ | ≥2.0     | ~57%     | <2.0            |
| ORS | ≥2.0     | ~57%     | <2.0            |
| MWG | ≥2.0     | ~57%     | <2.0            |
| TCB | ≥2.0     | ~57%     | <2.0            |
| HDB | ≥2.0     | ~57%     | <2.0            |
| HCM | ≥2.0     | ~57%     | <2.0            |

### Loại bỏ hoàn toàn
VIB, TPB, STB, DGW, VCB, EIB, HAG, VPB, MSN, NLG, NVL, VRE, BCM

---

## 2. CHIẾN LƯỢC 1 — GEM POCKET PIVOT PRO (VSA Filter) v6

### Tóm tắt
- **Loại**: Momentum breakout sau pullback
- **Pine Script**: `Gem - Pocket Pivot PRO (VSA Filter) v6`
- **Timeframe**: Daily (D)
- **Backtest**: 10 năm HOSE | Commission: 0.3% round-trip

### 10 Bộ lọc (phải thỏa TẤT CẢ)
```
1. Basic PP         — Nến xanh (Close > Open)
2. Volume mạnh      — Vol hôm nay > Max(vol 10 nến đỏ gần nhất) × 1.5
3. VSA dry supply   — Spread + Vol pattern sạch
4. Micro pullback   — Có ít nhất 1 nến đỏ trong 3 nến trước
5. Trend template   — Close > SMA20 VÀ Close > SMA100
6. SMA20 slope up   — SMA20 hôm nay > SMA20[5] × 1.005 (+0.5%/5 phiên)
7. SMA100 slope up  — SMA100 hôm nay > SMA100[1] (dốc lên)
8. ATR extension    — Open <= SMA20 × 1.10 (không FOMO gap quá xa)
9. FOMO gap filter  — Open không cách xa SMA20 quá
10. Delta dương     — FP Delta > 0 (mua chủ động chiếm ưu thế)
```

### Entry
```
Entry: Mở cửa phiên ngay sau ngày tín hiệu (giá open T+1)
Điều kiện thêm: Volume Footprint delta dương xác nhận
Không đuổi giá nếu open vượt quá SMA20 × 1.10
```

### Exit
```
Exit A — Hold 30 phiên (cho mã PF_Hold >= PF_Trail):
  CII, FTS, SHB, ACB, ...

Exit B — Trail MA20 (cho mã PF_Trail > PF_Hold):
  PDR, VND, VCI, ...
  → Thoát khi Close < SMA20

Stop Loss chung: Close < SMA20 (hoặc ghi nhận từ đầu dưới đáy nến signal)
```

### Kết quả backtest nổi bật
| Mã  | PF   | Mode      | Trades | WR  |
|-----|------|-----------|--------|-----|
| FTS | 6.39 | Hold 30b  | 8+     | 80% |
| PDR | 28.81| Trail MA20| 5+     | cao |
| VND | 10.05| Trail MA20| 8+     | cao |
| CII | 9.25 | Hold 30b  | 8+     | cao |

---

## 3. CHIẾN LƯỢC 2 — LIQUIDITY SWEEP + DELTA + TREND

### Tóm tắt
- **Loại**: Mean reversion sau stop hunt / liquidity grab
- **Pine Script**: `Liquidity Sweep + Delta + Trend [Optimized]`
- **Timeframe**: Daily (D) — scan tín hiệu; confirm H6
- **Backtest**: PF = 2.71 | WR = 57% | Hold 20 phiên

### Điều kiện tín hiệu (PHẢI ĐỦ TẤT CẢ)
```
1. Low hôm nay < prevWeekLow     — Giá quét xuống dưới đáy tuần trước
2. Close > prevWeekLow × 1.02   — Đóng cửa phục hồi mạnh (+2% trên prevWL)
3. Delta proxy > 0               — Lực mua chủ động chiếm ưu thế
4. Close > SMA100                — Đang trong uptrend dài hạn
5. SMA100 slope > 0.8%/5 phiên  — Trend tăng, không phải sideways
```

### Tham số tối ưu (từ backtest)
```
MA:           SMA 100 (tốt hơn EMA21 đáng kể: PF +1.26)
HTF:          Weekly (tốt hơn Monthly)
Slope:        0.8%/5 phiên
Close_above:  2.0% (balance giữa quality và quantity)
Hold:         20 phiên (thoát cứng)
```

### Entry & Exit
```
Entry:   Mở cửa phiên ngay sau tín hiệu (T+1 open)
         Lý tưởng: Limit về vùng prevWeekLow + 1%

Stop Loss: Dưới đáy nến signal (prevWeekLow - 1 ATR)
           Hoặc đóng cửa dưới SMA100

Take Profit:
  TP1: Kháng cự gần nhất / FP VAH (thoát 50%)
  TP2: Hold hết 20 phiên hoặc Trail SMA20
```

### Per-ticker kết quả
| Mã  | PF tốt nhất | Hold |
|-----|-------------|------|
| FTS | 6.39        | 20b  |
| SHB | 5.27        | 20b  |
| VIX | 3.18        | 20b  |
| PDR | 2.62        | 20b  |

---

## 4. BỘ CÔNG CỤ CHART (BẮT BUỘC)

### Timeframe
```
VN Stocks: H6 (6-hour) — loại bỏ volume thỏa thuận
           KHÔNG dùng Daily khi phân tích volume
Forex:     M5 cho entry | H4 cho context
```

### Indicators trên chart H6
```
1. Footprint Aggressor Analysis [Claude] v2  ← đọc Conf, CumDelta, DIV
2. Pocket Pivot PRO - Claude                 ← SMA20, SMA100, PP signal
3. Liquidity Sweep + Delta + Trend [Opt]     ← Sweep signal
4. Volume Delta Candle [Gem]                 ← volume context
5. Price Action GEM                          ← MA levels
6. Gem - S&R + Nearest Weekly Low           ← key levels
7. Periodic Volume Profile                   ← session volume
```

### Đọc Footprint (BẮT BUỘC trước khi vào lệnh)
```
Conf >= 60     → tín hiệu đủ mạnh
CumDelta > 0   → tiền thông minh đang mua
Buy% >= 55%    → áp lực mua chiếm ưu thế
DIV = false    → không có bearish divergence
BuyIMB >= 1    → có vùng buy imbalance chưa filled
```

---

## 5. RISK MANAGEMENT

### Tính Position Size
```
Vốn:          60,000,000 VND
Risk 1%:         600,000 VND (setup bình thường)
Risk 2%:       1,200,000 VND (setup confluence cao — PP PRO + Sweep + FP confirm)

Công thức:
  Số lô = Risk Amount / (Entry Price - Stop Loss Price)

Ví dụ ACB:
  Entry: 25,200 | SL: 24,500 → (Entry - SL) = 700
  Risk 1% = 600,000 / 700 = 857 cp → làm tròn 800 cp
  Risk 2% = 1,200,000 / 700 = 1,714 cp → làm tròn 1,700 cp
```

### Quy tắc risk
```
Max 1 lệnh/ngày cho mỗi strategy type
Max 3 lệnh mở cùng lúc
Không add position khi lệnh đang lỗ > 1%
Re-entry: Không vào lại sau sóng tăng >20% chưa pullback
```

### R:R tối thiểu
```
Setup bình thường:  R:R >= 1.5
Setup confluence:   R:R >= 1.2 (có thể chấp nhận)
Dưới 1.2:          Bỏ qua, dù tín hiệu đẹp
```

---

## 6. QUY TRÌNH HÀNG NGÀY

### Sáng (8:45 – 9:00) — Briefing
```bash
/brief          # Market overview + open positions
/safe EURUSD    # Nếu có lệnh forex sắp vào
```

### Giờ giao dịch (9:15 – 11:30)
```
1. Quan sát VNINDEX 15 phút đầu — bias thị trường
2. Nếu VNINDEX > 0: focus BUY signals
3. Nếu VNINDEX < -0.5%: không mở lệnh mới, chỉ quản lý lệnh cũ
4. Scan signal: node scan_live.mjs  (hoặc /scan trong Claude Code)
5. Với mã BUY/WATCH: /check [MÃ] để xác nhận
6. Vào lệnh nếu đủ điều kiện, ghi /trade ngay
```

### Cuối phiên (14:45 – 15:00)
```
1. Kiểm tra lệnh đang mở: cập nhật SL nếu cần
2. /review — tổng kết ngày
3. Ghi chú vào journal
```

### Cuối tuần (Thứ 6 – Thứ 7)
```
1. Review tất cả lệnh tuần
2. Tính P&L: python journal_helper.py --week
3. Cập nhật watchlist nếu cần
4. Chuẩn bị watchlist cho tuần sau
```

---

## 7. NGUYÊN TẮC CỐT LÕI

```
✅ CHỈ vào lệnh khi:
   - Footprint Conf >= 60 (hoặc rõ ràng trên chart)
   - CumDelta > 0 (dòng tiền xác nhận)
   - Mã trong watchlist 22 (đã backtest)
   - R:R >= 1.5
   - VNINDEX không sụt > -0.5% ngày hôm đó

❌ KHÔNG vào lệnh khi:
   - DIV signal = TRUE + CumDelta < 0
   - Giá < SMA20 (hoặc SMA20 đang giảm)
   - News cao su Forex (High Impact < 30 phút)
   - Đã có 3 lệnh mở
   - Sau sóng tăng > 20% chưa pullback
   - Mã thuộc danh sách "Loại bỏ"
```

---

## 8. SCAN COMMANDS

### Scan nhanh qua TradingView CDP (yêu cầu TradingView mở + debug port 9222)
```bash
cd C:\Users\ADMIN\tradingview-mcp
node scan_live.mjs
```

### Scan fallback qua Yahoo Finance (không cần TradingView)
```bash
cd C:\Users\ADMIN\tradingview-mcp
py scan_run.py
```

### Trong Claude Code session (full MCP tools)
```
/scan           # Scan 22 mã watchlist
/check [MÃ]    # Phân tích sâu 1 mã
/review         # Daily market review
/brief          # Pre-session briefing
```

---

## 9. PHÂN LOẠI TÍN HIỆU

| Signal  | Score   | Điều kiện              | Hành động                    |
|---------|---------|------------------------|------------------------------|
| BUY     | ≥ 71%   | ≥ 5/7 criteria OK      | Vào lệnh, ghi journal        |
| WATCH   | 43–70%  | 3–4/7 criteria OK      | Theo dõi thêm 1–2 phiên      |
| AVOID   | < 43%   | < 3/7 criteria         | Bỏ qua                       |
| LOẠI   | any     | DIV+CumD< 0 OR Price<MA20 | Không trade, exit nếu đang giữ |

---

## 10. TRADE SIZING NHANH (Reference Card)

| Entry–SL | Risk 1% (600K) | Risk 2% (1.2M) |
|----------|----------------|----------------|
| 100 VND  | 6,000 cp       | 12,000 cp      |
| 200 VND  | 3,000 cp       | 6,000 cp       |
| 300 VND  | 2,000 cp       | 4,000 cp       |
| 500 VND  | 1,200 cp       | 2,400 cp       |
| 700 VND  | 857 cp         | 1,714 cp       |
| 1,000 VND| 600 cp         | 1,200 cp       |
| 1,500 VND| 400 cp         | 800 cp         |
| 2,000 VND| 300 cp         | 600 cp         |
| 3,000 VND| 200 cp         | 400 cp         |
| 5,000 VND| 120 cp         | 240 cp         |

---
*File: VN_TRADING_KIT.md | Cập nhật mỗi khi backtest lại hoặc watchlist thay đổi*
