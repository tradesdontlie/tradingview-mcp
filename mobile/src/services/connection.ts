import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { supabase } from './supabase';

const URL_KEY = 'treebot_server_url';
const OLD_TOKEN_KEY = 'treebot_access_token';

export type BackendConfig = {
  serverUrl: string;
};

function cleanUrl(value: string) {
  const url = value.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw new Error('Enter a valid server URL beginning with http:// or https://');
  }
  return url;
}

export async function saveConnection(config: BackendConfig) {
  if (Platform.OS === 'web') {
    throw new Error('Secure connection storage is available in the mobile app.');
  }
  await SecureStore.setItemAsync(URL_KEY, cleanUrl(config.serverUrl));
  await SecureStore.deleteItemAsync(OLD_TOKEN_KEY);
}

export async function loadConnection(): Promise<BackendConfig | null> {
  if (Platform.OS === 'web') return null;
  const serverUrl = await SecureStore.getItemAsync(URL_KEY);
  await SecureStore.deleteItemAsync(OLD_TOKEN_KEY);
  return serverUrl ? { serverUrl } : null;
}

export async function clearConnection() {
  if (Platform.OS === 'web') return;
  await SecureStore.deleteItemAsync(URL_KEY);
  await SecureStore.deleteItemAsync(OLD_TOKEN_KEY);
}

export async function testConnection(config: BackendConfig) {
  const serverUrl = cleanUrl(config.serverUrl);
  const { data, error } = await supabase.auth.getSession();

  if (error) throw error;
  if (!data.session?.access_token) {
    throw new Error('Please sign in before connecting to your trading server.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(`${serverUrl}/api/state`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${data.session.access_token}`,
      },
      signal: controller.signal,
    });

    const text = await response.text();
    let result: unknown;

    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Backend returned invalid JSON (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const message =
        result && typeof result === 'object' && 'error' in result
          ? String((result as { error?: unknown }).error)
          : '';
      throw new Error(
        response.status === 401 || response.status === 403
          ? message || 'Authentication failed. The server may not support Supabase login.'
          : message || `Backend returned HTTP ${response.status}.`,
      );
    }

    if (
      !result ||
      typeof result !== 'object' ||
      !('run_mode' in result)
    ) {
      throw new Error('The server is not a recognised Tree Bot backend.');
    }

    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Connection timed out. Check the server address and network.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
