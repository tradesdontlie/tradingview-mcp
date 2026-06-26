//+------------------------------------------------------------------+
//|  FP_Breakout_XAUUSD.mq5                                          |
//|  FundingPips 2-Step $5,000 | XAUUSD H1                           |
//|  Strategy: EMA50/200 trend + 30-bar breakout, ATR SL/TP (RR 3),  |
//|            no trailing, London/NY session, 0.5% risk/trade.      |
//|  Port of the TradingView "FP Breakout FAST-PASS" (no-trail).     |
//|  Version: 1.0                                                    |
//+------------------------------------------------------------------+
#property copyright   "Custom EA"
#property version     "1.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\AccountInfo.mqh>

//============================ INPUTS ================================

//--- FundingPips $5K Risk Rules (guards sit inside the official limits)
input double   InpRiskPercent     = 0.5;     // Risk per trade (%)
input double   InpDailyLossGuard  = 4.5;     // Halt for the day at this daily loss % (rule 5%)
input double   InpMaxDDGuard      = 9.0;     // Stop EA at this total drawdown % (rule 10%)
input double   InpMaxLot          = 0.50;    // Hard cap on lot size (safety)
input double   InpPhase1Target    = 8.0;     // Phase 1 target % (info / optional stop)
input bool     InpStopAtTarget    = false;   // Stop trading once phase target reached

//--- Strategy (H1 breakout, matches the backtest)
input ENUM_TIMEFRAMES InpTF       = PERIOD_H1; // Strategy timeframe
input int      InpEMAfast         = 50;      // Fast EMA (trend)
input int      InpEMAslow         = 200;     // Slow EMA (trend)
input int      InpLookback        = 30;      // Breakout lookback (bars)
input int      InpATRPeriod       = 14;      // ATR period
input double   InpSL_ATR          = 1.5;     // Stop Loss = ATR x this
input double   InpRR              = 3.0;     // Take Profit = SL x this (RR)
input bool     InpUseVolFilter    = true;    // Require volume > MA x mult
input int      InpVolMA           = 20;      // Volume MA length
input double   InpVolMult         = 1.2;     // Volume must exceed MA x this

//--- Session filter (UTC windows; broker offset converts to server time)
input int      InpBrokerGMTOffset = 3;       // Broker server hours ahead of UTC (you = +3)
input bool     InpUseSession      = true;    // Only trade London/NY
input int      InpLondonOpenUTC   = 7;       // London open (UTC)
input int      InpLondonCloseUTC  = 12;      // London close (UTC)
input int      InpNYOpenUTC       = 13;      // New York open (UTC)
input int      InpNYCloseUTC      = 20;      // New York close (UTC)

//--- Weekend safety (avoid gap-through-stop breaching the daily rule)
input bool     InpCloseBeforeWE   = true;    // Flatten + stop before weekend
input int      InpFriCloseUTC     = 20;      // Friday: no new trades / flatten after this UTC hour

//--- Trade settings
input int      InpMagicNumber     = 20260622; // EA magic number
input int      InpMaxSpreadPts    = 50;      // Max spread (points) to allow entry
input int      InpSlippage        = 30;      // Max slippage (points)
input bool     InpEnableLogging   = true;    // Detailed logs

//========================= GLOBALS =================================
CTrade        trade;
CPositionInfo posInfo;
CAccountInfo  accountInfo;

int           handleEMAfast;
int           handleEMAslow;
int           handleATR;

datetime      lastBarTime         = 0;
double        dailyStartBalance   = 0;
double        accountStartBalance = 0;
datetime      lastDayChecked      = 0;
bool          eaHalted            = false;   // permanent stop (max DD)

//========================= LIFECYCLE ===============================
int OnInit()
  {
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFilling(ORDER_FILLING_FOK);

   accountStartBalance = accountInfo.Balance();
   dailyStartBalance   = accountStartBalance;
   lastDayChecked      = TimeCurrent();

   handleEMAfast = iMA(_Symbol, InpTF, InpEMAfast, 0, MODE_EMA, PRICE_CLOSE);
   handleEMAslow = iMA(_Symbol, InpTF, InpEMAslow, 0, MODE_EMA, PRICE_CLOSE);
   handleATR     = iATR(_Symbol, InpTF, InpATRPeriod);

   if(handleEMAfast == INVALID_HANDLE || handleEMAslow == INVALID_HANDLE || handleATR == INVALID_HANDLE)
     {
      Print("ERROR: indicator handle creation failed. EA stopping.");
      return(INIT_FAILED);
     }

   Print("FP Breakout EA initialized. Start balance: ", accountStartBalance,
         " | Symbol: ", _Symbol, " | TF: ", EnumToString(InpTF));
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   IndicatorRelease(handleEMAfast);
   IndicatorRelease(handleEMAslow);
   IndicatorRelease(handleATR);
   Print("FP Breakout EA deinitialized. Reason: ", reason);
  }

void OnTick()
  {
   if(eaHalted) return;

   //--- Process once per new bar on the strategy timeframe
   datetime curBar = iTime(_Symbol, InpTF, 0);
   if(curBar == lastBarTime) return;
   lastBarTime = curBar;

   ResetDailyCounters();

   //--- GUARD: max total drawdown (permanent stop)
   if(IsMaxDrawdownBreached()) return;

   //--- Weekend flatten / no-trade window
   if(InpCloseBeforeWE && IsWeekendCloseWindow())
     {
      if(PositionsTotal() > 0) CloseAllPositions("Weekend flatten");
      return;
     }

   //--- GUARD: daily loss limit
   if(IsDailyLossBreached()) return;

   //--- Optional: stop after phase target reached
   if(InpStopAtTarget && IsPhaseTargetReached()) return;

   //--- GUARD: session
   if(InpUseSession && !IsInTradingSession()) return;

   //--- GUARD: one position at a time
   if(PositionsTotal() > 0) return;

   //--- GUARD: spread
   if(!IsSpreadAcceptable()) return;

   //--- Signal
   int signal = GetTradeSignal();
   if(signal == 0) return;

   ExecuteTrade(signal);
  }

//+------------------------------------------------------------------+
//| SECTION: Daily Counter Management                                |
//+------------------------------------------------------------------+
void ResetDailyCounters()
  {
   MqlDateTime nowDT, lastDT;
   TimeToStruct(TimeCurrent(),  nowDT);
   TimeToStruct(lastDayChecked, lastDT);
   if(nowDT.day != lastDT.day)
     {
      dailyStartBalance = accountInfo.Balance();
      lastDayChecked    = TimeCurrent();
      if(InpEnableLogging)
         Print("New trading day. Daily start balance: ", dailyStartBalance);
     }
  }

//+------------------------------------------------------------------+
//| SECTION: Risk Guards                                             |
//+------------------------------------------------------------------+
bool IsDailyLossBreached()
  {
   double eq      = accountInfo.Equity();             // includes floating P&L
   double lossPct = (dailyStartBalance - eq) / dailyStartBalance * 100.0;
   if(lossPct >= InpDailyLossGuard)
     {
      if(PositionsTotal() > 0) CloseAllPositions("Daily loss guard");
      if(InpEnableLogging)
         Print("DAILY LOSS GUARD: ", DoubleToString(lossPct,2), "% >= ",
               InpDailyLossGuard, "%. No more trades today.");
      return true;
     }
   return false;
  }

bool IsMaxDrawdownBreached()
  {
   double eq      = accountInfo.Equity();
   double lossPct = (accountStartBalance - eq) / accountStartBalance * 100.0;
   if(lossPct >= InpMaxDDGuard)
     {
      CloseAllPositions("Max drawdown guard");
      eaHalted = true;
      if(InpEnableLogging)
         Print("MAX DD GUARD: ", DoubleToString(lossPct,2), "% >= ",
               InpMaxDDGuard, "%. EA permanently halted — review required.");
      return true;
     }
   return false;
  }

bool IsPhaseTargetReached()
  {
   double gainPct = (accountInfo.Equity() - accountStartBalance) / accountStartBalance * 100.0;
   if(gainPct >= InpPhase1Target)
     {
      if(InpEnableLogging)
         Print("PHASE TARGET reached: +", DoubleToString(gainPct,2), "%. Trading paused.");
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| SECTION: Session Filter (UTC via broker GMT offset)              |
//+------------------------------------------------------------------+
int UtcHourNow()
  {
   datetime utc = TimeCurrent() - (datetime)InpBrokerGMTOffset * 3600;
   MqlDateTime dt;
   TimeToStruct(utc, dt);
   return dt.hour;
  }

// Session check uses the SIGNAL BAR's open time (bar[1]), not current tick time.
// TradingView does the same: hour(time,"UTC") uses bar open, not bar close.
// Without this fix, bars closing at 12:00 UTC (end of London) and 20:00 UTC
// (end of NY) fall in the inter-session gap and get skipped.
int UtcHourSignalBar()
  {
   datetime barOpen = iTime(_Symbol, InpTF, 1);
   datetime utc = barOpen - (datetime)InpBrokerGMTOffset * 3600;
   MqlDateTime dt;
   TimeToStruct(utc, dt);
   return dt.hour;
  }

bool IsInTradingSession()
  {
   int h = UtcHourSignalBar();
   bool london = (h >= InpLondonOpenUTC && h < InpLondonCloseUTC);
   bool ny     = (h >= InpNYOpenUTC     && h < InpNYCloseUTC);
   return (london || ny);
  }

bool IsWeekendCloseWindow()
  {
   datetime utc = TimeCurrent() - (datetime)InpBrokerGMTOffset * 3600;
   MqlDateTime dt;
   TimeToStruct(utc, dt);
   // dt.day_of_week: 0=Sun ... 5=Fri 6=Sat. Block Fri after cutoff, all Sat.
   if(dt.day_of_week == 6) return true;                       // Saturday
   if(dt.day_of_week == 5 && dt.hour >= InpFriCloseUTC) return true; // Fri evening
   return false;
  }

//+------------------------------------------------------------------+
//| SECTION: Indicator Reading                                       |
//+------------------------------------------------------------------+
double EMAval(int handle, int shift)
  {
   double buf[];
   ArraySetAsSeries(buf, true);
   if(CopyBuffer(handle, 0, shift, 1, buf) < 1) return 0.0;
   return buf[0];
  }

double ATRval()
  {
   double buf[];
   ArraySetAsSeries(buf, true);
   if(CopyBuffer(handleATR, 0, 1, 1, buf) < 1) return 0.0; // last closed bar ATR
   return buf[0];
  }

// Highest high over `count` bars starting at `startShift` (MQL5-safe)
double HighestHigh(int startShift, int count)
  {
   double h[];
   ArraySetAsSeries(h, true);
   if(CopyHigh(_Symbol, InpTF, startShift, count, h) < count) return 0.0;
   int idx = ArrayMaximum(h, 0, count);
   if(idx < 0) return 0.0;
   return h[idx];
  }

double LowestLow(int startShift, int count)
  {
   double l[];
   ArraySetAsSeries(l, true);
   if(CopyLow(_Symbol, InpTF, startShift, count, l) < count) return 0.0;
   int idx = ArrayMinimum(l, 0, count);
   if(idx < 0) return 0.0;
   return l[idx];
  }

bool VolumeOK()
  {
   if(!InpUseVolFilter) return true;
   long v[];
   ArraySetAsSeries(v, true);
   if(CopyTickVolume(_Symbol, InpTF, 1, InpVolMA, v) < InpVolMA) return true; // fail open
   double sum = 0;
   for(int i = 0; i < InpVolMA; i++) sum += (double)v[i]; // bars [1..InpVolMA], v[0]=last closed bar
   double volMA = sum / InpVolMA;
   return ((double)v[0] > volMA * InpVolMult);
  }

//+------------------------------------------------------------------+
//| SECTION: Signal Generation (breakout + trend, on closed bar)     |
//+------------------------------------------------------------------+
#define SIGNAL_NONE 0
#define SIGNAL_BUY  1
#define SIGNAL_SELL -1

int GetTradeSignal()
  {
   double ema50  = EMAval(handleEMAfast, 1);  // last closed bar
   double ema200 = EMAval(handleEMAslow, 1);
   if(ema50 == 0 || ema200 == 0) return SIGNAL_NONE;

   double close1 = iClose(_Symbol, InpTF, 1); // last closed bar close
   double close2 = iClose(_Symbol, InpTF, 2);

   // Swing levels: highest/lowest of the 30 bars BEFORE the signal bar
   double swingHi1 = HighestHigh(2, InpLookback); // bars [2..31]
   double swingLo1 = LowestLow(2,  InpLookback);
   double swingHi2 = HighestHigh(3, InpLookback); // bars [3..32] (for fresh-cross check)
   double swingLo2 = LowestLow(3,  InpLookback);

   bool freshBreakUp = (close1 > swingHi1) && (close2 <= swingHi2);
   bool freshBreakDn = (close1 < swingLo1) && (close2 >= swingLo2);

   bool bull = (ema50 > ema200) && (close1 > ema50) && freshBreakUp && VolumeOK();
   bool bear = (ema50 < ema200) && (close1 < ema50) && freshBreakDn && VolumeOK();

   if(bull) return SIGNAL_BUY;
   if(bear) return SIGNAL_SELL;
   return SIGNAL_NONE;
  }

//+------------------------------------------------------------------+
//| SECTION: Trade Execution                                         |
//+------------------------------------------------------------------+
void ExecuteTrade(int signal)
  {
   double atr = ATRval();
   if(atr <= 0) { if(InpEnableLogging) Print("ATR invalid, skip."); return; }

   double slDist = atr * InpSL_ATR;
   double tpDist = slDist * InpRR;
   double lot    = CalculateLotSize(slDist);
   if(lot <= 0) { if(InpEnableLogging) Print("Lot=0, skip."); return; }

   double sl = 0, tp = 0;
   if(signal == SIGNAL_BUY)
     {
      double entry = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      sl = entry - slDist;
      tp = entry + tpDist;
      if(trade.Buy(lot, _Symbol, entry, sl, tp, "FP_BO_BUY"))
        {
         if(InpEnableLogging)
            Print("BUY  lot=", lot, " entry~", DoubleToString(entry,_Digits),
                  " SL=", DoubleToString(sl,_Digits), " TP=", DoubleToString(tp,_Digits),
                  " ATR=", DoubleToString(atr,_Digits));
        }
      else if(InpEnableLogging) Print("BUY failed: ", trade.ResultRetcodeDescription());
     }
   else if(signal == SIGNAL_SELL)
     {
      double entry = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      sl = entry + slDist;
      tp = entry - tpDist;
      if(trade.Sell(lot, _Symbol, entry, sl, tp, "FP_BO_SELL"))
        {
         if(InpEnableLogging)
            Print("SELL lot=", lot, " entry~", DoubleToString(entry,_Digits),
                  " SL=", DoubleToString(sl,_Digits), " TP=", DoubleToString(tp,_Digits),
                  " ATR=", DoubleToString(atr,_Digits));
        }
      else if(InpEnableLogging) Print("SELL failed: ", trade.ResultRetcodeDescription());
     }
  }

bool IsSpreadAcceptable()
  {
   long spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   if(spread > InpMaxSpreadPts)
     {
      if(InpEnableLogging) Print("Spread too high: ", spread, " > ", InpMaxSpreadPts);
      return false;
     }
   return true;
  }

//+------------------------------------------------------------------+
//| SECTION: Lot Size Calculation (risk-based 0.5%)                  |
//+------------------------------------------------------------------+
double CalculateLotSize(double slDistance)
  {
   double riskDollars = accountInfo.Balance() * (InpRiskPercent / 100.0);
   if(slDistance <= 0) return 0;

   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickValue <= 0 || tickSize <= 0) return 0;

   double pointsAtRisk = slDistance / tickSize;
   double lot          = riskDollars / (pointsAtRisk * tickValue);

   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double lotMin  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double lotMax  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);

   lot = MathFloor(lot / lotStep) * lotStep;
   lot = MathMin(lot, InpMaxLot);
   lot = MathMin(lot, lotMax);
   lot = MathMax(lot, lotMin);

   if(InpEnableLogging)
      Print("LOT CALC: risk=$", DoubleToString(riskDollars,2),
            " SLdist=", DoubleToString(slDistance,_Digits),
            " lot=", DoubleToString(lot,2));
   return lot;
  }

//+------------------------------------------------------------------+
//| SECTION: Emergency Close                                         |
//+------------------------------------------------------------------+
void CloseAllPositions(string reason)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
            PositionGetInteger(POSITION_MAGIC) == InpMagicNumber)
           {
            trade.PositionClose(ticket);
            if(InpEnableLogging) Print("Closed #", ticket, " (", reason, ")");
           }
        }
     }
  }
//+------------------------------------------------------------------+
