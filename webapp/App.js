import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { View, Text, StyleSheet, Pressable, TextInput, Alert } from 'react-native';
import Dashboard from './views/Dashboard';
import AdminPortal from './views/AdminPortal';
import Landing from './views/Landing';
import Header from './components/Header';
import LoginScreen from './components/LoginScreen';
import ForgotPasswordScreen from './components/ForgotPasswordScreen';
import ResetPasswordScreen from './components/ResetPasswordScreen';
import { Linking, Platform } from 'react-native';

// Removed push notification registration logic per request

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
  const [screen, setScreen] = useState(Platform.OS === 'web' ? 'landing' : 'login'); // 'landing' | 'dashboard' | 'settings' | 'about' | 'login' | 'forgot' | 'reset'
  const [token, setToken] = useState(null);
  const [initialResetToken, setInitialResetToken] = useState('');

  useEffect(() => {
    try {
      const t = localStorage.getItem('brewski_jwt');
      if (t) setToken(t);
    } catch (e) {
      // localStorage might not be available in some runtimes (native), ignore
    }
  }, []);

  // If the URL contains a token query parameter (used when redirecting into /admin),
  // consume it, persist it to localStorage, and remove it from the address bar.
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      const qp = new URLSearchParams(window.location.search || '');
      const t = qp.get('token');
      if (t) {
        try { localStorage.setItem('brewski_jwt', t); } catch (e) {}
        setToken(t);
        // remove token from URL for cleanliness
        qp.delete('token');
        const url = new URL(window.location.href);
        url.search = qp.toString();
        try { window.history.replaceState({}, document.title, url.toString()); } catch (e) {}
      }
    } catch (e) { }
  }, []);

  // Keep localStorage in sync with token state so other parts of the app (and manual fetches)
  // that read localStorage will include the current token.
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      if (token) localStorage.setItem('brewski_jwt', token);
      else localStorage.removeItem('brewski_jwt');
    } catch (e) { }
  }, [token]);

  // On web, detect reset token in the URL (either ?token= or in the hash) and open the reset screen
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const search = window.location.search || '';
      const hash = window.location.hash || '';
      const qp = new URLSearchParams(search);
      let t = qp.get('token');
      if (!t && hash) {
        // match ?token= or &token= inside the hash portion (e.g. #/reset?token=...)
        const m = hash.match(/[?&]token=([^&]+)/);
        if (m) t = decodeURIComponent(m[1]);
        else {
          // also allow simple #token=... forms
          const m2 = hash.match(/token=([^&]+)/);
          if (m2) t = decodeURIComponent(m2[1]);
        }
      }
      if (t) {
        setInitialResetToken(t);
        setScreen('reset');
        // Remove token from URL for cleanliness/security
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete('token');
          if (url.hash) {
            url.hash = url.hash.replace(/([?&])token=[^&]+(&?)/, (m, p1, p2) => (p2 ? p1 : '')).replace(/[?&]$/, '');
          }
          window.history.replaceState({}, document.title, url.toString());
        } catch (e) {
          // ignore replace failures
        }
      }
    } catch (e) {
      // ignore URL parsing errors
    }
  }, []);

  // If a token is present, switch to the dashboard automatically unless the current
  // browser path explicitly requests /admin. This prevents logging in from /admin and
  // being immediately redirected away.
  useEffect(() => {
    try {
      const pathname = (typeof window !== 'undefined' && window.location) ? String(window.location.pathname) : '';
      const isAdminPath = pathname.startsWith('/admin');
      const isManagePath = pathname.startsWith('/manage');
      if (token) {
        // If the browser path is /admin or /manage, keep the admin screen; otherwise, move to dashboard
        if (isAdminPath || isManagePath) {
          setScreen('admin');
        } else if (screen !== 'admin') {
          setScreen('dashboard');
        }
      }
    } catch (e) {
      if (token && screen !== 'admin') setScreen('dashboard');
    }
  }, [token, screen]);

  // On web, if the path is /admin open the admin screen by default
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.location && String(window.location.pathname).startsWith('/admin')) {
        setScreen('admin');
        try { window.history.replaceState({}, document.title, '/admin'); } catch (e) { }
      }
    } catch (e) { }
  }, []);

  // On web, if the path is /manage, open the manager portal if token maps to admin or manager
  useEffect(() => {
    try {
      if (typeof window === 'undefined' || !window.location) return;
      if (!String(window.location.pathname).startsWith('/manage')) return;
      // If no token, keep user on login; once token is set the other effect will switch screen
      if (!token) return;
      try {
        // Check current user's role by calling /admin/api/me — prefer SPA-local stored user if present
        const meRaw = localStorage.getItem('brewski_me');
        if (meRaw) {
          const me = JSON.parse(meRaw);
          if (me && (Number(me.is_admin) === 1 || me.role === 'manager')) {
            setScreen('admin');
            try { window.history.replaceState({}, document.title, '/manage'); } catch (e) {}
            return;
          }
        }
        // Fallback: fetch /admin/api/me to discover role
        fetch('/admin/api/me', { headers: { 'Authorization': token ? ('Bearer ' + token) : '' } }).then(r => {
          if (!r.ok) return null;
          return r.json();
        }).then(json => {
          if (json && json.user && (Number(json.user.is_admin) === 1 || json.user.role === 'manager')) {
            try { localStorage.setItem('brewski_me', JSON.stringify(json.user)); } catch (e) {}
            setScreen('admin');
            try { window.history.replaceState({}, document.title, '/manage'); } catch (e) {}
          } else {
            // Not allowed — redirect to landing or login
            setScreen('login');
          }
        }).catch(() => setScreen('login'));
      } catch (e) { }
    } catch (e) { }
  }, [token]);

  // Redirect unauthenticated users away from protected screens into login.
  useEffect(() => {
    // allow unauthenticated users to visit login, landing, forgot, and reset screens
    if (!token && screen && !['login', 'landing', 'forgot', 'reset'].includes(screen)) {
      const t = setTimeout(() => setScreen('login'), 10);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [screen, token]);

  const openScreen = (name) => {
    setScreen(name);
    setMenuOpen(false);
  };

  function openDashboard() {
    // On web, navigate same-tab to the server dashboard path
    try {
      if (typeof window !== 'undefined' && window.location) {
        window.location.href = '/dashboard/';
        return;
      }
    } catch (e) {
      // fall through to native linking
    }

    // Fallback: use React Native Linking for native runtimes
    try {
      const url = 'https://' + (typeof window !== 'undefined' ? window.location.host : '');
      Linking.openURL(url + '/dashboard/');
    } catch (e) {
      // best-effort; nothing else to do
    }
  }

  function handleLogout() {
    try { localStorage.removeItem('brewski_jwt'); } catch (e) { }
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
      <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
        {/* Push notification warning banner removed */}
        <Header
          title={titleMap[screen] || 'Brew Remote'}
          token={token}
          hideControls={['login', 'forgot', 'reset', 'landing'].includes(screen)}
          onMenuPress={() => setMenuOpen(m => !m)}
          onDashboardPress={() => {
            setMenuOpen(false);
            openDashboard();
          }}
          onLoginPress={() => { setMenuOpen(false); setScreen('login'); }}
          onLogoutPress={() => { handleLogout(); setMenuOpen(false); }}
        />
        <View style={styles.body}>
          {/* Side menu */}
          {menuOpen && (
            <View style={styles.sideMenu}>
              <Text style={styles.menuHeader}>Menu</Text>
              <Pressable onPress={() => openScreen('dashboard')} style={{ paddingVertical: 8 }}>
                <Text style={styles.menuItem}>Dashboard</Text>
              </Pressable>
              <Pressable onPress={() => openScreen('settings')} style={{ paddingVertical: 8 }}>
                <Text style={styles.menuItem}>Settings</Text>
              </Pressable>
              {token ? (
                <Pressable onPress={() => { handleLogout(); setMenuOpen(false); }} style={{ paddingVertical: 8 }}>
                  <Text style={[styles.menuItem, { color: '#ffcccb' }]}>Logout</Text>
                </Pressable>
              ) : (
                <Pressable onPress={() => { setMenuOpen(false); setScreen('login'); }} style={{ paddingVertical: 8 }}>
                  <Text style={styles.menuItem}>Login</Text>
                </Pressable>
              )}
            </View>
          )}
          <View style={styles.content}>
            {screen === 'landing' && !token && (
              <Landing onLoginPress={() => setScreen('login')} onDashboardPress={() => {
                if (!token) {
                  setScreen('login');
                } else {
                  setMenuOpen(false);
                  openDashboard();
                }
              }} />
            )}
            {!token && screen !== 'login' && screen !== 'landing' && null}
            {screen === 'login' && !token && <LoginScreen onLogin={(t) => {
              // Avoid a full-page redirect when logging in from /admin to prevent reload loops.
              // Instead, set the token in SPA state/localStorage and update the history to the
              // /admin path so the server-side gating isn't required for the SPA to render.
              try {
                if (typeof window !== 'undefined' && window.location && String(window.location.pathname).startsWith('/admin')) {
                  // Set token locally and update the URL without reloading the page.
                  try { localStorage.setItem('brewski_jwt', t); } catch (e) {}
                  setToken(t);
                  try { window.history.replaceState({}, document.title, '/admin'); } catch (e) {}
                  setScreen('admin');
                  return;
                }
              } catch (e) { /* fall back to default behavior below */ }

              // Default: set token and navigate within SPA
              setToken(t);
              try { if (typeof window !== 'undefined' && window.location && String(window.location.pathname).startsWith('/admin')) setScreen('admin'); else setScreen('dashboard'); } catch (e) { setScreen('dashboard'); }
            }} onForgot={() => setScreen('forgot')} />}
            {screen === 'forgot' && !token && <ForgotPasswordScreen onBack={() => setScreen('login')} />}
            {screen === 'reset' && !token && <ResetPasswordScreen initialToken={initialResetToken} onBack={() => setScreen('login')} />}
            {screen === 'dashboard' && token && <Dashboard token={token} />}
            {screen === 'admin' && token && <AdminPortal />}
            {screen === 'settings' && token && <SettingsScreen onBack={() => setScreen('dashboard')} />}
            {screen === 'about' && token && <AboutScreen onBack={() => setScreen('dashboard')} />}
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
