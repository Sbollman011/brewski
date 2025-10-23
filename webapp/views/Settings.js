import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Pressable, Alert } from 'react-native';
import { apiFetch } from '../src/api';

// Minimal settings view extracted from App.js. Shows account info and
// provides a change-password form. Expects props: token (JWT string) and
// optionally `user` object { username, email, role } for immediate display.

const styles = {
  container: { padding: 12, flex: 1 },
  sectionTitle: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
  label: { fontSize: 12, color: '#666', marginTop: 8 },
  // Slightly more compact inputs for mobile-first layout
  input: { borderWidth: 1, borderColor: '#ddd', padding: 6, marginTop: 6, borderRadius: 4, backgroundColor: '#fff', fontSize: 14 },
  // Smaller button footprint
  btn: { marginTop: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, backgroundColor: '#1b5e20', alignSelf: 'flex-start' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  infoRow: { marginTop: 6 },
  hint: { fontSize: 12, color: '#666', marginTop: 6 }
};

function passwordStrengthHints(pw) {
  if (!pw) return { score: 0, hints: ['Use a password of at least 8 characters.'] };
  const hints = [];
  let score = 0;
  if (pw.length >= 8) score += 1; else hints.push('Use at least 8 characters');
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) { score += 1; } else hints.push('Mix upper and lower case');
  if (/\d/.test(pw)) { score += 1; } else hints.push('Include numbers');
  if (/[^A-Za-z0-9]/.test(pw)) { score += 1; } else hints.push('Include a symbol (e.g. !@#$)');
  if (pw.length >= 16) { score += 1; }
  return { score, hints };
}

export default function Settings({ token, user: userProp }) {
  const [user, setUser] = useState(userProp || null);
  const [loading, setLoading] = useState(false);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');

  useEffect(() => {
    let mounted = true;
    if (!user && token) {
      setLoading(true);
      apiFetch('/admin/api/me').then(async (res) => {
        if (!mounted) return;
        try {
          if (res && res.ok) {
            const js = await res.json();
            if (js && js.user) setUser(js.user);
          } else if (res && res.status === 401) {
            // leave to parent to handle logout
          }
        } catch (e) {}
      }).catch(() => {}).finally(() => { if (mounted) setLoading(false); });
    }
    return () => { mounted = false; };
  }, [token]);

  function validateClientSide() {
    if (!newPw) return 'Enter a new password';
    if (newPw !== confirmPw) return 'Passwords do not match';
    if (newPw.length < 8) return 'Password must be at least 8 characters';
    const { score } = passwordStrengthHints(newPw);
    if (score < 3) return 'Password is weak; follow the suggestions below';
    return null;
  }

  async function handleChangePassword() {
    const clientErr = validateClientSide();
    if (clientErr) return Alert.alert && Alert.alert('Validation', clientErr);
    if (!curPw) return Alert.alert && Alert.alert('Missing current password', 'Please enter your current password to confirm');
    try {
      setLoading(true);
      const res = await apiFetch('/admin/api/me/password', { method: 'POST', body: { current: curPw, password: newPw } });
      if (res && res.ok) {
        Alert.alert && Alert.alert('Password changed', 'Your password was updated successfully');
        setCurPw(''); setNewPw(''); setConfirmPw('');
      } else if (res && res.status === 401) {
        Alert.alert && Alert.alert('Unauthorized', 'Current password incorrect');
      } else {
        // Try to show friendly message
        try {
          const txt = res && typeof res.text === 'function' ? await res.text() : null;
          Alert.alert && Alert.alert('Error', txt || 'Unable to change password');
        } catch (e) { Alert.alert && Alert.alert('Error', 'Unable to change password'); }
      }
    } catch (e) {
      Alert.alert && Alert.alert('Network error', 'Unable to reach server');
    } finally { setLoading(false); }
  }

  const strength = passwordStrengthHints(newPw);

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Account management</Text>

      <View>
        <Text style={{ fontWeight: '700' }}>User</Text>
        <View style={styles.infoRow}><Text>Username: {user ? (user.username || '—') : (loading ? 'loading…' : '—')}</Text></View>
        <View style={styles.infoRow}><Text>Email: {user ? (user.email || '—') : (loading ? 'loading…' : '—')}</Text></View>
        <View style={styles.infoRow}><Text>Role: {user ? (user.role || (user.is_admin ? 'admin' : 'user')) : (loading ? 'loading…' : '—')}</Text></View>
      </View>

      <View style={{ marginTop: 18 }}>
        <Text style={{ fontWeight: '700', marginBottom: 6 }}>Change password</Text>
        <Text style={styles.label}>Current password</Text>
        <TextInput secureTextEntry value={curPw} onChangeText={setCurPw} style={styles.input} />
        <Text style={styles.label}>New password</Text>
        <TextInput secureTextEntry value={newPw} onChangeText={setNewPw} style={styles.input} />
        <Text style={styles.label}>Confirm new password</Text>
        <TextInput secureTextEntry value={confirmPw} onChangeText={setConfirmPw} style={styles.input} />

        <View style={{ marginTop: 8 }}>
          <Text style={styles.hint}>Password strength: {['Very weak','Weak','Okay','Good','Strong','Excellent'][Math.min(5, strength.score)]}</Text>
          {strength.hints && strength.hints.length > 0 && (
            <View style={{ marginTop: 6 }}>
              {strength.hints.map((h, idx) => (<Text key={idx} style={{ fontSize: 12, color: '#666' }}>• {h}</Text>))}
            </View>
          )}
        </View>

        <Pressable onPress={handleChangePassword} style={styles.btn} disabled={loading}>
          <Text style={styles.btnText}>{loading ? 'Saving…' : 'Change password'}</Text>
        </Pressable>
      </View>
    </View>
  );
}
