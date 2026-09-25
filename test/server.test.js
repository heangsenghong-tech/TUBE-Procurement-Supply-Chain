'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/server');

let app, base, dir;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tube-test-'));
  app = createApp({ dataDir: dir });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + app.server.address().port;
});

test.after(async () => {
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async function call(method, url, body, headers = {}) {
    const h = Object.assign({}, headers);
    if (cookie) h.Cookie = cookie;
    if (method !== 'GET' && !('X-Tube-Request' in headers)) h['X-Tube-Request'] = '1';
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, json, headers: res.headers };
  };
}

const admin = client();
const staff = client();

test('fresh install shows setup and loads the real master data', async () => {
  const r = await fetch(base + '/', { redirect: 'manual' });
  assert.strictEqual(r.status, 200);
  assert.match(await r.text(), /Create the administrator account/);
  assert.strictEqual(app.store.count('items'), 160);
  assert.strictEqual(app.store.count('suppliers'), 26);
  assert.strictEqual(app.store.get('items', 'I00043').supplierCode, 'SUP-0011');
});

test('setup creates the admin with workspace and export access', async () => {
  const r = await admin('POST', '/api/setup', { name: 'Hong', email: 'hong@example.com', password: 'correct-horse' });
  assert.strictEqual(r.status, 200);
  const me = await admin('GET', '/api/me');
  assert.strictEqual(me.json.name, 'Hong');
  assert.strictEqual(me.json.procurement, true);
  assert.strictEqual(me.json.exportAuthorized, true);
  const again = await client()('POST', '/api/setup', { name: 'X', email: 'x@example.com', password: 'whatever12' });
  assert.strictEqual(again.status, 409);
});

test('signed-out visitors are sent to login and the API refuses them', async () => {
  const r = await fetch(base + '/', { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/login');
  const api = await client()('GET', '/api/db/items');
  assert.strictEqual(api.status, 401);
});

test('admin adds a store user who can sign in', async () => {
  const r = await admin('POST', '/api/admin/users', { name: 'KDT Store', email: 'kdt@example.com', password: 'store-pass-1' });
  assert.strictEqual(r.status, 200);
  const bad = await staff('POST', '/api/login', { email: 'kdt@example.com', password: 'wrong-pass' });
  assert.strictEqual(bad.status, 401);
  const ok = await staff('POST', '/api/login', { email: 'KDT@example.com', password: 'store-pass-1' });
  assert.strictEqual(ok.status, 200);
  const nonAdmin = await staff('GET', '/api/admin/users');
  assert.strictEqual(nonAdmin.status, 403);
});

test('state-changing calls need the request header (CSRF guard)', async () => {
  const r = await staff('POST', '/api/db/pr_headers', { prNumber: 'X' }, { 'X-Tube-Request': undefined });
  assert.strictEqual(r.status, 403);
});

test('store users can submit PRs but cannot change prices or grant themselves access', async () => {
  const pr = await staff('POST', '/api/db/pr_headers', { prNumber: 'PR-1', store: 'KDT outlet' });
  assert.strictEqual(pr.status, 200);
  assert.ok(pr.json.id);

  const price = await staff('PATCH', '/api/db/items/I00043', { unitPrice: 0.01 });
  assert.strictEqual(price.status, 403);
  assert.strictEqual(app.store.get('items', 'I00043').unitPrice, 11.3);

  const me = (await staff('GET', '/api/me')).json;
  const selfGrant = await staff('PUT', '/api/db/settings/procurement_access', { members: { [me.id]: { name: 'KDT' } }, pending: {} });
  assert.strictEqual(selfGrant.status, 403);

  const request = await staff('PATCH', '/api/db/settings/procurement_access', { pending: { [me.id]: { name: 'KDT Store', requestedAt: 'now' } } });
  assert.strictEqual(request.status, 200);
  const doc = app.store.get('settings', 'procurement_access');
  assert.ok(doc.pending[me.id]);
  assert.strictEqual(Object.keys(doc.members).length, 1);

  const del = await staff('DELETE', '/api/db/pr_headers/' + pr.json.id);
  assert.strictEqual(del.status, 403);
});

test('update merges nested maps like the prototype database did', async () => {
  await admin('PUT', '/api/db/settings/approval_roles', { hodByStore: { 'KDT outlet': 'a@example.com' }, testingMode: true });
  await admin('PATCH', '/api/db/settings/approval_roles', { hodByStore: { 'CDP outlet': 'b@example.com' } });
  const d = app.store.get('settings', 'approval_roles');
  assert.deepStrictEqual(d.hodByStore, { 'KDT outlet': 'a@example.com', 'CDP outlet': 'b@example.com' });
  assert.strictEqual(d.testingMode, true);
  const missing = await admin('PATCH', '/api/db/contracts/nope', { stage: 'signed' });
  assert.strictEqual(missing.status, 404);
});

test('every write is in the audit log', async () => {
  const r = await admin('GET', '/api/admin/audit?limit=50');
  const actions = r.json.entries.map((e) => e.action + ':' + (e.collection || ''));
  assert.ok(actions.includes('add:pr_headers'));
  assert.ok(actions.includes('update:settings'));
});

test('disabling a user signs them out', async () => {
  const users = (await admin('GET', '/api/admin/users')).json.users;
  const kdt = users.find((u) => u.email === 'kdt@example.com');
  const r = await admin('PATCH', '/api/admin/users/' + kdt.id, { active: false });
  assert.strictEqual(r.status, 200);
  const after = await staff('GET', '/api/me');
  assert.strictEqual(after.status, 401);
});

test('backup downloads a SQLite file', async () => {
  const res = await fetch(base + '/api/admin/backup', { headers: { Cookie: '' } });
  assert.strictEqual(res.status, 401);
  const r = await admin('GET', '/api/admin/backup');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /tube-procurement-backup-.*\.sqlite/);
});
