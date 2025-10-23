import React, { useState } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { apiFetch } from '../src/api';
import ToastBanner from './ToastBanner';

export default function LoginScreen({ onLogin, onForgot }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  async function submit() {
    if (!username || !password) {
      setToast({ type: 'error', text: 'Please provide both username and password.' });
      setTimeout(() => setToast(null), 3500);
      return;
    }
    setLoading(true);
    try {
      const resp = await apiFetch('/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      // Attempt to parse JSON body safely; fall back to text but sanitize messages
      let json = null; let bodyText = null;
      try {
        json = await resp.json().catch(() => null);
      } catch (e) { json = null; }
      if (!json) {
        try { bodyText = await resp.text().catch(() => null); } catch (e) { bodyText = null; }
      }

      // Helper: pick a friendly message for the user
      const friendlyForStatus = (status) => {
        if (!status) return 'Login failed';
        if (status === 401) return 'Invalid username or password.';
        if (status === 403) return 'Access denied. Check your account permissions.';
        if (status >= 500) return 'Server error. Please try again later.';
        if (status >= 400) return 'Login failed. Please check your credentials and try again.';
        return 'Login failed.';
      };

      if (resp.ok && json && json.token) {
        try { localStorage.setItem('brewski_jwt', json.token); } catch (e) { /* ignore */ }
        onLogin(json.token);
      } else {
        // Prefer a server-provided error message when it's short and safe
        let userMessage = null;
        try {
          if (json && json.error && typeof json.error === 'string' && json.error.length <= 150) userMessage = json.error;
          else if (json && json.message && typeof json.message === 'string' && json.message.length <= 150) userMessage = json.message;
        } catch (e) { userMessage = null; }

        if (!userMessage && bodyText) {
          // Sanitize bodyText: if it looks like HTML don't show it; otherwise show a trimmed version
          try {
            const t = bodyText.trim();
            if (/^<!doctype html>/i.test(t) || /<html[\s>]/i.test(t)) {
              userMessage = null; // don't show HTML to users
            } else {
              userMessage = t.length > 200 ? (t.slice(0, 200) + '...') : t;
            }
          } catch (e) { userMessage = null; }
        }

        // Fallback to friendly mapping by status code if nothing safe in body
        if (!userMessage) userMessage = friendlyForStatus(resp && resp.status ? resp.status : null);

        setToast({ type: 'error', text: userMessage });
        setTimeout(() => setToast(null), 4500);

        // Developer-only console logging for debugging (do not expose to users)
        try {
          if (window && window.brewskiDebug) {
            console.warn('Login failed', { status: resp && resp.status, json, bodyText });
          }
        } catch (e) {}
      }
    } catch (err) {
      // Avoid showing raw error messages to users; map common error shapes to friendly messages
      const msg = (err && err.message) ? err.message : String(err || 'Login failed');
      const safe = msg && msg.length < 200 ? msg : 'Login failed. Please try again.';
      setToast({ type: 'error', text: safe });
      setTimeout(() => setToast(null), 4500);
      try { if (window && window.brewskiDebug) console.error('Login submit exception', err); } catch (e) {}
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={{ padding: 20, alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 12, padding: 20, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, elevation: 3 }}>
        <ToastBanner toast={toast} />
        <Text style={{ fontSize: 24, fontWeight: '700', marginBottom: 6, color: '#0b3d2e' }}>Login</Text>
  <Text style={{ color: '#666', marginBottom: 16 }}>Access the Brew Remote dashboard</Text>

        <TextInput
          value={username}
          onChangeText={setUsername}
          placeholder="Username or email"
          autoCapitalize="none"
          style={{ borderWidth: 1, borderColor: '#e0e6e0', padding: 12, marginBottom: 10, borderRadius: 8, backgroundColor: '#fbfdfb' }}
        />
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          style={{ borderWidth: 1, borderColor: '#e0e6e0', padding: 12, marginBottom: 12, borderRadius: 8, backgroundColor: '#fbfdfb' }}
        />

        <Pressable onPress={submit} style={{ backgroundColor: '#0b3d2e', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginBottom: 10 }}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>{loading ? 'Logging in...' : 'Login'}</Text>
        </Pressable>

        <Pressable onPress={onForgot} style={{ alignItems: 'center', paddingVertical: 8 }}>
          <Text style={{ color: '#0b7aef' }}>Forgot password?</Text>
        </Pressable>
      </View>
    </View>
  );
}
