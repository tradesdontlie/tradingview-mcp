# Handoff: Scan→Check triage roadmap — P0 → P1 → P2

Ngày: 2026-08-09  
Trạng thái: triage engine và command đã hoàn tất; roadmap tiếp theo chưa triển khai  
Mục tiêu: sửa chất lượng evidence theo thứ tự an toàn, trước khi cố tạo thêm `CHECK_NOW`/`WATCH` trên live data.

## Kết luận đã chốt

Làm theo thứ tự:

1. **P0 — Evidence-quality sentinel**: read-only, đo chất lượng ghép scan/check, không đổi status semantics.
2. **P1 — Exchange identity ở producer**: khôi phục full identity trong scan artifact bằng field additive.
3. **P2 — Batch/cache provenance contract**: chốt candidate batch, cache key và alias semantics trước khi làm triage actionable trên live data.

Không gộp P1+P2 trong một pass đầu tiên. P1/P2 có thể tạo ripple qua producer, command, cache, doctor, contract và consumer.

## Boundary cho session kế tiếp

Slice đầu tiên chỉ được coi là đạt khi:

> Sau thay đổi, một evidence-quality sentinel read-only phải đọc scan/check artifact hiện có, báo cáo đầy đủ các điểm nghẽn identity/cache/batch/date/freshness/duplicate/partial, không sửa source hoặc journal, không thay đổi `CHECK_NOW|WATCH|BLOCKED|EXCLUDE`, được chứng minh bằng fixture deterministic và shadow isolated.

Nếu P0 cho thấy cần đổi public schema, `DATA_JSON`, `trade_plans`, `journal.db`, CDP flow hoặc execution path, dừng và tạo decision card; không âm thầm mở rộng scope.

## Trạng thái hiện tại — đã có

- [`scan_check_triage.mjs`](C:/Users/ADMIN/tradingview-mcp/scan_check_triage.mjs) là read-only triage owner.
- [`test_scan_check_triage.mjs`](C:/Users/ADMIN/tradingview-mcp/test_scan_check_triage.mjs) có fixture single/batch, bốn status, identity conflict, HSX/HOSE alias, freshness boundary, future, duplicate byte-identical và isolation.
- [`C:\Users\ADMIN\.claude\commands\check.md`](C:/Users/ADMIN/.claude/commands/check.md) có dispatch `/check triage` → `/triage`.
- [`C:\Users\ADMIN\.claude\commands\triage.md`](C:/Users/ADMIN/.claude/commands/triage.md) là compatibility alias và command owner duy nhất của wrapper.
- 8 regression suites + adversarial probes đã PASS; review cuối PASS A1–A10.
- Không có commit/deploy; `journal.db`, scan/check inputs và protected paths không bị sửa.

## Evidence hiện tại và nguyên nhân all-BLOCKED

Đây là giới hạn evidence, không phải lý do để nới fail-closed:

- `scan_live.mjs` đã biết exchange trong watchlist/candidate nội bộ, nhưng `buildScoutResult()` hiện persist row với ticker ngắn; `scan_latest.json` mất exchange per result.
- `scan_latest.json` vẫn có global `candidate_batch_id`.
- `check_one.mjs` ghi dated/latest/legacy aliases qua [`src/core/check_runtime.mjs`](C:/Users/ADMIN/tradingview-mcp/src/core/check_runtime.mjs), nhưng check cache hiện không có batch provenance chứng minh thuộc scan nào.
- `checkFilePattern()` hiện nhìn thấy nhiều historical/latest cache paths; nhiều path matching phải giữ `CHECK_DUPLICATE` cho tới khi alias semantics được owner chốt.
- Shadow live gần nhất: 16 record, 16 `BLOCKED`; blocker chính `CHECK_MISSING=16`, `SCAN_IDENTITY_MISSING=16`, `SCAN_MISSING_EVIDENCE=5`, `SCAN_SIGNAL_UNPROVEN=5`. Hash/mtime của 134 scan/check/journal files không đổi.
- Không được tuyên bố shortlist effectiveness, time savings hoặc trading edge từ shadow all-BLOCKED.

## P0 — Evidence-quality sentinel (làm trước)

### Mục tiêu

Tạo một sentinel read-only **bên cạnh** triage, khuyến nghị sở hữu riêng:

- `C:/Users/ADMIN/tradingview-mcp/scan_check_quality.mjs`
- `C:/Users/ADMIN/tradingview-mcp/test_scan_check_quality.mjs`

Tên artifact/output mới phải được chốt trong implementation diff trước khi thành public contract. Khuyến nghị giữ sentinel output tách khỏi triage status output để không làm đổi schema/semantics hiện tại.

### Tối thiểu phải đo

Theo từng run và theo từng ticker/candidate, phân biệt rõ:

- identity present / missing / conflict;
- cache candidate found / missing;
- exact batch join proven / missing / mismatch;
- market date match / mismatch;
- generated/as-of temporal order và future;
- freshness pass / stale, với threshold được inject;
- duplicate path / conflicting hash / partial / malformed;
- số record có thể adjudicate thủ công và số record bị chặn trước khi join.

Sentinel phải giữ nguyên source values, không tự đoán exchange, batch, status hoặc priority. Warnings như sector/heat chỉ là warning.

### Acceptance P0

1. Fixture current-failure shape tái hiện được all-BLOCKED live pattern.
2. Fixture exact/mismatch/missing batch, full/short/conflicting identity, date/order/freshness boundary, duplicate alias/conflict, malformed/partial.
3. Chạy không đổi `CHECK_NOW|WATCH|BLOCKED|EXCLUDE` và không phát `BUY`/`SELL`/`ALLOWED`.
4. Source scan/check artifacts và `journal.db` giữ nguyên hash + mtime; output nằm trong isolated root.
5. Pass `node test_scan_check_quality.mjs` và toàn bộ regression hiện có.
6. Shadow bounded có blocker distribution và adjudication-needed count; không gọi đó là proof hiệu quả.

## P1 — Khôi phục exchange identity ở producer

Chỉ làm sau khi P0 mô tả rõ baseline.

### Khuyến nghị thiết kế

- Thêm field additive `results[].exchange` vào scan artifact, giữ `results[].ticker` dạng short để không phá dashboard/consumer hiện có.
- Triage ghép `ticker + exchange` thành full identity; không suy luận từ `universe_exchange`, filename hoặc thứ tự file.
- Bảo toàn candidate→scan round-trip, non-empty unique identity và phân biệt HOSE/HNX/HSX alias theo contract.
- Cập nhật test/guard/scan contract cần thiết; không đổi `DATA_JSON` hay journal schema.

### Acceptance P1

- Mọi directional scan result có exchange canonical hoặc bị chặn cụ thể.
- Full identity round-trip pass trong fixture và shadow sample.
- Không có cross-board collision/duplicate do ticker ngắn.
- `/scan` display vẫn giữ source ticker/status/value; triage dùng identity additive.
- Chạy lại P0 sentinel, triage fixtures và toàn bộ regression sau mỗi fix.

## P2 — Chốt batch/cache provenance contract

Đây là decision card bắt buộc, không tự chọn semantics trong code.

### Câu hỏi phải chốt

1. Check cache được coi là joinable chỉ khi có `candidate_batch_id` khớp scan hay có fallback nào khác được owner phê duyệt?
2. Cache key canonical có phải `(full_ticker, timeframe=360, market_date, candidate_batch_id)` không?
3. Dated/latest aliases cùng một evidence hash có được coi là một artifact hợp lệ không?
4. Historical path ngoài target market date bị bỏ qua hay vẫn là blocker?
5. Standalone `/check [MÃ]` không có batch phải tiếp tục `BLOCKED` khi chạy triage chứ?
6. Có dùng run-isolated `CHECK_DATA_ROOT` thay cho alias heuristics không?

### Acceptance P2

- Fixtures exact/mismatch/missing batch, same-key alias, conflicting same-key hashes, historical cache và standalone check.
- Không join theo filename/order/date đơn lẻ.
- Không che conflict bằng cách coalesce hash nếu alias semantics chưa được chốt.
- Cập nhật `CLAUDE.md`/`CONTRACTS.md`/`/check`/`/scan`/doctor và consumers theo Section 9 nếu public contract đổi.
- Fresh review bắt buộc sau contract decision và mỗi fix.

## Tạm thời không build

- Auto chain `/scan` → `/check` → triage.
- LLM market conclusion hoặc scoring mới.
- Telegram/alert/execution/size/SL/TP/READY/BUY/SELL/ALLOWED mapping.
- Dọn/xóa cache historical tự động.
- Tuyên bố shortlist time-savings hoặc edge khi live shadow chưa có adjudication.

## Quy trình session kế tiếp

1. Đọc file này, [`HANDOFF-2026-08-09-scan-check-triage.md`](C:/Users/ADMIN/tradingview-mcp/HANDOFF-2026-08-09-scan-check-triage.md), `CLAUDE.md`, `C:\Users\ADMIN\claude_os\CONTRACTS.md` Section 9 và policy `AGENTS.md`.
2. Kiểm tra `git status`; bảo toàn dirty/untracked path hiện có.
3. Chốt boundary P0 ở trên trước mutation.
4. Map `input → owner → adapter → consumer → output`; không thêm consumer ngoài scope.
5. Implement đúng một bounded pass P0, chạy test + isolated shadow, review diff.
6. Chỉ sau P0 PASS mới tạo decision card/implementation plan cho P1; P2 không tự mở rộng.
7. Nếu có fix, invalidates evidence và phải chạy fresh test/review; dừng khi acceptance pass.

## Stop conditions

- Không chứng minh được identity/batch/date ordering → giữ `BLOCKED`.
- Cần đổi public schema/consumer ngoài owned paths → dừng, decision card.
- Cùng một hypothesis thất bại hai lần → dừng và báo blocker, không thêm heuristic.
- Shadow all-BLOCKED hoặc không có adjudication → không gọi là effectiveness proof.
