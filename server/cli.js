#!/usr/bin/env node
// Administration from the server's command line.
//   node server/cli.js create-admin <email> "<name>"      (prompts for a password)
//   node server/cli.js reset-password <email>              (prompts for a password)
//   node server/cli.js list-users
//   node server/cli.js backup [file]                       (consistent copy of the database)
'use strict';

const path = require('node:path');
const readline = require('node:readline');
const { createApp } = require('./server');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function password() {
  if (process.env.TUBE_PASSWORD) return process.env.TUBE_PASSWORD;
  const a = await ask('Password (min 8 characters): ');
  const b = await ask('Repeat password: ');
  if (a !== b) throw new Error('Passwords do not match.');
  return a;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const app = createApp({ seed: false });
  try {
    if (cmd === 'create-admin') {
      const [email, name] = args;
      if (!email || !name) throw new Error('Usage: create-admin <email> "<name>"');
      const u = app.auth.createUser({ email, name, password: await password(), isAdmin: true });
      app.grantWorkspace(u, null);
      console.log('Created administrator ' + u.email + ' with Procurement Workspace and Export access.');
    } else if (cmd === 'reset-password') {
      const [email] = args;
      const u = app.auth.listUsers().find((x) => x.email === String(email || '').toLowerCase());
      if (!u) throw new Error('No user with that email.');
      app.auth.setPassword(u.id, await password());
      app.store.audit(null, 'password-reset-cli', 'users', u.id);
      console.log('Password updated for ' + u.email + '. Their existing sessions were signed out.');
    } else if (cmd === 'list-users') {
      for (const u of app.auth.listUsers()) {
        console.log([u.email, u.name, u.is_admin ? 'admin' : '', u.active ? '' : 'DISABLED'].filter(Boolean).join('  ·  '));
      }
    } else if (cmd === 'backup') {
      const out = path.resolve(args[0] || ('tube-backup-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.sqlite'));
      app.db.exec("VACUUM INTO '" + out.replace(/'/g, "''") + "'");
      console.log('Backup written to ' + out);
    } else {
      console.log('Commands: create-admin <email> "<name>" | reset-password <email> | list-users | backup [file]');
      process.exitCode = cmd ? 1 : 0;
    }
  } finally {
    app.db.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
