import React from 'react';
import { View, Text, Pressable, StyleSheet, SafeAreaView, Platform, StatusBar } from 'react-native';

export default function Header({ title, token, onMenuPress, onDashboardPress, onLoginPress, onLogoutPress, hideControls = false, menuOpen = false }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.appBar}>
        {!hideControls && (
          <Pressable
            accessibilityLabel={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            accessibilityRole="button"
            accessibilityState={{ expanded: menuOpen }}
            onPress={onMenuPress}
            style={styles.hamburger}
          >
            <View style={styles.bar} />
            <View style={styles.bar} />
            <View style={styles.bar} />
          </Pressable>
        )}
        <Pressable onPress={() => { try { if (typeof onDashboardPress === 'function') return onDashboardPress(); if (typeof window !== 'undefined') window.location.href = '/dashboard'; } catch (e) {} }} accessibilityLabel="Home">
          <Text style={styles.appTitle}>{title || 'Brew Remote'}</Text>
        </Pressable>
        <View style={styles.rightArea}>
          {hideControls ? null : (
            token ? (
              <Pressable onPress={onLogoutPress} style={styles.loginBtn} accessibilityLabel="Logout">
                <Text style={styles.loginText}>Logout</Text>
              </Pressable>
            ) : (
              <Pressable onPress={onLoginPress} style={styles.loginBtn} accessibilityLabel="Login">
                <Text style={styles.loginText}>Login</Text>
              </Pressable>
            )
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#1b5e20', paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0 },
  appBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10 },
  appTitle: { color: '#fff', fontSize: 18, fontWeight: '600', marginLeft: 8 },
  hamburger: { padding: 4 },
  bar: { width: 22, height: 3, backgroundColor: '#fff', marginVertical: 2, borderRadius: 2 },
  rightArea: { marginLeft: 'auto', width: 120, alignItems: 'flex-end' },
  portalBtn: { backgroundColor: '#ffffff11', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  portalText: { color: '#fff', fontWeight: '600' },
  loginBtn: { backgroundColor: '#ffffff22', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  loginText: { color: '#fff', fontWeight: '600' },
});
