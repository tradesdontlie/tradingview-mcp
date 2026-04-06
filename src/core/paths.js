import { mkdirSync } from 'fs';
import { join, dirname, isAbsolute, resolve, normalize } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = dirname(dirname(__dirname));
export const DEFAULT_SCREENSHOT_DIR = join(PROJECT_ROOT, 'screenshots');

export function resolveScreenshotDir(output_dir) {
  const dir = !output_dir
    ? DEFAULT_SCREENSHOT_DIR
    : isAbsolute(output_dir) ? normalize(output_dir) : resolve(PROJECT_ROOT, output_dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}
