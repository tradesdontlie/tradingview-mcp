import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLaunchTarget } from '../src/core/health.js';

test('resolveLaunchTarget prefers a detected Windows AppX TradingView install', () => {
  const result = resolveLaunchTarget({
    platform: 'win32',
    env: {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    },
    exists: (path) => path === 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.0.0.7652_x64__n534cwy3pjxzj\\TradingView.exe',
    exec: (command) => {
      if (command === 'where TradingView.exe') {
        throw new Error('not found');
      }

      if (command.includes('Get-AppxPackage')) {
        return 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.0.0.7652_x64__n534cwy3pjxzj';
      }

      throw new Error(`unexpected command: ${command}`);
    },
  });

  assert.deepEqual(result, {
    tvPath: 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.0.0.7652_x64__n534cwy3pjxzj\\TradingView.exe',
    candidates: [
      'C:\\Users\\me\\AppData\\Local\\TradingView\\TradingView.exe',
      'C:\\Program Files\\TradingView\\TradingView.exe',
      'C:\\Program Files (x86)\\TradingView\\TradingView.exe',
    ],
  });
});

test('resolveLaunchTarget falls back to where output before AppX detection', () => {
  const result = resolveLaunchTarget({
    platform: 'win32',
    env: {
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    },
    exists: (path) => path === 'C:\\Tools\\TradingView.exe',
    exec: (command) => {
      if (command === 'where TradingView.exe') {
        return 'C:\\Tools\\TradingView.exe\r\n';
      }

      throw new Error(`unexpected command: ${command}`);
    },
  });

  assert.equal(result.tvPath, 'C:\\Tools\\TradingView.exe');
});
