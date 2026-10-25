import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Files like models.json and policy/phrases.json sit at the repository
// root. Code runs from src/ under tsx and from dist/src/ once compiled,
// so resolve assets by walking up to the directory holding package.json
// instead of assuming a fixed relative depth.
export function repoRoot(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function asset(rel: string, fromUrl: string = import.meta.url): string {
  return join(repoRoot(fromUrl), rel);
}
