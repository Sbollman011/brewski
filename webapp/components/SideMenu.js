import React from 'react';
import { View, Text, Pressable, StyleSheet, Platform, AccessibilityInfo, SafeAreaView } from 'react-native';

// Generic side menu; parent controls open state. Renders overlay when open.
// topOffset: number of pixels to push the menu down from the top (e.g. header height)
export default function SideMenu({ open, onClose, items = [], width = 200, showOverlay = true, header, footer, side = 'left', topOffset = 0 }) {
  if (!open) return null;
  return (
    <View style={[styles.wrap, styles.activeWrap]} pointerEvents="box-none" accessibilityViewIsModal={true} importantForAccessibility="yes">
      {showOverlay && <Pressable style={styles.overlay} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close menu" />}
      <SafeAreaView style={[styles.menuContainer, side === 'right' ? { right: 0 } : { left: 0 }, { top: topOffset || 0 }]} pointerEvents="box-none">
        <View style={[styles.menu, { width, [side]: 0 }]} accessibilityRole={Platform.OS === 'web' ? undefined : 'menu'} accessibilityLabel="Navigation menu">
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
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row' },
  // ensure the menu overlays content on native (Android/iOS) where sibling order otherwise stacks above it
  activeWrap: { zIndex: 1000, elevation: 30 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  menuContainer: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'flex-start' },
  // menu fills remaining vertical space from topOffset downward
  menu: { position: 'absolute', top: 0, bottom: 0, backgroundColor: '#1b5e20', paddingTop: 16, paddingHorizontal: 12, paddingBottom: 24, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, elevation: 8 },
  header: { marginBottom: 12 },
  footer: { marginTop: 16 },
  item: { paddingVertical: 8 },
  itemDisabled: { opacity: 0.5 },
  itemPressed: { opacity: 0.6 },
  itemText: { color: '#f1f8f1', fontSize: 14 },
  itemTextDisabled: { color: '#f1f8f1' },
  destructive: { color: '#ffcccb' }
});
