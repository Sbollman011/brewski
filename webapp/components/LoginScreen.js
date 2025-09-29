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
      const resp = await apiFetch('/admin/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const json = await resp.json();
      if (resp.ok && json && json.token) {
        try { localStorage.setItem('brewski_jwt', json.token); } catch (e) { /* ignore */ }
        onLogin(json.token);
      } else if (resp.status === 401) {
        setToast({ type: 'error', text: 'Invalid username or password.' });
        setTimeout(() => setToast(null), 3500);
      } else {
        setToast({ type: 'error', text: json && json.error ? json.error : 'Login failed' });
        setTimeout(() => setToast(null), 3500);
      }
    } catch (err) {
      setToast({ type: 'error', text: err.message || String(err) });
      setTimeout(() => setToast(null), 3500);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={{ padding: 20, alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 12, padding: 20, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, elevation: 3 }}>
        <ToastBanner toast={toast} />
        <Text style={{ fontSize: 24, fontWeight: '700', marginBottom: 6, color: '#0b3d2e' }}>Login</Text>
        <Text style={{ color: '#666', marginBottom: 16 }}>Access the Brew Remote portal</Text>

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
