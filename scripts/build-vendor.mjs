import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'public', 'vendor');
const packageJson = JSON.parse(
  await fs.readFile(path.join(root, 'node_modules', 'markdown-it', 'package.json'), 'utf8'),
);

await fs.mkdir(vendorDir, { recursive: true });
await build({
  entryPoints: [path.join(root, 'node_modules', 'markdown-it', 'index.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  banner: {
    js: `/*! markdown-it v${packageJson.version} | MIT License | https://github.com/markdown-it/markdown-it */`,
  },
  outfile: path.join(vendorDir, 'markdown-it.mjs'),
});
await fs.copyFile(
  path.join(root, 'node_modules', 'markdown-it', 'LICENSE'),
  path.join(vendorDir, 'markdown-it.LICENSE'),
);
