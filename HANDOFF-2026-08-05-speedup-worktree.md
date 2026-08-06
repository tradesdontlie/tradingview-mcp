# HANDOFF — 2026-08-05: Speedup scan/ta/check + worktree bẩn chưa commit

## 1. TL;DR

- Đã triển khai xong gói **A (adaptive polling + full-symbol identity check) + E (VNINDEX cache ≤2h)** và **D (batch check một process/lock/connection)**; toàn bộ test deterministic pass.
- Worktree **vốn đã bẩn từ trước** (công việc chưa commit của user: 7/22, sáng 04:21–04:44, chiều 13:51 hôm nay) — được giữ nguyên, KHÔNG đụng.
- **Blocker:** usage limit tài khoản (reset `2026-08-08 20:32`). Coding child đã làm xong code trước khi lỗi; Sol-medium reviewer bị chặn chưa review.
- **Khuyến nghị hiện tại: KHÔNG làm thêm thay đổi engine nào nữa; chờ 8/8 chạy lại Sol-medium review**, sau đó mới quyết định commit/branch và làm tiếp các mục C/I/F/B/G.

## 2. Boundary & acceptance của gói này

- Boundary: với cùng trạng thái chart, `scan_live.mjs`/`check_one.mjs` sinh evidence tương đương ngữ nghĩa (cùng giá trị footprint/MA/structure/wave, cùng lỗi fail-closed), NHƯNG bỏ sleep cố định (thay bằng readiness poll có cap ≤ worst-case cũ) và bỏ roundtrip chart VNINDEX khi cache ≤2h tươi.
- Output contract KHÔNG đổi: field DATA_JSON, schema `scan_latest.json`, env var, log format.
- Tiêu chí chấp nhận: bộ test deterministic + `git diff --check` (đã pass, xem mục 5).

## 3. Thay đổi CỦA TASK NÀY (6 file, mtime 17:46–17:48 2026-08-05)

| File | Nội dung |
|---|---|
| `rs_util.mjs` | `readVnindexCache(cache, maxAgeMs = FRESH_MS)`; export `FRESH_MS`. Default 36h giữ nguyên hành vi check_one. |
| `src/scan_policy.mjs` | `confirmSymbol` so full symbol (exchange+ticker, alias HSX↔HOSE; actual thiếu exchange → fallback ticker-only); helper mới `waitForStudy` (poll, chịu lỗi transient từng attempt, không throw khi hết attempts). |
| `scan_live.mjs` | Import `readVnindexCache`/`waitForStudy`; scanOne thay `sleep(1500)` bằng poll 6×400ms chờ study 'Footprint'; VNINDEX baseline đọc cache ≤2h + ≥25 closes trước, tươi thì bỏ roundtrip chart, cũ thì giữ flow cũ; restore chart chỉ khi state khác initState (fallback đầy đủ khi getState lỗi). |
| `check_one.mjs` (chỉ hunk speedup) | Import `confirmSymbol`/`waitForStudy`; skip symbolSearch khi initState đã khớp target; symbol confirm qua `confirmSymbol` 16×500ms; bỏ `sleep(2000)`, study retry thành poll 28×500ms (~14s cap ≈ worst-case cũ); `restoreChartState` chỉ restore khi state khác. |
| `test_rs_util.mjs` | Test maxAgeMs 2h/36h. |
| `tests/scan_policy.test.js` | Test confirmSymbol full-symbol (alias HSX, bare-ticker fallback, sai exchange reject) + waitForStudy (match sớm/trễ/absent/transient rejection → null). |

### 3b. Gói D (batch check) — 2026-08-05 tối

| File | Nội dung |
|---|---|
| `check_one.mjs` (hunk D) | Tách `export async function runOneCheck({ticker, timeframe, cacheDir, providedInitState, restoreOnExit, disconnectOnExit})` — giữ nguyên body flow cũ, restore/disconnect theo cờ; `main()` mới: single-ticker CLI giữ nguyên hành vi, thêm `--batch HOSE:A HOSE:B [tf]` — một CDP connection, một chart lock, restore 1 lần cuối, lỗi từng mã in `BATCH_ERROR <MÃ>: <msg>` và `process.exitCode=1` nếu có mã fail; `<2 ticker` → throw `BATCH_REQUIRES_2_OR_MORE_TICKERS` trước khi connect CDP. |
| `batch_check.mjs` (untracked, file user — đã thay) | Bỏ vòng spawn `execSync` từng mã; chạy 1 lần `check_one --batch` với đúng danh sách 11 mã + tf 360; parse từng dòng `DATA_JSON:`/`BATCH_ERROR`, ghi `claude_os/data/batch_check_log.json` giữ nguyên contract cũ (ticker/success/elapsed/json/error). Bản gốc đã backup: `backups/batch_check.mjs.bak-20260805`. |
| `test_check_runtime.mjs` | Thêm test fail-fast: `check_one --batch` với 1 mã → exit≠0 + `BATCH_REQUIRES_2_OR_MORE_TICKERS` (spawnSync, không cần CDP). |

Lưu ý: chế độ batch chỉ nhận ticker có `:` (VD `HOSE:OCB`); ticker trần (không có `:`) chỉ dùng ở chế độ single như cũ (check-gold/ta-gold vẫn chạy đúng vì dùng `ICMARKETS:XAUUSD`).

Lưu ý: diff `check_one.mjs` so HEAD là **hỗn hợp** — gồm hunk speedup (của task) + hunk evidence_quality/closed-bars (của user, có TRƯỚC task). Khi review/rollback phải tách theo hunk, không revert nguyên file.

## 4. Worktree bẩn CÓ SẴN TRƯỚC TASK (không thuộc task, KHÔNG được đụng/revert)

Modified (chưa commit, mtime):

- `telegram-bot.js` (7/22 02:09), `test_telegram_readiness.mjs` (7/22 02:09)
- `bar_status.mjs` (8/5 04:21), `test_vn_check.mjs` (8/5 04:42), `test_session_phase.mjs` (8/5 04:44), `package-lock.json` (8/5 13:51)
- `check_one.mjs`: phần evidence_quality/signal_quality + closed-bars refactor (đã có trước task; CONTRACTS 9A ghi nhận 2026-08-05)

Untracked (tồn tại sẵn, tóm tắt theo nhóm):

- Dữ liệu/artifact: `journal.db` (+ `.bak-*`), `database.db`, `tradingview.db`, `backtest_results.json`, `scan_results_*.json`, `multi_check_result.json`, `trading-journal.json`, `trading-state.json`, `*.csv` (ema921, xauusd), `vib_vp.json`, `vpb_vp.json`, `scan-history.json`, `scan_sma20_result.json`, `.tmp_clipboard_view.*`
- Code/scripts: `batch_check.mjs`, `get_stock.mjs`, `ea_monitor/`, `pine_scripts/`, `src/draw_*.mjs`, `hmm_regime.py`, `journal_helper.py`, `quant_tools.py`, `scan_run.py`, `post-session-scan.js`, `start-bot.bat`, `start-pm2.bat`, `ecosystem.config.cjs`
- Docs/plan: `AGENTS.md`, `EMA921_TRADING_RULES.md`, `POCKET_PIVOT_PRO_GUIDE.md`, `VN_TRADING_KIT.md`, `orchestrate-review-packet.md`, `docs/superpowers/plans/2026-08-04-tech-advisor-implementation-plan.md`, `docs/superpowers/specs/2026-08-04-tech-advisor-design.md`
- Khác: `backups/`, `.codegraph/`, `__pycache__/`, `skills/karpathy-guidelines/`

**Cảnh báo commit:** tuyệt đối không `git add -A` / `git commit -a` — sẽ cuốn toàn bộ công việc chưa commit của user. Nếu muốn cô lập gói này, chỉ `git add` đúng 6 file mục 3 (riêng `check_one.mjs` sẽ kéo theo hunk evidence_quality của user — cần user quyết định).

## 5. Verification (đã chạy, exit code thực tế)

```text
node test_rs_util.mjs                 exit=0
node test_check_runtime.mjs           exit=0
node test_vn_check.mjs                exit=0
node test_fmt_check.mjs               exit=0
node test_session_phase.mjs           exit=0
node test_scenarios.mjs               exit=0
node test_decision.mjs                exit=0
node test_closed_bar_integrity.mjs    exit=0
node --test tests/scan_policy.test.js exit=0
git diff --check                      exit=0
```

### 5b. Smoke test live (2026-08-05 ~19:29 ICT, market CLOSED, chart gốc HOSE:VNM/360)

- `node check_one.mjs HOSE:ACB 360` (sequential): **22.7s**, exit 0, DATA_JSON đầy đủ.
- `node check_one.mjs --batch HOSE:ACB HOSE:VCB 360`: **34.3s**, exit 0, đủ 2 dòng DATA_JSON đúng thứ tự, 0 `BATCH_ERROR`.
- So sánh field ACB sequential vs batch (so sánh đệ quy toàn bộ payload): **chỉ khác 5 field, toàn bộ là timestamp** — `vn.pm_profile.observed_at`, `vn.pm_profile.evidence_hash_fields.observed_at`, `generated_at`, `as_of`, `evidence_hash` (hash khác vì bao gồm timestamp). Mọi field semantic (price, structure, wave, fp, setup_state, decision, plan_scenario, ma, rs, htf, mtf, pivots, vn.*) **IDENTICAL**.
- VCB trong batch: hợp lệ (HOSE:VCB, symbol/tf confirmed, 130 bars, NO_SETUP).
- Chart sau smoke: `tv_health_check` = **HOSE:VNM/360** (restore 1 lần cuối đúng), lock đã nhả (`tradingview-chart.lock` không tồn tại).
- Timing: batch tiết kiệm ~5.6s/ticker (22.7s vs ~17.1s/mã) — với 11 mã: ~250s → ~189s (~24%).
- Evidence files: `C:\tmp\smoke\seq_acb.json`, `batch_acb.json`, `batch_vcb.json` (nhớ strip BOM khi đọc).

## 6. Blocker & việc còn treo

- Usage limit: `You've hit your usage limit... try again at Aug 8th, 2026 8:32 PM` — coding child `speedup_impl` và reviewer `speedup_review_sol` đều dính.
- Coding child hoàn thành code trước khi lỗi (bằng chứng mtime); root tự vá 2 lỗi còn lại (`waitForStudy` chịu lỗi transient; `confirmSymbol` chấp nhận actual không có exchange) và tự review toàn bộ diff.
- **Sau 8/8:** chạy lại Sol-medium review trên diff 6 file (packet sẵn trong thread), rồi quyết định branch/commit theo ý user.
- Chưa chạy smoke test live (cần TradingView + tạm đổi chart state). Không bắt buộc cho acceptance; làm khi TV rảnh nếu user muốn.

## 7. Rollback

- `rs_util.mjs`, `src/scan_policy.mjs`, `scan_live.mjs`, `test_rs_util.mjs`, `tests/scan_policy.test.js`: diff so HEAD chỉ gồm thay đổi của task → revert an toàn bằng `git checkout -- <file>` (hoặc restore theo diff).
- `check_one.mjs`: diff HỖN HỢP với thay đổi có sẵn của user → **không revert nguyên file**; phải bỏ thủ công từng hunk speedup (import confirmSymbol/waitForStudy, symbolSearch skip, confirmSymbol 16×500ms, waitForStudy study poll, restoreChartState có điều kiện) + hunk D (runOneCheck/main mới).
- `batch_check.mjs`: file untracked — bản gốc tại `backups/batch_check.mjs.bak-20260805`.

## 8. Khuyến nghị tiếp theo

- **Bây giờ (trước 8/8):** không thêm thay đổi engine; giữ nguyên hiện trạng. Có thể chạy smoke test live nếu user yêu cầu (VD `node batch_check.mjs` để đo thời gian thật khi TradingView rảnh).
- **8/8 trở đi:** (1) Sol-medium review diff (A+E+D); (2) user chốt commit/branch; (3) nếu muốn tiếp tục tăng tốc: C (warm vnstock worker), I (warm-up theo lịch bar close), F (skip restore/symbolSearch dư), B (check cache TTL), G (giảm max_candidates) — theo thứ tự advisor chốt: A → E → D → C/I → F → B → G.
