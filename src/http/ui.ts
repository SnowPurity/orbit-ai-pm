import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publicDir = path.join(projectRoot, 'public');

const assets: Record<string, { file: string; type: string }> = {
  'index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  'app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  'citations.js': { file: 'citations.js', type: 'text/javascript; charset=utf-8' },
  'styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  'vendor/markdown-it.mjs': { file: 'vendor/markdown-it.mjs', type: 'text/javascript; charset=utf-8' },
  'vendor/markdown-it.LICENSE': { file: 'vendor/markdown-it.LICENSE', type: 'text/plain; charset=utf-8' },
};

const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

async function sendAsset(reply: FastifyReply, name: keyof typeof assets) {
  const asset = assets[name];
  try {
    const body = await fs.readFile(path.join(publicDir, asset.file));
    return reply.headers(securityHeaders).type(asset.type).header('cache-control', 'no-store').send(body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return reply.code(404).type('text/plain; charset=utf-8').send('UI assets are missing');
    }
    throw error;
  }
}

export async function registerUi(app: FastifyInstance): Promise<void> {
  app.get('/', async (_request, reply) => reply.redirect('/ui'));
  app.get('/ui', async (_request, reply) => sendAsset(reply, 'index.html'));
  app.get('/ui/', async (_request, reply) => sendAsset(reply, 'index.html'));
  app.get('/ui/me', async (_request, reply) => sendAsset(reply, 'index.html'));
  app.get('/ui/app.js', async (_request, reply) => sendAsset(reply, 'app.js'));
  app.get('/ui/citations.js', async (_request, reply) => sendAsset(reply, 'citations.js'));
  app.get('/ui/styles.css', async (_request, reply) => sendAsset(reply, 'styles.css'));
  app.get('/ui/vendor/markdown-it.mjs', async (_request, reply) => sendAsset(reply, 'vendor/markdown-it.mjs'));
  app.get('/ui/vendor/markdown-it.LICENSE', async (_request, reply) =>
    sendAsset(reply, 'vendor/markdown-it.LICENSE'),
  );
  app.get('/ui/projects/*', async (_request, reply) => sendAsset(reply, 'index.html'));
  app.get('/ui/tasks/*', async (_request, reply) => sendAsset(reply, 'index.html'));
  app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());
}
