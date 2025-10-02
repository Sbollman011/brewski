import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform, AccessibilityInfo } from 'react-native';

// Generic side menu; parent controls open state. Renders overlay when open.
export default function SideMenu({ open, onClose, items = [], width = 200, showOverlay = true, header, footer }) {
  if (!open) return null;
  return (
    <View style={styles.wrap} pointerEvents="box-none" accessibilityViewIsModal={true} importantForAccessibility="yes">
      {showOverlay && <Pressable style={styles.overlay} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close menu" />}
      <View style={[styles.menu, { width }]} accessibilityRole={Platform.OS === 'web' ? undefined : 'menu'} accessibilityLabel="Navigation menu">
        {header ? <View style={styles.header}>{header}</View> : null}
        {items.map((it, idx) => {
          const disabled = !!it.disabled;
          return (
            <Pressable
              key={idx}
              disabled={disabled}
              onPress={() => { if (disabled) return; try { if (it.onPress) it.onPress(); } finally { if (it.autoClose !== false) onClose && onClose(); } }}
              style={({ pressed }) => [styles.item, disabled && styles.itemDisabled, pressed && !disabled && styles.itemPressed]}
              accessibilityLabel={it.accessibilityLabel || it.label}
              accessibilityRole={Platform.OS === 'web' ? undefined : 'menuitem'}
              accessibilityState={{ disabled, selected: !!it.selected }}
            >
              <Text style={[styles.itemText, it.destructive && styles.destructive, disabled && styles.itemTextDisabled]}>{it.label}</Text>
            </Pressable>
          );
        })}
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  menu: { backgroundColor: '#1b5e20', paddingTop: 16, paddingHorizontal: 12, paddingBottom: 24, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, elevation: 8 },
  header: { marginBottom: 12 },
  footer: { marginTop: 16 },
  item: { paddingVertical: 8 },
  itemDisabled: { opacity: 0.5 },
  itemPressed: { opacity: 0.6 },
  itemText: { color: '#f1f8f1', fontSize: 14 },
  itemTextDisabled: { color: '#f1f8f1' },
  destructive: { color: '#ffcccb' }
});
