// fmt_check.mjs - tach tu telegram-bot.js: render tom tat phone tu DATA_JSON cua check_one.mjs.
// KHONG import gi tu telegram-bot.js (file do tu chay khi import).

const num = v => (v == null ? '?' : Number(v).toLocaleString('en-US'));

// check_one.mjs in DATA_JSON cho model doc; phone can ban tom tat nguoi doc.
function fmtCheck(raw) {
    const idx = raw.indexOf('DATA_JSON:');
    if (idx === -1) return raw;
    let d;
    try { d = JSON.parse(raw.slice(idx + 'DATA_JSON:'.length).trim()); } catch { return raw; }
    const fp = d.fp || {}, wave = d.wave || {}, trail = d.trail || {}, tp = wave.tp || {};
    const checks = fp.checks || {};
    const passed = Object.values(checks).filter(Boolean).length;
    const lines = [
        `📊 ${d.ticker} ${num(d.price)} (${d.date})`,
        `Conf ${fp.conf ?? '?'}/100 | Checks ${passed}/${Object.keys(checks).length || '?'} | Score ${fp.score ?? '?'}`,
        `CumDelta ${num(fp.cumD)} | Buy ${fp.buyPct ?? '?'}% | Div ${fp.div ?? 0}`,
        `Cau truc: ${d.structure || '?'} | Wave: ${wave.phase || '?'}`,
        `Trail: ${trail.status || '?'} (SMA20 ${num(trail.sma20_current)})`,
        `TP: ${num(tp.tp100)} / ${num(tp.tp1272)} / ${num(tp.tp1618)}`,
        `SMA20 ${num((d.ma || {}).sma20)} | SMA100 ${num((d.ma || {}).sma100)}`,
    ];
    const notes = ((d.mtf || {}).notes || []).join(', ');
    if (notes) lines.push(`MTF: ${notes}`);
    if (d.tplus) {
        lines.push(`T+: khoa ${d.tplus.lock_sessions} phien | nhieu ~${d.tplus.floor_pct}% | ${d.tplus.exit_rule}`);
        for (const s of (d.scenarios || [])) {
            if (s.tplus_warn) lines.push(`⚠️ ${s.label}: SL ${s.sl_atr}xATR, RR-ket ${s.rr_locked ?? '?'} -> vao 1/2 + 1/2 sau khi hang ve`);
        }
    }
    return lines.join('\n');
}

export { fmtCheck, num };
