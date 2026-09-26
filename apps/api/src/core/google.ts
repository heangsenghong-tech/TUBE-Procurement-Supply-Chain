// Sign in with Google (OpenID Connect, authorization code + PKCE).
// Only verified accounts in the company's Google Workspace domain(s) — or individually listed
// exceptions (GOOGLE_ALLOWED_EMAILS) — are accepted, and only if an administrator has already
// added that person — Google proves who they are, the app
// decides what they can do.
import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Config } from '../config';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface OAuthState { state: string; nonce: string; verifier: string }

export function newOAuthState(): OAuthState {
  const r = () => crypto.randomBytes(32).toString('base64url');
  return { state: r(), nonce: r(), verifier: r() };
}

export function redirectUri(config: Config) {
  return new URL('/auth/google/callback', config.PUBLIC_URL).toString();
}

export function authorizationUrl(config: Config, s: OAuthState) {
  const challenge = crypto.createHash('sha256').update(s.verifier).digest('base64url');
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(config),
    response_type: 'code',
    scope: 'openid email profile',
    state: s.state,
    nonce: s.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    // `hd` narrows Google's account chooser to the Workspace, which would hide listed exceptions.
    ...(config.allowedDomains.length === 1 && !config.allowedEmails.length ? { hd: config.allowedDomains[0]! } : {})
  }).toString();
  return u.toString();
}

export interface GoogleIdentity { sub: string; email: string; name: string }

export class GoogleSignInError extends Error {}

export async function completeSignIn(config: Config, code: string, s: OAuthState): Promise<GoogleIdentity> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: config.GOOGLE_CLIENT_ID!, client_secret: config.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(config), grant_type: 'authorization_code', code_verifier: s.verifier
    })
  });
  if (!res.ok) throw new GoogleSignInError('Google did not accept the sign-in code.');
  const body = await res.json() as { id_token?: string };
  if (!body.id_token) throw new GoogleSignInError('Google returned no identity token.');

  const { payload } = await jwtVerify(body.id_token, jwks, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: config.GOOGLE_CLIENT_ID!
  });
  return checkClaims(config, payload as Record<string, unknown>, s.nonce);
}

// Separated so the domain/verification rules are unit-testable without Google.
export function checkClaims(config: Config, p: Record<string, unknown>, nonce: string): GoogleIdentity {
  if (p.nonce !== nonce) throw new GoogleSignInError('Sign-in session mismatch. Please try again.');
  const email = String(p.email ?? '').toLowerCase();
  if (!email || p.email_verified !== true) throw new GoogleSignInError('Your Google email address is not verified.');
  const domain = email.split('@')[1] ?? '';
  const hd = String(p.hd ?? '').toLowerCase();
  const listed = config.allowedEmails.includes(email);
  if (!listed && (!config.allowedDomains.includes(domain) || !config.allowedDomains.includes(hd))) {
    throw new GoogleSignInError('Please sign in with your Tube Cafe Google Workspace account.');
  }
  return { sub: String(p.sub), email, name: String(p.name ?? email) };
}
