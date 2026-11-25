import { apiRequest } from './api';

export type DashboardState = {
  run_mode: string;
  heartbeat: number;
  now: number;
  kill: { mode: string; reason: string };
  account: {
    equity: number;
    day_pnl: number;
    drawdown_pct: number;
  };
  stats: {
    trades: number;
    win_rate: number;
    net_pnl: number;
    profit_factor: number | string;
    expectancy: number;
    max_drawdown: number;
  };
  today: {
    opened: number;
    closed: number;
    wins: number;
    losses: number;
    win_pct: number;
    loss_pct: number;
    net: number;
  };
  nodes: Array<{
    node_id: number;
    level: number;
    state: string;
    symbol: string;
    side: string;
    volume: number;
    entry: number;
    sl: number;
    tp: number;
    net_pnl: number;
    created_ts: number;
  }>;
  rejections: Array<[string, number]>;
};

export async function fetchDashboard(): Promise<DashboardState> {
  return apiRequest('/api/state') as Promise<DashboardState>;
}
