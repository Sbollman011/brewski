import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Pressable, Modal, ScrollView } from 'react-native';
import { apiFetch } from '../src/api';
import ToastBanner from './ToastBanner';
// AsyncStorage will be dynamically imported on native so web bundle isn't affected

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
      let json = null;
      try {
        json = await resp.json();
      } catch (e) {
        // If content-type was HTML, surface a friendlier message
        try {
          const txt = await resp.text();
          if (txt && /^<!doctype html>/i.test(txt.trim())) {
            throw new Error('Server returned HTML instead of JSON. Check API host routing.');
          } else if (txt) {
            throw new Error(txt.slice(0, 160));
          }
        } catch (inner) {
          throw inner;
        }
      }
      if (resp.ok && json && json.token) {
        // persist token: prefer AsyncStorage on RN, fallback to localStorage on web
        try {
          if (typeof navigator !== 'undefined' && navigator.product === 'ReactNative') {
            try {
              const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
              await AsyncStorage.setItem('brewski_jwt', json.token);
            } catch (e) { /* ignore */ }
          } else {
            try { localStorage.setItem('brewski_jwt', json.token); } catch (e) { /* ignore */ }
          }
        } catch (e) {}
        // After storing token, attempt to read persistent logs (native) and show them before proceeding
        let logs = null;
        try {
          if (typeof navigator !== 'undefined' && navigator.product === 'ReactNative') {
            const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
            const raw = await AsyncStorage.getItem('@brewski:runtimeLogs');
            logs = raw ? JSON.parse(raw) : null;
          }
        } catch (e) { logs = null; }
        if (logs && Array.isArray(logs) && logs.length) {
          // show modal with logs and wait for user to continue
          setPendingLogs(logs);
          setShowLogsModal(true);
          // store token in parent only after user continues (handled by onContinue)
          tempTokenRef.current = json.token;
        } else {
          onLogin(json.token);
        }
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

  // UI state for showing logs modal
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [pendingLogs, setPendingLogs] = useState(null);
  const tempTokenRef = React.useRef(null);

  const onContinueAfterLogs = () => {
    try {
      setShowLogsModal(false);
      if (tempTokenRef.current) {
        onLogin(tempTokenRef.current);
        tempTokenRef.current = null;
      }
    } catch (e) { setShowLogsModal(false); }
  };

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
      {showLogsModal && (
        <Modal visible={showLogsModal} transparent animationType="slide">
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 }}>
            <View style={{ backgroundColor: '#fff', borderRadius: 12, maxHeight: '80%', padding: 16 }}>
              <Text style={{ fontSize: 18, fontWeight: '700', marginBottom: 8 }}>Recent native logs</Text>
              <ScrollView style={{ marginBottom: 12 }}>
                {pendingLogs && pendingLogs.length ? (
                  pendingLogs.slice(-100).reverse().map((it, idx) => (
                    <View key={idx} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#eee' }}>
                      <Text style={{ fontSize: 12, color: '#333' }}>{new Date(it.t || it.t).toLocaleString()}</Text>
                      <Text style={{ fontSize: 12, color: '#111' }}>{typeof it.entry === 'string' ? it.entry : JSON.stringify(it.entry)}</Text>
                    </View>
                  ))
                ) : (
                  <Text>No logs available</Text>
                )}
              </ScrollView>
              <Pressable onPress={onContinueAfterLogs} style={{ backgroundColor: '#0b3d2e', paddingVertical: 12, borderRadius: 8, alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>Continue</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}
