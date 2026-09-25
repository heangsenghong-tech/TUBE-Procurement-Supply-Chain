// Accounts, password hashing (scrypt) and cookie sessions.
'use strict';

const crypto = require('node:crypto');
const { now } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'tube_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function newUserId() { return 'u_' + crypto.randomBytes(12).toString('base64url'); }

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  return null;
}

function createAuth(db) {
  const q = {
    byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    all: db.prepare('SELECT id, email, name, is_admin, active, created_at FROM users ORDER BY name COLLATE NOCASE'),
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    insert: db.prepare('INSERT INTO users (id, email, name, password_hash, is_admin, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'),
    setPw: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    setFields: db.prepare('UPDATE users SET name = ?, is_admin = ?, active = ? WHERE id = ?'),
    newSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    session: db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`),
    dropSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    dropUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
  };

  return {
    COOKIE,
    userCount() { return q.count.get().n; },
    listUsers() { return q.all.all(); },
    getUser(id) { return q.byId.get(id) || null; },
    createUser({ email, name, password, isAdmin }) {
      email = String(email || '').trim().toLowerCase();
      name = String(name || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
      if (!name) throw new Error('Name is required.');
      const pwErr = validatePassword(password);
      if (pwErr) throw new Error(pwErr);
      if (q.byEmail.get(email)) throw new Error('A user with that email already exists.');
      const id = newUserId();
      q.insert.run(id, email, name.slice(0, 80), hashPassword(password), isAdmin ? 1 : 0, now());
      return q.byId.get(id);
    },
    updateUser(id, { name, isAdmin, active }) {
      const u = q.byId.get(id);
      if (!u) throw new Error('User not found.');
      q.setFields.run(
        name != null ? String(name).trim().slice(0, 80) || u.name : u.name,
        isAdmin != null ? (isAdmin ? 1 : 0) : u.is_admin,
        active != null ? (active ? 1 : 0) : u.active,
        id
      );
      if (active === false) q.dropUserSessions.run(id);
      return q.byId.get(id);
    },
    setPassword(id, password) {
      const pwErr = validatePassword(password);
      if (pwErr) throw new Error(pwErr);
      q.setPw.run(hashPassword(password), id);
      q.dropUserSessions.run(id);
    },
    login(email, password) {
      const u = q.byEmail.get(String(email || '').trim().toLowerCase());
      // Always run a hash so response time doesn't reveal whether the email exists.
      const ok = u ? verifyPassword(String(password || ''), u.password_hash) : (hashPassword('x'), false);
      if (!ok || !u.active) return null;
      const token = crypto.randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
      q.purge.run(now());
      q.newSession.run(sha256(token), u.id, expires);
      return { user: u, token, maxAge: SESSION_DAYS * 86400 };
    },
    userForToken(token) {
      if (!token) return null;
      return q.session.get(sha256(token), now()) || null;
    },
    logout(token) { if (token) q.dropSession.run(sha256(token)); }
  };
}

module.exports = { createAuth, hashPassword, verifyPassword, validatePassword };
