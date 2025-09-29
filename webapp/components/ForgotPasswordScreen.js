import React, { useState } from 'react';
import { View, Text, TextInput, Pressable } from 'react-native';
import { apiFetch } from '../src/api';
import ToastBanner from './ToastBanner';

export default function ForgotPasswordScreen({ onBack }) {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState(null);

  async function submit() {
    if (!email) {
      setToast({ type: 'error', text: 'Please enter the email associated with your account.' });
      setTimeout(() => setToast(null), 3500);
      return;
    }
    setSending(true);
    try {
      const resp = await apiFetch('/admin/api/forgot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
      });
      // always return 200 per server behavior
      setToast({ type: 'success', text: 'If that email is registered, reset instructions have been sent.' });
      setTimeout(() => { setToast(null); onBack(); }, 2500);
    } catch (e) {
      setToast({ type: 'error', text: 'Network error: ' + String(e) });
      setTimeout(() => setToast(null), 4000);
    } finally { setSending(false); }
  }

  return (
    <View style={{ padding: 20, alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: 420, backgroundColor: '#fff', borderRadius: 12, padding: 20, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 }}>
        <ToastBanner toast={toast} />
        <Text style={{ fontSize: 20, fontWeight: '700', marginBottom: 8 }}>Reset your password</Text>
        <Text style={{ color: '#666', marginBottom: 12 }}>Enter the email associated with your account and we'll send reset instructions.</Text>
        <TextInput value={email} onChangeText={setEmail} placeholder="Email" autoCapitalize="none" style={{ borderWidth:1, borderColor:'#e0e6e0', padding:12, borderRadius:8, marginBottom:12, backgroundColor:'#fbfdfb' }} />
        <Pressable onPress={submit} style={{ backgroundColor: '#0b3d2e', paddingVertical: 12, borderRadius:8, alignItems:'center' }}>
          <Text style={{ color:'#fff', fontWeight:'600' }}>{sending ? 'Sending...' : 'Send reset email'}</Text>
        </Pressable>
        <Pressable onPress={onBack} style={{ marginTop: 12, alignItems:'center' }}>
          <Text style={{ color:'#0b7aef' }}>Back to login</Text>
        </Pressable>
      </View>
    </View>
  );
}
