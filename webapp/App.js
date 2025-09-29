import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { View, Text, StyleSheet, Pressable, TextInput, Alert } from 'react-native';
import Dashboard from './views/Dashboard';
import Landing from './views/Landing';
import Header from './components/Header';
import { Linking, Platform } from 'react-native';
import { apiFetch } from './src/api';
// Removed push notification registration logic per request

// Importing necessary components
function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!username || !password) {
      Alert.alert('Missing fields', 'Please enter username and password');
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
        Alert.alert('Login failed', 'Invalid username or password');
      } else {
        Alert.alert('Login failed', json && json.error ? json.error : 'Invalid credentials');
      }
    } catch (err) {
      Alert.alert('Network error', err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={{ padding: 20 }}>
      <Text style={{ fontSize: 22, fontWeight: '700', marginBottom: 12, color: '#1b5e20' }}>Admin login</Text>
      <TextInput
        value={username}
        onChangeText={setUsername}
        placeholder="Username"
        autoCapitalize="none"
        style={{ borderWidth: 1, borderColor: '#ddd', padding: 12, marginBottom: 10, borderRadius: 8 }}
      />
      <TextInput
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        secureTextEntry
        style={{ borderWidth: 1, borderColor: '#ddd', padding: 12, marginBottom: 16, borderRadius: 8 }}
      />
      <Pressable onPress={submit} style={{ backgroundColor: '#1b5e20', paddingVertical: 14, borderRadius: 8, alignItems: 'center' }}>
        <Text style={{ color: '#fff', fontWeight: '600' }}>{loading ? 'Logging in...' : 'Login'}</Text>
      </Pressable>
    </View>
  );
}

function SettingsScreen({ onBack }) {
  return (
    <View style={{ padding: 12 }}>
      <Text style={{ fontSize: 18, fontWeight: '600' }}>Settings</Text>
      <Text style={{ marginTop: 8, color: '#444' }}>No settings yet — coming soon.</Text>
      <Pressable onPress={onBack} style={{ marginTop: 12 }}>
        <Text style={{ color: '#2196f3' }}>Back</Text>
      </Pressable>
    </View>
  );
}

function AboutScreen({ onBack }) {
  return (
    <View style={{ padding: 12 }}>
      <Text style={{ fontSize: 18, fontWeight: '600' }}>About</Text>
      <Text style={{ marginTop: 8, color: '#444' }}>Brew Remote — lightweight MQTT dashboard.</Text>
      <Pressable onPress={onBack} style={{ marginTop: 12 }}>
        <Text style={{ color: '#2196f3' }}>Back</Text>
      </Pressable>
    </View>
  );
}

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  // Default to landing on web, but show login first on native (mobile) devices
  const [screen, setScreen] = useState(Platform.OS === 'web' ? 'landing' : 'login'); // 'landing' | 'dashboard' | 'settings' | 'about' | 'login'
  const [token, setToken] = useState(null);

  useEffect(() => {
    try {
      const t = localStorage.getItem('brewski_jwt');
      if (t) setToken(t);
    } catch (e) {
      // localStorage might not be available in some runtimes (native), ignore
    }
  }, []);

  // If a token is present, switch to the dashboard automatically
  useEffect(() => {
    if (token) setScreen('dashboard');
  }, [token]);

  const openScreen = (name) => {
    setScreen(name);
    setMenuOpen(false);
  };

  function openPortal() {
    // On web, navigate same-tab to the server portal path
    try {
      if (typeof window !== 'undefined' && window.location) {
        window.location.href = '/portal/';
        return;
      }
    } catch (e) {
      // fall through to native linking
    }

    // Fallback: use React Native Linking for native runtimes
    try {
      const url = 'https://'+(typeof window !== 'undefined' ? window.location.host : '');
      Linking.openURL(url + '/portal/');
    } catch (e) {
      // best-effort; nothing else to do
    }
  }

  function handleLogout() {
    try { localStorage.removeItem('brewski_jwt'); } catch (e) {}
    setToken(null);
    setScreen('dashboard');
  }

  const titleMap = {
    landing: 'Brew Remote',
    dashboard: 'Brew Remote',
    settings: 'Settings',
    about: 'About',
  };

  // Push notification registration removed

  return (
    <SafeAreaProvider>
  <StatusBar style="light" backgroundColor="#1b5e20" />
  <SafeAreaView edges={["top"]} style={[styles.topInset, { backgroundColor: '#1b5e20' }]} />
      <SafeAreaView style={styles.root} edges={["left","right","bottom"]}>
        {/* Push notification warning banner removed */}
        <Header
          title={titleMap[screen] || 'Brew Remote'}
          token={token}
          onMenuPress={() => setMenuOpen(m => !m)}
          onPortalPress={() => {
            setMenuOpen(false);
            openPortal();
          }}
          onLoginPress={() => { setMenuOpen(false); setScreen('login'); }}
          onLogoutPress={() => { handleLogout(); setMenuOpen(false); }}
        />
        <View style={styles.body}>
          {/* Side menu */}
          {menuOpen && (
            <View style={styles.sideMenu}>
              <Text style={styles.menuHeader}>Menu</Text>
              <Pressable onPress={() => openScreen('dashboard')} style={{paddingVertical:8}}>
                <Text style={styles.menuItem}>Dashboard</Text>
              </Pressable>
              <Pressable onPress={() => openScreen('settings')} style={{paddingVertical:8}}>
                <Text style={styles.menuItem}>Settings</Text>
              </Pressable>
              {token ? (
                <Pressable onPress={() => { handleLogout(); setMenuOpen(false); }} style={{paddingVertical:8}}>
                  <Text style={[styles.menuItem, { color: '#ffcccb' }]}>Logout</Text>
                </Pressable>
              ) : (
                <Pressable onPress={() => { setMenuOpen(false); setScreen('login'); }} style={{paddingVertical:8}}>
                  <Text style={styles.menuItem}>Login</Text>
                </Pressable>
              )}
            </View>
          )}
          <View style={styles.content}>
            {screen === 'landing' && !token && (
              <Landing onLoginPress={() => setScreen('login')} onPortalPress={() => {
                if (!token) {
                  setScreen('login');
                } else {
                  setMenuOpen(false);
                  openPortal();
                }
              }} />
            )}
            {!token && screen !== 'login' && screen !== 'landing' && (
              // Redirect unauthenticated users trying to access non-public screens
              // to the login screen so they can't see protected UI.
              setTimeout(() => setScreen('login'), 10) || null
            )}
            {screen === 'login' && !token && <LoginScreen onLogin={(t) => { setToken(t); setScreen('dashboard'); }} />}
            {screen === 'dashboard' && <Dashboard />}
            {screen === 'settings' && <SettingsScreen onBack={() => setScreen('dashboard')} />}
            {screen === 'about' && <AboutScreen onBack={() => setScreen('dashboard')} />}
          </View>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  topInset: { backgroundColor: '#1b5e20' },
  appBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#1b5e20' },
  appTitle: { color: '#fff', fontSize: 18, fontWeight: '600', marginLeft: 8 },
  hamburger: { padding: 4 },
  bar: { width: 22, height: 3, backgroundColor: '#fff', marginVertical: 2, borderRadius: 2 },
  body: { flex: 1, flexDirection: 'row' },
  sideMenu: { width: 200, backgroundColor: '#1b5e20', paddingTop: 16, paddingHorizontal: 12 },
  menuHeader: { color: '#fff', fontWeight: '700', marginBottom: 12, fontSize: 16 },
  menuItem: { color: '#f1f8f1', paddingVertical: 6, fontSize: 14 },
  content: { flex: 1 },
});
