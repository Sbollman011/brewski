import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, Image } from 'react-native';

export default function Landing({ onLoginPress, onPortalPress }) {
  return (
    <ScrollView style={styles.container} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={styles.hero}>
  {/* Use root-mounted assets path so the image is served from /assets/logo.svg */}
  <Image source={{ uri: '/assets/logo.svg' }} style={styles.logo} resizeMode="contain" />
        <Text style={styles.brand}>Brew Remote</Text>
        <Text style={styles.tagline}>Remote control and automation for brewery systems</Text>
        <Text style={styles.lead}>We install equipment, sensors and an onsite control computer inside your brewery. Control temperatures and pumps from the Portal or the in-house device — or run automated recipes. We provide a subscription and ongoing support; you get secure remote access via our app and the browser Portal.</Text>

        <View style={styles.ctaRow}>
          <Pressable style={styles.ctaPrimary} onPress={onPortalPress} accessibilityLabel="Open Portal">
            <Text style={styles.ctaPrimaryText}>Open Portal</Text>
          </Pressable>
          <Pressable style={styles.ctaSecondary} onPress={onLoginPress} accessibilityLabel="Login">
            <Text style={styles.ctaSecondaryText}>Login</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.featuresWrap}>
        <Text style={styles.sectionTitle}>What it does</Text>
        <View style={styles.featuresRow}>
          <View style={styles.featureCard}>
            <Text style={styles.featureTitle}>Monitoring</Text>
            <Text style={styles.featureText}>Live telemetry from sensors and controllers gives you a real-time view of brew status and environment.</Text>
          </View>
          <View style={styles.featureCard}>
            <Text style={styles.featureTitle}>Control</Text>
            <Text style={styles.featureText}>Start/stop pumps, set temperatures, and trigger automated steps from the Portal or scheduled recipes.</Text>
          </View>
          <View style={styles.featureCard}>
            <Text style={styles.featureTitle}>Automation</Text>
            <Text style={styles.featureText}>Define recipe steps and triggers; the system will execute them reliably — manual override when needed.</Text>
          </View>
        </View>
      </View>

      <View style={styles.benefitsWrap}>
        <Text style={styles.sectionTitle}>Why breweries choose Brew Remote</Text>
        <Text style={styles.benefitItem}>• Improve consistency across batches with automated recipes and scheduled controls.</Text>
        <Text style={styles.benefitItem}>• Reduce downtime with remote alerts and real-time diagnostics.</Text>
        <Text style={styles.benefitItem}>• Secure access with local install and optional cloud tunneling to your origin.</Text>
      </View>

      <View style={styles.footerWrap}>
        <Text style={styles.footerText}>Installed inside your brewery. Designed for production — not a consumer toy.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f6fbf6' },
  // Match the header/navigation color so the hero/banner and nav look unified
  hero: { padding: 28, paddingTop: 36, alignItems: 'center', backgroundColor: '#1b5e20' },
  // Light text on the dark green banner for good contrast
  brand: { fontSize: 34, fontWeight: '800', color: '#ffffff', marginBottom: 6 },
  tagline: { fontSize: 16, color: '#dff3df', marginBottom: 12, textAlign: 'center' },
  lead: { maxWidth: 920, color: '#e6f5e7', textAlign: 'center', marginBottom: 18 },
  logo: { width: 120, height: 120, marginBottom: 10 },
  ctaRow: { flexDirection: 'row', gap: 12 },
  // On the dark hero we invert the primary CTA to white so it stands out
  ctaPrimary: { backgroundColor: '#ffffff', paddingVertical: 12, paddingHorizontal: 20, borderRadius: 8, marginHorizontal: 6 },
  ctaPrimaryText: { color: '#1b5e20', fontWeight: '700' },
  // Secondary CTA is a subtle white-outline button on the dark hero
  ctaSecondary: { borderColor: '#ffffff', borderWidth: 1, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, marginHorizontal: 6, backgroundColor: 'transparent' },
  ctaSecondaryText: { color: '#ffffff', fontWeight: '700' },

  featuresWrap: { padding: 20 },
  sectionTitle: { fontSize: 20, fontWeight: '700', color: '#234e24', marginBottom: 10, textAlign: 'center' },
  featuresRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  featureCard: { flex: 1, minWidth: 220, backgroundColor: '#fff', padding: 14, borderRadius: 8, margin: 6, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6 },
  featureTitle: { fontSize: 16, fontWeight: '700', color: '#1b5e20', marginBottom: 6 },
  featureText: { color: '#345b3a' },

  benefitsWrap: { padding: 20 },
  benefitItem: { color: '#2b5e31', marginBottom: 8 },

  footerWrap: { padding: 20, alignItems: 'center' },
  footerText: { color: '#4a6a4a' },
});
