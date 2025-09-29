import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';

export default function Header({ title, token, onMenuPress, onPortalPress, onLoginPress, onLogoutPress }) {
  return (
    <View style={styles.appBar}>
      <Pressable accessibilityLabel="Menu" onPress={onMenuPress} style={styles.hamburger}>
        <View style={styles.bar} />
        <View style={styles.bar} />
        <View style={styles.bar} />
      </Pressable>
      <Text style={styles.appTitle}>{title || 'Brew Remote'}</Text>
      <View style={styles.rightArea}>
        {token ? (
          <Pressable onPress={onLogoutPress} style={styles.loginBtn} accessibilityLabel="Logout">
            <Text style={styles.loginText}>Logout</Text>
          </Pressable>
        ) : (
          <Pressable onPress={onLoginPress} style={styles.loginBtn} accessibilityLabel="Login">
            <Text style={styles.loginText}>Login</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  appBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#1b5e20' },
  appTitle: { color: '#fff', fontSize: 18, fontWeight: '600', marginLeft: 8 },
  hamburger: { padding: 4 },
  bar: { width: 22, height: 3, backgroundColor: '#fff', marginVertical: 2, borderRadius: 2 },
  rightArea: { marginLeft: 'auto', width: 120, alignItems: 'flex-end' },
  portalBtn: { backgroundColor: '#ffffff11', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  portalText: { color: '#fff', fontWeight: '600' },
  loginBtn: { backgroundColor: '#ffffff22', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  loginText: { color: '#fff', fontWeight: '600' },
});
