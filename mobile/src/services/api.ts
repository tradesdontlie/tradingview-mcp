import { loadConnection } from './connection';
import { supabase } from './supabase';

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

  const response = await fetch(
    `${config.serverUrl}${path}`,
    {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      result.error || `Backend returned HTTP ${response.status}.`,
    );
  }

  return result;
}
