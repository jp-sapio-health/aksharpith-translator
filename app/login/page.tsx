'use client';

import { useState } from 'react';
import { useAuth } from '../../lib/auth-context';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const { signInWithGoogle, signInWithEmail, signUpWithEmail } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isSignUp) {
        await signUpWithEmail(email, password);
      } else {
        await signInWithEmail(email, password);
      }
      router.push('/');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Authentication failed';
      // Clean up Firebase error messages
      setError(msg.replace(/Firebase:\s*/, '').replace(/\(auth\/.*\)\.?/, '').trim());
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleAuth = async () => {
    setError('');
    setLoading(true);
    try {
      await signInWithGoogle();
      router.push('/');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Google sign-in failed';
      setError(msg.replace(/Firebase:\s*/, '').replace(/\(auth\/.*\)\.?/, '').trim());
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #fdf6ec 0%, #f5efe0 50%, #e8e0d0 100%)',
      fontFamily: "'Karla', sans-serif",
    }}>
      <div style={{
        width: '100%',
        maxWidth: 420,
        padding: '2.5rem',
        background: 'rgba(255,255,255,0.85)',
        borderRadius: 16,
        boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
        border: '1px solid rgba(180,160,130,0.2)',
      }}>
        <h1 style={{
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: '2rem',
          fontWeight: 500,
          color: '#5a4a3a',
          textAlign: 'center',
          marginBottom: '0.25rem',
        }}>
          Aksharpith
        </h1>
        <p style={{
          textAlign: 'center',
          color: '#8a7a6a',
          fontSize: '0.9rem',
          marginBottom: '2rem',
        }}>
          Translation Pipeline
        </p>

        {error && (
          <div style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            padding: '0.75rem 1rem',
            borderRadius: 8,
            fontSize: '0.85rem',
            marginBottom: '1rem',
          }}>
            {error}
          </div>
        )}

        <button
          onClick={handleGoogleAuth}
          disabled={loading}
          style={{
            width: '100%',
            padding: '0.75rem',
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: 8,
            fontSize: '0.95rem',
            cursor: loading ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
            color: '#333',
            fontFamily: "'Karla', sans-serif",
            opacity: loading ? 0.6 : 1,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
          Sign in with Google
        </button>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          margin: '1.5rem 0',
          gap: '1rem',
        }}>
          <div style={{ flex: 1, height: 1, background: '#ddd' }} />
          <span style={{ color: '#aaa', fontSize: '0.8rem' }}>or</span>
          <div style={{ flex: 1, height: 1, background: '#ddd' }} />
        </div>

        <form onSubmit={handleEmailAuth}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid #ddd',
              borderRadius: 8,
              fontSize: '0.95rem',
              marginBottom: '0.75rem',
              fontFamily: "'Karla', sans-serif",
              boxSizing: 'border-box',
            }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '1px solid #ddd',
              borderRadius: 8,
              fontSize: '0.95rem',
              marginBottom: '1rem',
              fontFamily: "'Karla', sans-serif",
              boxSizing: 'border-box',
            }}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '0.75rem',
              background: '#6b8f71',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: '0.95rem',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontFamily: "'Karla', sans-serif",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? 'Please wait...' : isSignUp ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        <p style={{
          textAlign: 'center',
          marginTop: '1rem',
          fontSize: '0.85rem',
          color: '#888',
        }}>
          {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button
            onClick={() => { setIsSignUp(!isSignUp); setError(''); }}
            style={{
              background: 'none',
              border: 'none',
              color: '#6b8f71',
              cursor: 'pointer',
              textDecoration: 'underline',
              fontFamily: "'Karla', sans-serif",
              fontSize: '0.85rem',
            }}
          >
            {isSignUp ? 'Sign in' : 'Sign up'}
          </button>
        </p>
      </div>
    </div>
  );
}
