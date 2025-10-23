import React, { useState, useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { View, Text, StyleSheet, Pressable, TextInput, Alert } from 'react-native';
import Dashboard from './views/Dashboard';
import AdminPortal from './views/AdminPortal';
import Landing from './views/Landing';
import Header from './components/Header';
import SideMenu from './components/SideMenu';
import LoginScreen from './components/LoginScreen';
import ForgotPasswordScreen from './components/ForgotPasswordScreen';
import ResetPasswordScreen from './components/ResetPasswordScreen';
import { Linking, Platform } from 'react-native';
// Try to load native AsyncStorage if available (guarded so web builds don't break)
let NativeAsyncStorage = null;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  NativeAsyncStorage = require('@react-native-async-storage/async-storage').default;
} catch (e) {
  NativeAsyncStorage = null;
}
// Platform-safe synchronous local storage shim. Many code paths expect a
// synchronous localStorage API (getItem/setItem/removeItem). In React Native
// those globals don't exist and referencing `localStorage` directly throws a
// ReferenceError. Provide `safeLocal` which prefers window.localStorage when
// available and otherwise falls back to a fast in-memory Map (non-persistent).
const _inMemoryLocal = new Map();
const safeLocal = {
  getItem: (k) => {
    try {
      if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.getItem === 'function') return window.localStorage.getItem(k);
    } catch (e) {}
    try { return _inMemoryLocal.has(k) ? _inMemoryLocal.get(k) : null; } catch (e) { return null; }
  },
  setItem: (k, v) => {
    try {
      if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.setItem === 'function') return window.localStorage.setItem(k, v);
    } catch (e) {}
    try { _inMemoryLocal.set(k, String(v)); } catch (e) {}
  },
  removeItem: (k) => {
    try {
      if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.removeItem === 'function') return window.localStorage.removeItem(k);
    } catch (e) {}
    try { _inMemoryLocal.delete(k); } catch (e) {}
  }
};
// Defensive polyfills: some JS runtimes (Hermes) may not expose `atob`/`btoa` or
// the global Buffer helper. Provide safe fallbacks that avoid throwing so code
// that attempts to parse JWTs or base64 data won't crash the app.
try {
  if (typeof globalThis.atob === 'undefined') {
    try {
      // Prefer Node-like Buffer when available
      if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        globalThis.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
      } else {
        // no-op safe fallback that returns empty string rather than throwing
        globalThis.atob = (s) => '';
      }
    } catch (e) {
      globalThis.atob = (s) => '';
    }
    // NOTE: do not redefine `safeLocal` here (top-level shim above is used across file).
  }
} catch (e) {}
try {
  if (typeof globalThis.btoa === 'undefined') {
    try {
      if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        globalThis.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
      } else {
        globalThis.btoa = (s) => '';
      }
    } catch (e) {
      globalThis.btoa = (s) => '';
    }
  }
} catch (e) {}
import { apiFetch } from './src/api';

// Error boundary to catch rendering errors and provide a friendly fallback UI
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    try {
      console.error('App ErrorBoundary caught error', error, info);
      // Persist minimal crash info for later retrieval (web-friendly)
      try {
        const payload = { message: String(error && error.message), stack: (error && error.stack) || null, info: info && info.componentStack, ts: Date.now() };
        try { safeLocal.setItem('brewski_last_error', JSON.stringify(payload)); } catch (e) {}
      } catch (e) {}
    } catch (e) {}
    this.setState({ info });
  }

  render() {
    if (this.state.hasError) {
      const err = this.state.error;
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', marginBottom: 8 }}>Something went wrong</Text>
          <Text style={{ color: '#444', marginBottom: 12 }}>{err && err.message ? String(err.message) : 'An unexpected error occurred.'}</Text>
          <View style={{ maxHeight: 240, width: '100%', padding: 8, backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#eee' }}>
            <Text style={{ fontSize: 11, color: '#333' }}>{(err && err.stack) || (this.state.info && this.state.info.componentStack) || ''}</Text>
          </View>
          <View style={{ flexDirection: 'row', marginTop: 12, gap: 12 }}>
            <Pressable onPress={() => { try { if (this.props.onReset) this.props.onReset(); else if (typeof window !== 'undefined' && window.location) window.location.reload(); } catch (e) {} }} style={{ backgroundColor: '#1976d2', padding: 10, borderRadius: 8 }}>
              <Text style={{ color: '#fff' }}>Reload / Reset</Text>
            </Pressable>
            <Pressable onPress={() => { try { const payload = safeLocal.getItem && safeLocal.getItem('brewski_last_error'); if (payload && typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(payload); Alert.alert && Alert.alert('Copied'); } catch (e) {} }} style={{ backgroundColor: '#6c757d', padding: 10, borderRadius: 8 }}>
              <Text style={{ color: '#fff' }}>Copy Error</Text>
            </Pressable>
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

// Removed push notification registration logic per request

import Settings from './views/Settings';

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  // Default to landing on web, but show login first on native (mobile) devices
  const [screen, setScreen] = useState(Platform.OS === 'web' ? 'landing' : 'login'); // native never shows landing
  const [token, setToken] = useState(null);
  const tokenRef = useRef(null);
  const [initialResetToken, setInitialResetToken] = useState('');
  const [cachedUser, setCachedUser] = useState(null); // minimal user info for role-based nav
  const [userLoading, setUserLoading] = useState(false);
  const intendedScreenRef = useRef(null); // remembers where user wanted to go pre-auth
  const [customerInfo, setCustomerInfo] = useState(null); // customer info for dynamic header title

  // Dynamic header title based on customer, fallback to default
  const getHeaderTitle = () => {
    if (customerInfo && customerInfo.name) {
      return customerInfo.name;
    }
    return 'Brew Remote';
  };

  // Derived access flag for manage/admin portal
  const hasManageAccess = !!(cachedUser && (Number(cachedUser.is_admin) === 1 || cachedUser.role === 'manager' || cachedUser.role === 'admin'));

  async function ensureUserLoaded(force = false) {
    if (!token) return;
    if (!force && (cachedUser || userLoading)) return;
    try {
      setUserLoading(true);
      let res = await apiFetch('/admin/api/me');
      // On native (no window, no localStorage), apiFetch should still send Authorization, but defensively retry with explicit token
      if (res && res.status === 401 && tokenRef.current) {
        try {
          res = await fetch('https://api.brewingremote.com/admin/api/me', { headers: { 'Authorization': 'Bearer ' + tokenRef.current, 'Accept': 'application/json' } });
        } catch (_) {}
      }
      if (!res || !res.ok) return;
      let js = null;
      try { js = await res.json(); } catch (e) { js = null; }
      if (js && js.user) {
        setCachedUser(js.user);
        try { safeLocal.setItem('brewski_me', JSON.stringify(js.user)); } catch (e) {}
      }
    } catch (e) {
      // swallow
    } finally {
      setUserLoading(false);
    }
  }

  useEffect(() => {
    try {
      const t = safeLocal.getItem('brewski_jwt');
      if (t) setToken(t);
      // attempt to hydrate cached user
      const meRaw = safeLocal.getItem('brewski_me');
      if (meRaw) {
        try { setCachedUser(JSON.parse(meRaw)); } catch (e) {}
      }
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
        try { safeLocal.setItem('brewski_jwt', t); } catch (e) {}
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
      try { if (token) safeLocal.setItem('brewski_jwt', token); else safeLocal.removeItem('brewski_jwt'); } catch (e) {}
    } catch (e) { }
    tokenRef.current = token;
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

  // Initial routing decision only once after token becomes available.
  const initialRoutedRef = useRef(false);
  useEffect(() => {
    if (!token || initialRoutedRef.current) return;
    try {
      const pathname = (typeof window !== 'undefined' && window.location) ? String(window.location.pathname) : '';
      const isAdminPath = pathname.startsWith('/admin');
      const isManagePath = pathname.startsWith('/manage');
      const isDashPath = pathname === '/dashboard' || pathname === '/dashboard/';
      if (isAdminPath || isManagePath) {
        setScreen('admin');
      } else if ((pathname === '/' || pathname === '') && Platform.OS === 'web') {
        // Web root: allow landing. Native: skip directly to dashboard.
        setScreen('landing');
      } else if (isDashPath) {
        setScreen('dashboard');
      } else {
        setScreen('dashboard');
      }
    } catch (e) {
      setScreen('dashboard');
    } finally {
      initialRoutedRef.current = true;
    }
  }, [token]);

  // Whenever token changes, ensure we have user info (unless already cached from localStorage)
  useEffect(() => {
    if (!token) { setCachedUser(null); return; }
    if (!cachedUser) ensureUserLoaded(false);
  }, [token]);

  // Force an eager user load right after token acquisition to populate role quickly (optimistic Manage rendering)
  useEffect(() => {
    if (!token) return;
    // slight delay to allow token persistence before fetch
    const h = setTimeout(() => { ensureUserLoaded(true); }, 50);
    return () => clearTimeout(h);
  }, [token]);

  // Register global JS/RN error handlers to capture runtime crashes in APKs
  useEffect(() => {
    const saveError = (err, info) => {
      try {
        const payload = { message: String(err && (err.message || err)), stack: (err && err.stack) || null, info: (info && info.componentStack) || null, ts: Date.now() };
        // Prefer native AsyncStorage on native platforms if available so release APKs persist crashes
        if (NativeAsyncStorage && Platform.OS !== 'web') {
          try { NativeAsyncStorage.setItem('brewski_last_error', JSON.stringify(payload)); } catch (e) {}
        } else {
          try { safeLocal.setItem('brewski_last_error', JSON.stringify(payload)); } catch (e) {}
        }
        console.error('Global captured error', payload);
      } catch (e) {}
    };

    // React Native global error handler (ErrorUtils is RN global)
    try {
      if (typeof global !== 'undefined' && global.ErrorUtils && typeof global.ErrorUtils.setGlobalHandler === 'function') {
        const prev = global.ErrorUtils.getGlobalHandler && global.ErrorUtils.getGlobalHandler();
        global.ErrorUtils.setGlobalHandler((err, isFatal) => {
          saveError(err, { componentStack: isFatal ? 'Uncaught fatal' : 'Uncaught' });
          if (prev && typeof prev === 'function') try { prev(err, isFatal); } catch (e) {}
        });
      }
    } catch (e) {}

    // window.onerror for web contexts
    const oldOnErr = (typeof window !== 'undefined' && window.onerror) ? window.onerror : null;
    try {
      if (typeof window !== 'undefined') {
        window.onerror = function (message, source, lineno, colno, error) {
          saveError(error || message, { componentStack: `${source}:${lineno}:${colno}` });
          if (oldOnErr) try { return oldOnErr(message, source, lineno, colno, error); } catch (e) {}
          return false;
        };
      }
    } catch (e) {}

    const onRejection = (ev) => {
      try { saveError(ev.reason || ev, { componentStack: 'UnhandledPromiseRejection' }); } catch (e) {}
    };
    try { if (typeof window !== 'undefined') window.addEventListener('unhandledrejection', onRejection); } catch (e) {}

    return () => {
      try { if (typeof window !== 'undefined') window.removeEventListener('unhandledrejection', onRejection); } catch (e) {}
      try { if (typeof window !== 'undefined' && oldOnErr) window.onerror = oldOnErr; } catch (e) {}
    };
  }, []);

  // Helpers to read/clear saved crash payload (works on native via AsyncStorage or web via localStorage)
  const readSavedCrash = async () => {
    try {
      if (NativeAsyncStorage && Platform.OS !== 'web') {
        const v = await NativeAsyncStorage.getItem('brewski_last_error');
        return v ? JSON.parse(v) : null;
      }
      try { const v = safeLocal.getItem('brewski_last_error'); return v ? JSON.parse(v) : null; } catch (e) {}
    } catch (e) {}
    return null;
  };

  const clearSavedCrash = async () => {
    try {
      if (NativeAsyncStorage && Platform.OS !== 'web') {
        await NativeAsyncStorage.removeItem('brewski_last_error');
        return true;
      }
      try { safeLocal.removeItem('brewski_last_error'); return true; } catch (e) {}
    } catch (e) { }
    return false;
  };

  // On web, if the path is /admin open the admin screen by default
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.location && String(window.location.pathname).startsWith('/admin')) {
        setScreen('admin');
        try { window.history.replaceState({}, document.title, '/admin'); } catch (e) { }
      }
    } catch (e) { }
  }, []);

  // Crash banner state and loader
  const [savedCrash, setSavedCrash] = useState(null);
  useEffect(() => {
    let mounted = true;
    readSavedCrash().then(r => { if (mounted) setSavedCrash(r); }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  const CrashBanner = ({ payload }) => {
    if (!payload) return null;
    const summary = payload.message ? String(payload.message).slice(0, 120) : 'Saved crash payload';
    return (
      <View style={{ position: 'absolute', right: 12, top: 12, zIndex: 9999 }}>
        <View style={{ backgroundColor: '#fff3cd', borderColor: '#ffeeba', borderWidth: 1, padding: 8, borderRadius: 8, maxWidth: 420 }}>
          <Text style={{ fontSize: 12, color: '#856404', fontWeight: '700' }}>Last crash detected</Text>
          <Text style={{ fontSize: 11, color: '#856404', marginTop: 6 }}>{summary}</Text>
          <View style={{ flexDirection: 'row', marginTop: 8, gap: 8 }}>
            <Pressable onPress={async () => { try { const full = JSON.stringify(payload, null, 2); if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(full); Alert.alert && Alert.alert('Copied crash payload'); } else if (Platform.OS !== 'web' && NativeAsyncStorage) { try { await NativeAsyncStorage.setItem('__brewski_temp_copy', full); Alert.alert && Alert.alert('Copied to device storage'); } catch (e) {} } } catch (e) {} }} style={{ backgroundColor: '#1976d2', padding: 6, borderRadius: 6 }}>
              <Text style={{ color: '#fff', fontSize: 12 }}>Copy</Text>
            </Pressable>
            <Pressable onPress={async () => { try { Alert.alert && Alert.alert('Crash details', (payload.stack || payload.info || payload.message) + '\n\nTimestamp: ' + new Date(payload.ts).toISOString()); } catch (e) {} }} style={{ backgroundColor: '#6c757d', padding: 6, borderRadius: 6 }}>
              <Text style={{ color: '#fff', fontSize: 12 }}>View</Text>
            </Pressable>
            <Pressable onPress={async () => { try { const ok = await clearSavedCrash(); if (ok) { setSavedCrash(null); Alert.alert && Alert.alert('Cleared'); } } catch (e) {} }} style={{ backgroundColor: '#c82333', padding: 6, borderRadius: 6 }}>
              <Text style={{ color: '#fff', fontSize: 12 }}>Clear</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  };

  // On web, if the path is /manage, open the manager portal if token maps to admin or manager
  useEffect(() => {
    try {
      if (typeof window === 'undefined' || !window.location) return;
      if (!String(window.location.pathname).startsWith('/manage')) return;
      // If no token, keep user on login; once token is set the other effect will switch screen
      if (!token) return;
      try {
        // Check current user's role by calling /admin/api/me — prefer SPA-local stored user if present
        const meRaw = safeLocal.getItem('brewski_me');
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
            try { safeLocal.setItem('brewski_me', JSON.stringify(json.user)); } catch (e) {}
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

  // If authenticated but still on an auth-only screen (login/forgot/reset) move to dashboard (or intended)
  useEffect(() => {
    if (token && ['login', 'forgot', 'reset'].includes(screen)) {
      const desired = intendedScreenRef.current;
      if (desired === 'admin') {
        openScreen('admin');
      } else {
        openScreen('dashboard');
      }
      intendedScreenRef.current = null;
    }
  }, [token, screen]);

  // Fallback guard: if we somehow have token but screen is a non-rendering value, coerce to dashboard
  useEffect(() => {
    if (token && !['landing','dashboard','admin','settings','about','login','forgot','reset'].includes(screen)) {
      setScreen('dashboard');
    }
  }, [token, screen]);

  // Handle direct deep links while unauthenticated: record intended screen
  useEffect(() => {
    if (token) return; // only care pre-auth
    try {
      if (typeof window === 'undefined') return;
      const pathname = String(window.location.pathname || '');
      if (/^\/admin/.test(pathname) || /^\/manage/.test(pathname)) {
        intendedScreenRef.current = 'admin';
        setScreen('login');
      } else if (pathname === '/dashboard' || pathname === '/dashboard/') {
        intendedScreenRef.current = 'dashboard';
        setScreen('login');
      }
    } catch (e) {}
  }, [token]);

  function openDashboard() {
    if (!token) {
      intendedScreenRef.current = 'dashboard';
      openScreen('dashboard');
      return;
    }
    openScreen('dashboard');
  }

  function handleLogout() {
    try { safeLocal.removeItem('brewski_jwt'); } catch (e) { }
    try { safeLocal.removeItem('brewski_me'); } catch (e) { }
    setCachedUser(null);
    setCustomerInfo(null);
    setToken(null);
    intendedScreenRef.current = null;
    if (Platform.OS === 'web') {
      setScreen('dashboard');
      try { if (typeof window !== 'undefined') window.history.pushState({}, '', '/dashboard'); } catch (e) {}
    } else {
      setScreen('login');
    }
  }

  const openScreen = (name) => {
    if (name === 'landing' && Platform.OS !== 'web') {
      name = 'dashboard';
    }
    if (!token && ['dashboard', 'admin', 'settings', 'about'].includes(name)) {
      intendedScreenRef.current = (name === 'admin') ? 'admin' : 'dashboard';
      name = 'login';
    }
    setScreen(name);
    setMenuOpen(false);
    try {
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        if (name === 'admin') {
          window.history.pushState({}, '', '/admin');
        } else if (name === 'dashboard') {
          window.history.pushState({}, '', '/dashboard');
        } else if (name === 'landing') {
          window.history.pushState({}, '', '/');
        } else {
          window.history.pushState({}, '', '/#' + name);
        }
      }
    } catch (e) { }
  };

  // Push notification registration removed

  return (
    <ErrorBoundary onReset={() => { try { handleLogout(); if (typeof window !== 'undefined' && window.location) window.location.reload(); } catch (e) {} }}>
    <SafeAreaProvider>
      {/* Crash banner: shows persisted crash payload from previous runs (native or web) */}
      {savedCrash ? <CrashBanner payload={savedCrash} /> : null}
      <StatusBar style="light" backgroundColor="#1b5e20" />
      <SafeAreaView edges={["top"]} style={[styles.topInset, { backgroundColor: '#1b5e20' }]} />
      <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
        {/* Push notification warning banner removed */}
        <Header
          title={getHeaderTitle()}
          token={token}
          hideControls={['login', 'forgot', 'reset', 'landing'].includes(screen)}
          menuOpen={menuOpen}
          hasManageAccess={hasManageAccess}
          onMenuPress={() => {
            const next = !menuOpen;
            setMenuOpen(next);
            if (next) ensureUserLoaded(false);
          }}
          onDashboardPress={() => {
            setMenuOpen(false);
            openDashboard();
          }}
          onManagePress={() => {
            setMenuOpen(false);
            openScreen('admin');
          }}
          onSettingsPress={() => {
            setMenuOpen(false);
            openScreen('settings');
          }}
          onLoginPress={() => { setMenuOpen(false); setScreen('login'); }}
          onLogoutPress={() => { handleLogout(); setMenuOpen(false); }}
        />
  <View style={styles.body} accessibilityElementsHidden={menuOpen} importantForAccessibility={menuOpen ? 'no-hide-descendants' : 'auto'}>
          <SideMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            items={[
              { label: 'Dashboard', onPress: () => openScreen('dashboard') },
              token && !cachedUser && userLoading ? { label: 'Manage (loading…)', disabled: true } : null,
              token && hasManageAccess ? { label: 'Manage', onPress: () => openScreen('admin') } : null,
              { label: 'Settings', onPress: () => openScreen('settings') },
              token ? { label: 'Logout', destructive: true, onPress: () => { handleLogout(); } } : { label: 'Login', onPress: () => setScreen('login') }
            ].filter(Boolean)}
          />
          <View style={styles.content}>
            {Platform.OS === 'web' && screen === 'landing' && (
              <Landing
                onLoginPress={() => setScreen('login')}
                onDashboardPress={() => {
                  if (!token) {
                    setScreen('login');
                  } else {
                    openScreen('dashboard');
                  }
                }}
                onManagePress={() => {
                  if (token) {
                    openScreen('admin');
                    return;
                  }
                  // Record intent then show login without triggering server 401
                  intendedScreenRef.current = 'admin';
                  setScreen('login');
                  // Update URL to /admin so upon reload or deep link consistency is preserved (no network request)
                  try { if (typeof window !== 'undefined') window.history.pushState({}, '', '/admin'); } catch (e) {}
                }}
              />
            )}
            {!token && screen !== 'login' && screen !== 'landing' && null}
            {screen === 'login' && !token && <LoginScreen onLogin={(t) => {
              // Avoid a full-page redirect when logging in from /admin to prevent reload loops.
              // Instead, set the token in SPA state/localStorage and update the history to the
              // /admin path so the server-side gating isn't required for the SPA to render.
              try {
                if (typeof window !== 'undefined' && window.location && String(window.location.pathname).startsWith('/admin')) {
                  // Set token locally and update the URL without reloading the page.
                  try { safeLocal.setItem('brewski_jwt', t); } catch (e) {}
                  setToken(t);
                  try { window.history.replaceState({}, document.title, '/admin'); } catch (e) {}
                  setScreen('admin');
                  return;
                }
              } catch (e) { /* fall back to default behavior below */ }

              // Default: set token and navigate within SPA honoring intended destination
              setToken(t);
              // Eagerly refresh user info so Manage appears quickly in menu (esp. native)
              setTimeout(() => { try { ensureUserLoaded(true); } catch(e){} }, 0);
              const desired = intendedScreenRef.current || (typeof window !== 'undefined' && String(window.location.pathname).startsWith('/dashboard') ? 'dashboard' : null);
              if (desired === 'admin') {
                openScreen('admin');
              } else {
                openScreen('dashboard');
              }
              intendedScreenRef.current = null;
            }} onForgot={() => setScreen('forgot')} />}
            {screen === 'forgot' && !token && <ForgotPasswordScreen onBack={() => setScreen('login')} />}
            {screen === 'reset' && !token && <ResetPasswordScreen initialToken={initialResetToken} onBack={() => setScreen('login')} />}
            {screen === 'dashboard' && token && <Dashboard token={token} onCustomerLoaded={setCustomerInfo} />}
            {screen === 'admin' && token && (
              hasManageAccess ? (
                <AdminPortal currentUser={cachedUser} loadingUser={userLoading} token={token} />
              ) : ((userLoading || !cachedUser) ? (
                // Grace period: while user role is still resolving, avoid redirect flicker to dashboard.
                <View style={{ padding: 20 }}>
                  <Text style={{ fontSize: 16, color: '#444' }}>Loading access…</Text>
                </View>
              ) : (
                // User resolved and has no manage access; redirect to dashboard.
                (() => { setTimeout(() => { if (!hasManageAccess) openScreen('dashboard'); }, 50); return (
                  <View style={{ padding: 20 }}>
                    <Text style={{ fontSize: 16, color: '#a33' }}>You do not have access to Manage.</Text>
                  </View>
                ); })()
              ))
            )}
            {screen === 'settings' && token && <Settings token={token} user={cachedUser} />}
          </View>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
    </ErrorBoundary>
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
  // Deprecated: inline side menu styles (kept for backward compatibility; remove if unused elsewhere)
  sideMenu: { width: 200, backgroundColor: '#1b5e20', paddingTop: 16, paddingHorizontal: 12 },
  menuHeader: { color: '#fff', fontWeight: '700', marginBottom: 12, fontSize: 16 },
  menuItem: { color: '#f1f8f1', paddingVertical: 6, fontSize: 14 },
  content: { flex: 1 },
});
