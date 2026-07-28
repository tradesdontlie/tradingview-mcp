// fmt_check.mjs — format check output for Telegram/display
// VN unified output and legacy non-VN paths

const num = v => (v == null ? '?' : Number(v).toLocaleString('en-US'));

function fmtUnavailable(raw, readiness = {}) {
    const blockers = Array.isArray(readiness.blockers) && readiness.blockers.length
        ? readiness.blockers
        : ['ENGINE_DATA_UNAVAILABLE'];
    return [
        raw,
        `SETUP: ${readiness.setup_state || 'UNKNOWN'}`,
        `PLAN: ${readiness.plan_status || 'UNKNOWN'}`,
        `GATE: ${readiness.gate_state || 'BLOCKED'}`,
        `PERMISSION: ${readiness.permission_state || 'UNKNOWN'}`,
        `BLOCKERS: ${blockers.join(', ')}`,
        'ACTION: NO',
    ].join('\n');
}

function fmtCompact(d) {
    const fp = d.fp || {};
    const wave = d.wave || {};
    const trail = d.trail || {};

    // VN unified check output
    if (d.vn) {
        const vn = d.vn;
        const vnSetup = vn.setup || {};
        const vnLive = vn.h6_live || {};

        // Readiness state from vn block
        const setupState = vn.setup_state || 'UNKNOWN';
        // blockers define readiness — no separate plan_status/gate_state here (computed in task 5)
        const blockers = Array.isArray(vn.blockers) ? vn.blockers : [];
        const hasHardBlock = blockers.length > 0;
        const planStatus = hasHardBlock ? 'BLOCKED' : (setupState === 'IN_ZONE' ? 'WATCH' : 'NONE');
        const gateState = 'WAITING'; // gate is task 5
        const windowOk = vn.window_ok !== false;

        const lines = [
            `📊 ${d.ticker} ${num(d.price)} (${d.date})`,
            `CONTEXT: ${vn.h6_history.structure || '?'} | SMA100 ${num(vn.h6_history.sma100)} | SMA20 ${num(vn.h6_history.sma20)}`,
            `SETUP: ${vnSetup.setup || 'NONE'}${vnSetup.anchor ? ' @ ' + vnSetup.anchor : ''}`,
            `H6 VSA: ${vnLive.vsa_churn ? '⚠️ Churn' : 'Neutral'} | Vol ${vnLive.vol_ratio != null ? (vnLive.vol_ratio * 100).toFixed(0) + '%' : '?'} / Avg20 ${num(vn.h6_history.avg_vol_20)}`,
            `FOOTPRINT: Buy ${vnLive.buy_pct ?? '?'}% | Bar Delta ${num(vnLive.bar_vol_delta)} | Delta% ${vnLive.delta_pct ?? '?'}% | B${vnLive.buy_stack ?? '?'}/S${vnLive.sell_stack ?? '?'} | Div ${vnLive.divergence ?? 0}`,
            `LTF SAFETY: ${vn.locked_ltf?.locked ? '✅ Locked' : (vn.locked_ltf?.reason || 'N/A')}`,
            `TIME: ${vn.entry_window?.window || '?'}${vn.entry_window?.priority ? ' [Priority]' : ''}`,
            `ENTRY: ${vnSetup.zone_low != null ? `${num(vnSetup.zone_low)}-${num(vnSetup.zone_high)}` : 'N/A'} | SL: ${num(vn.exit_policy?.sl)}`,
            `EXIT: ${vn.exit_policy?.trail || '?'}`,
            `PLAN: ${planStatus}`,
            `GATE: ${gateState}`,
        ];
        if (vn.pm_profile?.poc != null) {
            lines.push(`PM PROFILE: POC ${num(vn.pm_profile.poc)} VAH ${num(vn.pm_profile.vah)} VAL ${num(vn.pm_profile.val)} (${vn.pm_profile.profile_month})`);
        }
        if (blockers.length) {
            lines.push(`BLOCKERS: ${blockers.join(', ')}`);
        } else if (setupState === 'IN_ZONE' && windowOk) {
            lines.push('ACTION: WATCH — cho tin hieu xac nhan');
        } else if (setupState === 'NO_SETUP') {
            lines.push('ACTION: KHONG CO SETUP');
        } else {
            lines.push('ACTION: CHO');
        }
        return lines.join('\n');
    }

    // Legacy non-VN compact
    const tp = wave.tp || {};
    const checks = fp.checks || {};
    const passed = Object.values(checks).filter(Boolean).length;
    const lines = [
        `📊 ${d.ticker} ${num(d.price)} (${d.date})`,
        `Conf ${fp.conf ?? '?'}/100 | Checks ${passed}/${Object.keys(checks).length || '?'} | Score ${fp.score ?? '?'}`,
        `CumDelta ${num(fp.cumD)} | Buy ${fp.buyPct ?? '?'}% | Div ${fp.div ?? 0}`,
        `Cau truc: ${d.structure || '?'} | Wave: ${wave.phase || '?'}`,
        `Trail: ${trail.status || '?'} (SMA20 ${num(trail.sma20_current)})`,
        `TP: ${num(tp.tp100)} / ${num(tp.tp1272)} / ${num(tp.tp1618)}`,
    ];
    const notes = ((d.mtf || {}).notes || []).join(', ');
    if (notes) lines.push(`MTF: ${notes}`);
    if (d.tplus) {
        lines.push(`T+: khoa ${d.tplus.lock_sessions} phien | nhieu ~${d.tplus.floor_pct}% | ${d.tplus.exit_rule}`);
        for (const s of (d.scenarios || [])) {
            if (s.tplus_warn) lines.push(`⚠️ ${s.label}: SL ${s.sl_atr}xATR, RR-ket ${s.rr_locked ?? '?'}`);
        }
    }
    lines.push(`SMA20 ${num((d.ma || {}).sma20)} | SMA100 ${num((d.ma || {}).sma100)}`);
    return lines.join('\n');
}

function fmtDeep(d) {
    const compact = fmtCompact(d);
    const lines = compact.split('\n');

    // VN deep: add diagnostics
    if (d.vn) {
        const vn = d.vn;
        if (vn.h6_live) {
            lines.push(`H6 LIVE: price=${num(vn.h6_live.price)} vs_sma20=${vn.h6_live.location_vs_sma20 ?? '?'}% vs_sma100=${vn.h6_live.location_vs_sma100 ?? '?'}%`);
            lines.push(`FOOTPRINT: conf=${vn.h6_live.footprint_conf ?? '?'} cum_delta=${num(vn.h6_live.cum_delta)}`);
        }
        if (vn.ma_anchor) {
            lines.push(`MA GATE: allowed=${vn.ma_anchor.allowed} anchor=${vn.ma_anchor.anchor || '?'} ext=${vn.ma_anchor.extension_pct ?? '?'}% blocker=${vn.ma_anchor.blocker || 'none'}`);
        }
        if (vn.locked_ltf?.checks) {
            for (const [k, c] of Object.entries(vn.locked_ltf.checks)) {
                lines.push(`LTF ${k}: ok=${c.ok} closed=${c.closed} failures=${(c.failures || []).join(',') || 'none'}`);
            }
        }
        if (vn.exit_policy) {
            lines.push(`EXIT: sl=${num(vn.exit_policy.sl)} trail=${vn.exit_policy.trail || '?'}`);
        }
        return lines.join('\n');
    }

    // Legacy deep
    if (d.vsa_churn) lines.push(`VSA Churn: ${d.vsa_churn.flag ? '⚠️' : '✅'} ${d.vsa_churn.note || ''}`);
    if (d.topbot?.pattern) {
        lines.push(`TopBot: ${d.topbot.pattern} (${d.topbot.side}) ${d.topbot.confirmed ? '✅' : '⏳'}`);
    }
    if (d.price_limit?.board) {
        lines.push(`Gia: ${num(d.price)} | Tran ${num(d.price_limit.ceiling)} | San ${num(d.price_limit.floor)} | ${d.price_limit.pct_from_ref}%`);
    }
    if (d.htf) lines.push(`Weekly: ${d.htf.trend} (${d.htf.weeks || '?'}W)`);
    if (d.overhead) lines.push(`Overhead: ${num(d.overhead.resistance) || '?'} (headroom ${d.overhead.headroom_pct ?? '?'}%)`);
    if (d.avg_vol20) lines.push(`AvgVol20: ${num(d.avg_vol20)}`);
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

    // Legacy non-VN path — readiness from override or d.readiness
    const isDeep = raw.includes('--deep') || process.env.FMT_DEEP === '1';
    const compact = isDeep ? fmtDeep(d) : fmtCompact(d);
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
        `ACTION: ${actionable ? 'YES' : 'NO'}`,
    ].join('\n');
}

export { fmtCheck, fmtCompact, fmtDeep, num };
