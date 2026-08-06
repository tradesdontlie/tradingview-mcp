// telegram-bot.js - PULL bot: chay /scan, /check tu phone khi vang PC.
// Token/chat tu env TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (User level), KHONG hardcode.
// Can: PC bat + TradingView Desktop mo (scan/check lai CDP 9222).

import https from 'https';
import { execFile } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fmtCheck } from './fmt_check.mjs';

process.env.COS_AGENT = process.env.COS_AGENT || 'codex';

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TEST_MODE = process.env.TELEGRAM_BOT_TEST === '1';
if ((!TOKEN || !CHAT_ID) && !TEST_MODE) {
    console.error('Thieu env TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
    process.exit(1);
}
const API      = `https://api.telegram.org/bot${TOKEN}`;
const CWD      = 'C:\\Users\\ADMIN\\tradingview-mcp';
const COS_PY   = 'C:\\Users\\ADMIN\\claude_os\\cos.py';
const SCAN_LATEST = 'C:\\Users\\ADMIN\\claude_os\\data\\scan_latest.json';
const PYTHON   = process.env.TRADING_PYTHON || 'C:\\Python314\\python.exe';
const TIMEOUT  = 180_000;
const TG_LIMIT = 3900;
const TG_REQUEST_TIMEOUT = 30_000;

const HELP = [
    'Lenh kha dung:',
    '/scan - quet watchlist quyet dinh qua pipeline H6 canonical',
    '/check MA - soi sau 1 ma, vd: /check ACB',
    '/ask cau hoi - hoi DeepSeek flash (nhanh, re), vd: /ask PE la gi',
    '/plans - liet ke trade plan tu journal.db (READY/WATCH/AVOID)',
    '/help - tin nay',
    'Luu y: /scan /check chi doc va fail-closed, khong dat lenh. Can PC bat + TradingView Desktop dang mo; /ask can proxy LiteLLM.',
].join('\n');

function tgRequest(method, params) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(params);
        const req = https.request(`${API}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const payload = JSON.parse(data);
                    if (!payload.ok) return reject(new Error(payload.description || `Telegram ${method} failed`));
                    resolve(payload);
                } catch {
                    reject(new Error(`Telegram ${method} returned invalid JSON`));
                }
            });
        });
        req.setTimeout(TG_REQUEST_TIMEOUT, () => req.destroy(new Error('Telegram request timeout')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function sendMsg(text) {
    // Telegram gioi han 4096/tin -> cat khuc
    for (let i = 0; i < text.length; i += TG_LIMIT) {
        await tgRequest('sendMessage', { chat_id: CHAT_ID, text: text.slice(i, i + TG_LIMIT) });
    }
}

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function runScript(script, args, execute = execFile) {
    return new Promise(resolve => {
        execute('node', [script, ...args], { cwd: CWD, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                const out = stripAnsi((stdout || '') + (stderr ? `\n[stderr] ${stderr}` : '')).trim();
                if (err) return resolve(`LOI: engine command failed: ${err.message}`);
                resolve(out || '(khong co output)');
            });
    });
}

function formatCanonicalScan(payload) {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    if (payload?.engine_version !== 'h6-footprint-v3' || results.length === 0 ||
        results.some(row => row?.engine_version !== 'h6-footprint-v3')) {
        throw new Error('canonical scan artifact is invalid');
    }
    const allowedSignals = new Set(['BUY', 'WATCH', 'AVOID', 'N/A']);
    const tickers = results.map(row => String(row?.ticker || '').trim().toUpperCase());
    if (results.some(row => !allowedSignals.has(row?.signal)) || tickers.some(ticker => !ticker) ||
        new Set(tickers).size !== tickers.length) {
        throw new Error('canonical scan artifact has invalid signals/tickers');
    }
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const numericEvidence = ['score_pct', 'cum_delta', 'buy_pct', 'div_signal', 'max_buy_stack',
        'price', 'sma20', 'sma100', 'market_adj', 'rank_score', 'bar_age_pct'];
    const booleanEvidence = ['above_ma20', 'ma20_slope_ok', 'bar_closed', 'churn'];
    const regimes = new Set(['RISK_ON', 'NEUTRAL', 'RISK_OFF']);
    const sessionPhases = new Set(['ATO', 'EARLY', 'CONT_AM', 'LUNCH', 'CONT_PM', 'ATC', 'CLOSED']);
    const scanPhases = new Set(['IMPULSE', 'PULLBACK', 'DOWNTREND', 'SIDEWAYS']);
    for (const row of results.filter(item => item.signal !== 'N/A')) {
        const conf = row.conf_score ?? row.conf;
        const expectedQuality = row.bar_closed === true ? 'CONFIRMED' : 'PROVISIONAL';
        if (!Array.isArray(row.missing_fields) || row.missing_fields.length || !finite(conf) ||
            numericEvidence.some(field => !finite(row[field])) ||
            booleanEvidence.some(field => typeof row[field] !== 'boolean') ||
            !regimes.has(row.market_regime) || !sessionPhases.has(row.session_phase) ||
            !new Set(['HIGH', 'LOW']).has(row.session_trust) || !scanPhases.has(row.phase) ||
            ((row.phase === 'IMPULSE' || row.phase === 'PULLBACK') && !finite(row.vol_ratio)) ||
            !Array.isArray(row.decision_reasons) || row.decision_reasons.length === 0 ||
            row.decision_reasons.some(reason => typeof reason !== 'string' || reason.length === 0) ||
            row.signal_quality !== expectedQuality) {
            throw new Error(`canonical directional row is incomplete: ${row.ticker || '?'}`);
        }
    }
    const lines = [`SCAN ${payload.date || '?'} ${payload.scan_time || ''}`.trim()];
    for (const signal of ['BUY', 'WATCH', 'AVOID', 'N/A']) {
        const names = results.filter(row => row?.signal === signal).map(row => row.ticker);
        if (names.length) lines.push(`${signal === 'N/A' ? 'INSUFFICIENT DATA' : signal}: ${names.join(', ')}`);
    }
    lines.push(`Quet ${results.length} ma | engine h6-footprint-v3`);
    return lines.join('\n');
}

function runCanonicalScan(execute = execFile, readArtifact = readFileSync) {
    return new Promise(resolve => {
        execute(PYTHON, [COS_PY, 'scan-discover'],
            { cwd: CWD, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                const out = stripAnsi(stdout || '').trim();
                const error = stripAnsi(stderr || '').trim();
                if (err) return resolve({ ok: false, exit: err.code ?? 1, stdout: out, stderr: error });
                try {
                    const rendered = formatCanonicalScan(JSON.parse(readArtifact(SCAN_LATEST, 'utf8')));
                    resolve({ ok: true, exit: 0, stdout: out, stderr: error, rendered });
                } catch (artifactError) {
                    resolve({ ok: false, exit: 1, stdout: out,
                        stderr: [error, artifactError.message].filter(Boolean).join('\n') });
                }
            });
    });
}

function runDecision(args) {
    return new Promise(resolve => {
        execFile(PYTHON, [COS_PY, 'decision', ...args],
            { cwd: CWD, timeout: TIMEOUT, maxBuffer: 1024 * 1024 },
            (err, stdout, stderr) => {
                const out = stripAnsi(stdout || '').trim();
                const error = stripAnsi(stderr || '').trim();
                if (err || !out) return resolve({ ok: false, error: error || err?.message || 'empty decision output' });
                try { resolve({ ok: true, value: JSON.parse(out) }); }
                catch { resolve({ ok: false, error: 'decision output is not JSON' }); }
            });
    });
}

function readCheckPrice(raw) {
    const marker = 'DATA_JSON:';
    const offset = raw.indexOf(marker);
    if (offset === -1) return null;
    try {
        const price = Number(JSON.parse(raw.slice(offset + marker.length).trim()).price);
        return Number.isFinite(price) ? price : null;
    } catch {
        return null;
    }
}

function proofBlockers(plan) {
    try {
        const proof = typeof plan.gate_result === 'string'
            ? JSON.parse(plan.gate_result)
            : plan.gate_result;
        return Array.isArray(proof?.blockers) ? proof.blockers : [];
    } catch {
        return ['MALFORMED_GATE_PROOF'];
    }
}

async function currentReadiness(ticker, raw, decisionRunner = runDecision) {
    const latest = await decisionRunner(['plan-latest', '--market', 'VN', '--ticker', ticker, '--direction', 'LONG']);
    if (!latest.ok) {
        return {
            plan_status: 'UNKNOWN', gate_state: 'BLOCKED', permission_state: 'BLOCKED',
            blockers: ['PLAN_LOOKUP_UNAVAILABLE'],
        };
    }
    const plan = latest.value;
    const readiness = {
        plan_status: plan.status || 'UNKNOWN',
        gate_state: plan.gate_state || 'WAITING',
        permission_state: 'BLOCKED',
        blockers: proofBlockers(plan),
    };
    if (readiness.plan_status !== 'READY' || readiness.gate_state !== 'PASSED') {
        if (!readiness.blockers.length) readiness.blockers = ['NO_PASSED_GATE_PROOF'];
        return readiness;
    }
    if (!plan.gate_result || (typeof plan.gate_result === 'object' && plan.gate_result.state !== 'PASSED')) {
        readiness.gate_state = 'BLOCKED';
        readiness.permission_state = 'BLOCKED';
        readiness.blockers = [...readiness.blockers, 'MISSING_GATE_PROOF'];
        return readiness;
    }
    const price = readCheckPrice(raw);
    if (price == null) {
        readiness.gate_state = 'BLOCKED';
        readiness.blockers = ['CURRENT_PRICE_UNAVAILABLE'];
        return readiness;
    }
    const permission = await decisionRunner([
        'plan-validate', '--market', 'VN', '--ticker', ticker, '--direction', 'LONG',
        '--version', String(plan.version), '--actual-entry', String(price),
    ]);
    if (!permission.ok) {
        readiness.gate_state = 'BLOCKED';
        readiness.permission_state = 'BLOCKED';
        readiness.blockers = [...readiness.blockers, 'READY_PROOF_INVALID'];
        return readiness;
    }
    readiness.permission_state = permission.value.gate || 'BLOCKED';
    if (readiness.permission_state === 'BLOCKED') {
        readiness.blockers = [...readiness.blockers, ...(permission.value.reasons || [])];
    }
    return readiness;
}

// /ask -> DeepSeek flash qua cos.py ask. Prompt ghi file tam, lay STDOUT (cau tra loi).
function runAsk(prompt) {
    return new Promise(resolve => {
        const tmp = join(tmpdir(), `ask_${Date.now()}.txt`);
        try { writeFileSync(tmp, prompt, 'utf8'); }
        catch (e) { return resolve(`LOI ghi prompt: ${e.message}`); }
        execFile(PYTHON, [COS_PY, 'ask', '--model', 'flash', '--file', tmp],
            { cwd: CWD, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                try { unlinkSync(tmp); } catch {}
                const out = stripAnsi(stdout || '').trim();
                if (out) return resolve(out);
                const e = stripAnsi(stderr || '').trim();
                resolve(e || `LOI: ${err ? err.message : 'DeepSeek khong tra loi'}`);
            });
    });
}

let busy = false;

async function runExclusive(startMessage, work) {
    if (busy) return sendMsg('Dang chay lenh khac, cho xong da.');
    busy = true;
    try {
        await sendMsg(startMessage);
        return await work();
    } finally {
        busy = false;
    }
}

async function handle(text) {
    const [cmd, ...rest] = text.trim().split(/\s+/);
    const c = cmd.toLowerCase();
    if (c === '/start' || c === '/help') return sendMsg(HELP);
    if (c === '/plans') {
        const out = await new Promise(resolve => {
            execFile(PYTHON, [COS_PY, 'plans'], { cwd: CWD, timeout: TIMEOUT, maxBuffer: 1024 * 1024 },
                (err, stdout, stderr) => {
                    const o = stripAnsi(stdout || '').trim();
                    resolve(o || stripAnsi(stderr || '').trim() || `LOI: ${err ? err.message : '?'}`);
                });
        });
        return sendMsg(out);
    }
    if (c === '/ask') {
        const prompt = text.trim().slice(cmd.length).trim();  // giu nguyen xuong dong/khoang trang
        if (!prompt) return sendMsg('Thieu cau hoi. Vd: /ask PE la gi');
        return runExclusive('DeepSeek dang nghi...', async () => sendMsg(await runAsk(prompt)));
    }
    if (c === '/scan') {
        return runExclusive('Dang scan watchlist (1-3 phut)...', async () => {
            const result = await runCanonicalScan();
            if (!result.ok) {
                const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
                return sendMsg(`LOI: scan-discover exit ${result.exit}${detail ? `\n${detail}` : ''}`);
            }
            return sendMsg(result.rendered);
        });
    }
    if (c === '/check') {
        const ma = (rest[0] || '').toUpperCase().replace(/[^A-Z0-9:]/g, '');
        if (!ma) return sendMsg('Thieu ma. Vd: /check ACB');
        return runExclusive(`Dang check ${ma}...`, async () => {
            const out = await runScript('check_one.mjs', [ma.includes(':') ? ma : `HOSE:${ma}`]);
            const ticker = ma.split(':').at(-1);
            const readiness = out.startsWith('LOI:')
                ? { plan_status: 'UNKNOWN', gate_state: 'BLOCKED', permission_state: 'BLOCKED', blockers: ['ENGINE_REFRESH_FAILED'] }
                : await currentReadiness(ticker, out);
            return sendMsg(fmtCheck(out, readiness));
        });
    }
    return sendMsg(`Khong hieu "${cmd}".\n${HELP}`);
}

let offsetId = 0;

async function poll() {
    try {
        const r = await tgRequest('getUpdates', { offset: offsetId, timeout: 25, allowed_updates: ['message'] });
        for (const upd of (r && r.result) || []) {
            offsetId = upd.update_id + 1;
            const msg = upd.message;
            if (!msg || !msg.text) continue;
            if (String(msg.chat.id) !== String(CHAT_ID)) continue; // chi chu bot
            handle(msg.text).catch(e => console.error('handle:', e.message));
        }
    } catch (e) {
        console.error('poll:', e.message);
        await new Promise(r => setTimeout(r, 5000));
    }
    setImmediate(poll);
}

if (!TEST_MODE) {
    console.log('=== Telegram PULL bot: /scan /check (CDP) ===');
    sendMsg('Bot online. /help de xem lenh.').catch(() => {});
    poll();
}

export { currentReadiness, formatCanonicalScan, proofBlockers, runCanonicalScan, runScript };
