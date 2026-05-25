#!/usr/bin/env node
// Subscribe prompt. Big readable ASCII "SUBSCRIBE?" banner with a slow
// colour pulse and a cursor sweeping beneath it. Y/N input.
// Exits 0 on Y, 1 on N / Esc / Q.

const readline = require('readline');

const BANNER = [
  ' ____  _   _ ____ ____   ____ ____  ___ ____  _____ ___ ',
  '/ ___|| | | | __ ) ___| / ___|  _ \\|_ _| __ )| ____|__ \\',
  '\\___ \\| | | |  _ \\___ \\| |   | |_) || ||  _ \\|  _|   / /',
  ' ___) | |_| | |_) |__) | |___|  _ < | || |_) | |___ |_| ',
  '|____/ \\___/|____/____/ \\____|_| \\_\\___|____/|_____|(_) ',
];

const BANNER_WIDTH = BANNER[0].length;
const BLOCK_HEIGHT = BANNER.length + 4; // banner + cursor row + spacer + Y/N + hint

if (process.stdout.isTTY && process.stdout.columns < BANNER_WIDTH + 4) {
  console.error(`subscribe-prompt: terminal needs at least ${BANNER_WIDTH + 4} cols (you have ${process.stdout.columns}). resize and re-run.`);
  process.exit(2);
}

const RESET = '\x1b[0m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[K';
const DIM = '\x1b[38;5;240m';
const BRIGHT = '\x1b[38;5;231m';
const CURSOR_FG = '\x1b[38;5;215m';

// Two-shade slow pulse for the banner.
const PULSE = ['\x1b[38;5;110m', '\x1b[38;5;117m'];

process.stdout.write(HIDE_CURSOR);
process.stdout.write('\n'.repeat(BLOCK_HEIGHT));

let t = 0;
const FPS = 12;

const YES_LABEL = '[Y] yes';
const NO_LABEL  = '[N] no';
const HINT      = 'press y or n';

function render() {
  process.stdout.write(`\x1b[${BLOCK_HEIGHT}A`);

  const pulse = PULSE[Math.floor(t / 14) % PULSE.length];

  // Cursor oscillates left↔right along the banner width.
  const phase = (t / 30) % 2;
  const norm = phase < 1 ? phase : 2 - phase; // triangle wave 0→1→0
  const cursorCol = Math.round(norm * (BANNER_WIDTH - 1));

  for (let r = 0; r < BLOCK_HEIGHT; r++) {
    let line = '';
    if (r < BANNER.length) {
      line = pulse + BANNER[r] + RESET;
    } else if (r === BANNER.length) {
      // Cursor row beneath the banner.
      const padding = ' '.repeat(cursorCol);
      line = padding + CURSOR_FG + '▲' + RESET;
    } else if (r === BANNER.length + 2) {
      line = '  ' + BRIGHT + YES_LABEL + RESET + '   ' + DIM + NO_LABEL + RESET;
    } else if (r === BANNER.length + 3) {
      line = '  ' + DIM + HINT + RESET;
    }
    process.stdout.write(line + CLEAR_LINE + '\n');
  }

  t++;
}

const interval = setInterval(render, 1000 / FPS);
render();

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

function cleanup(code) {
  clearInterval(interval);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(SHOW_CURSOR);
  process.exit(code);
}

process.stdin.on('keypress', (_, key) => {
  if (!key) return;
  if (key.name === 'y') cleanup(0);
  else if (key.name === 'n' || key.name === 'escape' || key.name === 'q') cleanup(1);
  else if (key.ctrl && key.name === 'c') cleanup(130);
});

process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));
