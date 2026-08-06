# VN STOCKS AUTO SCAN - Phase 2 v4
# VSA + Footprint + Market Context
# Mode A: POSITION_SYMBOLS -> full report (footprint + VSA + context)
# Mode B: Other symbols    -> BUY alert khi conf >= 70
Set-Location "C:\Users\ADMIN\tradingview-mcp"

$TOKEN   = $env:TELEGRAM_BOT_TOKEN
$CHAT_ID = $env:TELEGRAM_CHAT_ID
if (-not $TOKEN -or -not $CHAT_ID) {
    throw "Missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID"
}
$API_URL = "https://api.telegram.org/bot$TOKEN/sendMessage"

# Symbols co position -> bao cao day du moi lan
# Cap nhat khi co position moi
$POSITION_SYMBOLS = @()

# Tat ca 23 ma Phase 2
$ALL_SYMBOLS = @(
    "HOSE:VCB","HOSE:MSB","HOSE:HCM","HOSE:HHP","HOSE:PHR",
    "HOSE:BID","HOSE:CDC","HOSE:GEX","HOSE:DPM","HOSE:SAB",
    "HOSE:NAF","HNX:VTZ","HOSE:STB","HOSE:VPL","HOSE:GMD",
    "HOSE:POW","HOSE:LPB","HOSE:PAN","HOSE:VPI","HOSE:KOS",
    "HOSE:EVF","HOSE:NAB","HOSE:PET"
)

# ── Telegram ──────────────────────────────────────────────────────────────
function Send-TG {
    param([string]$msg)
    $body = @{ chat_id = $CHAT_ID; text = $msg; parse_mode = 'HTML' }
    try {
        Invoke-RestMethod -Uri $API_URL -Method Post -Body $body -ErrorAction Stop | Out-Null
    } catch {
        Write-Host "  [TG ERROR] $_" -ForegroundColor Red
    }
}

# ── TV API helpers ─────────────────────────────────────────────────────────
function Set-TVSymbol([string]$sym) {
    $js = "var c=window._exposed_chartWidgetCollection; var w=c?c.activeChartWidget.value():null; if(w&&w.setSymbol){w.setSymbol('$sym',null);'ok';}else 'no_api';"
    $r = node src/cli/index.js ui eval $js 2>&1 | ConvertFrom-Json -ErrorAction SilentlyContinue
    return ($r -and $r.success -and $r.result -eq 'ok')
}

function Get-Quote {
    $r = node src/cli/index.js quote 2>&1 | ConvertFrom-Json -ErrorAction SilentlyContinue
    return $r
}

function Get-OHLCV([int]$count = 25) {
    # Note: --summary flag returns last_5_bars only; without flag returns full bars array
    $r = node src/cli/index.js ohlcv --count $count 2>&1 | ConvertFrom-Json -ErrorAction SilentlyContinue
    return $r
}

function Get-OHLCVSummary {
    $r = node src/cli/index.js ohlcv --count 5 --summary 2>&1 | ConvertFrom-Json -ErrorAction SilentlyContinue
    return $r
}

function Get-Values {
    $r = node src/cli/index.js values 2>&1 | ConvertFrom-Json -ErrorAction SilentlyContinue
    return $r
}

function Get-FP([object]$vals) {
    if (-not $vals -or -not $vals.success) { return $null }
    return ($vals.studies | Where-Object { $_.name -like "*Footprint*" } | Select-Object -First 1)
}

function Parse-Num([string]$s) {
    if (-not $s) { return 0 }
    $clean = $s -replace '[^0-9\-]',''
    $n = 0; [int]::TryParse($clean, [ref]$n) | Out-Null; return $n
}

function Parse-Long([string]$s) {
    if (-not $s) { return [long]0 }
    $isNeg = ($s -match '^\s*[^\d]' -and $s -notmatch '^\s*\d') -or ($s -match '^-')
    $digits = $s -replace '[^\d]',''
    if (-not $digits) { return [long]0 }
    [long]$n = [long]$digits
    if ($isNeg) { return -$n } else { return $n }
}

# ── Format helpers ─────────────────────────────────────────────────────────
function Fmt-Price([long]$p) { return ($p).ToString("N0") }

function Pct([long]$a, [long]$b) {
    if ($b -eq 0) { return "n/a" }
    return "{0:F1}%" -f (($a - $b) / [Math]::Abs($b) * 100)
}

# ── VSA Analysis ───────────────────────────────────────────────────────────
function Get-VSA([array]$bars) {
    if (-not $bars -or $bars.Count -lt 5) { return $null }

    $n = $bars.Count
    $last = $bars[$n-1]
    $prev = $bars[$n-2]

    # Average volume of all bars except last 2 (unbiased baseline)
    $refBars  = $bars[0..($n-3)]
    $avgVol   = [long](($refBars | Measure-Object -Property volume -Average).Average)
    $avgSpread= [long](($bars | ForEach-Object { $_.high - $_.low } | Measure-Object -Average).Average)

    # Last bar metrics
    $spread   = [long]($last.high - $last.low)
    $closePos = if ($spread -gt 0) { [int](([long]$last.close - [long]$last.low) * 100 / $spread) } else { 50 }
    $volRatio = if ($avgVol -gt 0) { [math]::Round([long]$last.volume / $avgVol, 1) } else { 0 }
    $isUpBar  = [long]$last.close -ge [long]$last.open
    $spreadRatio = if ($avgSpread -gt 0) { [math]::Round($spread / $avgSpread, 1) } else { 1 }

    # Wave progress: how far is current price from base within this window
    $lowestLow   = [long](($bars | ForEach-Object { [long]$_.low  } | Measure-Object -Minimum).Minimum)
    $highestHigh = [long](($bars | ForEach-Object { [long]$_.high } | Measure-Object -Maximum).Maximum)
    $waveRange   = $highestHigh - $lowestLow
    $waveProgress= if ($waveRange -gt 0) { [int](([long]$last.close - $lowestLow) * 100 / $waveRange) } else { 50 }

    # Gain from base (%)
    $gainFromBase = if ($lowestLow -gt 0) { [math]::Round(([long]$last.close - $lowestLow) * 100 / $lowestLow, 1) } else { 0 }

    # Volume trend: last 3 bars avg vs prior avg
    $recentVolAvg = [long](($bars[($n-3)..($n-1)] | Measure-Object -Property volume -Average).Average)
    $volTrend = if ($avgVol -gt 0) { [math]::Round($recentVolAvg / $avgVol, 1) } else { 1 }

    # VSA Pattern detection (last bar)
    $pattern = "Binh thuong"
    if ($volRatio -ge 2.0 -and $closePos -lt 25) {
        $pattern = "CLIMAX/UPTHRUST - vol cao but dong cua thap - nguy hiem"
    } elseif ($volRatio -ge 1.8 -and $closePos -ge 70 -and $isUpBar) {
        $pattern = "THRUST MANH - vol cao, dong cua cao trong nen - bullish"
    } elseif (-not $isUpBar -and $spreadRatio -lt 0.6 -and $volRatio -lt 0.7) {
        $pattern = "NO SUPPLY - nen giam nhe, spread hep, vol thap - bullish"
    } elseif ($isUpBar -and $spreadRatio -lt 0.6 -and $volRatio -lt 0.7) {
        $pattern = "NO DEMAND - nen tang nhe, spread hep, vol thap - bearish"
    } elseif ([long]$last.low -lt [long]$prev.low -and [long]$last.close -gt [long]$prev.low) {
        $pattern = "SHAKEOUT/SPRING - dip xuong duoi roi hoi phuc manh - bullish"
    } elseif ($volRatio -ge 1.5 -and $isUpBar -and $spreadRatio -ge 1.3) {
        $pattern = "WIDE SPREAD UP - bung no tang - xac nhan markup"
    }

    # Phase estimate
    $phase = ""
    if ($waveProgress -ge 85) {
        $phase = "DINH SONG - $gainFromBase% tu day - NGUY HIEM, co the phan phoi"
    } elseif ($waveProgress -ge 65) {
        $phase = "MARKUP - $gainFromBase% tu day - dang tang, theo doi"
    } elseif ($waveProgress -ge 35) {
        $phase = "RE-ACCUM - $gainFromBase% tu day - tich luy lai giua song"
    } else {
        $phase = "ACCUM/DAY - $gainFromBase% tu day - vung co hoi tot"
    }

    # Entry quality score
    $entryScore = 0
    if ($waveProgress -lt 40) { $entryScore += 3 }    # near base = best
    elseif ($waveProgress -lt 65) { $entryScore += 1 } # mid = ok
    else { $entryScore -= 2 }                           # near top = risky
    if ($pattern -like "*NO SUPPLY*" -or $pattern -like "*SPRING*") { $entryScore += 2 }
    if ($volTrend -gt 1.3) { $entryScore += 1 }        # volume expanding
    if ($pattern -like "*CLIMAX*" -or $pattern -like "*NO DEMAND*") { $entryScore -= 2 }

    $entryLabel = if ($entryScore -ge 4) { "TOT - vung entry chuan VSA" }
                  elseif ($entryScore -ge 2) { "CHAP NHAN - co the xem xet" }
                  elseif ($entryScore -ge 0) { "TRUNG TINH - cho tin hieu ro hon" }
                  else { "KHONG NEN - rui ro cao" }

    return [PSCustomObject]@{
        AvgVol       = $avgVol
        VolRatio     = $volRatio
        VolTrend     = $volTrend
        ClosePos     = $closePos
        Spread       = $spread
        SpreadRatio  = $spreadRatio
        WaveProgress = $waveProgress
        GainFromBase = $gainFromBase
        LowestLow    = $lowestLow
        HighestHigh  = $highestHigh
        Pattern      = $pattern
        Phase        = $phase
        EntryScore   = $entryScore
        EntryLabel   = $entryLabel
    }
}

# ── Position Report Builder ────────────────────────────────────────────────
function Build-PositionReport {
    param(
        [string]$ticker,
        [object]$quote,
        [object]$ohlcv,
        [object]$fp,
        [object]$vals,
        [object]$vsa,
        [string]$marketCtx
    )

    $price   = $quote.close
    $open    = $quote.open
    $high    = $quote.high
    $low     = $quote.low
    $vol     = $quote.volume
    $change  = $price - $open
    $chgPct  = if ($open -gt 0) { [math]::Round($change * 100 / $open, 1) } else { 0 }

    # SMA values from Price Action GEM indicator
    $sma20  = 0L; $sma100 = 0L
    $gemStudy = $vals.studies | Where-Object { $_.name -like "*Price Action*" } | Select-Object -First 1
    if ($gemStudy) {
        $sma20  = Parse-Long ([string]$gemStudy.values.'MA Fast')
        $sma100 = Parse-Long ([string]$gemStudy.values.'MA Slow')
    }

    # Footprint values
    $conf     = Parse-Num  ([string]$fp.values.Confluence)
    $div      = Parse-Num  ([string]$fp.values.'Div Signal')
    $cumDelta = Parse-Long ([string]$fp.values.'Cum Delta')
    $cumSlope = Parse-Long ([string]$fp.values.'Cum Slope')
    $fpDelta  = Parse-Long ([string]$fp.values.'FP Delta')
    $buyVol   = Parse-Long ([string]$fp.values.'FP Buy Vol')
    $sellVol  = Parse-Long ([string]$fp.values.'FP Sell Vol')
    $totVol   = Parse-Long ([string]$fp.values.'FP Total Vol')
    $volAvg   = Parse-Long ([string]($vals.studies | Where-Object {$_.name -like "*Volume*" -and $_.values.'Volume MA'} | Select-Object -First 1).values.'Volume MA')

    # SL calculation from recent bars
    $bars = @()
    if ($ohlcv -and $ohlcv.bars) { $bars = $ohlcv.bars }
    $recentLow = if ($bars.Count -ge 3) {
        $lows = $bars[-3..-1] | ForEach-Object { [long]$_.low }
        ($lows | Measure-Object -Minimum).Minimum
    } else { [long]$low }

    $slBelow    = [long]($recentLow * 0.99)
    $slSma20    = [long]($sma20 * 0.985)
    $trailLevel = $sma20

    # Signal
    $signal = ""; $action = ""; $emoji = ""
    if ($div -eq 1 -and $cumDelta -lt 0) {
        $signal = "BEAR DIV + CUM DELTA AM ($($cumDelta.ToString('N0')))"; $action = "THOAT LENH NGAY"; $emoji = "[!!! THOAT]"
    } elseif ($div -eq 1 -and $cumSlope -lt 0) {
        $signal = "BEAR DIV - delta dang giam"; $action = "THAT CHAT STOP LOSS"; $emoji = "[!! CANH BAO]"
    } elseif ($div -eq 1) {
        $signal = "BEAR DIV (cum delta con duong: $($cumDelta.ToString('N0')))"; $action = "THEO DOI CHAT - dat SL tai day gan nhat"; $emoji = "[! CANH BAO NHE]"
    } elseif ($conf -ge 70) {
        $signal = "BUY MANH (conf=$conf/100)"; $action = "NAM GIU / THEM LENH - Trail SL len SMA20"; $emoji = "[>> BUY MANH]"
    } elseif ($conf -ge 50) {
        $signal = "TICH LUY TOT (conf=$conf/100)"; $action = "GIU VI THE - trail SL neu co loi"; $emoji = "[++ GIU]"
    } elseif ($conf -ge 30) {
        $signal = "TRUNG TINH (conf=$conf/100)"; $action = "GIU VA THEO DOI"; $emoji = "[~ GIU]"
    } elseif ($conf -gt 0) {
        $signal = "YEU (conf=$conf/100)"; $action = "XUAT LENH MOT PHAN"; $emoji = "[- YEU]"
    } else {
        $signal = "CHUA CO TIN HIEU (conf=0)"; $action = "GIU VA CHO - kiem tra lai sau 13:00"; $emoji = "[-- CHO]"
    }

    $deltaRatio = if ($totVol -gt 0) { [int]($buyVol * 100 / $totVol) } else { 0 }
    $deltaSign  = if ($fpDelta -ge 0) { "+" } else { "" }
    $volStr     = if ($volAvg -gt 0) { "{0:F1}x avg" -f ($vol / $volAvg) } else { "n/a" }

    # VSA block
    $vsaBlock = ""
    if ($vsa) {
        $vsaBlock = @"

--- VSA ---
Phase:    $($vsa.Phase)
Pattern:  $($vsa.Pattern)
Wave:     $($vsa.WaveProgress)% (day $($vsa.LowestLow.ToString('N0')) -> dinh $($vsa.HighestHigh.ToString('N0')))
Vol trend: $($vsa.VolTrend)x vs TB | Last bar: $($vsa.VolRatio)x | Dong cua: top $($vsa.ClosePos)% nen
Entry VSA: $($vsa.EntryLabel)
"@
    }

    $lines = @(
        "==============================",
        "$emoji $ticker - BAO CAO VI THE",
        "==============================",
        "Thi truong: $marketCtx",
        "Gia: $(Fmt-Price $price) ($($chgPct.ToString('+#.#;-#.#;0'))%) | O=$(Fmt-Price $open) H=$(Fmt-Price $high) L=$(Fmt-Price $low)",
        "Vol: $(Fmt-Price $vol) ($volStr)",
        "",
        "--- FOOTPRINT ---",
        "Confluence: $conf/100",
        "FP Delta: $deltaSign$(Fmt-Price $fpDelta) (mua $deltaRatio% / ban $([int](100-$deltaRatio))%)",
        "Cum Delta: $(if($cumDelta -ge 0){'+'}else{''})$(Fmt-Price $cumDelta) | Slope: $(if($cumSlope -ge 0){'+'}else{''})$(Fmt-Price $cumSlope)",
        "Bear Div: $(if($div -eq 1){'CO - CANH BAO'}else{'Khong'})",
        "",
        "--- XU HUONG ---",
        "SMA20: $(Fmt-Price $sma20) | SMA100: $(Fmt-Price $sma100)",
        "Gia vs SMA20: $(Pct $price $sma20) | vs SMA100: $(Pct $price $sma100)",
        $vsaBlock,
        "--- TIN HIEU ---",
        ">>> $signal",
        ">>> Khuyen nghi: $action",
        "",
        "--- QUAN LY LENH ---",
        "SL de xuat:   $(Fmt-Price $slBelow) (1% duoi day 3 nen)",
        "SL vs SMA20:  $(Fmt-Price $slSma20) (1.5% duoi SMA20)",
        "Trail SL:     $(Fmt-Price $trailLevel) (SMA20)",
        "=============================="
    )

    return ($lines -join "`n").Trim()
}

# ── Chart Setup Verification ──────────────────────────────────────────────
# QUAN TRONG: Chart phai dang o H6 voi volume khop lenh (khong co thoa thuan)
# Chi doi symbol (setSymbol), KHONG doi timeframe trong qua trinh scan
function Check-Timeframe {
    $js = "var c=window._exposed_chartWidgetCollection; var w=c?c.activeChartWidget.value():null; w ? w.timeframe() : 'unknown';"
    $r = node src/cli/index.js ui eval $js 2>&1 | ConvertFrom-Json -ErrorAction SilentlyContinue
    return ($r -and $r.success) ? $r.result : 'unknown'
}

# ── Market Context (VNINDEX) ───────────────────────────────────────────────
function Get-MarketContext {
    Set-TVSymbol "HOSE:VNINDEX" | Out-Null
    Start-Sleep -Seconds 3
    $q = Get-Quote
    if (-not $q -or -not $q.success) { return "VNINDEX: n/a" }

    $chg    = $q.close - $q.open
    $chgPct = if ($q.open -gt 0) { [math]::Round($chg * 100 / $q.open, 2) } else { 0 }
    $dir    = if ($chgPct -ge 0.5) { "BULL (+$chgPct%)" }
              elseif ($chgPct -le -0.5) { "BEAR ($chgPct%)" }
              else { "NEUTRAL ($($chgPct.ToString('+#.##;-#.##;0'))%)" }

    return "VNINDEX $($q.close.ToString('N0')) | $dir"
}

# ── Main Scan ──────────────────────────────────────────────────────────────
$scanTime  = Get-Date -Format 'HH:mm dd/MM/yyyy'
$buyAlerts = 0
$posReports= 0

Write-Host "=== Phase 2 Scan v4 (VSA+FP+Context) - $scanTime ===" -ForegroundColor Cyan

# Kiem tra timeframe - PHAI la H6 voi volume khop lenh
$tf = Check-Timeframe
if ($tf -ne '240' -and $tf -ne 'unknown') {
    Write-Host "  [!!] CANH BAO: Chart dang o timeframe '$tf', KHONG phai H6 (240)" -ForegroundColor Red
    Write-Host "  [!!] Chuyen ve H6 trong TradingView truoc khi scan de volume chinh xac!" -ForegroundColor Red
    Write-Host "  [!!] Volume hien tai co the bao gom ca thoa thuan (sai lech VSA/footprint)" -ForegroundColor Red
    Write-Host ""
} elseif ($tf -eq '240') {
    Write-Host "  [OK] Timeframe H6 - volume khop lenh chinh xac" -ForegroundColor Green
}

# Market context first
Write-Host "  [MARKET] Lay VNINDEX..." -ForegroundColor Gray -NoNewline
$marketCtx = Get-MarketContext
Write-Host " $marketCtx" -ForegroundColor $(if ($marketCtx -like "*BULL*") {"Green"} elseif ($marketCtx -like "*BEAR*") {"Red"} else {"Yellow"})
Write-Host ""

foreach ($fullSym in $ALL_SYMBOLS) {
    $ticker     = $fullSym.Split(':')[1]
    $isPosition = $POSITION_SYMBOLS -contains $fullSym
    $modeLabel  = if ($isPosition) { "[POS]" } else { "[SCAN]" }

    Write-Host -NoNewline "  $modeLabel [$ticker] " -ForegroundColor $(if ($isPosition) { "Yellow" } else { "White" })

    # Switch symbol
    Set-TVSymbol $fullSym | Out-Null
    Start-Sleep -Seconds 3

    # Verify
    $q = Get-Quote
    if (-not $q -or -not $q.success -or $q.symbol -ne $fullSym) {
        Write-Host "SKIP (verify failed)" -ForegroundColor DarkGray
        continue
    }

    # Get all data
    $vals = Get-Values
    $fp   = Get-FP $vals

    if (-not $fp) {
        Write-Host "ERROR: no FP data" -ForegroundColor Red
        Send-TG "[!] MCP offline - kiem tra TradingView Desktop"
        break
    }

    $conf = Parse-Num ([string]$fp.values.Confluence)
    $div  = Parse-Num ([string]$fp.values.'Div Signal')
    $cumR = [string]$fp.values.'Cum Delta'

    # ── Position symbols: full report ─────────────────────────────────────
    if ($isPosition) {
        $ohlcv = Get-OHLCV 25
        $vsa   = if ($ohlcv -and $ohlcv.bars) { Get-VSA $ohlcv.bars } else { $null }
        $report = Build-PositionReport -ticker $ticker -quote $q -ohlcv $ohlcv -fp $fp -vals $vals -vsa $vsa -marketCtx $marketCtx
        Send-TG $report
        $posReports++

        $color = if ($conf -ge 70) { "Green" } elseif ($div -eq 1) { "Magenta" } else { "Yellow" }
        Write-Host "conf=$conf div=$div cum=$cumR [POS SENT]" -ForegroundColor $color
    }
    # ── Scan symbols: BUY alert only ──────────────────────────────────────
    elseif ($conf -ge 70) {
        # Pull VSA for BUY alerts too
        $ohlcv = Get-OHLCV 25
        $vsa   = if ($ohlcv -and $ohlcv.bars) { Get-VSA $ohlcv.bars } else { $null }

        $cumDelta = Parse-Long $cumR
        $cumSign  = if ($cumDelta -ge 0) { "+" } else { "" }
        $chgPct   = if ($q.open -gt 0) { [math]::Round(($q.close - $q.open) * 100 / $q.open, 1) } else { 0 }

        $vsaBlock = if ($vsa) {
"
<b>VSA</b>
<code>Phase    $($vsa.Phase)
Pattern  $($vsa.Pattern)
Entry    $($vsa.EntryLabel)</code>"
        } else { "" }

        $msg = @"
<b>BUY RO RANG: $ticker</b>
<code>Conf      $conf/100
Gia       $(Fmt-Price $q.close)  ($($chgPct.ToString('+#.#;-#.#;0'))%)
Cum Delta $cumSign$(Fmt-Price $cumDelta)</code>
$vsaBlock
$marketCtx
<i>Dong tien mua manh — check chart!</i>
"@
        Send-TG $msg.Trim()
        $buyAlerts++
        Write-Host "conf=$conf div=$div cum=$cumR | VSA: $(if($vsa){$vsa.Phase}else{'n/a'}) [BUY SENT]" -ForegroundColor Green
    }
    else {
        $color = if ($div -eq 1) { "Magenta" } else { "DarkGray" }
        Write-Host "conf=$conf div=$div cum=$cumR" -ForegroundColor $color
    }

    Start-Sleep -Milliseconds 200
}

Write-Host ""
Write-Host "=== DONE: $posReports pos reports + $buyAlerts BUY alerts | $marketCtx ===" -ForegroundColor Cyan
