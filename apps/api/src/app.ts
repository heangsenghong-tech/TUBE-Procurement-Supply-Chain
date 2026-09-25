import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config';
import type { Db } from './db/client';
import { type Actor, loadActor } from './core/actor';
import { AppError, unauthenticated } from './core/errors';
import { SESSION_COOKIE, userIdForSession } from './core/sessions';
import { authRoutes } from './routes/auth';
import { apiRoutes } from './routes/api';

declare module 'fastify' {
  interface FastifyRequest { actor: Actor | null }
}

export async function buildApp(config: Config, db: Db) {
  const app = Fastify({
    logger: config.APP_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.cookie'] },
    trustProxy: config.TRUST_PROXY === '1',
    bodyLimit: 5 * 1024 * 1024
  });

  await app.register(cookie, { secret: config.COOKIE_SECRET! });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
      "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self' https://accounts.google.com"
    ].join('; '));
  });

  app.decorateRequest('actor', null);

  // Every API request: resolve the session to a person and load their current roles.
  // State-changing requests must also carry X-Tube-Request, which cross-site pages can't send.
  app.addHook('preHandler', async (req: FastifyRequest) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-tube-request'] !== '1') {
      throw new AppError(403, 'Missing request header.', 'csrf');
    }
    const userId = await userIdForSession(db, req.cookies[SESSION_COOKIE]);
    const actor = userId ? await loadActor(db, userId) : null;
    if (!actor) throw unauthenticated();
    req.actor = actor;
  });

  app.setErrorHandler((err: unknown, req, reply: FastifyReply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.message, code: err.code, details: err.details });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues[0]?.message ?? 'Invalid input.', code: 'validation',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message, code: e.code ?? 'error' });
    // Unique violations etc. that slipped past validation.
    if (e.code === '23505') return reply.status(409).send({ error: 'That already exists.', code: 'conflict' });
    req.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server.', code: 'server_error' });
  });

  await app.register(authRoutes(config, db));
  await app.register(apiRoutes(config, db), { prefix: '/api' });
  app.get('/healthz', async () => ({ ok: true, env: config.APP_ENV }));

  // The web app (built React bundle). Any non-API path falls back to index.html.
  if (fs.existsSync(path.join(config.WEB_DIST, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.WEB_DIST, wildcard: false, index: false });
    const indexHtml = fs.readFileSync(path.join(config.WEB_DIST, 'index.html'), 'utf8');
    app.get('/*', async (req, reply) => {
      const file = req.url.split('?')[0]!.replace(/^\/+/, '');
      if (file && fs.existsSync(path.join(config.WEB_DIST, file)) && !file.includes('..')) {
        return reply.header('Cache-Control', file.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache').sendFile(file);
      }
      return reply.header('Cache-Control', 'no-store').type('text/html').send(indexHtml);
    });
  }
  return app;
}
