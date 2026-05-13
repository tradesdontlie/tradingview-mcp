/**
 * Fixtures representing the TradingView Strategy Tester report DOM.
 * Values taken from a live TV Desktop 3.1.0.7818 session (2026-05-13).
 * Class hashes (e.g. -hIlv5It8) rotate between builds — tests rely on
 * the [class*="..."] substring selectors used in src/core/data.js.
 */

export const POPULATED_REPORT_HTML = `
<div class="reportContainer-hIlv5It8">
  <div class="containerCell-aB1c2D3e">
    <div class="title-xY9z8W7v">Total P&amp;L</div>
    <div class="positiveValue-pQrStUvW">+15,437.00USD+1.54%</div>
  </div>
  <div class="containerCell-aB1c2D3e">
    <div class="title-xY9z8W7v">Max equity drawdown</div>
    <div class="value-mNoPqRsT">7,256.00</div>
  </div>
  <div class="containerCell-aB1c2D3e">
    <div class="title-xY9z8W7v">Total trades</div>
    <div class="value-mNoPqRsT">748</div>
  </div>
  <div class="containerCell-aB1c2D3e">
    <div class="title-xY9z8W7v">Profitable trades</div>
    <div class="value-mNoPqRsT">33.29%</div>
  </div>
  <div class="containerCell-aB1c2D3e">
    <div class="title-xY9z8W7v">Profit factor</div>
    <div class="value-mNoPqRsT">1.172</div>
  </div>
</div>
`;

export const POPULATED_METRICS = {
  'Total P&L': '+15,437.00USD+1.54%',
  'Max equity drawdown': '7,256.00',
  'Total trades': '748',
  'Profitable trades': '33.29%',
  'Profit factor': '1.172',
};

export const EMPTY_REPORT_HTML = `
<div class="someOtherPanel-foo"></div>
`;
