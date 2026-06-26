//+------------------------------------------------------------------+
//|  MC_Scalp_v3_XAUUSD.mq5                                         |
//|  Marubozu candle scalp — XAUUSD H1                               |
//|  FundingPips 2-Step challenge edition                             |
//|                                                                  |
//|  Signal: marubozu candle on bar[1]                               |
//|    body ≥ 75% of range, opposing wick ≤ 15%, size ≥ 1.5× ATR   |
//|  Filter: H1 EMA50 trend + RSI(14) > 55 (L) / < 45 (S)          |
//|  Session: UTC 00:00–14:00 (Asian + full London)                  |
//|  Exit: BE at 80% of TP → then trail 1×ATR                       |
//|  Risk: 1.72% per trade (~$86 on $5k account)                    |
//|                                                                  |
//|  Backtest results (TV, 18 months XAUUSD H1):                    |
//|    89 trades · WR 67.4% · PF 2.27 · 5.1 trades/month           |
//|    Cumulative +21.5% @ 2% equity risk                            |
//+------------------------------------------------------------------+
#property copyright "MC Scalp v3 / Claude"
#property version   "1.00"
#property description "Marubozu scalp EA for XAUUSD H1 — FundingPips edition"

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>

//=== INPUTS =========================================================

input group "=== Candle Filter ==="
input double InpBodyPct   = 75.0;   // Min body % of candle range
input double InpWickPct   = 15.0;   // Max opposing wick % of range
input double InpMinATR    = 1.5;    // Min candle size (ATR multiplier)
input int    InpATRLen    = 14;     // ATR period

input group "=== TP / SL ==="
input double InpTPPct     = 100.0;  // TP % of candle range
input double InpSLPct     = 60.0;   // SL % of candle range

input group "=== Trend Filter ==="
input bool   InpH1EMA     = true;   // H1 EMA50 trend filter ON
input int    InpEMAPeriod = 50;     // EMA period

input group "=== Direction ==="
input int    InpDir       = 0;      // 0=Both  1=Long only  2=Short only

input group "=== RSI Filter ==="
input bool   InpRSIOn     = true;   // RSI filter ON
input double InpRSIBull   = 55.0;   // Long: RSI (signal bar) must be ABOVE
input double InpRSIBear   = 45.0;   // Short: RSI (signal bar) must be BELOW
input int    InpRSIPeriod = 14;     // RSI period

input group "=== Exit: BE + Trail ==="
input double InpBEPct     = 80.0;   // BE trigger: price at X% of TP distance from entry
input double InpTrailATR  = 1.0;    // Trail offset (ATR multiplier) after BE trigger

input group "=== Session Filter (UTC) ==="
input bool   InpSessOn    = true;   // Session filter ON
input int    InpSessStart = 0;      // Session start hour, UTC inclusive (0 = 00:00)
input int    InpSessEnd   = 14;     // Session end hour, UTC exclusive (14 = up to 13:59)

input group "=== Risk Management ==="
input double InpRiskPct   = 1.72;   // Risk % of balance per trade
input double InpMaxSpread = 30.0;   // Max allowed spread in points
input ulong  InpMagic     = 20250101; // Magic number

//=== GLOBALS ========================================================

CTrade        g_trade;
CPositionInfo g_pos;

int    g_atrHnd = INVALID_HANDLE;
int    g_emaHnd = INVALID_HANDLE;
int    g_rsiHnd = INVALID_HANDLE;

double g_atrBuf[];
double g_emaBuf[];
double g_rsiBuf[];

datetime g_lastBar = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(30);

   // Auto-detect filling mode supported by broker
   ENUM_ORDER_TYPE_FILLING fill = GetFillingMode();
   g_trade.SetTypeFilling(fill);

   g_atrHnd = iATR(_Symbol, PERIOD_H1, InpATRLen);
   g_emaHnd = iMA (_Symbol, PERIOD_H1, InpEMAPeriod, 0, MODE_EMA, PRICE_CLOSE);
   g_rsiHnd = iRSI(_Symbol, PERIOD_H1, InpRSIPeriod, PRICE_CLOSE);

   if(g_atrHnd == INVALID_HANDLE || g_emaHnd == INVALID_HANDLE || g_rsiHnd == INVALID_HANDLE)
   {
      Alert("MC Scalp v3: indicator init failed — check symbol/timeframe");
      return INIT_FAILED;
   }

   ArraySetAsSeries(g_atrBuf, true);
   ArraySetAsSeries(g_emaBuf, true);
   ArraySetAsSeries(g_rsiBuf, true);

   EventSetTimer(60);
   DrawDashboard();

   PrintFormat("MC Scalp v3 ready | Magic=%d | Risk=%.2f%% | Session UTC %02d-%02d | Filling=%s",
      InpMagic, InpRiskPct, InpSessStart, InpSessEnd, EnumToString(fill));
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   if(g_atrHnd != INVALID_HANDLE) IndicatorRelease(g_atrHnd);
   if(g_emaHnd != INVALID_HANDLE) IndicatorRelease(g_emaHnd);
   if(g_rsiHnd != INVALID_HANDLE) IndicatorRelease(g_rsiHnd);
   ObjectsDeleteAll(0, "MCS3_");
}

//+------------------------------------------------------------------+
void OnTick()
{
   // Manage BE+Trail on every tick
   ManageTrail();

   // Entry logic runs only on new bar open
   datetime barTime = iTime(_Symbol, PERIOD_H1, 0);
   if(barTime == g_lastBar) return;
   g_lastBar = barTime;

   // Skip if already in a trade
   if(HasPosition()) return;

   // Session check
   if(InpSessOn && !InSession()) return;

   // Spread check
   double spread = (SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID)) / _Point;
   if(spread > InpMaxSpread) return;

   // Load indicators (need at least 3 bars back)
   if(CopyBuffer(g_atrHnd, 0, 0, 3, g_atrBuf) < 3) return;
   if(CopyBuffer(g_emaHnd, 0, 0, 3, g_emaBuf) < 3) return;
   if(CopyBuffer(g_rsiHnd, 0, 0, 3, g_rsiBuf) < 3) return;

   //--- Signal bar = bar[1] (just closed)
   double s_open  = iOpen (_Symbol, PERIOD_H1, 1);
   double s_close = iClose(_Symbol, PERIOD_H1, 1);
   double s_high  = iHigh (_Symbol, PERIOD_H1, 1);
   double s_low   = iLow  (_Symbol, PERIOD_H1, 1);
   double s_range = s_high - s_low;
   if(s_range < _Point * 10) return;

   double body    = MathAbs(s_close - s_open);
   double body_p  = body / s_range * 100.0;
   double up_wick = s_high  - MathMax(s_close, s_open);
   double dn_wick = MathMin(s_close, s_open) - s_low;
   double up_wp   = up_wick / s_range * 100.0;
   double dn_wp   = dn_wick / s_range * 100.0;

   double atr     = g_atrBuf[1];          // ATR of signal bar
   double ema     = g_emaBuf[0];          // current EMA (entry bar)
   double rsi_sig = g_rsiBuf[1];          // RSI of signal bar

   //--- Marubozu bull: body≥75%, upper wick≤15%, size≥1.5×ATR
   bool mc_bull = (s_close > s_open)
               && (body_p  >= InpBodyPct)
               && (up_wp   <= InpWickPct)
               && (s_range >= atr * InpMinATR);

   //--- Marubozu bear: body≥75%, lower wick≤15%, size≥1.5×ATR
   bool mc_bear = (s_close < s_open)
               && (body_p  >= InpBodyPct)
               && (dn_wp   <= InpWickPct)
               && (s_range >= atr * InpMinATR);

   if(!mc_bull && !mc_bear) return;

   double cur_price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   bool h1_up = !InpH1EMA || cur_price > ema;
   bool h1_dn = !InpH1EMA || cur_price < ema;
   bool rsi_l = !InpRSIOn || rsi_sig > InpRSIBull;
   bool rsi_s = !InpRSIOn || rsi_sig < InpRSIBear;

   double tp_dist = s_range * (InpTPPct / 100.0);
   double sl_dist = s_range * (InpSLPct / 100.0);
   tp_dist = MathMax(tp_dist, 30 * _Point);
   sl_dist = MathMax(sl_dist, 15 * _Point);

   if(mc_bull && h1_up && rsi_l && (InpDir == 0 || InpDir == 1))
      OpenTrade(ORDER_TYPE_BUY, tp_dist, sl_dist, atr, rsi_sig);
   else if(mc_bear && h1_dn && rsi_s && (InpDir == 0 || InpDir == 2))
      OpenTrade(ORDER_TYPE_SELL, tp_dist, sl_dist, atr, rsi_sig);
}

//+------------------------------------------------------------------+
// Session filter — UTC time
bool InSession()
{
   MqlDateTime dt;
   TimeToStruct(TimeGMT(), dt);
   int h = dt.hour;
   if(InpSessStart < InpSessEnd)
      return h >= InpSessStart && h < InpSessEnd;
   return h >= InpSessStart || h < InpSessEnd; // overnight wrap e.g. 22-06
}

//+------------------------------------------------------------------+
bool HasPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
      if(g_pos.SelectByIndex(i) && g_pos.Symbol() == _Symbol && g_pos.Magic() == InpMagic)
         return true;
   return false;
}

//+------------------------------------------------------------------+
double CalcLots(double sl_dist)
{
   double balance  = AccountInfoDouble(ACCOUNT_BALANCE);
   double risk_amt = balance * InpRiskPct / 100.0;
   double tick_val = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tick_sz  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);

   if(tick_sz <= 0 || tick_val <= 0 || sl_dist <= 0) return SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);

   double sl_ticks = sl_dist / tick_sz;
   double lot      = risk_amt / (sl_ticks * tick_val);

   double step     = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   lot = MathFloor(lot / step) * step;
   lot = MathMax(lot, SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN));
   lot = MathMin(lot, SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX));
   return lot;
}

//+------------------------------------------------------------------+
void OpenTrade(ENUM_ORDER_TYPE type, double tp_dist, double sl_dist, double atr, double rsi)
{
   double lot = CalcLots(sl_dist);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double price, tp, sl;

   if(type == ORDER_TYPE_BUY)
   {
      price = ask;
      tp    = NormalizeDouble(price + tp_dist, _Digits);
      sl    = NormalizeDouble(price - sl_dist, _Digits);
   }
   else
   {
      price = bid;
      tp    = NormalizeDouble(price - tp_dist, _Digits);
      sl    = NormalizeDouble(price + sl_dist, _Digits);
   }

   bool ok = g_trade.PositionOpen(_Symbol, type, lot, price, sl, tp, "MCS3");
   if(ok)
      PrintFormat("OPEN %s | %.2f lots | entry=%.2f SL=%.2f TP=%.2f | ATR=%.2f RSI=%.1f",
         type == ORDER_TYPE_BUY ? "BUY" : "SELL", lot, price, sl, tp, atr, rsi);
   else
      PrintFormat("OPEN FAILED: %d %s", g_trade.ResultRetcode(), g_trade.ResultRetcodeDescription());
}

//+------------------------------------------------------------------+
// BE + Trailing stop — called on every tick
// Phase 1: when price reaches 80% of TP, move SL to breakeven
// Phase 2: trail SL with 1×ATR offset, only in profitable direction
void ManageTrail()
{
   if(CopyBuffer(g_atrHnd, 0, 0, 2, g_atrBuf) < 2) return;
   double atr        = g_atrBuf[0];
   double trail_dist = atr * InpTrailATR;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!g_pos.SelectByIndex(i)) continue;
      if(g_pos.Symbol() != _Symbol || g_pos.Magic() != InpMagic) continue;

      double entry  = g_pos.PriceOpen();
      double cur_sl = g_pos.StopLoss();
      double cur_tp = g_pos.TakeProfit();
      if(cur_tp <= 0 || cur_sl <= 0) continue;

      double new_sl = cur_sl;

      if(g_pos.PositionType() == POSITION_TYPE_BUY)
      {
         double bid      = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         double tp_dist  = cur_tp - entry;
         double be_trig  = entry + tp_dist * (InpBEPct / 100.0);

         if(bid >= be_trig)
         {
            double trail_sl = NormalizeDouble(bid - trail_dist, _Digits);
            new_sl = MathMax(trail_sl, entry);  // floor: at least breakeven
            new_sl = MathMax(new_sl, cur_sl);   // never move SL down
         }

         if(new_sl > cur_sl + _Point)
            g_trade.PositionModify(g_pos.Ticket(), new_sl, cur_tp);
      }
      else // SELL
      {
         double ask      = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
         double tp_dist  = entry - cur_tp;
         double be_trig  = entry - tp_dist * (InpBEPct / 100.0);

         if(ask <= be_trig)
         {
            double trail_sl = NormalizeDouble(ask + trail_dist, _Digits);
            new_sl = MathMin(trail_sl, entry);  // ceiling: at most breakeven
            new_sl = MathMin(new_sl, cur_sl);   // never move SL up
         }

         if(new_sl < cur_sl - _Point)
            g_trade.PositionModify(g_pos.Ticket(), new_sl, cur_tp);
      }
   }
}

//+------------------------------------------------------------------+
// Auto-detect the order filling mode supported by broker
ENUM_ORDER_TYPE_FILLING GetFillingMode()
{
   uint filling = (uint)SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_FOK) != 0) return ORDER_FILLING_FOK;
   if((filling & SYMBOL_FILLING_IOC) != 0) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
}

//+------------------------------------------------------------------+
void OnTimer() { DrawDashboard(); }

void OnChartEvent(const int id, const long& lp, const double& dp, const string& sp)
{
   if(id == CHARTEVENT_CHART_CHANGE) DrawDashboard();
}

void DrawDashboard()
{
   string prefix = "MCS3_";
   int    x = 10, y = 20, dy = 18;
   color  clr_head  = clrGold;
   color  clr_val   = clrWhite;
   color  clr_green = clrLimeGreen;
   color  clr_red   = clrTomato;

   struct Row { string label; string val; color c; };
   Row rows[] =
   {
      { "MC Scalp v3",      "XAUUSD H1",                       clr_head  },
      { "Risk/trade",       DoubleToString(InpRiskPct, 2)+"%", clr_val   },
      { "Session (UTC)",    IntegerToString(InpSessStart)+"–"+IntegerToString(InpSessEnd)+"h", clr_val },
      { "Body/Wick/ATR",    DoubleToString(InpBodyPct,0)+"% / "+DoubleToString(InpWickPct,0)+"% / "+DoubleToString(InpMinATR,1)+"×", clr_val },
      { "RSI filter",       InpRSIOn ? "ON (>"+DoubleToString(InpRSIBull,0)+" / <"+DoubleToString(InpRSIBear,0)+")" : "OFF", clr_val },
      { "BE trigger",       DoubleToString(InpBEPct,0)+"% of TP", clr_val },
      { "Trail",            DoubleToString(InpTrailATR,1)+"× ATR", clr_val },
   };

   for(int i = 0; i < ArraySize(rows); i++)
   {
      string name = prefix + IntegerToString(i);
      string txt  = rows[i].label + ":  " + rows[i].val;
      if(ObjectFind(0, name) < 0)
         ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE,  x);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE,  y + i * dy);
      ObjectSetString (0, name, OBJPROP_TEXT,        txt);
      ObjectSetInteger(0, name, OBJPROP_COLOR,       rows[i].c);
      ObjectSetInteger(0, name, OBJPROP_FONTSIZE,    9);
      ObjectSetString (0, name, OBJPROP_FONT,        "Consolas");
      ObjectSetInteger(0, name, OBJPROP_CORNER,      CORNER_LEFT_UPPER);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE,  false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN,      true);
   }
   ChartRedraw(0);
}
