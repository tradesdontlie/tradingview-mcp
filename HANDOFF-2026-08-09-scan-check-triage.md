# Handoff: Scan→Check triage read-only

Ngày: 2026-08-09  
Trạng thái: tài liệu thiết kế/provenance; triage read-only và quality gate hiện đã được triển khai  
Mục tiêu: xây một lát cắt nhỏ nhưng có ích thực tế cho việc lọc nhiều mã trước khi kiểm tra tay.

## Khuyến nghị

Xây **A′ — Scan→Check triage read-only**, có quality gate tích hợp. Công cụ đọc artifact scan và check hiện có, ghép bằng chứng theo mã/khung thời gian/thời điểm, rồi tạo hàng đợi ưu tiên.

Đây là công cụ ưu tiên kiểm tra, không phải công cụ phát quyền mua.

### Trạng thái đầu ra

- `CHECK_NOW`: đủ bằng chứng để ưu tiên kiểm tra tay hoặc preflight.
- `WATCH`: bằng chứng hợp lệ nhưng chưa cần ưu tiên.
- `BLOCKED`: thiếu, stale, future, partial, sai identity, sai timeframe hoặc join không chắc chắn.
- `EXCLUDE`: chỉ khi có bằng chứng âm canonical; thiếu dữ liệu không được chuyển thành `EXCLUDE`.

Không được phát `BUY`, `SELL` hoặc `ALLOWED`. `CHECK_NOW` không phải lệnh mua.

## Vì sao làm lát cắt này

- [`scan_live.mjs`](C:/Users/ADMIN/tradingview-mcp/scan_live.mjs) đã có pipeline scan watchlist/candidate batch, regime, sector và chất lượng bar.
- [`check_one.mjs`](C:/Users/ADMIN/tradingview-mcp/check_one.mjs) đã có kiểm tra từng mã, H6 history, structure, setup, plan và `DATA_JSON:`.
- [`batch_check.mjs`](C:/Users/ADMIN/tradingview-mcp/batch_check.mjs) đã xử lý kết quả nhiều mã và attribution theo ticker.
- [`fmt_check.mjs`](C:/Users/ADMIN/tradingview-mcp/fmt_check.mjs) đã có điều kiện fail-closed cho trạng thái actionable.
- `telegram-bot.js` đã có một phần execution-readiness; không nhân bản phần đó trong lát cắt đầu tiên.

Lợi ích cần kiểm chứng là giảm thời gian tạo shortlist và giảm việc mở nhầm artifact, không phải tăng số tín hiệu.

## Phạm vi triển khai đề xuất

### File sở hữu

- Tạo `C:/Users/ADMIN/tradingview-mcp/scan_check_triage.mjs`.
- Tạo `C:/Users/ADMIN/tradingview-mcp/test_scan_check_triage.mjs`.
- Chỉ cập nhật tài liệu hoặc test khác nếu acceptance chứng minh cần thiết.

### Input canonical

- Scan artifact từ `SCAN_LATEST_PATH`.
- Check cache từ `CHECK_DATA_ROOT`, dùng quy ước trong [`src/core/check_runtime.mjs`](C:/Users/ADMIN/tradingview-mcp/src/core/check_runtime.mjs).
- Quy tắc closed-bar/session từ [`bar_status.mjs`](C:/Users/ADMIN/tradingview-mcp/bar_status.mjs), nếu artifact cần xác minh.

### Quy tắc ghép artifact

1. Xác minh full ticker và exchange trong payload; không tin tên file short ticker.
2. Xác minh timeframe là `360` và `tf_confirmed`/`symbol_confirmed` hợp lệ.
3. Xác minh market date, `generated_at`, `as_of` và thứ tự thời gian. Check phải thuộc đúng ngày và không được có thời điểm mâu thuẫn với scan.
4. Vì check cache hiện không có `candidate_batch_id`, mọi join không thể chứng minh chắc chắn phải là `BLOCKED`; không tự suy đoán theo thứ tự file.
5. Freshness threshold phải inject được trong fixture và chỉ dùng sau khi owner phê duyệt semantics. Không tự đặt một con số rồi coi là contract.
6. Sector/heat hiện là warning; không nâng thành hard `EXCLUDE` nếu chưa có contract mới.
7. Missing, stale, future, malformed, duplicate và partial failure luôn giữ blocker cụ thể.

### Output đề xuất

Tạo derived triage artifact, không ghi `journal.db`, với tối thiểu:

```json
{
  "schema_version": 1,
  "generated_at": "...",
  "status": "CHECK_NOW|WATCH|BLOCKED|EXCLUDE",
  "ticker": "HOSE:ACB",
  "timeframe": "360",
  "scan_ref": { "date": "...", "candidate_batch_id": "..." },
  "check_ref": { "as_of": "...", "evidence_hash": "..." },
  "blockers": [],
  "missing_evidence": [],
  "warnings": [],
  "manual_next_step": "..."
}
```

Giữ nguyên `DATA_JSON:`, scan schema và check schema v1. Tên artifact/output mới phải được chốt trong implementation diff trước khi trở thành public contract.

## Non-goals

- Không đọc chart trực tiếp hoặc tự điều khiển CDP.
- Không đổi symbol/timeframe, navigation, drawing, alert hay layout.
- Không đặt lệnh, tính size tự động hoặc sửa stop/TP.
- Không ghi/sửa `journal.db`, `DATA_JSON`, `trade_plans` hoặc schema.
- Không thêm LLM tự kết luận thị trường trong lát cắt này.
- Không phát tín hiệu `BUY`/`SELL`; không biến warning thành permission.

## Acceptance bắt buộc

1. Fixture deterministic cho single ticker và batch.
2. Có fixture cho `CHECK_NOW`, `WATCH`, `BLOCKED`, `EXCLUDE`.
3. Full ticker/exchange, timeframe, market date và temporal ordering sai hoặc mơ hồ phải ra `BLOCKED`.
4. Missing/stale/future/duplicate/malformed/partial không bao giờ ra `CHECK_NOW`.
5. `EXCLUDE` chỉ xuất hiện từ canonical negative evidence.
6. Không có code path phát `BUY`, `SELL` hoặc `ALLOWED`.
7. Freshness boundary được test tại `threshold - 1 ms`, `threshold` và `threshold + 1 ms` bằng clock/threshold inject.
8. Chạy pass:
   - `node test_scan_check_triage.mjs`
   - `node test_check_runtime.mjs`
   - `node test_vn_check.mjs`
   - `node test_fmt_check.mjs`
   - `node test_closed_bar_integrity.mjs`
   - `node test_session_phase.mjs`
   - `node test_phase_evidence.mjs`
   - `node test_scenarios.mjs`
9. Chứng minh hash/mtime của scan/check artifacts và `journal.db` không đổi; output mới phải nằm trong data root/đường dẫn isolated được chỉ định.
10. Sau test fixture, chạy một shadow thật có giới hạn và ghi lại thời gian tạo shortlist, phân bố blocker và các trường hợp cần adjudication thủ công. Chưa tuyên bố hiệu quả nếu chỉ có test pass.

## Quy trình session tiếp theo

1. Đọc file này, [`CLAUDE.md`](C:/Users/ADMIN/tradingview-mcp/CLAUDE.md), `C:\Users\ADMIN\claude_os\CONTRACTS.md` Section 9 và policy `AGENTS.md`.
2. Kiểm tra `git status`; bảo toàn mọi dirty/untracked path không thuộc file sở hữu.
3. Chốt boundary trước mutation:

   > Sau thay đổi, một lệnh triage read-only phải ghép đúng scan/check artifact và tạo `CHECK_NOW|WATCH|BLOCKED|EXCLUDE` deterministic, không phát quyền giao dịch, được chứng minh bằng fixture và regression tests.

4. Implement một pass bounded, review diff đúng file sở hữu, rồi chạy toàn bộ acceptance.
5. Nếu cần đổi public schema, freshness semantics hoặc `candidate_batch_id`, dừng và tạo decision card thay vì âm thầm mở rộng scope.

## Khi nào đổi hướng

- Nếu telemetry cho thấy đa số candidate đã có plan `READY` nhưng bị chặn ở permission/risk, chuyển sang execution-readiness preflight.
- Nếu temporal join scan/check không đủ đáng tin, làm quality sentinel trước.
- Nếu chưa có cách đo thời gian shortlist và false promotion, chỉ gọi đây là prototype, chưa phải công cụ hiệu quả đã chứng minh.
