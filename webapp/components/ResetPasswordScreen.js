import React, { useState } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { apiFetch } from '../src/api';
import ToastBanner from './ToastBanner';

export default function ResetPasswordScreen({ onBack }) {
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);

  async function submit() {
    if (!token || !newPassword) {
      setToast({ type: 'error', text: 'Please provide the reset token and a new password.' });
      setTimeout(() => setToast(null), 3500);
      return;
    }
    setSubmitting(true);
    try {
      const resp = await apiFetch('/admin/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, newPassword })});
      const json = await resp.json().catch(() => ({}));
      if (resp.ok) {
        setToast({ type: 'success', text: 'Password updated successfully. You can now login.' });
        setTimeout(() => { setToast(null); onBack(); }, 2000);
      } else {
        setToast({ type: 'error', text: json && json.error ? json.error : 'Invalid or expired token' });
        setTimeout(() => setToast(null), 4000);
      }
    } catch (e) {
      setToast({ type: 'error', text: 'Network error: ' + String(e) });
      setTimeout(() => setToast(null), 4000);
    } finally { setSubmitting(false); }
  }

  return (
    <View style={{ padding: 20, alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 12, padding: 20, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 }}>
        <ToastBanner toast={toast} />
        <Text style={{ fontSize: 20, fontWeight: '700', marginBottom: 8 }}>Reset password</Text>
        <Text style={{ color: '#666', marginBottom: 12 }}>Paste the token you received in email and choose a new password.</Text>
        <TextInput value={token} onChangeText={setToken} placeholder="Reset token" autoCapitalize="none" style={{ borderWidth:1, borderColor:'#e0e6e0', padding:12, borderRadius:8, marginBottom:10, backgroundColor:'#fbfdfb' }} />
        <TextInput value={newPassword} onChangeText={setNewPassword} placeholder="New password" secureTextEntry style={{ borderWidth:1, borderColor:'#e0e6e0', padding:12, borderRadius:8, marginBottom:12, backgroundColor:'#fbfdfb' }} />
        <Pressable onPress={submit} style={{ backgroundColor: '#0b3d2e', paddingVertical: 12, borderRadius:8, alignItems:'center' }}>
          <Text style={{ color:'#fff', fontWeight:'600' }}>{submitting ? 'Submitting...' : 'Reset password'}</Text>
        </Pressable>
        <Pressable onPress={onBack} style={{ marginTop: 12, alignItems:'center' }}>
          <Text style={{ color:'#0b7aef' }}>Back to login</Text>
        </Pressable>
      </View>
    </View>
  );
}
