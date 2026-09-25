// Sign in with Google, sign out, and (training/dev only) a demo account picker.
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as t from '../db/schema';
import { audit } from '../core/audit';
import { AppError } from '../core/errors';
import { GoogleSignInError, type OAuthState, authorizationUrl, completeSignIn, newOAuthState } from '../core/google';
import { SESSION_COOKIE, SESSION_DAYS, createSession, deleteSession } from '../core/sessions';

const OAUTH_COOKIE = 'tube_oauth';
// Training only: proves the visitor signed in with a company Google account before they may
// pick a demo person (the training database contains the real price list).
const TRAINEE_COOKIE = 'tube_trainee';

export function authRoutes(config: Config, db: Db) {
  const googleConfigured = !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
  const devLogin = config.DEV_LOGIN === '1' && config.APP_ENV !== 'production';
  const devLoginNeedsGoogle = devLogin && googleConfigured;
  const isTrainee = (req: FastifyRequest) => {
    if (!devLoginNeedsGoogle) return true;
    const raw = req.cookies[TRAINEE_COOKIE];
    const v = raw ? req.unsignCookie(raw) : null;
    return !!(v?.valid && v.value);
  };

  async function startSession(req: FastifyRequest, reply: FastifyReply, userId: string, method: string) {
    const token = await createSession(db, userId, { ip: req.ip, userAgent: req.headers['user-agent'] });
    await db.update(t.users).set({ lastLoginAt: new Date() }).where(eq(t.users.id, userId));
    await audit(db, { userId, action: 'login', comment: method });
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: SESSION_DAYS * 86400
    });
  }

  return async function (app: FastifyInstance) {
    app.get('/auth/options', async (req) => ({
      google: googleConfigured, devLogin: devLogin && isTrainee(req), devLoginNeedsGoogle: devLogin && !isTrainee(req), environment: config.APP_ENV
    }));

    app.get('/auth/google', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) => {
      if (!googleConfigured) return reply.redirect('/login?error=google_not_configured');
      const s = newOAuthState();
      reply.setCookie(OAUTH_COOKIE, JSON.stringify(s), {
        path: '/auth/google', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 600, signed: true
      });
      return reply.redirect(authorizationUrl(config, s));
    });

    app.get('/auth/google/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const q = req.query as { code?: string; state?: string; error?: string };
      const fail = (code: string) => {
        reply.clearCookie(OAUTH_COOKIE, { path: '/auth/google' });
        return reply.redirect('/login?error=' + encodeURIComponent(code));
      };
      if (q.error) return fail('google_cancelled');
      const raw = req.cookies[OAUTH_COOKIE];
      const unsigned = raw ? req.unsignCookie(raw) : null;
      if (!unsigned?.valid || !unsigned.value) return fail('expired');
      const s = JSON.parse(unsigned.value) as OAuthState;
      if (!q.code || !q.state || q.state !== s.state) return fail('expired');

      let identity;
      try { identity = await completeSignIn(config, q.code, s); }
      catch (e) {
        req.log.warn({ err: e }, 'google sign-in failed');
        return fail(e instanceof GoogleSignInError && /Workspace/.test(e.message) ? 'wrong_domain' : 'google_failed');
      }
      const user = await db.query.users.findFirst({ where: eq(t.users.email, identity.email) });
      if (!user && devLoginNeedsGoogle) {
        // Training: any company account may try the demo people once it has proven who it is.
        await audit(db, { userId: null, action: 'training.google', comment: identity.email });
        reply.setCookie(TRAINEE_COOKIE, identity.email, { path: '/auth', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 12 * 3600, signed: true });
        reply.clearCookie(OAUTH_COOKIE, { path: '/auth/google' });
        return reply.redirect('/login');
      }
      if (!user || !user.active) {
        await audit(db, { userId: null, action: 'login.refused', comment: `${identity.email}: ${user ? 'disabled' : 'not registered'}` });
        return fail(user ? 'disabled' : 'not_registered');
      }
      if (user.googleSub && user.googleSub !== identity.sub) return fail('account_mismatch');
      await db.update(t.users).set({ googleSub: identity.sub, name: user.name || identity.name }).where(eq(t.users.id, user.id));
      await startSession(req, reply, user.id, 'google');
      reply.clearCookie(OAUTH_COOKIE, { path: '/auth/google' });
      return reply.redirect('/');
    });

    app.post('/auth/logout', async (req, reply) => {
      if (req.headers['x-tube-request'] !== '1') throw new AppError(403, 'Missing request header.', 'csrf');
      await deleteSession(db, req.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    if (devLogin) {
      // Training/development only: choose which demo person to be. Never available in production.
      app.get('/auth/dev-users', async (req) => {
        if (!isTrainee(req)) throw new AppError(403, 'Sign in with your company Google account first.', 'forbidden');
        const rows = await db.select({ id: t.users.id, name: t.users.name, email: t.users.email, unit: t.orgUnits.name })
          .from(t.users).leftJoin(t.orgUnits, eq(t.orgUnits.id, t.users.orgUnitId)).where(eq(t.users.active, true)).orderBy(asc(t.users.name));
        return rows;
      });
      app.post('/auth/dev-login', async (req, reply) => {
        if (req.headers['x-tube-request'] !== '1') throw new AppError(403, 'Missing request header.', 'csrf');
        if (!isTrainee(req)) throw new AppError(403, 'Sign in with your company Google account first.', 'forbidden');
        const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
        const user = await db.query.users.findFirst({ where: and(eq(t.users.id, userId), eq(t.users.active, true)) });
        if (!user) throw new AppError(404, 'User not found.', 'not_found');
        await startSession(req, reply, user.id, 'dev-login');
        return { ok: true };
      });
    }
  };
}
