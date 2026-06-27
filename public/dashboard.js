const REGIME_POLL_MS = 400;   // matches the server's 300ms CDP tick loop
const ASIA_POLL_MS   = 15000;
const NEWS_POLL_MS   = 30000;

function fmt(n, dec = 2) {
  if (n == null || Number.isNaN(n)) return '--';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function regimeBadge(p) {
  if (p.regime === 'TRENDING') {
    const arrow = p.trendDir === 'UP' ? '↑' : p.trendDir === 'DOWN' ? '↓' : '';
    return `<span class="badge badge-trend">TRENDING ${arrow}</span>`;
  }
  if (p.regime === 'RANGING') return `<span class="badge badge-range">RANGING</span>`;
  if (p.regime === 'TRANSITIONING') return `<span class="badge badge-mixed">MIXED</span>`;
  return '';
}

function actionBadge(tb) {
  if (!tb) return '';
  if (tb.action === 'CONTINUE') return `<span class="badge badge-continue">CONTINUE ${tb.direction === 'UP' ? '↑' : '↓'} ${tb.strength}</span>`;
  if (tb.action === 'FADE')     return `<span class="badge badge-fade">FADE ${tb.direction === 'UP' ? '↑' : '↓'} ${tb.strength}</span>`;
  return `<span class="badge badge-wait">WAIT</span>`;
}

function reversalBadge(rv) {
  if (!rv || !rv.probability) return '<span class="row"><span class="label">Reversal</span><span class="value">none</span></span>';
  const dir = rv.direction === 'UP' ? 'up' : 'down';
  return `<div class="row"><span class="label">Reversal</span><span class="value ${dir}">${rv.probability} ${rv.direction === 'UP' ? '↑' : '↓'}</span></div>` +
    (rv.triggers && rv.triggers.length ? `<div class="reason">Triggers: ${rv.triggers.join(', ')}</div>` : '');
}

function renderRegimeCard(p) {
  if (!p || p.error) {
    return `<div class="card"><div class="card-title"><span class="symbol">${p ? p.symbol : '--'}</span></div><div class="empty">${p ? p.error : 'no data'}</div></div>`;
  }
  const l = p.layers;
  return `
    <div class="card-title">
      <span class="symbol">${p.symbol}</span>
      <span class="meta">${p.resolution}m · ${p.session}</span>
    </div>
    <div class="row"><span class="label">Regime</span><span>${regimeBadge(p)} <span class="value">${p.confidence}%</span></span></div>
    <div class="row"><span class="label">Structure</span><span class="value">${l.structure.bos ? 'BOS ' + l.structure.bos.toUpperCase() : (l.structure.choch ? 'CHoCH' : 'no BOS')}</span></div>
    <div class="row"><span class="label">ATR ratio</span><span class="value">${fmt(l.priceAction.atrRatio)}</span></div>
    <div class="row"><span class="label">VWAP dev</span><span class="value">${l.priceAction.vwapDev != null ? fmt(l.priceAction.vwapDev) + '%' : 'n/a'}</span></div>
    <div class="row"><span class="label">Vol ratio (20-bar)</span><span class="value">${fmt(l.volume.ratio)}</span></div>
    <div class="row"><span class="label">Wk-hr Vol</span><span class="value">${l.volume.weeklyRatio != null ? fmt(l.volume.weeklyRatio) + 'x' : 'n/a'}</span></div>
    <div class="row"><span class="label">Price</span><span class="value">${fmt(p.close)}</span></div>
    ${reversalBadge(p.reversal)}
    <div class="row" style="margin-top:8px"><span class="label">Action</span><span>${actionBadge(p.tradeBias)}</span></div>
    <div class="reason">${p.tradeBias ? p.tradeBias.reason : ''}</div>
  `;
}

let prevRegimeKeys = {};

async function pollRegime() {
  try {
    const res = await fetch('/api/regime');
    const data = await res.json();
    const container = document.getElementById('regime-cards');
    container.innerHTML = '';

    if (data.error) {
      container.appendChild(el('div', 'card', `<div class="empty">connection error: ${data.error}</div>`));
      return;
    }
    if (!data.now || !data.now.panes || data.now.panes.length === 0) {
      container.appendChild(el('div', 'card', `<div class="empty">waiting for data…</div>`));
      return;
    }

    for (const p of data.now.panes) {
      const card = el('div', 'card', renderRegimeCard(p));
      const key = p.symbol + ':' + p.regime + ':' + (p.trendDir || '');
      if (prevRegimeKeys[p.symbol] && prevRegimeKeys[p.symbol] !== key) card.classList.add('flash');
      prevRegimeKeys[p.symbol] = key;
      container.appendChild(card);
    }
  } catch (err) {
    document.getElementById('regime-cards').innerHTML = `<div class="card"><div class="empty">fetch failed: ${err.message}</div></div>`;
  }
}

function renderAsiaCard(key, idx) {
  if (!idx || idx.error) {
    return el('div', 'card idx-card', `<div class="card-title"><span class="symbol">${key}</span></div><div class="empty">${idx ? idx.error : 'no data'}</div>`);
  }
  const dir = idx.changePct < 0 ? 'down' : 'up';
  const card = el('div', 'card idx-card' + (idx.bigDrop ? ' big-drop' : ''),
    `<div class="card-title"><span class="symbol">${idx.name}</span><span class="meta">${key}</span></div>` +
    `<div class="change ${dir}">${idx.changePct > 0 ? '+' : ''}${fmt(idx.changePct)}%</div>` +
    `<div class="row"><span class="label">Price</span><span class="value">${fmt(idx.price)}</span></div>` +
    `<div class="row"><span class="label">Prev close</span><span class="value">${fmt(idx.prevClose)}</span></div>` +
    (idx.bigDrop ? `<div class="alert">⚠ Big drop — possible MNQ spillover risk</div>` : '')
  );
  return card;
}

async function pollAsia() {
  try {
    const res = await fetch('/api/asia');
    const data = await res.json();
    const container = document.getElementById('asia-cards');
    container.innerHTML = '';
    for (const key of Object.keys(data)) {
      if (key.startsWith('_')) continue;
      container.appendChild(renderAsiaCard(key, data[key]));
    }
  } catch (err) {
    document.getElementById('asia-cards').innerHTML = `<div class="card"><div class="empty">fetch failed: ${err.message}</div></div>`;
  }
}

function renderOilCard(label, oil) {
  if (!oil || oil.error) return el('div', 'card idx-card', `<div class="card-title"><span class="symbol">${label}</span></div><div class="empty">${oil ? oil.error : 'no data'}</div>`);
  const dir = oil.changePct < 0 ? 'down' : 'up';
  return el('div', 'card idx-card',
    `<div class="card-title"><span class="symbol">${label}</span></div>` +
    `<div class="change ${dir}">${oil.changePct > 0 ? '+' : ''}${fmt(oil.changePct)}%</div>` +
    `<div class="row"><span class="label">Price</span><span class="value">$${fmt(oil.price)}</span></div>`
  );
}

function renderNewsTopic(topic, items) {
  const col = el('div', 'news-topic');
  col.appendChild(el('h3', null, topic));
  if (!items || items.length === 0 || items[0].error) {
    col.appendChild(el('div', 'empty', items && items[0] && items[0].error ? items[0].error : 'no items'));
    return col;
  }
  for (const item of items) {
    col.appendChild(el('div', 'news-item',
      `<a href="${item.link}" target="_blank" rel="noopener">${item.title}</a><br>` +
      `<span class="src">${item.source || ''} · ${item.published || ''}</span>`
    ));
  }
  return col;
}

async function pollNews() {
  try {
    const res = await fetch('/api/news');
    const data = await res.json();

    const oilContainer = document.getElementById('oil-cards');
    oilContainer.innerHTML = '';
    if (data.oil) {
      for (const label of Object.keys(data.oil)) {
        oilContainer.appendChild(renderOilCard(label, data.oil[label]));
      }
    }

    const newsContainer = document.getElementById('news-columns');
    newsContainer.innerHTML = '';
    if (data.topics) {
      for (const topic of Object.keys(data.topics)) {
        newsContainer.appendChild(renderNewsTopic(topic, data.topics[topic]));
      }
    }
  } catch (err) {
    document.getElementById('news-columns').innerHTML = `<div class="empty">fetch failed: ${err.message}</div>`;
  }
}

function tickClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}

setInterval(tickClock, 1000);
setInterval(pollRegime, REGIME_POLL_MS);
setInterval(pollAsia, ASIA_POLL_MS);
setInterval(pollNews, NEWS_POLL_MS);

tickClock();
pollRegime();
pollAsia();
pollNews();
