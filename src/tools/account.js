import { z } from 'zod';
import { jsonResult } from './_format.js';
import { evaluate } from '../connection.js';

export function registerAccountTools(server) {
  server.tool('get_account_balance', 'Read the account balance from the TradingView broker panel', {}, async () => {
    try {
      // First click the Fusion Markets tab to ensure the panel is expanded
      await evaluate(`
        (() => {
          const btns = document.querySelectorAll('button');
          for (const btn of btns) {
            if (btn.innerText && btn.innerText.includes('Fusion Markets')) {
              btn.click();
              return true;
            }
          }
          return false;
        })()
      `);

      // Small delay for panel to render
      await new Promise(r => setTimeout(r, 500));

      const balanceText = await evaluate(`
        (() => {
          const header = document.querySelector('div.js-account-manager-header');
          if (!header) return null;
          // Account Balance is the first value field
          const fields = header.querySelectorAll('div.value-tWnxJF90');
          if (fields.length > 0 && fields[0].innerText) {
            return fields[0].innerText.replace(/[^0-9.]/g, '');
          }
          return null;
        })()
      `);

      const balance = parseFloat(balanceText);
      if (isNaN(balance)) return jsonResult({ success: false, error: 'Could not read balance' });
      return jsonResult({ success: true, balance });
    } catch (err) {
      return jsonResult({ success: false, error: err.message });
    }
  });
}
