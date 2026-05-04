import type {
  BenchmarkResult, BenchmarkSummary, ParsedScript, Proposal,
} from '../types';

const BASE = '/api';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ─── Benchmarks ──────────────────────────────────────────────────────────────

export async function listBenchmarks(params?: {
  symbol?: string;
  algo_hash?: string;
  limit?: number;
}): Promise<BenchmarkSummary[]> {
  const qs = new URLSearchParams();
  if (params?.symbol) qs.set('symbol', params.symbol);
  if (params?.algo_hash) qs.set('algo_hash', params.algo_hash);
  if (params?.limit) qs.set('limit', String(params.limit));
  const data = await get<{ results: BenchmarkSummary[] }>(`/benchmarks?${qs}`);
  return data.results;
}

export async function getBenchmark(id: string): Promise<BenchmarkResult> {
  const data = await get<{ result: BenchmarkResult }>(`/benchmarks/${id}`);
  return data.result;
}

export async function runBenchmark(payload: {
  trades: unknown[];
  bars: unknown[];
  equity: unknown[];
  options?: Record<string, unknown>;
}): Promise<{ id: string; result: BenchmarkResult }> {
  return post('/benchmarks/run', payload);
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export async function parsePine(source: string): Promise<ParsedScript> {
  const data = await post<{ parsed: ParsedScript }>('/parse', { source });
  return data.parsed;
}

// ─── Improve ─────────────────────────────────────────────────────────────────

export async function getImprovement(params: {
  benchmarkId: string;
  pineSource?: string;
  weights?: Record<string, number>;
}): Promise<{ proposals: Proposal[]; analysis?: string }> {
  return post('/improve', params);
}
