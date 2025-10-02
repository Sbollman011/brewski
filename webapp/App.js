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
import { apiFetch } from './src/api';

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
  const [screen, setScreen] = useState(Platform.OS === 'web' ? 'landing' : 'login'); // native never shows landing
  const [token, setToken] = useState(null);
  const tokenRef = useRef(null);
  const [initialResetToken, setInitialResetToken] = useState('');
  const [cachedUser, setCachedUser] = useState(null); // minimal user info for role-based nav
  const [userLoading, setUserLoading] = useState(false);
  const intendedScreenRef = useRef(null); // remembers where user wanted to go pre-auth

  // Static header title per requirement
  const APP_TITLE = 'Brew Remote';

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
        try { localStorage.setItem('brewski_me', JSON.stringify(js.user)); } catch (e) {}
      }
    } catch (e) {
      // swallow
    } finally {
      setUserLoading(false);
    }
  }

  useEffect(() => {
    try {
      const t = localStorage.getItem('brewski_jwt');
      if (t) setToken(t);
      // attempt to hydrate cached user
      const meRaw = localStorage.getItem('brewski_me');
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
      if (typeof window !== 'undefined') {
        if (token) localStorage.setItem('brewski_jwt', token); else localStorage.removeItem('brewski_jwt');
      }
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
    try { localStorage.removeItem('brewski_jwt'); } catch (e) { }
    try { localStorage.removeItem('brewski_me'); } catch (e) { }
    setCachedUser(null);
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
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor="#1b5e20" />
      <SafeAreaView edges={["top"]} style={[styles.topInset, { backgroundColor: '#1b5e20' }]} />
      <SafeAreaView style={styles.root} edges={["left", "right", "bottom"]}>
        {/* Push notification warning banner removed */}
        <Header
          title={APP_TITLE}
          token={token}
          hideControls={['login', 'forgot', 'reset', 'landing'].includes(screen)}
          menuOpen={menuOpen}
          onMenuPress={() => {
            const next = !menuOpen;
            setMenuOpen(next);
            if (next) ensureUserLoaded(false);
          }}
          onDashboardPress={() => {
            setMenuOpen(false);
            openDashboard();
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
                  try { localStorage.setItem('brewski_jwt', t); } catch (e) {}
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
            {screen === 'dashboard' && token && <Dashboard token={token} />}
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
  // Deprecated: inline side menu styles (kept for backward compatibility; remove if unused elsewhere)
  sideMenu: { width: 200, backgroundColor: '#1b5e20', paddingTop: 16, paddingHorizontal: 12 },
  menuHeader: { color: '#fff', fontWeight: '700', marginBottom: 12, fontSize: 16 },
  menuItem: { color: '#f1f8f1', paddingVertical: 6, fontSize: 14 },
  content: { flex: 1 },
});
