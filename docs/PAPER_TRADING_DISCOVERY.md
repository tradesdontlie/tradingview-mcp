# Paper Trading Discovery

Status: **authenticated evidence captured** — Capture 1 (Guest/Linux) plus
Capture 2 (authenticated Paper-connected on Windows Desktop 3.3.0). Native
broker id is `"Paper"`. Implemented in `src/core/paper.js` with fail-closed
mutations.

## Purpose and scope

Map how TradingView Desktop represents its **native Paper Trading**
environment (Trading Panel → Paper Trading provider) so the MCP can later
expose safe `paper_*` tools. This effort supports **only** TradingView's
native Paper Trading. It will never support Binance, Interactive Brokers
(live, demo or paper), any other broker, or any real-money account. Every
future `paper_*` mutation must positively identify the native Paper Trading
provider and fail closed otherwise.

## Authentication model

The human authenticates in TradingView Desktop normally. The MCP never
accepts or automates usernames, passwords, cookies, tokens or API keys. If a
probe shows that TradingView requires login, record that state — do not work
around it.

## Security rules for evidence collection

- Never paste cookies, tokens, authorization headers or storage contents into
  this document, into issues, or into test fixtures.
- `scripts/paper_discovery.js` only reports structural knowledge (names,
  attributes, booleans). It inspects runtime objects through property
  descriptors so accessor getters are never executed, collects no free-form
  element text (only `aria-label` / `data-name` / `role` values), and redacts
  secret-looking keys, token-like strings and email addresses before printing.
  Do not bypass it with ad-hoc probes that dump storage or headers.
- Screenshots attached as evidence must not show account emails or personal
  data. Paper account balances/IDs are acceptable.
- Record structural knowledge only, e.g. "connection state is readable from
  service X", never the secret material itself.

## What the repository already knows (static baseline)

| Touchpoint | Mechanism | Source |
|------------|-----------|--------|
| Open/close Trading Panel button | C — semantic DOM: `data-name="trading-button"`, `aria-label="Trading Panel"` | `src/core/ui.js` |
| Replay-mode simulated trades (NOT Paper Trading) | A — internal API: `window.TradingViewApi._replayApi.buy()/sell()/closePosition()` | `src/core/replay.js` |
| Internal API discovery pattern | method enumeration via `tv_discover` | `src/core/health.js` |

Runtime path (Capture 2): `bottomWidgetBar._widgetControllers.get('paper_trading')._trading`
→ `activeBroker()` → `_brokerMetainfo.id === "Paper"`. Mutations go through
`activeBroker().placeOrder / cancelOrder / modifyOrder / closePosition /
editPositionBrackets`. Connect via `trading.selectBroker("Paper")`.

## Mechanism classification

| Class | Meaning |
|-------|---------|
| A | Internal structured API (e.g. a service method returning data) |
| B | Internal model/store (observable structured state) |
| C | Semantic DOM (`data-name`, `aria-label`, `role`) |
| D | UI automation (clicks/typing on discovered elements) |
| E | Unsupported / unreliable — do not build on it |

Absolute coordinates are for exploration only and are never an acceptable
production mechanism.

## Environment record

Fill this in for every discovery session. Findings are only comparable when
the environment is recorded.

| Field | Value |
|-------|-------|
| TradingView Desktop version | _fill in (Help → About)_ |
| Install type (installer / MSIX / dmg / AppImage) | _fill in_ |
| Operating system + version | _fill in_ |
| CDP endpoint | _default 127.0.0.1:9222_ |
| TradingView session state | _authenticated / login required_ |
| Paper Trading account state | _fresh / has history / reset recently_ |
| Trading Panel state during capture | _closed / open-disconnected / open-connected_ |
| Probe report file | _e.g. paper-discovery-connected.json_ |

### Capture 1 — 2026-08-07 (unauthenticated baseline)

| Field | Value |
|-------|-------|
| TradingView Desktop version | 3.3.0 (Electron 38.2.2, Chrome 140) |
| Install type | snap package, extracted with unsquashfs and run directly |
| Operating system + version | Ubuntu Linux (headless VM, Xvfb display :1) |
| CDP endpoint | 127.0.0.1:9222 |
| TradingView session state | **unauthenticated** (`window.user.username === 'Guest'`, no user id) |
| Paper Trading account state | n/a (not logged in) |
| Trading Panel state during capture | widget registered but disabled; `trading-button` absent from DOM |
| Probe report file | paper-discovery-unauthenticated.json + targeted follow-up probes |

### Capture 2 — 2026-08-07 (authenticated, Paper connected)

| Field | Value |
|-------|-------|
| TradingView Desktop version | 3.3.0 (Electron 38.2.2, Chrome 140) |
| Install type | Windows MSIX (`TradingView.Desktop`) launched with `--remote-debugging-port=9223` |
| Operating system + version | Windows 10/11 |
| CDP endpoint | 127.0.0.1:9223 |
| TradingView session state | **authenticated** (`window.user` has id; username present) |
| Paper Trading account state | has open short position; account type `demo` |
| Trading Panel state during capture | open, `activeWidgetName === 'paper_trading'`, `connectStatus === 1` |
| Probe report file | local `paper-discovery-*.json` captures (gitignored; not committed) |

#### Capture 2 — key confirmed facts

- Native Paper broker stable id: **`Paper`** (`activeBroker()._brokerMetainfo.id`).
- `connectStatus` values confirmed live: `1` Connected (Capture 2), `3` Disconnected (Capture 1).
- Account id via `trading._account` (string) and `activeBroker().currentAccount()`; type `demo` via `currentAccountType()`.
- Account summary via `accountManagerInfo().summary[i].wValue.value()` aligned with `accountsMetainfo[].summaryRow` ids: `balance`, `equity`, `realizedPL`, `unrealizedPL`, `accountMargin`, `availableFunds`, `ordersMargin`, `marginBuffer`.
- Positions: `_positionService.positions()` / `activeBroker().positions()` — fields include `id` (symbol), `side` (±1), `qty`, `avgPrice`, `lastPrice`, `pl`, `extra.{pl,plPercent,usedMargin,leverage,accountCurrency}`, bracket flags.
- Orders: `_ordersService.activeOrders()`; history via `activeBroker().ordersHistory()`.
- Order type enum (Broker API): Limit=1, Market=2, Stop=3, StopLimit=4; side Buy=1, Sell=-1; status Filled=2 etc.
- Durations / TIF (Capture 2 `metainfo.durations`): `DAY`, `WEEK` (UI default), `MONTH`, `GTD` (requires `datetime`). Exposed on `paper_place_order` as `tif` + `duration_datetime`.
- Mutation surface on active broker: `placeOrder`, `modifyOrder`, `cancelOrder`, `closePosition`, `editPositionBrackets`, `selectBroker("Paper")`, `setCurrentAccount`.
- `supportTrailingStop` was **false** on the observed Paper position (Capture 2) — no trailing-stop tool.
- Account reset / createAccount exist on the broker object but are **not** exposed as MCP tools (destructive).

## Runtime evidence — confirmed findings (Capture 1)

All findings below were read through property descriptors (no getter or
mutation-suggesting method was invoked; the only methods called were
zero-argument queries classified as safe reads: `isWidgetEnabled`,
`enabledWidgets`, `isAvailable`, `isVisible`, `connectStatus`,
`activeBroker`). Single version/OS tested — reliability is "one capture"
until reproduced elsewhere.

### The Trading Panel is a bottom-bar widget named `paper_trading`

`window.TradingView.bottomWidgetBar._widgetControllers` is a `Map` with keys
`paper_trading`, `backtesting`, `replay_trading`, `scripteditor`. The bottom
widget bar exposes `showWidget(name)`, `isWidgetEnabled(name)`,
`getWidgetByName(name)`, `activateWidget(name)`, `enabledWidgets()` (returns
a WatchedValue), `isVisible()`, `activeWidgetName()`. This means panel
open/close/state is mechanism **A** (internal structured API), not DOM
clicks — the existing `ui_open_panel('trading')` DOM approach is the
fallback, not the primary path.

When unauthenticated: `isWidgetEnabled('paper_trading') === false`,
`enabledWidgets().value() === []`, and the `trading-button` element does not
exist in the DOM.

### The trading service (`controller._trading`)

`bottomWidgetBar._widgetControllers.get('paper_trading')._trading` is the
application-wide trading service. Structural surface (names captured, none
invoked except where noted):

- Provider management: `brokersList`, `brokersMetainfo`, `brokersPlans`,
  `activeBroker()` (WatchedValue → `null` when disconnected — confirmed),
  `selectBroker`, `pickDefaultBroker`, `reconnectCurrentBroker`,
  `_tryReconnectLastBroker`, `brokersRegistry`, `brokerSelectManager`.
- Connection: `connectStatus()` (WatchedValue → numeric enum; value `3`
  confirmed while disconnected), `onConnectionStatusChange`,
  `onBrokerChange`, `onBrokerLoading`, `onNeedSelectBroker`.
  The numeric values are consistent with TradingView's public Broker API
  documentation (`1 = Connected`, `2 = Connecting`, `3 = Disconnected`,
  `4 = Error`) — values 1/2/4 still need live confirmation.
- Account: `accountType`, `_account` (`null` when disconnected — confirmed),
  `verifyBrokerLiveAccount` (live-account distinction exists in the model),
  `_onCurrentAccountUpdate`.
- Orders: `_ordersService`, `orderViewController`, `_checkAndPlaceOrder`,
  `_checkAndOpenOrderDialog`, `toggleOrderDialog`, `_isMarketOrderSupported`,
  `getQtySuggester`.
- Panel/UI: `toggleTradingPanelVisibility`, `toggleTradingWidget`,
  `tradingPanel`, `getAccountManagerVisibilityMode`,
  `setAccountManagerVisibilityMode`, `setDOMPanelVisibility`,
  `setOrderPanelVisibility`.
- Auth: `_subscribeNativeLogin`, `loginDialogVisibility`,
  `_brokerLoginManager`, `brokerLoginEventsBus`, `_logOut`.
- Paper-specific: `_getPaperCompetitions`,
  `_getActivePaperCompetitionsSinceTimestamp`.

### Broker registry

`trading.brokersRegistry` exposes `getBrokers`, `getBrokersMetaInfos`,
`getBrokerMetaInfoById`, `getBrokerPlanByIntegrationId`, `isBrokerFavorite`.
**`getBrokerMetaInfoById` is the expected path for positive identification
of the native Paper Trading provider by a stable internal id** — the actual
id value must be captured from an authenticated session before any mutation
guard is coded.

### Positions service

`trading._positionService` (`_serviceName=PositionsService`): `positions()`,
`find`, `positionUpdate`, `positionsRemoved`, `getCurrency`,
`supportBrackets`, `supportReverse`, `isDisplayModeIndividualPositions`,
`realIdFromBroker`. Data shape pending an authenticated session with an open
position.

### Orders service

`trading._ordersService` (`_serviceName=OrdersService`): `orders()`,
`activeOrders()`, `find`, `activeOrdersUpdated`, `activeOrdersRemoved`,
`orderRejected`, `getCurrency`, and **`getExitLevelOrderId`** — exit levels
(brackets) are modeled with their own order ids, which supports the
multi-level SL/TP requirement. Exact states and shapes pending.

### Session detection (unauthenticated state)

- `window.user` exists with `username === 'Guest'` and no meaningful id →
  reliable anonymous marker (structural check, no secrets).
- `window.TradingView.changeLoginState` / `signOut` functions exist.
- `window.TradingView.isFeatureEnabled('trading_terminal') === false` while
  anonymous.
- The Trading Panel button (`data-name="trading-button"`) is **absent** from
  the DOM when unauthenticated — DOM-based availability checks must not
  confuse "logged out" with "panel closed".

### Trading backend globals

- `window.TRADING_REST_SERVER_URL === 'https://rest-demo.tradingview.com/tradingview/v1'`
  (public endpoint URL, not a secret) — the Paper backend is served from a
  `rest-demo` host, consistent with TradingView's REST broker integration
  model.
- `window.TRADING_SERVER_LOGGER_URL === 'https://trdlg.tradingview.com'`.
- `window.TradingViewApi._getTradingFeatureFlagsService` resolves a service
  from an internal registry (`serviceOrNull(TRADING_FEATURE_FLAGS_SERVICE)`).

### Linux note (how this capture was made)

TradingView for Linux ships as a snap. For discovery in an environment
without snapd: download via the snapcraft API, `unsquashfs` the package, and
run `<extracted>/tradingview --remote-debugging-port=9222 --no-sandbox`
under an X display. Login is a human step; this capture deliberately stayed
anonymous.

## Discovery procedure

Run this on a machine with TradingView Desktop. Total hands-on time is a few
minutes per capture.

1. Launch TradingView Desktop with CDP enabled — use the matching script in
   `scripts/` (`launch_tv_debug.bat`, `launch_tv_debug_mac.sh`,
   `launch_tv_debug_linux.sh`) or add `--remote-debugging-port=9222` yourself.
2. Log in normally (human at the keyboard). Open any chart.
3. Verify the bridge works: `npm run tv -- status` (or `tv status` if linked).
4. Capture the baseline state (Trading Panel closed):

   ```bash
   node scripts/paper_discovery.js > paper-discovery-panel-closed.json
   ```

5. Open the Trading Panel (bottom of the chart), but do not connect a broker
   yet. Capture again:

   ```bash
   node scripts/paper_discovery.js > paper-discovery-disconnected.json
   ```

6. Select **Paper Trading** in the panel and connect. Capture again:

   ```bash
   node scripts/paper_discovery.js > paper-discovery-connected.json
   ```

7. Optional but valuable: place one small Paper order manually (e.g. 1 share
   market order with an attached stop loss and take profit), then capture
   `paper-discovery-with-position.json`. This makes position/order/exit
   structures visible to the service scan.
8. While the panel is open, note down manually (plain observation, no tools):
   - the tabs shown in the panel (e.g. Positions, Orders, Account Summary...);
   - the columns of each tab;
   - the fields of the order ticket (side, quantity, order type, TP/SL
     controls, and how TP/SL amounts are expressed — price, ticks, currency,
     percentage);
   - the account selector contents and the exact provider name displayed;
   - anything the UI calls funds/margin/leverage/commission in
     account settings (exact wording).
9. Attach the JSON reports and notes to the tracking issue/PR. The reports
   are already sanitized, but skim them before sharing anyway.

The probe report files match `paper-discovery-*.json` and are gitignored so
raw captures are never committed by accident.

### What the probe collects

`scripts/paper_discovery.js` connects through the same CDP bridge as the MCP
(`src/connection.js`) and captures four read-only sections:

| Section | Question it answers |
|---------|---------------------|
| `namespaces` | Which keys exist on `window.TradingViewApi` / `window.TradingView`, and which window globals have trading-suggestive names |
| `trading_like_services` | Which objects in those namespaces expose methods with names like order/position/account/broker/margin/leverage/commission |
| `bottom_widget_bar` | Whether the bottom widget bar knows a trading widget (would allow API-based panel open like `showWidget('backtesting')`) |
| `trading_panel_dom` | Trading Panel button state and the `data-name`/`role`/button-`aria-label` inventory of the bottom and right layout areas |

### Follow-up probes (after the first captures)

Once the service scan reveals candidate paths, target them individually with
`tv ui evaluate`. Enumerate first, through property descriptors
(`Object.getOwnPropertyDescriptor` / `Object.getOwnPropertyNames`), the way
the probe itself does — property reads and getter access can execute code, so
do not invoke any method or accessor getter until its name and context have
been classified as a safe read from prior evidence. Never call methods whose
names suggest mutation (`place*`, `cancel*`, `modify*`, `reset*`, `create*`,
`close*`) during discovery.

## Evidence tables

Every row starts as `unknown`. Only fill a row from a captured report or a
directly observed session, and cite the capture file.

### A. Trading session

| Capability | Available | Source | API/DOM path | Reliability | Notes |
|------------|-----------|--------|--------------|-------------|-------|
| Detect authenticated session | **yes** | Capture 2 | B — `window.user` has id + non-Guest username | 1 capture (3.3.0/Win) | must not read secrets |
| Detect login-required state | **yes** | Capture 1 | B — `window.user.username === 'Guest'` / missing id; corroborated by `isFeatureEnabled('trading_terminal') === false` and absent `trading-button` | 1 capture (3.3.0/Linux) | maps to `TRADINGVIEW_AUTH_REQUIRED` |
| Detect expired session | unknown | — | — | — | |

### B. Trading Panel

| Capability | Available | Source | API/DOM path | Reliability | Notes |
|------------|-----------|--------|--------------|-------------|-------|
| Panel availability | **yes** | Capture 1 | A — `bottomWidgetBar.isWidgetEnabled('paper_trading')` | 1 capture | `false` while anonymous |
| Panel open/closed state | **yes** | Capture 1 | A — `bottomWidgetBar.isVisible()` / `activeWidgetName()` (WatchedValues); DOM `trading-button` is fallback (C) | 1 capture | widget name is `paper_trading` |
| Panel open/close action | **yes** | Capture 2 | A — `bottomWidgetBar.showWidget('paper_trading')` / close/hide | implemented in `paper_open_panel` | same API family as `backtesting` |
| Active provider name | **yes** | Capture 2 | A — `activeBroker()._brokerMetainfo.id/title` | 1 capture | id is `"Paper"`, title `"Paper Trading"` |
| Provider list | **yes** | Capture 2 | A — `brokersRegistry.getBrokersMetaInfos()` (async) | 1 capture | first entry id `"Paper"` |
| Connection state | **yes** | Capture 1+2 | A — `trading.connectStatus()` WatchedValue | `1` connected, `3` disconnected | see section C |
| Account selector | **yes** | Capture 2 | A — `accountsMetainfo()` / `currentAccount()` / `setCurrentAccount` | 1 capture | |

### C. Native Paper Trading connection

| Capability | Available | Source | API/DOM path | Reliability | Notes |
|------------|-----------|--------|--------------|-------------|-------|
| Positive identification of native Paper Trading (stable id, not display string) | **yes** | Capture 2 | A — `activeBroker()._brokerMetainfo.id === "Paper"` | 1 capture (3.3.0/Win) | allowlist constant `NATIVE_PAPER_BROKER_ID` in `src/core/paper.js` |
| disconnected state | **yes** | Capture 1 | A — `connectStatus() === 3` | 1 capture | matches public Broker API enum (Disconnected=3) |
| connecting state | expected `2` | public Broker API docs | A — `connectStatus()` | unconfirmed live | |
| connected state | **yes** | Capture 2 | A — `connectStatus() === 1` | 1 capture | |
| reconnecting state | unknown | — | — | — | possibly Connecting(2) again; confirm |
| failed state | expected `4` (Error) | public Broker API docs | A — `connectStatus()` | unconfirmed live | |
| authentication-required state | **yes** (session-level) | Capture 1 | B — anonymous marker (section A) gates everything | 1 capture | broker-level login dialog state: `trading.loginDialogVisibility` (untested) |

### D. Paper accounts

| Capability | Available | Source | API/DOM path | Reliability | Notes |
|------------|-----------|--------|--------------|-------------|-------|
| List accounts | **yes** | Capture 2 | A — `activeBroker().accountsMetainfo()` | 1 capture | |
| Active account id | **yes** | Capture 2 | A — `trading._account` string + `currentAccount()` | 1 capture | |
| Display name | **yes** | Capture 2 | A — `accountsMetainfo[].name` | 1 capture | |
| Currency | **yes** | Capture 2 | A — position `extra.accountCurrency` | 1 capture | e.g. `USD` |
| Balance | **yes** | Capture 2 | A — `accountManagerInfo().summary` wValue | 1 capture | UI: "Saldo da conta" |
| Equity | **yes** | Capture 2 | A — summary wValue | 1 capture | UI: "Valor da conta" |
| Realized P&L | **yes** | Capture 2 | A — summary id `realizedPL` | 1 capture | |
| Unrealized P&L | **yes** | Capture 2 | A — summary id `unrealizedPL` | 1 capture | |
| Available funds | **yes** | Capture 2 | A — summary id `availableFunds` | 1 capture | UI: "Fundos disponíveis" |
| Used funds / margin used | **yes** | Capture 2 | A — summary id `accountMargin` | 1 capture | UI: "Margem da conta" |
| Borrowed funds | unknown | — | — | — | |
| Buying power | unknown | — | — | — | not a separate summary row in Capture 2 |
| Leverage | **yes** (per position) | Capture 2 | A — position `extra.leverage` | 1 capture | e.g. `"10:1"` |

Terminology note: a previously mentioned concept resembling "collective
funds" is NOT an API name. Record the exact TradingView wording observed in
the account summary and map it to one of the rows above (or add a row with
the literal term) before any public API field is named after it.

### E. Account configuration

| Capability | Available | Source | API/DOM path | Reliability | Notes |
|------------|-----------|--------|--------------|-------------|-------|
| Create Paper account | unknown | — | — | — | mutation — later increment |
| Switch account | unknown | — | — | — | |
| Currency setting | unknown | — | — | — | |
| Initial/reset balance setting | unknown | — | — | — | |
| Account reset | unknown | — | — | — | destructive — READ-ONLY documentation only; no mutation tool in early PRs |
| Leverage settings (global / per asset class) | unknown | — | — | — | |
| Commission settings | unknown | — | — | — | |

### F. Positions

| Capability | Available | Source | API/DOM path | Reliability | Notes |
|------------|-----------|--------|--------------|-------------|-------|
| Stable position identity | **yes** | Capture 2 | A — position `id` (symbol string for net positions) | 1 capture | e.g. `BINANCE:BTCUSDT` |
| Symbol / side / quantity | **yes** | Capture 2 | A — `symbol`, `side` (±1), `qty` | 1 capture | |
| Average fill price | **yes** | Capture 2 | A — `avgPrice` | 1 capture | |
| Current price / unrealized P&L | **yes** | Capture 2 | A — `lastPrice`, `pl` / `extra.pl` | 1 capture | |
| Realized P&L | account-level | Capture 2 | A — summary `realizedPL` | 1 capture | |
| Margin per position | **yes** | Capture 2 | A — `extra.usedMargin` | 1 capture | |
| Attached protective orders | **yes** (flags) | Capture 2 | A — `supportBrackets` / `supportStopLoss` on position | 1 capture | `editPositionBrackets` for mutation |
| Partial positions / multiple positions per symbol | display mode exists | Capture 1 | A — `isDisplayModeIndividualPositions` | untested | `closeIndividualPosition` also present |

### G. Orders

| Capability | Available | Source | API/DOM path | Reliability | Notes |
|------------|-----------|--------|--------------|-------------|-------|
| Market orders | **yes** | Capture 2 | A — `placeOrder` + configFlags.supportMarketOrders; type=2 | 1 capture | |
| Limit orders | **yes** | Capture 2 | A — type=1; configFlags.supportLimitOrders | 1 capture | filled history sample type=1 |
| Stop orders | **yes** (flag) | Capture 2 | A — configFlags.supportStopOrders; type=3 | 1 capture | |
| Stop-limit orders | **yes** (flag) | Capture 2 | A — configFlags.supportStopLimitOrders; type=4 | 1 capture | |
| Order states (pending/working/filled/partial/cancelled/rejected) | **yes** | Capture 2 | A — status enum 1..6 | 1 capture | canceled=1 filled=2 inactive=3 placing=4 rejected=5 working=6 |

### H. Stop Loss / Take Profit (first-class requirement)

| Capability | Available | Source | API/DOM path | Reliability | Notes |
|------------|-----------|--------|--------------|-------------|-------|
| SL attached at order creation | bracket model exists | Capture 1 | A — `supportBrackets` (PositionsService) | untested | |
| TP attached at order creation | bracket model exists | Capture 1 | A — `supportBrackets` (PositionsService) | untested | |
| Add/change exits on an open position | unknown | — | — | — | |
| OCO / bracket semantics | unknown | — | — | — | |
| Price-based SL/TP | unknown | — | — | — | |
| Monetary / percentage-based SL/TP | unknown | — | — | — | |
| Multiple TP levels | exit levels have own order ids | Capture 1 | A — `getExitLevelOrderId` (OrdersService) | untested | strong hint that multi-level exits are modeled |
| Multiple SL levels | unknown | — | — | — | |
| Per-exit quantity | unknown | — | — | — | |

### I. Trailing stop

| Capability | Available | Source | API/DOM path | Reliability | Notes |
|------------|-----------|--------|--------------|-------------|-------|
| Trailing stop supported by native Paper Trading | **no** (observed) | Capture 2 | A — position `supportTrailingStop === false` | 1 capture | configFlags.supportModifyTrailingStop present but position flag false |
| Distance representation (price/percent/ticks) | unknown | — | — | — | |
| Modification behavior | unknown | — | — | — | |

### J. Margin / funds / leverage

| Capability | Available | Source | API/DOM path | Reliability | Notes |
|------------|-----------|--------|--------------|-------------|-------|
| Margin required (pre-trade) | unknown | — | — | — | |
| Margin used | unknown | — | — | — | |
| Insufficient-funds behavior | unknown | — | — | — | record the rejection surface |
| Per-asset-class leverage | unknown | — | — | — | |

### K. Commissions

| Capability | Available | Source | API/DOM path | Reliability | Notes |
|------------|-----------|--------|--------------|-------------|-------|
| No commission mode | unknown | — | — | — | |
| Fixed commission | unknown | — | — | — | |
| Percentage commission | unknown | — | — | — | |
| Per-contract commission | unknown | — | — | — | |
| Commission currency | unknown | — | — | — | |

## Known risks and unknowns

- Internal runtime paths (`window.TradingViewApi.*`) are undocumented and can
  change between Desktop versions; every confirmed row must state the version
  it was captured on.
- The Trading Panel may be implemented as a bottom widget, a right-rail
  widget, or an iframe depending on version — the DOM probe reports both
  layout areas to disambiguate.
- Paper Trading state may be partly server-backed; if reads require
  authenticated REST calls (as alerts do), that is a design decision to record
  here, not to improvise.
- Provider display names are localized; positive identification must rely on
  a stable internal identifier, never on the display string containing
  "Paper".

## What happens next

Capture 2 landed the stable id `"Paper"` and the account/position/order
shapes. Tools are implemented in `src/core/paper.js` with
`assertPaperContext()` fail-closed on `NATIVE_PAPER_BROKER_ID`.

Remaining follow-ups (optional / later increments):

1. Confirm `connectStatus` values `2` (Connecting) and `4` (Error) live.
2. Exercise `editPositionBrackets` with multi-level exit quantities.
3. Document account reset / createAccount carefully before any destructive tool.
4. Re-verify broker id `"Paper"` on macOS / Linux Desktop builds.
