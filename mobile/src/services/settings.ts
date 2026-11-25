import { apiRequest } from './api';

export type TradingSettings = {
  profile: 'standard' | 'small' | 'scalp';
  allocated_capital: number;
  risk_per_trade_amount: number;
  daily_loss_pct: number;
  max_open_risk_pct: number;
};

export type EngineStatus = {
  state: 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';
  alive: boolean;
  error: string | null;
};

export async function fetchSettings(): Promise<TradingSettings> {
  return apiRequest('/api/settings') as Promise<TradingSettings>;
}

export async function saveSettings(
  settings: TradingSettings,
): Promise<{ saved: boolean; settings: TradingSettings }> {
  return apiRequest('/api/settings', 'POST', settings) as Promise<{ saved: boolean; settings: TradingSettings }>;
}

export async function fetchEngineStatus(): Promise<EngineStatus> {
  return apiRequest('/api/engine') as Promise<EngineStatus>;
}

export type AccessStatus = {
  authenticated: boolean;
  admin: boolean;
};

export async function fetchAccess(): Promise<AccessStatus> {
  return apiRequest('/api/access') as Promise<AccessStatus>;
}

export async function controlEngine(
  action: 'start' | 'stop',
) {
  return apiRequest('/api/engine', 'POST', { action });
}

export async function controlKillSwitch(
  action: 'pause' | 'freeze' | 'liquidate' | 'reset',
) {
  const body = action === 'reset'
    ? { action, confirm: 'RESET' }
    : { action };

  return apiRequest('/api/kill', 'POST', body);
}
