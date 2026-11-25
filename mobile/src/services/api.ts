import { loadConnection } from './connection';
import { supabase } from './supabase';

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Backend returned invalid JSON (HTTP ${response.status}).`);
  }
}

export async function apiRequest(
  path: string,
  method = 'GET',
  body?: object,
) {
  const config = await loadConnection();

  if (!config) {
    throw new Error('Connect your trading server first.');
  }

  const { data, error } = await supabase.auth.getSession();

  if (error) throw error;

  const accessToken = data.session?.access_token;

  if (!accessToken) {
    throw new Error('Your session has expired. Please sign in again.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${config.serverUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const result = await readJson(response);

    if (!response.ok) {
      throw new Error(
        result.error || `Backend returned HTTP ${response.status}.`,
      );
    }

    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request timed out. Check the server address and network.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
