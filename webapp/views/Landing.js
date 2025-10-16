import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, Image } from 'react-native';

// Props:
//  - onLoginPress(): open login screen (generic)
//  - onDashboardPress(): go to dashboard (respecting auth)
//  - onManagePress(): attempt to open manage/admin portal (SPA-managed)
export default function Landing({ onLoginPress, onDashboardPress, onManagePress }) {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <View style={styles.hero}>
        {/* Logo + headline row */}
        <View style={styles.heroTopRow}>
          <Image source={require('../assets/logo.png')} style={styles.logo} resizeMode="contain" />
          <View style={styles.heroTitleBlock}>
            <Text style={styles.brand}>Brew Remote</Text>
            <Text style={styles.tagline}>Real-time monitoring • Smart control • Automation</Text>
          </View>
        </View>
        <Text style={styles.lead}>A local controller + secure remote portal for fermentation, mash, boil & cellar operations. Stay in control from anywhere without exposing your whole network.</Text>
        <View style={styles.ctaRow}>
          <Pressable style={styles.ctaPrimary} onPress={onDashboardPress} accessibilityLabel="Dashboard">
            <Text style={styles.ctaPrimaryText}>Dashboard</Text>
          </Pressable>
          <Pressable style={styles.ctaSecondary} onPress={() => {
            if (onManagePress) {
              onManagePress();
              return;
            }
            // Fallback: previous behavior (full navigation) if handler not supplied
            try { if (typeof window !== 'undefined') window.location.href = '/admin'; }
            catch (e) { onLoginPress && onLoginPress(); }
          }} accessibilityLabel="Manage">
            <Text style={styles.ctaSecondaryText}>Manage</Text>
          </Pressable>
        </View>
        <View style={styles.miniFeaturesRow}>
          <View style={styles.miniFeature}><Text style={styles.miniFeatureTitle}>Telemetry</Text><Text style={styles.miniFeatureText}>Temps & states live</Text></View>
          <View style={styles.miniFeature}><Text style={styles.miniFeatureTitle}>Control</Text><Text style={styles.miniFeatureText}>Targets & pumps</Text></View>
          <View style={styles.miniFeature}><Text style={styles.miniFeatureTitle}>Automation</Text><Text style={styles.miniFeatureText}>Recipe steps</Text></View>
          <View style={styles.miniFeature}><Text style={styles.miniFeatureTitle}>Alerts</Text><Text style={styles.miniFeatureText}>Thresholds</Text></View>
        </View>
      </View>

      <View style={styles.sectionShell}>
        <Text style={styles.sectionTitle}>Why breweries choose us</Text>
        <View style={styles.bullets}>
          <Text style={styles.bullet}>• Consistent batches via repeatable automated targets.</Text>
          <Text style={styles.bullet}>• Remote visibility reduces downtime & guesswork.</Text>
          <Text style={styles.bullet}>• Secure: on‑prem core with a hardened bridge.</Text>
          <Text style={styles.bullet}>• Extensible: MQTT topics integrate with what you already have.</Text>
        </View>
      </View>

      <View style={styles.footerWrap}>
        <Text style={styles.footerText}>Built for production breweries — lightweight, observable, secure.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5faf6' },
  scrollContent: { flexGrow: 1 },
  hero: { paddingVertical: 32, paddingHorizontal: 24, backgroundColor: '#134a17', alignItems: 'stretch', borderBottomLeftRadius: 18, borderBottomRightRadius: 18 },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', marginBottom: 12 },
  heroTitleBlock: { alignItems: 'center', marginLeft: 8 },
  logo: { width: 72, height: 72 },
  brand: { fontSize: 36, fontWeight: '800', color: '#ffffff', letterSpacing: 0.5 },
  tagline: { fontSize: 14, color: '#cfead2', marginTop: 4 },
  lead: { color: '#e2f6e5', textAlign: 'center', marginTop: 10, marginBottom: 18, maxWidth: 880, alignSelf: 'center', lineHeight: 20 },
  ctaRow: { flexDirection: 'row', justifyContent: 'center', marginBottom: 10 },
  ctaPrimary: { backgroundColor: '#ffffff', paddingVertical: 11, paddingHorizontal: 20, borderRadius: 8, marginHorizontal: 6, minWidth: 140, alignItems: 'center' },
  ctaPrimaryText: { color: '#134a17', fontWeight: '700' },
  ctaSecondary: { borderColor: '#ffffff', borderWidth: 1, paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8, marginHorizontal: 6, backgroundColor: 'rgba(255,255,255,0.05)', minWidth: 120, alignItems: 'center' },
  ctaSecondaryText: { color: '#ffffff', fontWeight: '700' },
  miniFeaturesRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 },
  miniFeature: { backgroundColor: 'rgba(255,255,255,0.07)', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, margin: 4, minWidth: 116 },
  miniFeatureTitle: { color: '#fff', fontWeight: '700', fontSize: 13 },
  miniFeatureText: { color: '#d6efda', fontSize: 11, marginTop: 2 },
  sectionShell: { paddingHorizontal: 20, paddingVertical: 28 },
  sectionTitle: { fontSize: 20, fontWeight: '700', color: '#244f27', marginBottom: 14, textAlign: 'center' },
  bullets: { maxWidth: 840, alignSelf: 'center' },
  bullet: { color: '#2d5d32', marginBottom: 8, lineHeight: 18 },
  footerWrap: { padding: 18, alignItems: 'center', borderTopWidth: 1, borderTopColor: '#e0efe3' },
  footerText: { color: '#4a6a4a', fontSize: 12, textAlign: 'center' }
});
