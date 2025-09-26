import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import Dashboard from './views/Dashboard';
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
  const [screen, setScreen] = useState('dashboard'); // 'dashboard' | 'settings' | 'about'

  const openScreen = (name) => {
    setScreen(name);
    setMenuOpen(false);
  };

  const titleMap = {
    dashboard: 'Brew Remote',
    settings: 'Settings',
    about: 'About',
  };

  // Push notification registration removed

  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor="#263238" />
      <SafeAreaView edges={["top"]} style={styles.topInset} />
      <SafeAreaView style={styles.root} edges={["left","right","bottom"]}>
        {/* Push notification warning banner removed */}
        <View style={styles.appBar}>
          <Pressable accessibilityLabel="Menu" onPress={() => setMenuOpen(m => !m)} style={styles.hamburger}>
            <View style={styles.bar} />
            <View style={styles.bar} />
            <View style={styles.bar} />
          </Pressable>
          <Text style={styles.appTitle}>{titleMap[screen] || 'Brew Remote'}</Text>
          <View style={{width:32}} />
        </View>
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
              <Pressable onPress={() => openScreen('about')} style={{paddingVertical:8}}>
                <Text style={styles.menuItem}>About</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.content}>
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
  topInset: { backgroundColor: '#263238' },
  appBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#263238' },
  appTitle: { color: '#fff', fontSize: 18, fontWeight: '600', marginLeft: 8 },
  hamburger: { padding: 4 },
  bar: { width: 22, height: 3, backgroundColor: '#fff', marginVertical: 2, borderRadius: 2 },
  body: { flex: 1, flexDirection: 'row' },
  sideMenu: { width: 200, backgroundColor: '#37474f', paddingTop: 16, paddingHorizontal: 12 },
  menuHeader: { color: '#fff', fontWeight: '700', marginBottom: 12, fontSize: 16 },
  menuItem: { color: '#eceff1', paddingVertical: 6, fontSize: 14 },
  content: { flex: 1 },
});
