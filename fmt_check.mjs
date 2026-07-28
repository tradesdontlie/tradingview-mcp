// fmt_check.mjs - tach tu telegram-bot.js: render tom tat phone tu DATA_JSON cua check_one.mjs.
// KHONG import gi tu telegram-bot.js (file do tu chay khi import).

const num = v => (v == null ? '?' : Number(v).toLocaleString('en-US'));

function fmtUnavailable(raw, readiness = {}) {
    const blockers = Array.isArray(readiness.blockers) && readiness.blockers.length
        ? readiness.blockers
        : ['ENGINE_DATA_UNAVAILABLE'];
    return [
        raw,
        'SETUP: UNKNOWN',
        `PLAN: ${readiness.plan_status || 'UNKNOWN'}`,
        `GATE: ${readiness.gate_state || 'BLOCKED'}`,
        `PERMISSION: ${readiness.permission_state || 'BLOCKED'}`,
        `BLOCKERS: ${blockers.join(', ')}`,
        'ACTIONABLE: NO',
    ].join('\n');
}

function fmtDeep(d, fp, wave, trail, tp, checks, passed) {
    const lines = [...fmtCompact(d).split('\n')];
    if (d.vsa_churn) lines.push(`VSA Churn: ${d.vsa_churn.flag ? '⚠️' : '✅'} ${d.vsa_churn.note || ''}`);
    if (d.vsa_signals) {
        if (d.vsa_signals.no_demand?.flag) lines.push('VSA: No Demand (cau yeu giua uptrend)');
        if (d.vsa_signals.no_supply?.flag) lines.push('VSA: No Supply (cung can giua pullback)');
    }
    if (d.topbot?.pattern) {
        lines.push(`TopBot: ${d.topbot.pattern} (${d.topbot.side}) ${d.topbot.confirmed ? '✅' : '⏳'}`);
    }
    if (d.price_limit?.board) {
        lines.push(`Gia: ${num(d.price)} | Tran ${num(d.price_limit.ceiling)} | San ${num(d.price_limit.floor)} | ${d.price_limit.pct_from_ref}%`);
        if (d.price_limit.ceiling_risk) lines.push('⚠️ Sat tran!');
        if (d.price_limit.floor_risk) lines.push('⚠️ Sat san!');
    }
    if (d.htf) lines.push(`Weekly: ${d.htf.trend} (${d.htf.weeks || '?'}W)`);
    if (d.rs) lines.push(`RS VNINDEX: ${d.rs.rs_20 != null ? d.rs.rs_20 : '?'} ${d.rs.leader ? '🏆' : ''}`);
    if (d.mtf?.notes?.length) lines.push(`MTF: ${d.mtf.score} (${d.mtf.notes.join(', ')})`);
    if (d.overhead) lines.push(`Overhead: ${num(d.overhead.resistance) || '?'} (headroom ${d.overhead.headroom_pct ?? '?'}%)`);
    if (d.avg_vol20) lines.push(`AvgVol20: ${num(d.avg_vol20)}`);
    return lines.join('\n');
}

function fmtCompact(d) {
    const fp = d.fp || {};
    const wave = d.wave || {};
    const trail = d.trail || {};
    const lines = [
        `📊 ${d.ticker} ${num(d.price)} (${d.date})`,
        `Buy ${fp.buyPct ?? '?'}% | Delta ${num(fp.cumD)} | Delta% ${fp.totalVol && fp.cumD != null && fp.totalVol > 0 ? Math.round(fp.cumD / fp.totalVol * 100) : '?'}%`,
        `Stacks: B${fp.buyStack ?? '?'}/S${fp.sellStack ?? '?'} | Div ${fp.div ?? 0}`,
    ];

    // VN unified check
    if (d.vn) {
        const vn = d.vn;
        lines.push(`H6 Vol: ${num(d.avg_vol20)} | H6 Live Vol: ${vn.h6_live.vol_ratio != null ? (vn.h6_live.vol_ratio * 100).toFixed(0) + '%' : '?'}`);
        lines.push(`Setup: ${vn.setup.setup || 'NONE'} | Zone: ${num(vn.setup.zone_low)}-${num(vn.setup.zone_high)}`);
        if (vn.pm_profile?.poc != null) {
            lines.push(`PM Profile: POC ${num(vn.pm_profile.poc)} VAH ${num(vn.pm_profile.vah)} VAL ${num(vn.pm_profile.val)}`);
        }
        lines.push(`MA: SMA20 ${num(d.ma?.sma20)} | SMA100 ${num(d.ma?.sma100)} ${vn.ma_anchor?.anchor ? '(' + vn.ma_anchor.anchor + ')' : ''}`);
        lines.push(`Cau truc: ${d.structure || '?'} | Protected: ${num(vn.h6_history.protected_low)}`);
        lines.push(`Trail: ${trail.status || '?'} | LTF: ${vn.locked_ltf.status}`);
        lines.push(`SETUP: ${vn.setup_state || 'UNKNOWN'}`);
        const blockers = vn.blockers || [];
        lines.push(`BLOCKERS: ${blockers.length ? blockers.join(', ') : 'NONE'}`);
        return lines.join('\n');
    }

    // Legacy non-VN
    const tp = wave.tp || {};
    const checks = fp.checks || {};
    const passed = Object.values(checks).filter(Boolean).length;
    lines.push(`Conf ${fp.conf ?? '?'}/100 | Checks ${passed}/${Object.keys(checks).length || '?'} | Score ${fp.score ?? '?'}`);
    lines.push(`CumDelta ${num(fp.cumD)}`);
    lines.push(`Cau truc: ${d.structure || '?'} | Wave: ${wave.phase || '?'}`);
    lines.push(`Trail: ${trail.status || '?'} (SMA20 ${num(trail.sma20_current)})`);
    lines.push(`TP: ${num(tp.tp100)} / ${num(tp.tp1272)} / ${num(tp.tp1618)}`);
    const notes = ((d.mtf || {}).notes || []).join(', ');
    if (notes) lines.push(`MTF: ${notes}`);
    if (d.tplus) {
        lines.push(`T+: khoa ${d.tplus.lock_sessions} phien | nhieu ~${d.tplus.floor_pct}% | ${d.tplus.exit_rule}`);
        for (const s of (d.scenarios || [])) {
            if (s.tplus_warn) lines.push(`⚠️ ${s.label}: SL ${s.sl_atr}xATR, RR-ket ${s.rr_locked ?? '?'} -> vao 1/2 + 1/2 sau khi hang ve`);
        }
    }
    lines.push(`SMA20 ${num((d.ma || {}).sma20)} | SMA100 ${num((d.ma || {}).sma100)}`);
    return lines.join('\n');
}

function fmtCheck(raw, readinessOverride) {
    const idx = raw.indexOf('DATA_JSON:');
    if (idx === -1) {
        if (!readinessOverride) return raw;
        return fmtUnavailable(raw, readinessOverride);
    }
    let d;
    try { d = JSON.parse(raw.slice(idx + 'DATA_JSON:'.length).trim()); }
    catch { return readinessOverride ? fmtUnavailable(raw, readinessOverride) : raw; }

    // VN unified path
    if (d.vn) {
        const isDeep = raw.includes('--deep') || process.env.FMT_DEEP === '1';
        return isDeep ? fmtDeep(d) : fmtCompact(d);
    }

    // Legacy non-VN path with readiness
    const isDeep = raw.includes('--deep') || process.env.FMT_DEEP === '1';
    const compact = isDeep ? fmtDeep(d) : fmtCompact(d);
    if (!d.vn) {
        const readiness = readinessOverride || d.readiness || {};
        const setupState = d.setup_state || readiness.setup_state || 'UNKNOWN';
        const planStatus = readiness.plan_status || 'WATCH';
        const gateState = readiness.gate_state || 'WAITING';
        const permissionState = readiness.permission_state || 'UNKNOWN';
        const blockers = Array.isArray(readiness.blockers) && readiness.blockers.length
            ? readiness.blockers
            : (readiness.gate_state ? [] : ['NO_GATE_PROOF']);
        const actionable = setupState === 'IN_ZONE'
            && planStatus === 'READY'
            && gateState === 'PASSED'
            && ['ALLOWED', 'REDUCED'].includes(permissionState);
        return compact + '\n' + [
            `SETUP: ${setupState}`,
            `PLAN: ${planStatus}`,
            `GATE: ${gateState}`,
            `PERMISSION: ${permissionState}`,
            ...(blockers.length ? [`BLOCKERS: ${blockers.join(', ')}`] : []),
            `ACTIONABLE: ${actionable ? 'YES' : 'NO'}`,
        ].join('\n');
    }
    return compact;
}

export { fmtCheck, fmtCompact, fmtDeep, num };
