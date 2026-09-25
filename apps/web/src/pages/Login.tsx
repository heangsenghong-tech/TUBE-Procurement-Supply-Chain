import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { ErrorText } from '../lib/ui';

const ERRORS: Record<string, string> = {
  not_registered: 'Your Google account isn\'t set up in this system yet. Ask the Procurement & Supply Chain administrator to add you.',
  disabled: 'Your access has been turned off. Contact the administrator if this is a mistake.',
  wrong_domain: 'Please sign in with your Tube Cafe Google Workspace account (not a personal Gmail).',
  account_mismatch: 'This email is linked to a different Google account. Contact the administrator.',
  expired: 'The sign-in took too long or was interrupted. Please try again.',
  google_cancelled: 'Sign-in was cancelled.',
  google_failed: 'Google sign-in didn\'t complete. Please try again.',
  google_not_configured: 'Google sign-in isn\'t configured on this server yet.'
};

export function LoginPage() {
  const [params] = useSearchParams();
  const options = useQuery({ queryKey: ['auth-options'], queryFn: () => api.get<{ google: boolean; devLogin: boolean; devLoginNeedsGoogle?: boolean; environment: string }>('/auth/options') });
  const devUsers = useQuery({
    queryKey: ['dev-users'], enabled: !!options.data?.devLogin,
    queryFn: () => api.get<{ id: string; name: string; email: string; unit: string | null }[]>('/auth/dev-users')
  });
  const [err, setErr] = useState<unknown>(null);
  const error = params.get('error');

  const devLogin = async (userId: string) => {
    try { await api.post('/auth/dev-login', { userId }); location.href = '/'; } catch (e) { setErr(e); }
  };

  return (
    <div className="wrap" style={{ maxWidth: 460 }}>
      <div className="hero flex items-center gap-3">
        <img src="/tube-logo.png" alt="Tube Coffee" style={{ width: 52, height: 52 }} />
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Tube Procurement &amp; Supply Chain</h1>
          <div className="sub">Tube Cafe Co., Ltd.</div>
        </div>
      </div>
      {options.data?.environment === 'training' && <div className="banner banner-training"><strong>TRAINING environment</strong> — practice data only.</div>}
      <div className="card">
        <h2>Sign in</h2>
        <div className="section-note">Use your Tube Cafe Google Workspace account.</div>
        {error && <div className="banner" style={{ marginBottom: 14 }}>{ERRORS[error] ?? 'Sign-in failed. Please try again.'}</div>}
        {options.data?.google !== false && (
          <a className="btn-primary flex items-center justify-center gap-2" href="/auth/google" style={{ textDecoration: 'none', width: '100%' }}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
            Sign in with Google
          </a>
        )}
        {options.data?.devLoginNeedsGoogle && (
          <div className="sub" style={{ marginTop: 12 }}>Training: sign in with your company Google account first — you'll then pick which demo person to be.</div>
        )}
        {options.data?.devLogin && (
          <div style={{ marginTop: 18 }}>
            <h3>Demo accounts</h3>
            <div className="section-note">Pick who you want to be. This picker exists only outside production.</div>
            {devUsers.data?.map((u) => (
              <button key={u.id} type="button" className="list-row w-full" style={{ background: 'none', border: 'none', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }} onClick={() => devLogin(u.id)}>
                <span><span style={{ fontWeight: 600 }}>{u.name}</span><br /><span className="sub">{u.email}</span></span>
                <span className="sub">{u.unit ?? ''}</span>
              </button>
            ))}
          </div>
        )}
        <div style={{ marginTop: 10 }}><ErrorText error={err} /></div>
      </div>
      <div className="sub" style={{ textAlign: 'center' }}>Need access? Ask the Supply Chain &amp; Procurement administrator to add your email.</div>
    </div>
  );
}
