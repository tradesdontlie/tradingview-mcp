import CDP from 'chrome-remote-interface';
import fs from 'fs';

const client = await CDP({ host: 'localhost', port: 9222 });
const { Runtime, Page } = client;
await Runtime.enable();
await Page.enable();

const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 60 });
fs.writeFileSync('/tmp/tv_state.jpg', Buffer.from(data, 'base64'));
console.error('Screenshot saved to /tmp/tv_state.jpg');

// Also check what dialogs/modals are visible
const dialogs = await Runtime.evaluate({
  expression: `(function() {
    var modals = document.querySelectorAll('[class*="dialog"], [class*="modal"], [class*="popup"]');
    return Array.from(modals).filter(m => m.offsetParent !== null).slice(0, 5).map(m => ({
      dataName: m.getAttribute('data-name'),
      className: (m.className || '').slice(0, 80),
      visible: true,
      text: (m.textContent || '').trim().slice(0, 100)
    }));
  })()`,
  returnByValue: true
});
console.error('Visible dialogs:', JSON.stringify(dialogs.result.value));

await client.close();
