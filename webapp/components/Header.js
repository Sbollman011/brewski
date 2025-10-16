import React from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, Platform, StatusBar, Image } from 'react-native';
// Static import for Ionicons (package installed)
import { Ionicons } from '@expo/vector-icons';

export default function Header({ title, token, onMenuPress, onDashboardPress, onLoginPress, onLogoutPress, onSettingsPress, hideControls = false, menuOpen = false }) {
  const IS_WEB = Platform.OS === 'web';
  const IS_MOBILE = !IS_WEB;

  return (
    <>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.appBar}>
          {/* Show hamburger only on web; on mobile we'll provide a bottom nav instead */}
          {!hideControls && IS_WEB && (
            <Pressable
              accessibilityLabel={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              accessibilityRole="button"
              accessibilityState={{ expanded: menuOpen }}
              onPress={onMenuPress}
              style={[styles.hamburger, IS_WEB && styles.hamburgerWeb]}
            >
              <View style={styles.bar} />
              <View style={styles.bar} />
              <View style={styles.bar} />
            </Pressable>
          )}
          <Pressable onPress={() => { try { if (typeof onDashboardPress === 'function') return onDashboardPress(); if (typeof window !== 'undefined') window.location.href = '/dashboard'; } catch (e) {} }} accessibilityLabel="Home" style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Image source={require('../assets/logo.png')} style={styles.headerLogo} />
            <Text style={styles.appTitle}>{title || 'Brew Remote'}</Text>
          </Pressable>
          <View style={styles.rightArea}>
            {/* Keep login/logout visible on web; on mobile prefer profile in bottom nav */}
            {(!IS_MOBILE && !hideControls) ? (
              token ? (
                <Pressable onPress={onLogoutPress} style={styles.loginBtn} accessibilityLabel="Logout">
                  <Text style={styles.loginText}>Logout</Text>
                </Pressable>
              ) : (
                <Pressable onPress={onLoginPress} style={styles.loginBtn} accessibilityLabel="Login">
                  <Text style={styles.loginText}>Login</Text>
                </Pressable>
              )
            ) : null}
          </View>
        </View>
      </SafeAreaView>

      {/* Mobile-only bottom navigation bar replacing the side menu UX. */}
      {IS_MOBILE && !hideControls && (
        <View style={[styles.bottomNav, styles.bottomNavElevated]} accessibilityRole="navigation" accessibilityLabel="App navigation">
          <Pressable style={styles.bottomNavItem} onPress={onDashboardPress} accessibilityLabel="Home">
            {Ionicons ? <Ionicons name="home-outline" size={22} color="#fff" /> : <Text style={styles.bottomIcon}>🏠</Text>}
            <Text style={styles.bottomLabel}>Home</Text>
          </Pressable>
          <Pressable style={styles.bottomNavItem} onPress={onMenuPress} accessibilityLabel="Devices">
            {Ionicons ? <Ionicons name="flash-outline" size={22} color="#fff" /> : <Text style={styles.bottomIcon}>🔌</Text>}
            <Text style={styles.bottomLabel}>Devices</Text>
          </Pressable>
          <Pressable style={styles.bottomNavItem} onPress={onSettingsPress} accessibilityLabel="Settings">
            {Ionicons ? <Ionicons name="settings-outline" size={22} color="#fff" /> : <Text style={styles.bottomIcon}>⚙️</Text>}
            <Text style={styles.bottomLabel}>Settings</Text>
          </Pressable>
          <Pressable style={styles.bottomNavItem} onPress={token ? onLogoutPress : onLoginPress} accessibilityLabel={token ? 'Logout' : 'Login'}>
            {Ionicons ? <Ionicons name={token ? 'log-out-outline' : 'log-in-outline'} size={22} color="#fff" /> : <Text style={styles.bottomIcon}>{token ? '🔓' : '🔒'}</Text>}
            <Text style={styles.bottomLabel}>{token ? 'Logout' : 'Login'}</Text>
          </Pressable>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#1b5e20', paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0 },
  appBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10 },
  appTitle: { color: '#fff', fontSize: 18, fontWeight: '600', marginLeft: 8 },
  hamburger: { padding: 4 },
  bar: { width: 22, height: 3, backgroundColor: '#fff', marginVertical: 2, borderRadius: 2 },
  rightArea: { marginLeft: 'auto', width: 120, alignItems: 'flex-end' },
  hamburgerWeb: { marginRight: 12 },
  portalBtn: { backgroundColor: '#ffffff11', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  portalText: { color: '#fff', fontWeight: '600' },
  loginBtn: { backgroundColor: '#ffffff22', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  loginText: { color: '#fff', fontWeight: '600' },
  headerLogo: { width: 28, height: 28, marginRight: 8, resizeMode: 'contain' }
  ,
  bottomNav: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 62, backgroundColor: '#1b5e20', flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#ffffff22', paddingBottom: 6 },
  // ensure the bottom nav stacks above content on Android/iOS
  bottomNavElevated: { zIndex: 9999, elevation: 12 },
  bottomNavItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 6 },
  bottomIcon: { fontSize: 20, color: '#fff' },
  bottomLabel: { fontSize: 11, color: '#fff', marginTop: 2 }
});
