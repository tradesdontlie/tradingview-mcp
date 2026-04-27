import { register } from '../router.js';
import * as core from '../../core/ui.js';

register('ui', {
  description: 'UI automation tools (click, keyboard, hover, scroll, find, eval, type, panel, fullscreen, mouse)',
  subcommands: new Map([
    ['click', {
      description: 'Click a UI element',
      options: {
        by: { type: 'string', short: 'b', description: 'Selector: aria-label, data-name, text, class-contains' },
        value: { type: 'string', short: 'v', description: 'Value to match' },
        chain: { type: 'string', short: 'c', description: 'Event chain: minimal (default) | full — use full for stubborn buttons' },
      },
      handler: (opts) => core.click({ by: opts.by || 'text', value: opts.value, event_chain: opts.chain }),
    }],
    ['keyboard', {
      description: 'Press a keyboard key or shortcut',
      options: {
        ctrl: { type: 'boolean', description: 'Hold Ctrl' },
        shift: { type: 'boolean', description: 'Hold Shift' },
        alt: { type: 'boolean', description: 'Hold Alt' },
        meta: { type: 'boolean', description: 'Hold Meta/Cmd' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Key required. Usage: tv ui keyboard Escape');
        const modifiers = [];
        if (opts.ctrl) modifiers.push('ctrl');
        if (opts.shift) modifiers.push('shift');
        if (opts.alt) modifiers.push('alt');
        if (opts.meta) modifiers.push('meta');
        return core.keyboard({ key: positionals[0], modifiers: modifiers.length > 0 ? modifiers : undefined });
      },
    }],
    ['hover', {
      description: 'Hover over a UI element',
      options: {
        by: { type: 'string', short: 'b', description: 'Selector: aria-label, data-name, text, class-contains' },
        value: { type: 'string', short: 'v', description: 'Value to match' },
      },
      handler: (opts) => core.hover({ by: opts.by || 'text', value: opts.value }),
    }],
    ['scroll', {
      description: 'Scroll the chart',
      options: {
        amount: { type: 'string', short: 'a', description: 'Scroll amount in pixels (default 300)' },
      },
      handler: (opts, positionals) => {
        const direction = positionals[0] || 'down';
        return core.scroll({ direction, amount: opts.amount ? Number(opts.amount) : undefined });
      },
    }],
    ['find', {
      description: 'Find UI elements by text, aria-label, or CSS selector',
      options: {
        strategy: { type: 'string', short: 's', description: 'Search strategy: text, aria-label, css' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Query required. Usage: tv ui find "Indicators"');
        return core.findElement({ query: positionals.join(' '), strategy: opts.strategy });
      },
    }],
    ['eval', {
      description: 'Execute JavaScript in TradingView page context',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Expression required. Usage: tv ui eval "1+1"');
        return core.uiEvaluate({ expression: positionals.join(' ') });
      },
    }],
    ['type', {
      description: 'Type text into focused input',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Text required. Usage: tv ui type "hello"');
        return core.typeText({ text: positionals.join(' ') });
      },
    }],
    ['panel', {
      description: 'Open/close/toggle a panel',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Usage: tv ui panel pine-editor open');
        return core.openPanel({ panel: positionals[0], action: positionals[1] || 'toggle' });
      },
    }],
    ['fullscreen', {
      description: 'Toggle fullscreen mode',
      handler: () => core.fullscreen(),
    }],
    ['mouse', {
      description: 'Click at x,y coordinates',
      options: {
        right: { type: 'boolean', description: 'Right click' },
        double: { type: 'boolean', description: 'Double click' },
      },
      handler: (opts, positionals) => {
        if (positionals.length < 2) throw new Error('Usage: tv ui mouse 400 400 [--right] [--double]');
        return core.mouseClick({
          x: Number(positionals[0]),
          y: Number(positionals[1]),
          button: opts.right ? 'right' : 'left',
          double_click: opts.double,
        });
      },
    }],
  ]),
});
