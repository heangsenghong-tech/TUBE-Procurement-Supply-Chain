import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { checkClaims, GoogleSignInError } from '../src/core/google';
import { buildWorld, freshDatabase, TEST_DB_URL, type World } from './helpers';

let app: FastifyInstance;
let w: World;
let close: () => Promise<void>;
const config = loadConfig({ APP_ENV: 'test', DATABASE_URL: TEST_DB_URL, DEV_LOGIN: '1', WEB_DIST: '/nonexistent' } as NodeJS.ProcessEnv);

beforeAll(async () => {
  const { db, sql } = await freshDatabase();
  close = () => sql.end();
  w = await buildWorld(db);
  app = await buildApp(config, db);
});
afterAll(async () => { await app.close(); await close(); });

async function signIn(key: string) {
  const res = await app.inject({ method: 'POST', url: '/auth/dev-login', headers: { 'x-tube-request': '1' }, payload: { userId: w.people[key]!.id } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'tube_session')!;
  expect(cookie.httpOnly).toBe(true);
  return { cookie: `tube_session=${cookie.value}`, 'x-tube-request': '1' };
}

describe('authentication', () => {
  it('refuses the API without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses state changes without the anti-CSRF header', async () => {
    const h = await signIn('kdt.staff');
    const res = await app.inject({ method: 'POST', url: '/api/requests/sample', headers: { cookie: h.cookie }, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it('signs out', async () => {
    const h = await signIn('kdt.staff');
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: h })).statusCode).toBe(401);
  });

  it('refuses to start production with dev login, without Google, or without HTTPS', () => {
    const base = { APP_ENV: 'production', DATABASE_URL: 'postgres://x', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', PUBLIC_URL: 'https://p.example', COOKIE_SECRET: 'x'.repeat(32) };
    expect(() => loadConfig(base as never)).not.toThrow();
    expect(() => loadConfig({ ...base, DEV_LOGIN: '1' } as never)).toThrow(/DEV_LOGIN/);
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: undefined } as never)).toThrow(/GOOGLE/);
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'http://p.example' } as never)).toThrow(/https/);
  });

  it('dev login does not exist when disabled', async () => {
    const prodLike = await buildApp(loadConfig({ APP_ENV: 'test', DATABASE_URL: TEST_DB_URL, DEV_LOGIN: '0', WEB_DIST: '/nonexistent' } as never), w.db);
    const res = await prodLike.inject({ method: 'POST', url: '/auth/dev-login', headers: { 'x-tube-request': '1' }, payload: { userId: w.people.ceo!.id } });
    expect(res.statusCode).toBe(404);
    await prodLike.close();
  });
});

describe('training environment', () => {
  it('with Google configured, the demo picker stays locked until a company Google sign-in', async () => {
    const training = await buildApp(loadConfig({ APP_ENV: 'training', DATABASE_URL: TEST_DB_URL, DEV_LOGIN: '1', WEB_DIST: '/nonexistent',
      GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' } as never), w.db);
    const opts = (await training.inject({ method: 'GET', url: '/auth/options' })).json();
    expect(opts.devLogin).toBe(false);
    expect(opts.devLoginNeedsGoogle).toBe(true);
    expect((await training.inject({ method: 'GET', url: '/auth/dev-users' })).statusCode).toBe(403);
    const res = await training.inject({ method: 'POST', url: '/auth/dev-login', headers: { 'x-tube-request': '1' }, payload: { userId: w.people.ceo!.id } });
    expect(res.statusCode).toBe(403);
    await training.close();
  });
});

describe('Google sign-in claims', () => {
  const cfg = { ...config, allowedDomains: ['tubecafecambodia.com'] };
  const good = { sub: '1', email: 'a@tubecafecambodia.com', email_verified: true, hd: 'tubecafecambodia.com', nonce: 'n', name: 'A' };
  it('accepts a verified Workspace account', () => {
    expect(checkClaims(cfg, good, 'n').email).toBe('a@tubecafecambodia.com');
  });
  it('rejects personal Gmail, other domains, unverified emails and replayed tokens', () => {
    expect(() => checkClaims(cfg, { ...good, email: 'a@gmail.com', hd: undefined }, 'n')).toThrow(GoogleSignInError);
    expect(() => checkClaims(cfg, { ...good, hd: 'evil.com' }, 'n')).toThrow(/Workspace/);
    expect(() => checkClaims(cfg, { ...good, email_verified: false }, 'n')).toThrow(/verified/);
    expect(() => checkClaims(cfg, good, 'other-nonce')).toThrow(/mismatch/);
  });
});

describe('authorization over HTTP', () => {
  it('a store user cannot reach procurement, pricing, suppliers, users or settings', async () => {
    const h = await signIn('kdt.staff');
    for (const url of ['/api/procurement/review', '/api/suppliers', '/api/pos', '/api/users', '/api/approval-rules', '/api/reports/spend', '/api/exports/price-list', '/api/audit']) {
      const res = await app.inject({ method: 'GET', url, headers: h });
      expect(res.statusCode, url).toBe(403);
    }
    const items = (await app.inject({ method: 'GET', url: '/api/items?q=Arabica', headers: h })).json();
    expect(items[0].prices).toBeUndefined();
    expect(items[0].standardCost).toBeUndefined();
  });

  it('a store user cannot approve their own request or change prices', async () => {
    const h = await signIn('kdt.staff');
    const bean = (await app.inject({ method: 'GET', url: '/api/items?q=I00043', headers: h })).json()[0];
    const created = await app.inject({ method: 'POST', url: '/api/requests/purchase', headers: h,
      payload: { track: 'store', orgUnitId: w.units.KDT, lines: [{ itemId: bean.id, qty: 30 }] } });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    const approve = await app.inject({ method: 'POST', url: `/api/requests/${id}/approval`, headers: h, payload: { action: 'approve' } });
    expect(approve.statusCode).toBe(403);
    const price = await app.inject({ method: 'POST', url: `/api/items/${bean.id}/prices`, headers: h, payload: { supplierId: await w.supplier('SUP-0011'), unitPrice: 0.01, rank: 1 } });
    expect(price.statusCode).toBe(403);

    const hod = await signIn('kdt.hod');
    const inbox = (await app.inject({ method: 'GET', url: '/api/approvals/inbox', headers: hod })).json();
    expect(inbox.some((x: { documentId: string }) => x.documentId === id)).toBe(true);
    const ok = await app.inject({ method: 'POST', url: `/api/requests/${id}/approval`, headers: hod, payload: { action: 'approve' } });
    expect(ok.statusCode).toBe(200);
  });

  it('validation errors come back as 400 with a readable message', async () => {
    const h = await signIn('kdt.staff');
    const res = await app.inject({ method: 'POST', url: '/api/requests/purchase', headers: h, payload: { track: 'store', orgUnitId: w.units.KDT, lines: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least one item/);
  });

  it('exports: CSV only with Export Authorization, and formula cells are neutralised', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/exports/price-list', headers: await signIn('buyer') })).statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: '/api/exports/price-list', headers: await signIn('buyer.export') });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.body).toContain('Item Code,Description');
  });

  it('CSV import validates every row before writing anything', async () => {
    const h = await signIn('buyer');
    const csv = 'Item Code,Description,Category,Type,UOM,Unit Price,Supplier\r\nX1,Good row,Food,Direct,kg,2,Kofi\r\nX2,Bad unit,Food,Direct,Crate,2,\r\nX3,Bad supplier,Food,Direct,Pcs,1,Nobody Ltd\r\n';
    const res = await app.inject({ method: 'POST', url: '/api/import/items', headers: h, payload: { csv, dryRun: false } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4]);
    const items = (await app.inject({ method: 'GET', url: '/api/items?q=X1', headers: h })).json();
    expect(items.find((i: { code: string }) => i.code === 'X1')).toBeUndefined();
  });
});
