import React from 'react';
import { View, Text } from 'react-native';

export default function ToastBanner({ toast }) {
  if (!toast || !toast.text) return null;
  const bg = toast.type === 'error' ? '#ffefef' : toast.type === 'success' ? '#eefaf1' : '#fffbe6';
  const color = toast.type === 'error' ? '#a70000' : toast.type === 'success' ? '#00683a' : '#6a5800';
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ backgroundColor: bg, borderRadius: 8, padding: 8, borderWidth: 1, borderColor: (toast.type === 'error' ? '#ffd6d6' : '#cdecd8') }}>
        <Text style={{ color, fontSize: 13 }}>{toast.text}</Text>
      </View>
    </View>
  );
}
