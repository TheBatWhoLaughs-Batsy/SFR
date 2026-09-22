// Node ESM resolve hook: the app's sources import relative modules without a .js
// extension (Vite resolves those; Node does not). Registered by register.mjs so the
// harness drives the SHIPPED lib files in place -- copying them to a scratch dir with
// rewritten imports, as earlier throwaway harnesses did, is how a check silently ends
// up testing a stale copy.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[cm]?js(on)?$/.test(specifier) && context.parentURL) {
    const abs = fileURLToPath(new URL(specifier, context.parentURL));
    for (const cand of [`${abs}.js`, `${abs}/index.js`]) {
      if (existsSync(cand)) return next(pathToFileURL(cand).href, context);
    }
  }
  return next(specifier, context);
}
