# EMA 9/21 XAUUSD — Trading Rules (Backtest 2025)

> Derived from: 354,011 M1 bars | Full year 2025 | 944 baseline trades
> Best config: PF=2.32 | WR=37.3% | +28.3%/year (1% risk/trade)

---

## ⚡ TÓM TẮT NHANH

| | PRIMARY | SECONDARY |
|---|---|---|
| Direction | **SHORT** | **LONG** |
| Session | **London** | **London** |
| Ngày | **Thứ Hai** | **Thứ Tư** |
| Body min | **≥ 0.55** | **≥ 0.55** |
| RR | **3.0** | **2.0** |
| Slope M15 | ≥ 0.03 | ≥ 0.10 |

---

## 📋 RULE SET ĐẦY ĐỦ

### ĐIỀU KIỆN CHUNG (áp dụng cả PRIMARY và SECONDARY)

```
✅ Chỉ trade trong London session: 15:15 – 18:00 (Giờ VN, GMT+7)
✅ Chỉ trade Thứ Hai (SHORT) hoặc Thứ Tư (LONG)
❌ Không trade: Thứ 3, Thứ 5, Thứ 6
❌ Không trade nếu có FOMC / NFP / CPI trong ngày
❌ Không trade NY session (21:00–23:00) — không có edge
❌ Không trade LONG ngoài Thứ Tư
```

---

## 🔴 PRIMARY — SHORT (Thứ Hai, London)

### Điều kiện vào lệnh (tất cả 6 phải đúng):

```
1. Timeframe: M1
2. Giờ VN: 15:15 – 18:00, đúng ngày Thứ Hai
3. Close M1 < EMA21 M15         (giá dưới trend M15)
4. Slope M15 < -0.03            (M15 đang downtrend)
5. EMA9 M1 < EMA21 M1           (alignment đúng chiều SHORT)
6. Close M1 < EMA9 M1           (giá dưới EMA nhanh)
7. High M1 >= EMA21 M1          (nến vừa test/chạm EMA21 = pullback lên)
8. Body% >= 0.55                (thân nến ≥ 55% range — nến có conviction)
   Body% = abs(close - open) / (high - low)
```

### Entry / SL / TP:
```
Entry = Close của nến tín hiệu
SL    = High của nến tín hiệu + 0.30 (spread)
Risk  = SL - Entry
TP    = Entry - Risk × 3.0
```

### Ví dụ:
```
Nến tín hiệu: Open=3150.50 High=3152.00 Low=3148.80 Close=3149.20
Body% = |3149.20 - 3150.50| / (3152.00 - 3148.80) = 1.30/3.20 = 0.41 → KHÔNG ĐẠT (< 0.55)

Nến tín hiệu: Open=3152.00 High=3153.50 Low=3148.50 Close=3149.00
Body% = |3149.00 - 3152.00| / (3153.50 - 3148.50) = 3.00/5.00 = 0.60 → ĐẠT ✓
Entry = 3149.00
SL    = 3153.50 + 0.30 = 3153.80
Risk  = 3153.80 - 3149.00 = 4.80
TP    = 3149.00 - 4.80 × 3.0 = 3134.60
```

---

## 🟢 SECONDARY — LONG (Thứ Tư, London)

### Điều kiện vào lệnh:

```
1. Timeframe: M1
2. Giờ VN: 15:15 – 18:00, đúng ngày Thứ Tư
3. Close M1 > EMA21 M15         (giá trên trend M15)
4. Slope M15 > +0.10            (M15 đang uptrend RÕ RÀNG — ngưỡng cao hơn)
5. EMA9 M1 > EMA21 M1           (alignment đúng chiều LONG)
6. Close M1 > EMA9 M1           (giá trên EMA nhanh)
7. Low M1 <= EMA21 M1           (nến vừa test/chạm EMA21 = pullback xuống)
8. Body% >= 0.55                (thân nến ≥ 55% range)
```

### Entry / SL / TP:
```
Entry = Close của nến tín hiệu
SL    = Low của nến tín hiệu - 0.30 (spread)
Risk  = Entry - SL
TP    = Entry + Risk × 2.0
```

---

## 💰 POSITION SIZING (Risk Management)

```
Risk per trade = 1% vốn tài khoản
Lot size = (Vốn × 1%) / (Risk_pts × $1/pt cho mini lot)

Ví dụ tài khoản $10,000:
  Risk = $100
  Nếu Risk = 5.0 pts → Lot = $100 / ($5.0 × 10) = 2.0 mini lots
  Nếu Risk = 3.0 pts → Lot = $100 / ($3.0 × 10) = 3.3 mini lots
```

---

## 🚦 QUẢN LÝ LỆNH

```
Max 3 lệnh/session (London Thứ Hai hoặc Thứ Tư tính riêng)
Max 1 lệnh mở cùng lúc
Nếu thua 2 lệnh liên tiếp trong 1 session → DỪNG session đó
Cuối session (18:00) → đóng lệnh còn mở theo giá thị trường
```

---

## 📅 LỊCH TRADE HÀNG TUẦN

```
Thứ Hai  : SHORT setup — xem London (15:15–18:00) ✅
Thứ Ba   : NGHỈ ❌
Thứ Tư   : LONG setup — xem London (15:15–18:00) ✅
Thứ Năm  : NGHỈ ❌
Thứ Sáu  : NGHỈ ❌
```

---

## 📊 KỲ VỌNG THỰC TẾ

| Metric | PRIMARY (SHORT Mon) | SECONDARY (LONG Wed) |
|--------|--------------------|--------------------|
| Số lệnh/năm | ~59 | ~71 |
| Số lệnh/tháng | ~5 | ~6 |
| Win Rate | 37.3% | 46.5% |
| Profit Factor | **2.32** | **1.57** |
| Avg win | +10.89 pts | ~+6 pts |
| Avg loss | -2.79 pts | ~-3 pts |
| Return (1% risk) | **+28.3%/năm** | +15%/năm |
| Max DD | -25.5 pts | -23.5 pts |

---

## ⚠️ THÁNG XẤU — DẤU HIỆU DỪNG

Dựa trên backtest 2025, các tháng thua lỗ thường xảy ra khi:
- Vàng đang trong giai đoạn consolidation / sideway lớn
- Tháng Mar, Jun, Aug, Sep, Nov 2025 đều âm với PRIMARY config
- **Nếu thua 3 tuần liên tiếp → nghỉ 1 tuần, review lại**

---

## 🔧 CÁCH TÍNH TRÊN TRADINGVIEW

### Indicator cần thêm vào chart M1:
```
1. EMA(9)  → EMA9_M1
2. EMA(21) → EMA21_M1
```

### Indicator trên M15 (mở chart M15 song song):
```
1. EMA(21) → EMA21_M15
2. Slope = EMA21_M15[0] - EMA21_M15[3]  (tự tính bằng mắt hoặc indicator)
```

### Cách đọc Body%:
```
Nến xanh (bull): Body% = (Close - Open) / (High - Low)
Nến đỏ (bear) : Body% = (Open - Close) / (High - Low)
→ Cần ≥ 0.55 (55%) → nến có thân chiếm hơn nửa total range
→ Nhìn bằng mắt: thân nến phải dài hơn bóng trên + bóng dưới cộng lại
```

---

## 📝 CHECKLIST TRƯỚC KHI VÀO LỆNH

### SHORT (Thứ Hai London):
- [ ] Đang trong giờ 15:15–18:00 VN, đúng Thứ Hai?
- [ ] Không có tin tức cao cấp hôm nay (FOMC/NFP/CPI)?
- [ ] Close < EMA21 M15?
- [ ] EMA21 M15 đang dốc xuống (slope âm)?
- [ ] EMA9 M1 < EMA21 M1?
- [ ] Close < EMA9 M1?
- [ ] High của nến >= EMA21 M1 (đã chạm/vượt qua EMA21)?
- [ ] Body% >= 0.55?
- [ ] Chưa có lệnh nào đang mở?
- [ ] Chưa đến 3 lệnh trong session này?
- [ ] Chưa thua 2 lệnh liên tiếp hôm nay?

---

## 🚨 NHỮNG GÌ KHÔNG NÊN LÀM

```
❌ Không LONG vào Thứ Hai (ngay cả khi setup đẹp)
❌ Không SHORT vào Thứ Tư (dùng setup ngược lại)
❌ Không trade NY session dù hướng nào
❌ Không bỏ filter body% — đây là filter quan trọng nhất
❌ Không dùng RR < 2.0 (breakeven WR của RR=3 là 25%, dễ đạt hơn)
❌ Không average down / add thêm lệnh khi đang lỗ
❌ Không move SL về entry trước khi giá đi đủ xa (ít nhất 1×Risk)
```

---

*Backtest: HistData.com XAUUSD M1 — Jan 2025 → Dec 2025 (354,011 bars)*
*Script: backtest_histdata.py — C:\Users\ADMIN\tradingview-mcp\*
*Last updated: 2026-05-27*
