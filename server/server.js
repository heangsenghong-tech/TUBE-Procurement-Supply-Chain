// Tube Procurement & Supply Chain — self-hosted server.
// Serves the app page and replaces the Claude artifact runtime (db, user, downloads)
// with a local REST + Server-Sent Events API backed by SQLite.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDb, createStore, now } = require('./db');
const { createAuth, verifyPassword } = require('./auth');
const { COLLECTIONS, checkWrite, isProcMember, isExportAuthorized } = require('./rules');
const { seedIfEmpty } = require('./seed');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 5 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ')
};

function createApp(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data', 'runtime');
  const db = openDb(path.join(dataDir, 'tube.sqlite'));
  const store = createStore(db);
  const auth = createAuth(db);
  const trustProxy = opts.trustProxy != null ? opts.trustProxy : process.env.TRUST_PROXY === '1';
  const forceSecure = opts.cookieSecure != null ? opts.cookieSecure : process.env.COOKIE_SECURE === '1';

  if (opts.seed !== false) seedIfEmpty(store, path.join(ROOT, 'data', 'seed'));

  // ---- live updates (Server-Sent Events) ----
  const streams = new Set();
  function broadcast(evt) {
    const line = 'data: ' + JSON.stringify(evt) + '\n\n';
    for (const s of streams) s.res.write(line);
  }
  const heartbeat = setInterval(() => { for (const s of streams) s.res.write(': ping\n\n'); }, 25000);
  heartbeat.unref();

  // ---- login throttling ----
  const attempts = new Map();
  function throttled(key) {
    const t = Date.now();
    const a = (attempts.get(key) || []).filter((x) => t - x < 15 * 60e3);
    attempts.set(key, a);
    return a.length >= 10;
  }
  function recordFail(key) { (attempts.get(key) || attempts.set(key, []).get(key)).push(Date.now()); }

  // ---- helpers ----
  function send(res, status, body, headers = {}) {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(status, Object.assign({}, SECURITY_HEADERS,
      { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      headers));
    res.end(isStr ? body : JSON.stringify(body));
  }
  function fail(res, status, message) { send(res, status, { error: message, code: status === 403 ? 'permission-denied' : status === 404 ? 'not-found' : 'error' }); }

  function cookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
  }
  function isSecure(req) {
    return forceSecure || !!req.socket.encrypted ||
      (trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
  }
  function clientIp(req) {
    if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || '';
  }
  function sessionCookie(req, value, maxAge) {
    return auth.COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge +
      (isSecure(req) ? '; Secure' : '');
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  function publicUser(u) {
    return { id: u.id, name: u.name, email: u.email, isAdmin: u.is_admin === 1 };
  }

  function serveStatic(req, res, rel) {
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return fail(res, 404, 'Not found.');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return fail(res, 404, 'Not found.');
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, Object.assign({}, SECURITY_HEADERS, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
      }));
      fs.createReadStream(file).pipe(res);
    });
  }

  function redirect(res, to) { res.writeHead(302, Object.assign({ Location: to }, SECURITY_HEADERS)); res.end(); }

  // ---- request handling ----
  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const method = req.method;
    const token = cookies(req)[auth.COOKIE];
    const user = auth.userForToken(token);

    // Pages
    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      if (auth.userCount() === 0) return serveStatic(req, res, 'setup.html');
      return user ? serveStatic(req, res, 'index.html') : redirect(res, '/login');
    }
    if (method === 'GET' && p === '/login') {
      if (auth.userCount() === 0) return redirect(res, '/');
      return user ? redirect(res, '/') : serveStatic(req, res, 'login.html');
    }
    if (method === 'GET' && p === '/admin') {
      if (!user) return redirect(res, '/login');
      if (user.is_admin !== 1) return redirect(res, '/');
      return serveStatic(req, res, 'admin.html');
    }
    if (method === 'GET' && p === '/account') {
      return user ? serveStatic(req, res, 'account.html') : redirect(res, '/login');
    }
    if (method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

    if (!p.startsWith('/api/')) {
      if (method !== 'GET') return fail(res, 405, 'Method not allowed.');
      if (/\.html$/.test(p)) return fail(res, 404, 'Not found.');
      return serveStatic(req, res, p.slice(1));
    }

    // CSRF: every state-changing API call must carry this header, which a cross-site
    // form or image can't set (and we never answer CORS preflights).
    if (method !== 'GET' && req.headers['x-tube-request'] !== '1') return fail(res, 403, 'Missing request header.');

    // First-run setup: create the first administrator from the browser.
    if (method === 'POST' && p === '/api/setup') {
      if (auth.userCount() !== 0) return fail(res, 409, 'Setup is already complete.');
      const body = await readJson(req);
      let u;
      try { u = auth.createUser({ email: body.email, name: body.name, password: body.password, isAdmin: true }); }
      catch (e) { return fail(res, 400, e.message); }
      grantWorkspace(u, null);
      const s = auth.login(u.email, body.password);
      return send(res, 200, { user: publicUser(u) }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
    }

    if (method === 'POST' && p === '/api/login') {
      const body = await readJson(req);
      const key = clientIp(req) + '|' + String(body.email || '').toLowerCase();
      if (throttled(key)) return fail(res, 429, 'Too many attempts. Wait 15 minutes and try again.');
      const s = auth.login(body.email, body.password);
      if (!s) { recordFail(key); return fail(res, 401, 'Email or password is incorrect.'); }
      attempts.delete(key);
      store.audit(s.user.id, 'login');
      return send(res, 200, { user: publicUser(s.user) }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
    }

    if (method === 'POST' && p === '/api/logout') {
      auth.logout(token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    if (!user) return fail(res, 401, 'Sign in first.');

    if (method === 'GET' && p === '/api/me') {
      return send(res, 200, Object.assign(publicUser(user), {
        procurement: isProcMember(store, user), exportAuthorized: isExportAuthorized(store, user)
      }));
    }

    if (method === 'POST' && p === '/api/me/password') {
      const body = await readJson(req);
      const full = auth.getUser(user.id);
      if (!verifyPassword(String(body.currentPassword || ''), full.password_hash)) return fail(res, 400, 'Current password is incorrect.');
      try { auth.setPassword(user.id, body.newPassword); } catch (e) { return fail(res, 400, e.message); }
      store.audit(user.id, 'password-change');
      const s = auth.login(user.email, body.newPassword);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, s.token, s.maxAge) });
    }

    if (method === 'GET' && p === '/api/profiles') {
      const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 200);
      const out = {};
      ids.forEach((id) => { const u = auth.getUser(id); if (u) out[id] = { name: u.name }; });
      return send(res, 200, out);
    }

    if (method === 'GET' && p === '/api/events') {
      res.writeHead(200, Object.assign({}, SECURITY_HEADERS, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
      }));
      res.write('retry: 3000\n\n');
      const entry = { res, userId: user.id };
      streams.add(entry);
      req.on('close', () => streams.delete(entry));
      return;
    }

    // ---- document collections: /api/db/:collection[/:id] ----
    const m = p.match(/^\/api\/db\/([^/]+)(?:\/([^/]+))?$/);
    if (m) {
      const collection = decodeURIComponent(m[1]);
      const id = m[2] ? decodeURIComponent(m[2]) : null;
      if (!COLLECTIONS.has(collection)) return fail(res, 404, 'Unknown collection.');
      if (id !== null && !ID_RE.test(id)) return fail(res, 400, 'Invalid document id.');

      if (method === 'GET' && id === null) return send(res, 200, { docs: store.list(collection) });
      if (method === 'GET') {
        const d = store.get(collection, id);
        return send(res, 200, { exists: d !== null, data: d });
      }

      const body = method === 'DELETE' ? {} : await readJson(req);
      if (method !== 'DELETE' && (body === null || typeof body !== 'object' || Array.isArray(body))) return fail(res, 400, 'Document must be an object.');

      if (method === 'POST' && id === null) {
        const newId = crypto.randomBytes(10).toString('base64url');
        const deny = checkWrite(store, user, 'add', collection, newId, body);
        if (deny) return fail(res, 403, deny);
        store.add(collection, newId, body, user.id);
        broadcast({ op: 'set', collection, id: newId, data: body });
        return send(res, 200, { id: newId, data: body });
      }
      if (id === null) return fail(res, 405, 'Method not allowed.');

      if (method === 'PUT') {
        const deny = checkWrite(store, user, 'set', collection, id, body);
        if (deny) return fail(res, 403, deny);
        const data = store.set(collection, id, body, user.id);
        broadcast({ op: 'set', collection, id, data });
        return send(res, 200, { id, data });
      }
      if (method === 'PATCH') {
        const deny = checkWrite(store, user, 'update', collection, id, body);
        if (deny) return fail(res, 403, deny);
        const data = store.update(collection, id, body, user.id);
        if (data === null) return fail(res, 404, 'Document not found.');
        broadcast({ op: 'set', collection, id, data });
        return send(res, 200, { id, data });
      }
      if (method === 'DELETE') {
        const deny = checkWrite(store, user, 'delete', collection, id, null);
        if (deny) return fail(res, 403, deny);
        store.remove(collection, id, user.id);
        broadcast({ op: 'delete', collection, id });
        return send(res, 200, { id });
      }
      return fail(res, 405, 'Method not allowed.');
    }

    // ---- administration ----
    if (p.startsWith('/api/admin/')) {
      if (user.is_admin !== 1) return fail(res, 403, 'Administrator access is required.');

      if (method === 'GET' && p === '/api/admin/users') {
        const proc = (store.get('settings', 'procurement_access') || {}).members || {};
        const exp = (store.get('settings', 'export_authorization') || {}).members || {};
        return send(res, 200, { users: auth.listUsers().map((u) => ({
          id: u.id, email: u.email, name: u.name, isAdmin: u.is_admin === 1, active: u.active === 1,
          createdAt: u.created_at, procurement: !!proc[u.id], exportAuthorized: !!exp[u.id]
        })) });
      }
      if (method === 'POST' && p === '/api/admin/users') {
        const body = await readJson(req);
        let u;
        try { u = auth.createUser({ email: body.email, name: body.name, password: body.password, isAdmin: !!body.isAdmin }); }
        catch (e) { return fail(res, 400, e.message); }
        store.audit(user.id, 'user-create', 'users', u.id, undefined, { email: u.email, name: u.name, isAdmin: !!body.isAdmin });
        if (body.procurement) grantWorkspace(u, user.id, 'procurement_access');
        if (body.exportAuthorized) grantWorkspace(u, user.id, 'export_authorization');
        return send(res, 200, { user: publicUser(u) });
      }
      const um = p.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (method === 'PATCH' && um) {
        const id = decodeURIComponent(um[1]);
        const body = await readJson(req);
        if (id === user.id && (body.active === false || body.isAdmin === false)) return fail(res, 400, 'You can\'t remove your own administrator access.');
        try {
          const before = auth.getUser(id);
          const u = auth.updateUser(id, { name: body.name, isAdmin: body.isAdmin, active: body.active });
          if (body.password) auth.setPassword(id, body.password);
          store.audit(user.id, 'user-update', 'users', id,
            before && { name: before.name, isAdmin: before.is_admin === 1, active: before.active === 1 },
            { name: u.name, isAdmin: u.is_admin === 1, active: u.active === 1, passwordReset: !!body.password });
          if (body.active === false) for (const s of streams) if (s.userId === id) s.res.end();
          return send(res, 200, { user: publicUser(u) });
        } catch (e) { return fail(res, 400, e.message); }
      }
      if (method === 'GET' && p === '/api/admin/audit') {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 200, 1), 1000);
        const rows = db.prepare(`SELECT a.seq, a.at, a.action, a.collection, a.doc_id, a.before, a.after, u.name AS user_name
          FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.seq DESC LIMIT ?`).all(limit);
        return send(res, 200, { entries: rows });
      }
      if (method === 'GET' && p === '/api/admin/backup') {
        const tmp = path.join(dataDir, 'backup-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.sqlite');
        db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
        store.audit(user.id, 'backup-download');
        const stamp = now().slice(0, 19).replace(/[:T]/g, '-');
        res.writeHead(200, Object.assign({}, SECURITY_HEADERS, {
          'Content-Type': 'application/vnd.sqlite3',
          'Content-Disposition': 'attachment; filename="tube-procurement-backup-' + stamp + '.sqlite"',
          'Cache-Control': 'no-store'
        }));
        const rs = fs.createReadStream(tmp);
        rs.pipe(res);
        rs.on('close', () => fs.rm(tmp, { force: true }, () => {}));
        return;
      }
    }

    return fail(res, 404, 'Not found.');
  }

  // Adds a user to the workspace (and export) member lists the page reads.
  function grantWorkspace(u, byId, only) {
    const docs = only ? [only] : ['procurement_access', 'export_authorization'];
    for (const docId of docs) {
      const cur = store.get('settings', docId) || { members: {}, pending: {} };
      const members = Object.assign({}, cur.members || {});
      members[u.id] = { name: u.name, addedAt: now() };
      const pending = Object.assign({}, cur.pending || {});
      delete pending[u.id];
      const data = { members, pending };
      store.set('settings', docId, data, byId);
      broadcast({ op: 'set', collection: 'settings', id: docId, data });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Server error.');
      if (!e.status) console.error(e);
    });
  });
  server.on('close', () => { clearInterval(heartbeat); db.close(); });
  return { server, store, auth, db, grantWorkspace };
}

module.exports = { createApp };

if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 8080;
  const host = process.env.HOST || '0.0.0.0';
  const { server, auth } = createApp();
  server.listen(port, host, () => {
    console.log('Tube Procurement & Supply Chain running on http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + port);
    if (auth.userCount() === 0) console.log('No accounts yet — open the address above to create the first administrator.');
  });
}
