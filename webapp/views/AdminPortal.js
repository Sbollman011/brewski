import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TextInput, Button, TouchableOpacity, Modal, ActivityIndicator, StyleSheet, Alert, Platform, ScrollView } from 'react-native';
import { apiFetch } from '../src/api';

const doFetch = async (path, opts = {}) => {
  // On web, use same-origin relative paths so the admin SPA talks to the server that served it.
  if (typeof window !== 'undefined') {
    const headers = Object.assign({}, opts.headers || {});
    try {
      const token = localStorage.getItem('brewski_jwt');
      if (token) headers['Authorization'] = `Bearer ${token}`;
    } catch (e) {}

    // Route admin API calls to the central backend host so web builds (dev or
    // production) always reach the real API instead of any local dev server that
    // might serve HTML. For non-admin paths, use same-origin relative URLs.
    let finalUrl = path;
  try {
  const API_HOST = 'api.brewingremote.com';
      const loc = window.location || {};
      // If this is an admin API path, always target the central API host.
      if (String(path || '').startsWith('/admin/api')) {
        finalUrl = `https://${API_HOST}${path.startsWith('/') ? path : '/' + path}`;
      } else {
        // For other paths (assets or non-admin SPA routes), keep same-origin
        // behavior so the browser requests the files served by the server.
        finalUrl = path;
      }
    } catch (e) { finalUrl = path; }

    const res = await fetch(finalUrl, Object.assign({ headers, method: opts.method || 'GET', body: opts.body ? JSON.stringify(opts.body) : undefined }, {}));
    // If unauthorized, don't force a full-page navigation back to /admin.
    // Instead surface the 401 to the SPA and let the app clear the token and
    // show the login/unauthorized UI. This prevents a fast reload/redirect loop
    // when the server intentionally returns a 401 HTML response for /admin.
    if (res.status === 401) {
      // try to consume any JSON error body first
      let bodyTxt = '';
      try { bodyTxt = await res.text(); } catch (e) {}
      const err = new Error(`HTTP 401 ${bodyTxt}`);
      err.status = 401;
      throw err;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${txt}`);
    }
    return await res.json();
  }
  // Fallback to apiFetch (native) which will route to configured API host
  return await apiFetch(path, opts).then(r => r.json ? r.json() : r);
};

function Row({ item, onEdit }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{item.name} <Text style={styles.rowSlug}>({item.slug})</Text></Text>
        <Text style={styles.rowMeta}>{item.controller_host1 || item.controller_ip || '—'}{item.controller_host2 ? ` / ${item.controller_host2}` : ''}:{item.controller_port || '—'}</Text>
        {item.metadata ? <Text style={styles.rowMeta}>{item.metadata}</Text> : null}
      </View>
      <TouchableOpacity onPress={() => onEdit(item)} style={styles.rowButton}><Text style={{ color:'#1b5e20' }}>Edit</Text></TouchableOpacity>
    </View>
  );
}

export default function AdminPortal() {
  const [user, setUser] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [page, setPage] = useState(0);
  const [limit] = useState(25);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    // load current user (if token present)
    (async () => {
      try {
        const me = await doFetch('/admin/api/me');
        if (me && me.user) setUser(me.user);
      } catch (e) {
        // If the API responded with a 401, clear any stale token and surface
        // the unauthenticated state inside the SPA rather than forcing a
        // full-page navigation. This prevents redirect loops while keeping
        // the admin token persistence when valid.
        try {
            if (e && e.status === 401) {
            try { localStorage.removeItem('brewski_jwt'); } catch (err) {}
            setUser(null);
            try { if (typeof window !== 'undefined') window.dispatchEvent(new Event('brewski:logout')); } catch (err) {}
            return;
          }
        } catch (err) {}
        // otherwise just ignore and allow the SPA to show its message
      }
    })();
  }, []);

  useEffect(() => { loadPage(page); }, [page]);

  async function loadPage(p = 0) {
    setLoading(true);
    try {
      const off = p * limit;
      const res = await doFetch(`/admin/api/customers?limit=${limit}&offset=${off}`);
      if (res && res.customers) {
        setCustomers(res.customers);
        setTotal(res.total || res.customers.length);
      }
    } catch (e) {
      console.error('loadPage error', e && e.message);
      try {
        if (e && e.status === 401) {
          try { localStorage.removeItem('brewski_jwt'); } catch (err) {}
          setUser(null);
          try { if (typeof window !== 'undefined') window.dispatchEvent(new Event('brewski:logout')); } catch (err) {}
          setLoading(false);
          return;
        }
      } catch (err) {}
      Alert.alert('Error', String(e && e.message));
    }
    setLoading(false);
  }

  async function createCustomer(payload) {
    try {
      const res = await doFetch('/admin/api/customers', { method: 'POST', body: payload });
      if (res && res.ok) { setShowCreate(false); setPage(0); loadPage(0); }
    } catch (e) { Alert.alert('Create failed', String(e && e.message)); }
  }

  async function updateCustomer(id, payload) {
    try {
      const res = await doFetch(`/admin/api/customers/${id}`, { method: 'PUT', body: payload });
      if (res && res.ok) { setEditing(null); loadPage(page); }
    } catch (e) { Alert.alert('Update failed', String(e && e.message)); }
  }

  if (loading) return <ActivityIndicator style={{ marginTop: 20 }} />;

  return (
    <View style={{ padding: 12, flex: 1 }}>
      <Text style={{ fontSize: 20, fontWeight: '700', marginBottom: 8 }}>Admin Portal</Text>
      {!user && <Text>Please sign in with an admin account.</Text>}
      {user && Number(user.is_admin) !== 1 && <Text>You are not an admin.</Text>}
      {user && Number(user.is_admin) === 1 && (
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <View style={{ marginBottom: 8 }}><Text>Signed in as: {user.username} ({user.email || 'no email'})</Text></View>
          <View style={{ flexDirection: 'row', marginBottom: 8 }}>
            <TouchableOpacity onPress={() => setShowCreate(true)} style={{ backgroundColor: '#1b5e20', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 }}>
              <Text style={{ color: '#fff' }}>Create Customer</Text>
            </TouchableOpacity>
          </View>
          <FlatList data={customers} keyExtractor={i => String(i.id)} renderItem={({item}) => <Row item={item} onEdit={setEditing} />} style={{ marginTop: 12 }} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
            <Button title="Prev" onPress={() => setPage(Math.max(0, page-1))} disabled={page<=0} />
            <Text style={{ alignSelf: 'center' }}>{page+1} / {Math.max(1, Math.ceil((total||customers.length)/limit))}</Text>
            <Button title="Next" onPress={() => setPage(page+1)} disabled={(page+1)*limit >= (total||customers.length)} />
          </View>
        </ScrollView>
      )}

      <Modal visible={!!editing} animationType="slide">
        {editing && <CustomerEditor initial={editing} onCancel={() => setEditing(null)} onSave={(payload) => updateCustomer(editing.id, payload)} onDeleted={() => { setEditing(null); loadPage(0); }} />}
      </Modal>

      <Modal visible={showCreate} animationType="slide">
        <CustomerEditor onCancel={() => setShowCreate(false)} onSave={(payload) => createCustomer(payload)} />
      </Modal>
    </View>
  );
}

// Generic confirm modal (React-based) so web and native behave the same.
function ConfirmModal({ visible, title, message, onCancel, onConfirm }) {
  return (
    <Modal visible={!!visible} transparent animationType="fade">
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: 320, backgroundColor: '#fff', padding: 16, borderRadius: 8 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', marginBottom: 8 }}>{title || 'Confirm'}</Text>
          <Text style={{ marginBottom: 16 }}>{message || 'Are you sure?'}</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            <TouchableOpacity onPress={onCancel} style={{ paddingHorizontal: 12, paddingVertical: 8, marginRight: 8 }}>
              <Text style={{ color: '#444' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onConfirm} style={{ backgroundColor: '#b71c1c', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 }}>
              <Text style={{ color: '#fff' }}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function CustomerEditor({ initial, onCancel, onSave, onDeleted }) {
  const [slug, setSlug] = useState(initial ? initial.slug : '');
  const [name, setName] = useState(initial ? initial.name : '');
  // New: support two host fields; fall back to legacy controller_ip if present
  const [controller_host1, setControllerHost1] = useState(initial ? (initial.controller_host1 || initial.controller_ip || '') : '');
  const [controller_host2, setControllerHost2] = useState(initial ? (initial.controller_host2 || '') : '');
  // controller_port is managed internally; remove from editable fields
  const [controller_port, setControllerPort] = useState('');
  const [metadata, setMetadata] = useState(initial ? (initial.metadata||'') : '');
  const [users, setUsers] = useState([]);
  const [newUser, setNewUser] = useState({ username: '', password: '', email: '', name: '', is_admin: false });
  const [sensors, setSensors] = useState([]);
  const [newSensorKey, setNewSensorKey] = useState('');
  const [confirm, setConfirm] = useState(null);

  // Reset create-user form when switching to a new customer (create mode)
  useEffect(() => {
    if (!initial) setNewUser({ username: '', password: '', email: '', name: '', is_admin: false });
  }, [initial]);

  async function loadUsers() {
    if (!initial || !initial.id) return;
    try {
      const res = await doFetch(`/admin/api/customers/${initial.id}/users`);
      if (res && res.users) setUsers(res.users);
    } catch (e) { console.error('loadUsers', e && e.message); }
  }

  async function createUser() {
    if (!initial || !initial.id) return;
    try {
      const body = Object.assign({}, newUser);
      const res = await doFetch(`/admin/api/customers/${initial.id}/users`, { method: 'POST', body });
      if (res && res.ok) { setNewUser({ username:'', password:'', email:'', name:'', is_admin:false }); loadUsers(); }
    } catch (e) { Alert.alert('Create user failed', String(e && e.message)); }
  }

  async function loadSensors() {
    if (!initial || !initial.id) return;
    try {
      const res = await doFetch(`/admin/api/customers/${initial.id}/sensors`);
      if (res && res.sensors) setSensors(res.sensors);
    } catch (e) { console.error('loadSensors', e && e.message); setSensors([]); }
  }



  async function createSensor() {
    if (!initial || !initial.id) return;
    try {
      const res = await doFetch(`/admin/api/customers/${initial.id}/sensors`, { method: 'POST', body: { sensor_key: newSensorKey } });
      if (res && res.ok) { setNewSensorKey(''); loadSensors(); }
    } catch (e) { Alert.alert('Create sensor failed', String(e && e.message)); }
  }

  useEffect(() => { loadUsers(); loadSensors(); }, []);


  // Delete user with confirmation (uses React modal)
  async function deleteUser(userId) {
    if (!initial || !initial.id) return;
    setConfirm({
      title: 'Delete User',
      message: 'Are you sure you want to delete this user?',
      onConfirm: async () => {
        try {
          const res = await doFetch(`/admin/api/users/${userId}`, { method: 'DELETE' });
          console.log('deleteUser response', res);
          loadUsers();
          try { Alert.alert('Deleted', 'User deleted'); } catch (e) { if (typeof window !== 'undefined') window.alert('User deleted'); }
        } catch (e) { Alert.alert('Delete failed', String(e && e.message)); }
        setConfirm(null);
      },
      onCancel: () => setConfirm(null)
    });
  }

  // Delete sensor with confirmation
  async function deleteSensor(sensorId) {
    if (!initial || !initial.id) return;
    setConfirm({
      title: 'Delete Sensor',
      message: 'Are you sure you want to delete this sensor?',
      onConfirm: async () => {
        try {
          const res = await doFetch(`/admin/api/customers/${initial.id}/sensors/${sensorId}`, { method: 'DELETE' });
          console.log('deleteSensor response', res);
          loadSensors();
          try { Alert.alert('Deleted', 'Sensor deleted'); } catch (e) { if (typeof window !== 'undefined') window.alert('Sensor deleted'); }
        } catch (e) { Alert.alert('Delete failed', String(e && e.message)); }
        setConfirm(null);
      },
      onCancel: () => setConfirm(null)
    });
  }

  // Delete customer with confirmation
  async function deleteCustomer() {
    if (!initial || !initial.id) return;
    setConfirm({
      title: 'Delete Customer',
      message: 'Are you sure you want to delete this customer and all associated users and sensors? This cannot be undone.',
          onConfirm: async () => {
        try {
          const res = await doFetch(`/admin/api/customers/${initial.id}`, { method: 'DELETE' });
          console.log('deleteCustomer response', res);
          if (onDeleted) onDeleted();
          else if (onCancel) onCancel();
          try { Alert.alert('Deleted', 'Customer deleted'); } catch (e) { if (typeof window !== 'undefined') window.alert('Customer deleted'); }
        } catch (e) { Alert.alert('Delete failed', String(e && e.message)); }
        setConfirm(null);
      },
      onCancel: () => setConfirm(null)
    });
  }

  // Note: confirmation is handled via the React ConfirmModal (state `confirm`).

  async function save() {
    const payload = { slug, name, controller_host1: controller_host1 || null, controller_host2: controller_host2 || null, metadata };
    if (onSave) await onSave(payload);
  }

  return (
    <View style={{ padding: 16, flex: 1 }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 18, fontWeight: '700' }}>{initial ? 'Edit Customer' : 'Create Customer'}</Text>
        <TextInput value={name} onChangeText={setName} placeholder="Name" style={styles.input} />
        <TextInput value={slug} onChangeText={setSlug} placeholder="Slug" style={styles.input} />
        <TextInput value={controller_host1} onChangeText={setControllerHost1} placeholder="Host (primary)" style={styles.input} />
        <TextInput value={controller_host2} onChangeText={setControllerHost2} placeholder="Host (secondary, optional)" style={styles.input} />
        <Text style={{ fontSize: 12, color: '#666', marginTop: 6 }}>Ports are managed internally; leave blank.</Text>
        <TextInput value={metadata} onChangeText={setMetadata} placeholder="Metadata (JSON)" style={[styles.input, styles.metadataInput]} multiline textAlignVertical="top" />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
          <Button title="Cancel" onPress={onCancel} />
          <Button title="Save" onPress={save} />
        </View>
      {/* Users section */}
      {initial && initial.id ? (
        <View style={{ marginTop: 18 }}>
          <Text style={{ fontSize: 16, fontWeight: '700' }}>Users</Text>
          <FlatList data={users} keyExtractor={u => String(u.id)} renderItem={({item}) => (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 }}>
              <Text>{item.username} {item.is_admin ? '(admin)' : ''} — {item.email || 'no email'}</Text>
              <TouchableOpacity onPress={() => deleteUser(item.id)} style={{ marginLeft: 12 }}>
                <Text style={{ color: '#b71c1c' }}>Delete</Text>
              </TouchableOpacity>
            </View>
          )} />
          <Text style={{ marginTop: 8, fontWeight: '600' }}>Create User</Text>
          <TextInput value={newUser.username} onChangeText={t => setNewUser(s => ({...s, username: t}))} placeholder="Username" style={styles.input} />
          <TextInput value={newUser.password} onChangeText={t => setNewUser(s => ({...s, password: t}))} placeholder="Password" style={styles.input} secureTextEntry />
          <TextInput value={newUser.name} onChangeText={t => setNewUser(s => ({...s, name: t}))} placeholder="Full name" style={styles.input} />
          <TextInput value={newUser.email} onChangeText={t => setNewUser(s => ({...s, email: t}))} placeholder="Email" style={styles.input} />
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
            <TouchableOpacity onPress={() => setNewUser(s => ({...s, is_admin: !s.is_admin}))} style={{ marginRight: 8 }}>
              <Text style={{ color: newUser.is_admin ? '#1b5e20' : '#666' }}>{newUser.is_admin ? '☑' : '☐'}</Text>
            </TouchableOpacity>
            <Text>Grant admin privileges</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
            <TouchableOpacity onPress={createUser} style={{ backgroundColor: '#1b5e20', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6 }}>
              <Text style={{ color: '#fff' }}>Create User</Text>
            </TouchableOpacity>
          </View>

          {/* Sensors */}
          <View style={{ marginTop: 18 }}>
            <Text style={{ fontSize: 16, fontWeight: '700' }}>Sensors / Raw Inputs</Text>
            <FlatList data={sensors} keyExtractor={s => String(s.id)} renderItem={({item}) => (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 }}>
                <Text>{item.sensor_key} — {item.metadata || ''}</Text>
                <TouchableOpacity onPress={() => deleteSensor(item.id)} style={{ marginLeft: 12 }}>
                  <Text style={{ color: '#b71c1c' }}>Delete</Text>
                </TouchableOpacity>
              </View>
            )} />
            <TextInput value={newSensorKey} onChangeText={setNewSensorKey} placeholder="Sensor key" style={styles.input} />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
              <TouchableOpacity onPress={createSensor} style={{ backgroundColor: '#1b5e20', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6 }}>
                <Text style={{ color: '#fff' }}>Add Sensor</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Delete customer button */}
          <View style={{ marginTop: 24, alignItems: 'flex-end' }}>
            <TouchableOpacity onPress={deleteCustomer} style={{ backgroundColor: '#b71c1c', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 6 }}>
              <Text style={{ color: '#fff', fontWeight: '700' }}>Delete Customer</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
      {/* Render confirmation modal when requested */}
        {confirm ? (
          <ConfirmModal visible={true} title={confirm.title} message={confirm.message} onCancel={confirm.onCancel} onConfirm={confirm.onConfirm} />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', padding: 8, borderBottomWidth: 1, borderColor: '#eee', alignItems: 'center' },
  rowTitle: { fontWeight: '700' },
  rowSlug: { color: '#666', fontWeight: '400' },
  rowMeta: { color: '#666', fontSize: 12 },
  rowButton: { padding: 8 },
  input: { borderWidth: 1, borderColor: '#ddd', padding: 8, marginTop: 8, borderRadius: 4, backgroundColor: '#fff' },
  metadataInput: { height: 160, minHeight: 120, borderWidth: 1, borderColor: '#ddd', padding: 8, marginTop: 8, borderRadius: 4, backgroundColor: '#fff' }
});
