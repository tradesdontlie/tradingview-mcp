/**
 * Pine Script v6 reference, migration rules, and error explanations.
 *
 * Pine v6 highlights (vs v5):
 *  - User-defined types (UDTs) and methods on them (`type` + `method`)
 *  - Maps and improved generics (`map.new<K, V>()`)
 *  - Dynamic `request.security` arguments (non-constant symbol/timeframe)
 *  - Polylines for multi-segment drawings (`polyline.new`)
 *  - Cleaner namespacing (built-ins under `ta.`, `math.`, `str.`, `time.`,
 *    `chart.`, `runtime.`, `request.`, `array.`, `map.`, `matrix.`,
 *    `color.`, `display.`, `format.`, `font.`, `session.`, `currency.`,
 *    `barstate.`, `barmerge.`, `position.`, `extend.`, `xloc.`, `yloc.`,
 *    `text.`, `label.`, `line.`, `box.`, `table.`)
 *
 * This file does NOT bundle the full Pine v6 reference (that's huge). It
 * carries the most-used signatures the agent needs to write correct v6 code
 * without round-tripping to the docs.
 */

/** Common Pine v6 builtin signatures, grouped by namespace. */
export const V6_BUILTINS = {
  ta: {
    'ta.sma': 'ta.sma(source: series float, length: simple int) -> series float',
    'ta.ema': 'ta.ema(source: series float, length: simple int) -> series float',
    'ta.wma': 'ta.wma(source: series float, length: simple int) -> series float',
    'ta.rma': 'ta.rma(source: series float, length: simple int) -> series float',
    'ta.vwma': 'ta.vwma(source: series float, length: simple int) -> series float',
    'ta.rsi': 'ta.rsi(source: series float, length: simple int) -> series float',
    'ta.macd': 'ta.macd(source: series float, fastlen: simple int, slowlen: simple int, siglen: simple int) -> [series float, series float, series float]',
    'ta.bb': 'ta.bb(source: series float, length: simple int, mult: simple float) -> [series float, series float, series float]  // returns [middle, upper, lower]',
    'ta.atr': 'ta.atr(length: simple int) -> series float',
    'ta.tr': 'ta.tr(handle_na: simple bool = false) -> series float',
    'ta.stoch': 'ta.stoch(source: series float, high: series float, low: series float, length: simple int) -> series float',
    'ta.crossover': 'ta.crossover(source1: series float, source2: series float) -> series bool',
    'ta.crossunder': 'ta.crossunder(source1: series float, source2: series float) -> series bool',
    'ta.cross': 'ta.cross(source1: series float, source2: series float) -> series bool',
    'ta.highest': 'ta.highest(source: series float, length: simple int) -> series float',
    'ta.lowest': 'ta.lowest(source: series float, length: simple int) -> series float',
    'ta.change': 'ta.change(source: series float, length: simple int = 1) -> series float',
    'ta.valuewhen': 'ta.valuewhen(condition: series bool, source: series float, occurrence: simple int) -> series float',
    'ta.barssince': 'ta.barssince(condition: series bool) -> series int',
    'ta.pivothigh': 'ta.pivothigh(source: series float = high, leftbars: simple int, rightbars: simple int) -> series float',
    'ta.pivotlow': 'ta.pivotlow(source: series float = low, leftbars: simple int, rightbars: simple int) -> series float',
    'ta.linreg': 'ta.linreg(source: series float, length: simple int, offset: simple int) -> series float',
    'ta.percentrank': 'ta.percentrank(source: series float, length: simple int) -> series float',
    'ta.correlation': 'ta.correlation(source1: series float, source2: series float, length: simple int) -> series float',
  },
  math: {
    'math.abs': 'math.abs(x: series int|float) -> series',
    'math.max': 'math.max(x1, x2, ...) -> series',
    'math.min': 'math.min(x1, x2, ...) -> series',
    'math.round': 'math.round(x: series float, precision: simple int = 0) -> series',
    'math.floor': 'math.floor(x: series float) -> series int',
    'math.ceil': 'math.ceil(x: series float) -> series int',
    'math.log': 'math.log(x: series float) -> series float',
    'math.sqrt': 'math.sqrt(x: series float) -> series float',
    'math.sum': 'math.sum(source: series float, length: simple int) -> series float',
    'math.random': 'math.random(min: simple float = 0, max: simple float = 1, seed: simple int = na) -> series float',
  },
  request: {
    'request.security': 'request.security(symbol: simple|series string, timeframe: simple|series string, expression, gaps: simple barmerge_gaps = barmerge.gaps_off, lookahead: simple barmerge_lookahead = barmerge.lookahead_off) -> series  // v6: symbol/timeframe can be dynamic',
    'request.dividends': 'request.dividends(ticker: simple string, field: simple string = dividends.gross, gaps: simple = barmerge.gaps_off, lookahead: simple = barmerge.lookahead_off) -> series float',
    'request.splits': 'request.splits(ticker: simple string, field: simple string, gaps: simple = barmerge.gaps_off, lookahead: simple = barmerge.lookahead_off) -> series float',
    'request.earnings': 'request.earnings(ticker: simple string, field: simple string = earnings.actual, gaps = barmerge.gaps_off, lookahead = barmerge.lookahead_off) -> series float',
    'request.financial': 'request.financial(symbol: simple string, financial_id: simple string, period: simple string, gaps = barmerge.gaps_off, ignore_invalid_symbol: simple bool = false) -> series float',
  },
  strategy: {
    'strategy()': 'strategy(title, shorttitle = na, overlay = false, format = format.inherit, precision = na, scale = scale.right, pyramiding = 0, calc_on_order_fills = false, calc_on_every_tick = false, max_bars_back = 0, backtest_fill_limits_assumption = 0, default_qty_type = strategy.fixed, default_qty_value = 1, initial_capital = 1000000, currency = currency.NONE, slippage = 0, commission_type = strategy.commission.percent, commission_value = 0, process_orders_on_close = false, close_entries_rule = "FIFO", margin_long = 100, margin_short = 100, explicit_plot_zorder = false, max_lines_count = 50, max_labels_count = 50, max_boxes_count = 50, calc_bars_count = 0, risk_free_rate = 2.0, use_bar_magnifier = false, fill_orders_on_standard_ohlc = false, max_polylines_count = 50)',
    'strategy.entry': 'strategy.entry(id: series string, direction: strategy_direction, qty: series float = na, limit: series float = na, stop: series float = na, oca_name: series string = "", oca_type: input string = strategy.oca.none, comment: series string = na, alert_message: series string = na) -> void',
    'strategy.exit': 'strategy.exit(id, from_entry = "", qty = na, qty_percent = 100, profit = na, limit = na, loss = na, stop = na, trail_price = na, trail_points = na, trail_offset = na, oca_name = "", comment = na, comment_profit = na, comment_loss = na, comment_trailing = na, alert_message = na, alert_profit = na, alert_loss = na, alert_trailing = na, disable_alert = false) -> void',
    'strategy.close': 'strategy.close(id: series string, when = true, comment = na, qty = na, qty_percent = 100, alert_message = na, immediately = false, disable_alert = false) -> void',
    'strategy.close_all': 'strategy.close_all(comment = na, alert_message = na, immediately = false, disable_alert = false) -> void',
    'strategy.long': 'strategy.long  // const for strategy.entry direction (long)',
    'strategy.short': 'strategy.short  // const for strategy.entry direction (short)',
  },
  input: {
    'input.int': 'input.int(defval: const int, title: const string = na, minval = na, maxval = na, step = 1, options = na, tooltip = na, inline = na, group = na, display = display.all, confirm = false) -> input int',
    'input.float': 'input.float(defval: const float, title = na, minval = na, maxval = na, step = na, options = na, tooltip = na, inline = na, group = na, display = display.all, confirm = false) -> input float',
    'input.bool': 'input.bool(defval: const bool, title = na, tooltip = na, inline = na, group = na, display = display.all, confirm = false) -> input bool',
    'input.string': 'input.string(defval: const string, title = na, options = na, tooltip = na, inline = na, group = na, display = display.all, confirm = false) -> input string',
    'input.source': 'input.source(defval: const string = "close", title = na, tooltip = na, inline = na, group = na, display = display.all) -> series float',
    'input.timeframe': 'input.timeframe(defval: const string, title = na, options = na, tooltip = na, inline = na, group = na, display = display.all, confirm = false) -> input string',
    'input.symbol': 'input.symbol(defval: const string, title = na, tooltip = na, inline = na, group = na, display = display.all, confirm = false) -> input string',
    'input.session': 'input.session(defval: const string, title = na, options = na, tooltip = na, inline = na, group = na, display = display.all, confirm = false) -> input string',
    'input.color': 'input.color(defval: const color, title = na, tooltip = na, inline = na, group = na, display = display.all, confirm = false) -> input color',
  },
  array: {
    'array.new': 'array.new<T>(size: series int = 0, initial_value: T = na) -> array<T>  // also array.new_float, array.new_int, array.new_string, etc.',
    'array.push': 'array.push(id: array<T>, value: T) -> void',
    'array.pop': 'array.pop(id: array<T>) -> T',
    'array.get': 'array.get(id: array<T>, index: series int) -> T',
    'array.set': 'array.set(id: array<T>, index: series int, value: T) -> void',
    'array.size': 'array.size(id: array<T>) -> series int',
    'array.sort': 'array.sort(id: array<T>, order: simple int = order.ascending) -> void',
    'array.sum': 'array.sum(id: array<int|float>) -> series float',
    'array.avg': 'array.avg(id: array<int|float>) -> series float',
    'array.percentile_linear_interpolation': 'array.percentile_linear_interpolation(id: array<int|float>, percentage: series float) -> series float',
    'array.first': 'array.first(id: array<T>) -> T  // throws if empty',
    'array.last': 'array.last(id: array<T>) -> T  // throws if empty',
    'array.from': 'array.from(arg0, arg1, ...) -> array<T>  // type inferred from arg0',
  },
  map: {
    'map.new': 'map.new<K, V>() -> map<K, V>  // v5+',
    'map.put': 'map.put(id: map<K, V>, key: K, value: V) -> V',
    'map.get': 'map.get(id: map<K, V>, key: K) -> V',
    'map.contains': 'map.contains(id: map<K, V>, key: K) -> bool',
    'map.remove': 'map.remove(id: map<K, V>, key: K) -> V',
    'map.size': 'map.size(id: map<K, V>) -> int',
    'map.keys': 'map.keys(id: map<K, V>) -> array<K>',
    'map.values': 'map.values(id: map<K, V>) -> array<V>',
  },
  drawing: {
    'line.new': 'line.new(first_point: chart.point, second_point: chart.point, xloc = xloc.bar_index, extend = extend.none, color = color.blue, style = line.style_solid, width = 1, force_overlay = false) -> line',
    'label.new': 'label.new(point: chart.point, text = "", xloc = xloc.bar_index, yloc = yloc.price, color = color.blue, style = label.style_label_down, textcolor = color.white, size = size.normal, textalign = text.align_center, tooltip = "", text_font_family = font.family_default, force_overlay = false) -> label',
    'box.new': 'box.new(top_left: chart.point, bottom_right: chart.point, border_color = color.blue, border_width = 1, border_style = line.style_solid, extend = extend.none, xloc = xloc.bar_index, bgcolor = color.new(color.blue, 90), text = "", text_size = size.auto, text_color = color.black, text_halign = text.align_center, text_valign = text.align_center, text_wrap = text.wrap_none, text_font_family = font.family_default, force_overlay = false) -> box',
    'polyline.new': 'polyline.new(points: array<chart.point>, curved = false, closed = false, xloc = xloc.bar_index, line_color = color.blue, fill_color = na, line_style = line.style_solid, line_width = 1, force_overlay = false) -> polyline  // v5.6+',
    'table.new': 'table.new(position: simple table_position, columns: simple int, rows: simple int, bgcolor = na, frame_color = na, frame_width = 0, border_color = na, border_width = 0, force_overlay = false) -> table',
    'chart.point.new': 'chart.point.new(time: series int, index: series int, price: series float) -> chart.point  // v5+',
    'chart.point.from_index': 'chart.point.from_index(index: series int, price: series float) -> chart.point',
    'chart.point.from_time': 'chart.point.from_time(time: series int, price: series float) -> chart.point',
    'chart.point.now': 'chart.point.now(price: series float = close) -> chart.point',
  },
  str: {
    'str.tostring': 'str.tostring(value: series int|float|bool|string, format: simple string = na) -> series string',
    'str.tonumber': 'str.tonumber(string: series string) -> series float',
    'str.format': 'str.format(formatString: simple string, arg0, arg1, ...) -> series string',
    'str.length': 'str.length(string: series string) -> series int',
    'str.contains': 'str.contains(source: series string, str: series string) -> series bool',
    'str.split': 'str.split(string: series string, separator: series string) -> array<string>',
  },
  time: {
    'time': 'time -> series int  // UNIX time of current bar in ms',
    'time_close': 'time_close -> series int  // UNIX time of current bar close in ms',
    'time(timeframe)': 'time(timeframe: simple string, session: simple string = na, timezone: simple string = syminfo.timezone) -> series int',
    'timestamp': 'timestamp(year, month, day, hour = 0, minute = 0, second = 0) -> series int  // or timestamp(dateString)',
  },
};

/** Common v4/v5 -> v6 migration rules (heuristic regex-based rewrites). */
export const MIGRATION_RULES = [
  // Version header
  { name: 'version_header', pattern: /\/\/@version\s*=\s*[12345]/g, replacement: '//@version=6' },
  // Top-level declarations
  { name: 'study_to_indicator', pattern: /(^|\s)study\s*\(/g, replacement: '$1indicator(' },
  // v4 input() → typed input.*() — best-effort: infer from defval literal
  { name: 'input_typed_int',    pattern: /(^|[^a-zA-Z0-9_.])input\s*\(\s*(-?\d+)(?=\s*[,)])/g,                       replacement: '$1input.int($2' },
  { name: 'input_typed_float',  pattern: /(^|[^a-zA-Z0-9_.])input\s*\(\s*(-?\d+\.\d+)(?=\s*[,)])/g,                  replacement: '$1input.float($2' },
  { name: 'input_typed_bool',   pattern: /(^|[^a-zA-Z0-9_.])input\s*\(\s*(true|false)(?=\s*[,)])/g,                  replacement: '$1input.bool($2' },
  { name: 'input_typed_string', pattern: /(^|[^a-zA-Z0-9_.])input\s*\(\s*(["'][^"']*["'])(?=\s*[,)])/g,              replacement: '$1input.string($2' },
  // Built-ins moved under namespaces in v5
  { name: 'security_to_request', pattern: /(^|[^a-zA-Z0-9_.])security\s*\(/g, replacement: '$1request.security(' },
  { name: 'financial_to_request', pattern: /(^|[^a-zA-Z0-9_.])financial\s*\(/g, replacement: '$1request.financial(' },
  { name: 'tickerid_to_ticker_new', pattern: /(^|[^a-zA-Z0-9_.])tickerid\s*\(/g, replacement: '$1ticker.new(' },
  { name: 'iff_to_ternary_hint', pattern: /(^|[^a-zA-Z0-9_.])iff\s*\(/g, replacement: '$1/* iff() removed in v5: use ternary `cond ? a : b` */ iff(' },
  // ta namespace (built-ins)
  { name: 'ta_rsi', pattern: /(^|[^a-zA-Z0-9_.])rsi\s*\(/g, replacement: '$1ta.rsi(' },
  { name: 'ta_sma', pattern: /(^|[^a-zA-Z0-9_.])sma\s*\(/g, replacement: '$1ta.sma(' },
  { name: 'ta_ema', pattern: /(^|[^a-zA-Z0-9_.])ema\s*\(/g, replacement: '$1ta.ema(' },
  { name: 'ta_wma', pattern: /(^|[^a-zA-Z0-9_.])wma\s*\(/g, replacement: '$1ta.wma(' },
  { name: 'ta_rma', pattern: /(^|[^a-zA-Z0-9_.])rma\s*\(/g, replacement: '$1ta.rma(' },
  { name: 'ta_vwma', pattern: /(^|[^a-zA-Z0-9_.])vwma\s*\(/g, replacement: '$1ta.vwma(' },
  { name: 'ta_atr', pattern: /(^|[^a-zA-Z0-9_.])atr\s*\(/g, replacement: '$1ta.atr(' },
  { name: 'ta_tr', pattern: /(^|[^a-zA-Z0-9_.])tr\s*\(/g, replacement: '$1ta.tr(' },
  { name: 'ta_macd', pattern: /(^|[^a-zA-Z0-9_.])macd\s*\(/g, replacement: '$1ta.macd(' },
  { name: 'ta_bb', pattern: /(^|[^a-zA-Z0-9_.])bb\s*\(/g, replacement: '$1ta.bb(' },
  { name: 'ta_stoch', pattern: /(^|[^a-zA-Z0-9_.])stoch\s*\(/g, replacement: '$1ta.stoch(' },
  { name: 'ta_crossover', pattern: /(^|[^a-zA-Z0-9_.])crossover\s*\(/g, replacement: '$1ta.crossover(' },
  { name: 'ta_crossunder', pattern: /(^|[^a-zA-Z0-9_.])crossunder\s*\(/g, replacement: '$1ta.crossunder(' },
  { name: 'ta_cross', pattern: /(^|[^a-zA-Z0-9_.])cross\s*\(/g, replacement: '$1ta.cross(' },
  { name: 'ta_highest', pattern: /(^|[^a-zA-Z0-9_.])highest\s*\(/g, replacement: '$1ta.highest(' },
  { name: 'ta_lowest', pattern: /(^|[^a-zA-Z0-9_.])lowest\s*\(/g, replacement: '$1ta.lowest(' },
  { name: 'ta_change', pattern: /(^|[^a-zA-Z0-9_.])change\s*\(/g, replacement: '$1ta.change(' },
  { name: 'ta_valuewhen', pattern: /(^|[^a-zA-Z0-9_.])valuewhen\s*\(/g, replacement: '$1ta.valuewhen(' },
  { name: 'ta_barssince', pattern: /(^|[^a-zA-Z0-9_.])barssince\s*\(/g, replacement: '$1ta.barssince(' },
  { name: 'ta_pivothigh', pattern: /(^|[^a-zA-Z0-9_.])pivothigh\s*\(/g, replacement: '$1ta.pivothigh(' },
  { name: 'ta_pivotlow', pattern: /(^|[^a-zA-Z0-9_.])pivotlow\s*\(/g, replacement: '$1ta.pivotlow(' },
  // math namespace
  { name: 'math_abs', pattern: /(^|[^a-zA-Z0-9_.])abs\s*\(/g, replacement: '$1math.abs(' },
  { name: 'math_max', pattern: /(^|[^a-zA-Z0-9_.])max\s*\(/g, replacement: '$1math.max(' },
  { name: 'math_min', pattern: /(^|[^a-zA-Z0-9_.])min\s*\(/g, replacement: '$1math.min(' },
  { name: 'math_round', pattern: /(^|[^a-zA-Z0-9_.])round\s*\(/g, replacement: '$1math.round(' },
  { name: 'math_floor', pattern: /(^|[^a-zA-Z0-9_.])floor\s*\(/g, replacement: '$1math.floor(' },
  { name: 'math_ceil', pattern: /(^|[^a-zA-Z0-9_.])ceil\s*\(/g, replacement: '$1math.ceil(' },
  { name: 'math_log', pattern: /(^|[^a-zA-Z0-9_.])log\s*\(/g, replacement: '$1math.log(' },
  { name: 'math_sqrt', pattern: /(^|[^a-zA-Z0-9_.])sqrt\s*\(/g, replacement: '$1math.sqrt(' },
  // str namespace
  { name: 'str_tostring', pattern: /(^|[^a-zA-Z0-9_.])tostring\s*\(/g, replacement: '$1str.tostring(' },
  { name: 'str_tonumber', pattern: /(^|[^a-zA-Z0-9_.])tonumber\s*\(/g, replacement: '$1str.tonumber(' },
];

/** Common Pine compile errors mapped to actionable explanations / fix hints. */
export const ERROR_EXPLANATIONS = [
  {
    match: /Could not find function or function reference\s+'?(\w+)/i,
    explain: (m) => {
      const fn = m[1];
      // Suggest only namespaces where this function actually exists.
      const candidates = [];
      for (const [ns, table] of Object.entries(V6_BUILTINS)) {
        if (Object.keys(table).some(k => k === `${ns}.${fn}` || k === fn)) candidates.push(`${ns}.${fn}`);
      }
      if (candidates.length > 0) {
        return `"${fn}" was moved under a namespace in Pine v5/v6. Use: ${candidates.join(' OR ')}.`;
      }
      return `"${fn}" is not in scope. In Pine v5/v6 most built-ins live under a namespace (ta.*, math.*, str.*, request.*, array.*, map.*). Call pine_v6_reference({name:"${fn}"}) to find the correct prefix, or pine_migrate_v6 to auto-rewrite legacy code.`;
    },
  },
  {
    match: /Mismatched input/i,
    explain: () => 'Pine uses 4-space indentation (NOT braces or tabs) to scope blocks under `if`/`for`/`while` and inside `=>` function bodies. Check that every nested line is indented by exactly 4 more spaces than its parent.',
  },
  {
    match: /Undeclared identifier\s+'?(\w+)/i,
    explain: (m) => `"${m[1]}" was used before any assignment. Declare it first: \`${m[1]} = <expression>\` for series, or \`var ${m[1]} = 0\` to persist across bars.`,
  },
  {
    match: /Cannot use 'strategy\.\w+' in a study|strategy\.\w+ used but/i,
    explain: () => 'Strategy functions (strategy.entry, strategy.close, strategy.exit) require a strategy() declaration at the top of the file, not indicator(). Change `indicator("...")` to `strategy("...", overlay=true, ...)`.',
  },
  {
    match: /condition must be of type bool/i,
    explain: () => 'Pine `if` / `while` conditions must be `bool`. If you have a number, compare it explicitly: `if myInt != 0` or `if not na(myFloat)`. If you have an `int`, cast with `bool(x)` only when the semantic is "non-zero is true".',
  },
  {
    match: /Cannot call '.+?' with arguments|No overload of '.+?'/i,
    explain: () => 'The arguments don\'t match any overload. Common causes: passing a `series` where `simple` is required (e.g. lengths must be `simple int`), or using an old v4 signature. Look up the function in pine_v6_reference.',
  },
  {
    match: /'?(\w+)'? is recommended to be declared before|may differ from version/i,
    explain: () => 'A v5/v6-only function or syntax was used without `//@version=6` at the top. Add `//@version=6` as the first non-comment line.',
  },
  {
    match: /script must have one of the following declarations/i,
    explain: () => 'Every Pine script must declare itself as exactly one of: indicator("Name", overlay=...), strategy("Name", overlay=..., ...), or library("Name"). Add one of these as the first executable line.',
  },
  {
    match: /Version of Pine Script\s+(?:is\s+)?outdated|Pine Script.{0,20}is outdated/i,
    explain: () => 'INFO-level: TradingView is recommending you upgrade to v6. To silence, change `//@version=5` (or 4/3) to `//@version=6`. Run pine_migrate_v6 for an automated rewrite.',
  },
  {
    match: /max_bars_back/i,
    explain: () => 'The script needs more historical bars than the default limit. Add `max_bars_back=500` (or larger) as an argument to your indicator()/strategy() declaration.',
  },
  {
    match: /Series length must be greater than zero/i,
    explain: () => 'A length argument resolved to 0 or negative. Check your `input.int(..., minval=1)` or guard with `math.max(1, length)`.',
  },
  {
    match: /Cannot modify global variable/i,
    explain: () => 'In Pine, `=` reassigns a local; to mutate a script-level variable across bars use `:=`. e.g. `var int counter = 0` (declaration), then `counter := counter + 1` (mutation).',
  },
];

/** Lookup a builtin's signature by name (with or without namespace prefix). */
/**
 * C12 / A1-F12 — Enum members for builtin functions whose `simple string`
 * parameters in V6_BUILTINS are actually closed enums in Pine v6.
 * Augments lookupBuiltin() responses with valid enum values + common
 * mistakes (e.g. earnings.actual_period does NOT exist; use earnings.actual).
 */
export const V6_ENUM_MEMBERS = {
  'request.earnings': {
    field: {
      valid: ['earnings.actual', 'earnings.estimate', 'earnings.standardized'],
      common_mistakes: [
        {
          tried: 'earnings.actual_period',
          fix: "No 'actual_period' constant exists in Pine v6. For fiscal-period labels, derive from time(time, '3M') or call request.financial(symbol, 'EARNINGS', period='FQ').",
        },
        {
          tried: 'earnings.eps',
          fix: "Use 'earnings.actual' (reported EPS). 'eps' is not a valid Pine v6 earnings constant.",
        },
      ],
    },
  },
  'request.dividends': {
    field: {
      valid: ['dividends.gross', 'dividends.net'],
      common_mistakes: [
        { tried: 'dividends.amount', fix: "Use 'dividends.gross' or 'dividends.net'." },
      ],
    },
  },
};

export function lookupBuiltin(name) {
  const q = String(name).trim();
  for (const [ns, table] of Object.entries(V6_BUILTINS)) {
    for (const [key, sig] of Object.entries(table)) {
      if (key === q || key.endsWith('.' + q) || key === ns + '.' + q) {
        const out = { found: true, name: key, namespace: ns, signature: sig };
        const enums = V6_ENUM_MEMBERS[key];
        if (enums) out.enums = enums;
        return out;
      }
    }
  }
  // Substring match as fallback
  const matches = [];
  for (const [ns, table] of Object.entries(V6_BUILTINS)) {
    for (const [key, sig] of Object.entries(table)) {
      if (key.toLowerCase().includes(q.toLowerCase())) {
        matches.push({ name: key, namespace: ns, signature: sig });
      }
    }
  }
  return { found: matches.length > 0, matches: matches.slice(0, 10) };
}

/** Return all builtins as a flat list (for "list everything" queries). */
export function listAllBuiltins() {
  const out = [];
  for (const [ns, table] of Object.entries(V6_BUILTINS)) {
    for (const [key, sig] of Object.entries(table)) {
      out.push({ name: key, namespace: ns, signature: sig });
    }
  }
  return out;
}
