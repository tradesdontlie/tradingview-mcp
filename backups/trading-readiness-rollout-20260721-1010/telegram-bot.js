// telegram-bot.js - PULL bot: chay /scan, /check tu phone khi vang PC.
// Token/chat tu env TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (User level), KHONG hardcode.
// Can: PC bat + TradingView Desktop mo (scan/check lai CDP 9222).

import https from 'https';
import { execFile } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fmtCheck } from './fmt_check.mjs';

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT_ID) {
    console.error('Thieu env TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
    process.exit(1);
}
const API      = `https://api.telegram.org/bot${TOKEN}`;
const CWD      = 'C:\\Users\\ADMIN\\tradingview-mcp';
const COS_PY   = 'C:\\Users\\ADMIN\\claude_os\\cos.py';
const TIMEOUT  = 180_000;   // scan 5 ma qua CDP co the cham
const TG_LIMIT = 3900;

const HELP = [
    'Lenh kha dung:',
    '/scan - quet watchlist footprint (GMD ACB VND OCB HCM)',
    '/check MA - soi sau 1 ma, vd: /check ACB',
    '/ask cau hoi - hoi DeepSeek flash (nhanh, re), vd: /ask PE la gi',
    '/plans - liet ke trade plan tu journal.db (READY/WATCH/AVOID)',
    '/help - tin nay',
    'Luu y: can PC bat + TradingView Desktop dang mo (/scan /check). /ask can PC bat + proxy LiteLLM.',
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
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
        });
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

function runScript(script, args) {
    return new Promise(resolve => {
        execFile('node', [script, ...args], { cwd: CWD, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                const out = stripAnsi((stdout || '') + (stderr ? `\n[stderr] ${stderr}` : '')).trim();
                if (err && !out) return resolve(`LOI: ${err.message}`);
                resolve(out || '(khong co output)');
            });
    });
}

// /ask -> DeepSeek flash qua cos.py ask. Prompt ghi file tam, lay STDOUT (cau tra loi).
function runAsk(prompt) {
    return new Promise(resolve => {
        const tmp = join(tmpdir(), `ask_${Date.now()}.txt`);
        try { writeFileSync(tmp, prompt, 'utf8'); }
        catch (e) { return resolve(`LOI ghi prompt: ${e.message}`); }
        execFile('python', [COS_PY, 'ask', '--model', 'flash', '--file', tmp],
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

async function handle(text) {
    const [cmd, ...rest] = text.trim().split(/\s+/);
    const c = cmd.toLowerCase();
    if (c === '/start' || c === '/help') return sendMsg(HELP);
    if (c === '/plans') {
        const out = await new Promise(resolve => {
            execFile('python', [COS_PY, 'plans'], { cwd: CWD, timeout: TIMEOUT, maxBuffer: 1024 * 1024 },
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
        if (busy) return sendMsg('Dang chay lenh khac, cho xong da.');
        busy = true;
        await sendMsg('DeepSeek dang nghi...');
        const out = await runAsk(prompt);
        busy = false;
        return sendMsg(out);
    }
    if (c === '/scan') {
        if (busy) return sendMsg('Dang chay lenh khac, cho xong da.');
        busy = true;
        await sendMsg('Dang scan watchlist (1-3 phut)...');
        const out = await runScript('scan_live.mjs', []);
        busy = false;
        return sendMsg(out);
    }
    if (c === '/check') {
        const ma = (rest[0] || '').toUpperCase().replace(/[^A-Z0-9:]/g, '');
        if (!ma) return sendMsg('Thieu ma. Vd: /check ACB');
        if (busy) return sendMsg('Dang chay lenh khac, cho xong da.');
        busy = true;
        await sendMsg(`Dang check ${ma}...`);
        const out = await runScript('check_one.mjs', [ma.includes(':') ? ma : `HOSE:${ma}`]);
        busy = false;
        return sendMsg(fmtCheck(out));
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

console.log('=== Telegram PULL bot: /scan /check (CDP) ===');
sendMsg('Bot online. /help de xem lenh.').catch(() => {});
poll();
