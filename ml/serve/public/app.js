const POLL_MS = 15000;

function probClass(p) {
  if (p == null) return '';
  if (p >= 0.6) return 'high';
  if (p >= 0.45) return 'mid';
  return 'low';
}

function fmtProb(p) {
  return p == null ? '—' : (p * 100).toFixed(1) + '%';
}

function renderCard(key, pred) {
  if (pred.status === 'no_model') {
    return `
      <div class="card">
        <h2>${pred.symbol} · ${pred.timeframe}</h2>
        <div class="flags">no trained model yet</div>
      </div>
    `;
  }

  const flags = Object.entries(pred.context_flags || {})
    .filter(([, v]) => v)
    .map(([k]) => k.replace(/_/g, ' '))
    .join(', ') || 'none';

  return `
    <div class="card">
      <h2>${pred.symbol} · ${pred.timeframe}</h2>
      <div class="row"><span class="label">entry</span><span>${pred.entry?.toFixed(2) ?? '—'}</span></div>
      <div class="row"><span class="label">long TP first</span><span class="prob ${probClass(pred.prob_long_tp)}">${fmtProb(pred.prob_long_tp)}</span></div>
      <div class="row"><span class="label">short TP first</span><span class="prob ${probClass(pred.prob_short_tp)}">${fmtProb(pred.prob_short_tp)}</span></div>
      <div class="row"><span class="label">tp/sl</span><span>${pred.tp_points}/${pred.sl_points}pt (${pred.tp_ticks}/${pred.sl_ticks} ticks, ${pred.horizon_bars} bars)</span></div>
      <div class="flags">active flags: ${flags}</div>
    </div>
  `;
}

async function poll() {
  try {
    const res = await fetch('/api/predictions');
    const data = await res.json();
    const cards = document.getElementById('cards');
    const entries = Object.entries(data.predictions || {});
    cards.innerHTML = entries.length
      ? entries.map(([key, pred]) => renderCard(key, pred)).join('')
      : '<div class="error">No predictions yet — waiting for first poll cycle (or no trained models found).</div>';
    document.getElementById('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    document.getElementById('updated').textContent = `poll failed: ${err.message}`;
  }
}

poll();
setInterval(poll, POLL_MS);
