// Environment configuration, validated at start-up so a misconfigured server refuses to run.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));

const schema = z.object({
  APP_ENV: z.enum(['production', 'training', 'development', 'test']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  // Public address people open, e.g. https://procurement.tubecafecambodia.com
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Comma-separated Google Workspace domains allowed to sign in.
  GOOGLE_ALLOWED_DOMAINS: z.string().default('tubecafecambodia.com'),
  // Comma-separated individual Google accounts outside those domains that may also sign in
  // (e.g. an authorised Finance proxy on Gmail). They still need to be added as users first.
  GOOGLE_ALLOWED_EMAILS: z.string().default(''),
  // Lets you pick a demo account without Google — refused in production.
  DEV_LOGIN: z.enum(['0', '1']).default('0'),
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  // Signs the short-lived Google sign-in cookie. Required (32+ chars) in production.
  COOKIE_SECRET: z.string().min(32).optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().optional(),
  SEED_DIR: z.string().default(path.resolve(here, '../../../data/seed')),
  WEB_DIST: z.string().default(path.resolve(here, '../../web/dist'))
});

export type Config = z.infer<typeof schema> & { cookieSecure: boolean; allowedDomains: string[]; allowedEmails: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty variables (e.g. "KEY=" in .env) as not set.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error('Invalid configuration:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  const c = parsed.data;
  if (c.APP_ENV === 'production') {
    if (c.DEV_LOGIN === '1') throw new Error('DEV_LOGIN must not be enabled in production.');
    if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required in production.');
    if (!c.PUBLIC_URL.startsWith('https://')) throw new Error('PUBLIC_URL must be https:// in production.');
    if (!c.COOKIE_SECRET) throw new Error('COOKIE_SECRET (32+ random characters) is required in production.');
  }
  return {
    ...c,
    COOKIE_SECRET: c.COOKIE_SECRET ?? crypto.randomBytes(32).toString('hex'),
    cookieSecure: c.PUBLIC_URL.startsWith('https://'),
    allowedDomains: c.GOOGLE_ALLOWED_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    allowedEmails: c.GOOGLE_ALLOWED_EMAILS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
  };
}
