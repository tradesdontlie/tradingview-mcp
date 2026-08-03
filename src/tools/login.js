import { z } from 'zod';
import { jsonResult } from './_format.js';
import { evaluate } from '../connection.js';
import { execSync } from 'child_process';

const CREDENTIALS_FILE = '/home/kali/trading-ai/credentials.enc';

function decryptCredentials(masterPassword) {
  const out = execSync(`openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in ${CREDENTIALS_FILE} -k "${masterPassword}"`, { encoding: 'utf-8' });
  const [user, pass] = out.trim().split(':');
  return { user, pass };
}

export function registerLoginTools(server) {
  // Check if broker panel is logged in (balance visible)
  server.tool('check_broker_connection', 'Check if broker is logged in on TradingView', {}, async () => {
    try {
      const result = await evaluate(`
        (() => {
          // 1. Look for balance text (typical in TradingView broker panel)
          const balanceElements = document.querySelectorAll('.balance, .balance-value, [data-role="account-balance"], .tv-trading-panel__balance');
          for (const el of balanceElements) {
            if (el.innerText && el.innerText.trim() !== '') return true;
          }
          // 2. Look for login button — if present, we're logged out
          const buttons = Array.from(document.querySelectorAll('button'));
          const loginBtn = buttons.find(btn => btn.innerText.includes('Log In') || btn.innerText.includes('Sign In'));
          if (loginBtn) return false;
          // 3. If no login button and no balance, still assume logged in (maybe panel is hidden)
          return true;
        })()
      `);
      return jsonResult({ connected: result === true || result === 'true' });
    } catch (err) {
      return jsonResult({ connected: false, error: err.message });
    }
  });

  // Auto-login using standard selectors + text search
  server.tool('auto_login', 'Automatically fill credentials and click login button.', {
    master_password: z.string().describe('Master password to decrypt credentials'),
  }, async ({ master_password }) => {
    try {
      const { user, pass } = decryptCredentials(master_password);

      await evaluate(`
        (() => {
          // Helper to find input by possible attributes
          function findInput(names) {
            for (const name of names) {
              const el = document.querySelector(\`input[name="\${name}"], input[placeholder*="\${name}" i], input[type="\${name}"]\`);
              if (el) return el;
            }
            // Fallback: any input that looks like username (text/email) or password
            if (names.includes('username')) return document.querySelector('input[type="text"]:not([readonly]), input[type="email"]');
            if (names.includes('password')) return document.querySelector('input[type="password"]');
            return null;
          }

          const userInput = findInput(['username', 'email', 'login']);
          if (!userInput) return 'User input not found';
          userInput.value = '${user}';
          userInput.dispatchEvent(new Event('input', { bubbles: true }));
          userInput.dispatchEvent(new Event('change', { bubbles: true }));

          const passInput = findInput(['password']);
          if (!passInput) return 'Password input not found';
          passInput.value = '${pass}';
          passInput.dispatchEvent(new Event('input', { bubbles: true }));
          passInput.dispatchEvent(new Event('change', { bubbles: true }));

          // Find login button by visible text
          const buttons = Array.from(document.querySelectorAll('button, a[role="button"]'));
          const loginBtn = buttons.find(btn => btn.innerText.trim().toLowerCase().includes('log in') || 
                                              btn.innerText.trim().toLowerCase().includes('sign in'));
          if (!loginBtn) return 'Login button not found';
          loginBtn.click();
          return 'Login clicked';
        })()
      `);
      return jsonResult({ success: true, message: 'Login submitted' });
    } catch (err) {
      return jsonResult({ success: false, error: err.message });
    }
  });
}
