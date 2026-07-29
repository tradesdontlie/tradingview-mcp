// fmt_check.mjs — canonical VN /check renderer plus legacy non-VN formatting.

const num = value => (value == null ? '?' : Number(value).toLocaleString('en-US'));
const STRUCTURE_V2_VERSION = 'vn-structure-v2-channel-20-3-005-2';
const MANUAL_CHECKS = [
    ['M15_CLOSED_NOT_BEARISH', 'M15 closed not bearish'],
    ['H6_LIVE_NO_UPTHRUST', 'H6 no upthrust/distribution'],
    ['FOOTPRINT_NO_SELL_IMBALANCE', 'Footprint no sell imbalance'],
    ['DELTA_NO_BEARISH_DIVERGENCE', 'Delta no bearish divergence'],
    ['PM_PROFILE_CONFIRMATION', 'PM Profile confirmation'],
];

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

function uniqueCodes(values) {
    return [...new Set(values.filter(value => typeof value === 'string' && value.length))];
}

function fmtVn(d, readinessOverride) {
    const vn = d.vn || {};
    const setup = vn.setup || {};
    const history = vn.h6_history || {};
    const live = vn.h6_live || {};
    const structure = history.structure_v2 || {};
    const ready = readinessOverride || {};
    const setupState = ready.setup_state || vn.setup_state || 'UNKNOWN';
    const planStatus = readinessOverride ? ready.plan_status || 'WATCH' : 'WATCH';
    const gateState = readinessOverride ? ready.gate_state || 'WAITING' : 'WAITING';
    const permissionState = readinessOverride ? ready.permission_state || 'UNKNOWN' : 'UNKNOWN';
    const blockers = uniqueCodes([
        ...(Array.isArray(vn.blockers) ? vn.blockers : []),
        ...(Array.isArray(vn.auto_core?.blockers) ? vn.auto_core.blockers : []),
        ...(Array.isArray(ready.blockers) ? ready.blockers : []),
    ]);
    const structureWellFormed = structure.version === STRUCTURE_V2_VERSION
        && ['UP', 'DOWN', 'RANGE', 'MIXED'].includes(structure.trend_state)
        && ['EXPANDING', 'CONTRACTING', 'STABLE', 'SHIFTING'].includes(structure.range_state);
    const structureConfirmed = structureWellFormed && structure.confirmed === true;
    const actionable = structureConfirmed
        && setupState === 'IN_ZONE'
        && planStatus === 'READY'
        && gateState === 'PASSED'
        && ['ALLOWED', 'REDUCED'].includes(permissionState)
        && blockers.length === 0;
    const hardNoBuy = !structureWellFormed
        || permissionState === 'BLOCKED'
        || ['INVALIDATED', 'GAP_THROUGH'].includes(setupState)
        || blockers.some(code => [
            'BELOW_SMA100', 'SYMBOL_MISMATCH', 'TIMEFRAME_MISMATCH',
            'TIMEFRAME_UNCONFIRMED', 'STRUCTURE_V2_INVALID',
        ].includes(code));
    const action = actionable ? 'CHECK TAY TRUOC KHI MUA' : (hardNoBuy ? 'KHONG MUA' : 'CHO DOI');

    const setupMissing = uniqueCodes([
        ...blockers.filter(code => code === 'NO_SETUP' || code.startsWith('STRUCTURE_')),
        ...(setup.setup ? [] : ['NO_SETUP']),
        ...(structureWellFormed ? [] : ['STRUCTURE_V2_INVALID']),
        ...(structureWellFormed && !structureConfirmed ? ['STRUCTURE_NOT_CONFIRMED'] : []),
    ]);
    const buyMissing = actionable ? [] : uniqueCodes([
        ...blockers,
        ...(setupState === 'IN_ZONE' ? [] : [`SETUP_${setupState}`]),
        ...(planStatus === 'READY' ? [] : [`PLAN_${planStatus}`]),
        ...(gateState === 'PASSED' ? [] : [`GATE_${gateState}`]),
        ...(['ALLOWED', 'REDUCED'].includes(permissionState) ? [] : [`PERMISSION_${permissionState}`]),
        ...(structureWellFormed ? [] : ['STRUCTURE_V2_INVALID']),
        ...(structureWellFormed && !structureConfirmed ? ['STRUCTURE_NOT_CONFIRMED'] : []),
    ]);
    const trigger = actionable
        ? 'MANUAL_CHECKS_ALL_PASS'
        : (vn.plan_scenario?.trigger || buyMissing[0] || setupMissing[0] || 'WAIT_FOR_CANONICAL_STATE');
    const invalidation = vn.plan_scenario?.invalidation
        || (hardNoBuy ? (buyMissing[0] || 'STRUCTURE_V2_INVALID') : 'STRUCTURE_OR_DATA_STATE_CHANGES');
    const asOf = structure.as_of || d.as_of || d.generated_at || d.date || '?';
    const structureState = `${structure.trend_state || 'UNKNOWN'}/${structure.range_state || 'UNKNOWN'}`;
    const confirmation = structure.confirmed === true ? 'CONFIRMED' : 'PROVISIONAL';
    const manualByCode = new Map(
        (Array.isArray(vn.manual_checks) ? vn.manual_checks : [])
            .filter(item => item && item.code)
            .map(item => [item.code, item]),
    );
    const manualLines = MANUAL_CHECKS.map(([code, label]) => {
        const item = manualByCode.get(code) || {};
        const value = item.value ?? item.result ?? item.status ?? 'N/A - KIEM TRA TAY';
        return `[ ] ${label}: ${value}`;
    });
    const volRatio = Number.isFinite(Number(live.vol_ratio)) ? `${Number(live.vol_ratio).toFixed(2)}x` : '?';

    return [
        'QUYET DINH',
        `${d.ticker || '?'} H6 | as_of ${asOf} | ACTION: ${action}`,
        `SETUP: ${setup.setup || 'NONE'} | STATE: ${setupState} | STRUCTURE: ${structureState} - ${confirmation}`,
        `PLAN: ${planStatus} | GATE: ${gateState} | PERMISSION: ${permissionState}`,
        `THIEU DE CO SETUP: ${setupMissing.length ? setupMissing.join(', ') : 'none'}`,
        `THIEU DE XEM XET MUA: ${buyMissing.length ? buyMissing.join(', ') : 'none'}`,
        'HANH DONG',
        `TRIGGER: ${trigger}`,
        `ACTION: ${action}`,
        'DIEU KIEN VO HIEU',
        invalidation,
        'BANG CHUNG',
        `PRICE ${num(d.price)} | SMA20 ${num(history.sma20)} | SMA100 ${num(history.sma100)} | VOL ${volRatio} | WINDOW ${vn.entry_window?.window || '?'} | H6 BARS ${history.bars_completed ?? '?'}`,
        ...manualLines,
    ].join('\n');
}

function fmtCompact(d, readinessOverride) {
    if (d.vn) return fmtVn(d, readinessOverride);

    const fp = d.fp || {};
    const wave = d.wave || {};
    const trail = d.trail || {};
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
        for (const scenario of (d.scenarios || [])) {
            if (scenario.tplus_warn) lines.push(`⚠️ ${scenario.label}: SL ${scenario.sl_atr}xATR, RR-ket ${scenario.rr_locked ?? '?'}`);
        }
    }
    lines.push(`SMA20 ${num((d.ma || {}).sma20)} | SMA100 ${num((d.ma || {}).sma100)}`);
    return lines.join('\n');
}

function fmtDeep(d, readinessOverride) {
    if (d.vn) return fmtVn(d, readinessOverride);
    const lines = fmtCompact(d, readinessOverride).split('\n');
    if (d.vsa_churn) lines.push(`VSA Churn: ${d.vsa_churn.flag ? '⚠️' : '✅'} ${d.vsa_churn.note || ''}`);
    if (d.topbot?.pattern) lines.push(`TopBot: ${d.topbot.pattern} (${d.topbot.side}) ${d.topbot.confirmed ? '✅' : '⏳'}`);
    if (d.price_limit?.board) lines.push(`Gia: ${num(d.price)} | Tran ${num(d.price_limit.ceiling)} | San ${num(d.price_limit.floor)} | ${d.price_limit.pct_from_ref}%`);
    if (d.htf) lines.push(`Weekly: ${d.htf.trend} (${d.htf.weeks || '?'}W)`);
    if (d.overhead) lines.push(`Overhead: ${num(d.overhead.resistance) || '?'} (headroom ${d.overhead.headroom_pct ?? '?'}%)`);
    if (d.avg_vol20) lines.push(`AvgVol20: ${num(d.avg_vol20)}`);
    return lines.join('\n');
}

function fmtCheck(raw, readinessOverride) {
    const idx = raw.indexOf('DATA_JSON:');
    if (idx === -1) return readinessOverride ? fmtUnavailable(raw, readinessOverride) : raw;
    let data;
    try {
        data = JSON.parse(raw.slice(idx + 'DATA_JSON:'.length).trim());
    } catch {
        return readinessOverride ? fmtUnavailable(raw, readinessOverride) : raw;
    }
    const deep = raw.includes('--deep') || process.env.FMT_DEEP === '1';
    if (data.vn) return deep ? fmtDeep(data, readinessOverride) : fmtCompact(data, readinessOverride);

    const compact = deep ? fmtDeep(data) : fmtCompact(data);
    const readiness = readinessOverride || data.readiness || {};
    const setupState = data.setup_state || readiness.setup_state || 'UNKNOWN';
    const planStatus = readiness.plan_status || 'WATCH';
    const gateState = readiness.gate_state || 'WAITING';
    const permissionState = readiness.permission_state || 'UNKNOWN';
    const blockers = Array.isArray(readiness.blockers) && readiness.blockers.length
        ? readiness.blockers
        : (readiness.gate_state ? [] : ['NO_GATE_PROOF']);
    const actionable = setupState === 'IN_ZONE' && planStatus === 'READY'
        && gateState === 'PASSED' && ['ALLOWED', 'REDUCED'].includes(permissionState);
    return `${compact}\n${[
        `SETUP: ${setupState}`,
        `PLAN: ${planStatus}`,
        `GATE: ${gateState}`,
        `PERMISSION: ${permissionState}`,
        ...(blockers.length ? [`BLOCKERS: ${blockers.join(', ')}`] : []),
        `ACTION: ${actionable ? 'YES' : 'NO'}`,
    ].join('\n')}`;
}

export { fmtCheck, fmtCompact, fmtDeep, num };
