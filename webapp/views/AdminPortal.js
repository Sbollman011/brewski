import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TextInput, Button, TouchableOpacity, Modal, ActivityIndicator, StyleSheet, Alert, Platform, ScrollView } from 'react-native';
import { apiFetch } from '../src/api';

const doFetchFactory = (tokenProvider) => async (path, opts = {}) => {
  const API_HOST = 'api.brewingremote.com';
  const token = typeof tokenProvider === 'function' ? tokenProvider() : tokenProvider;
  const headers = Object.assign({}, opts.headers || {});
  if (token && !headers['Authorization']) headers['Authorization'] = `Bearer ${token}`;
  if (!headers['Accept']) headers['Accept'] = 'application/json';
  const method = opts.method || 'GET';
  const body = opts.body && method !== 'GET' ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined;

  // Always build absolute URL for /admin/api when not already absolute to avoid HTML SPA responses.
  let finalUrl = path;
  if (typeof path === 'string' && path.startsWith('/admin/api')) {
    finalUrl = `https://${API_HOST}${path}`;
  } else if (typeof path === 'string' && !/^https?:/i.test(path)) {
    // Non admin relative path – leave as-is (same-origin) on web, but on native prefix.
    if (typeof window === 'undefined') {
      finalUrl = `https://${API_HOST}${path.startsWith('/') ? path : '/' + path}`;
    }
  }

  const res = await fetch(finalUrl, { method, headers, body });
  if (res.status === 401) {
    if (token) {
      // Helpful diagnostic only if we *thought* we had a token
      console.warn('doFetch 401 with token present, path=', path);
    }
    let bodyTxt = '';
    try { bodyTxt = await res.text(); } catch (e) {}
    const err = new Error(`HTTP 401 ${bodyTxt || 'unauthorized'}`);
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${txt}`);
  }
  try { return await res.json(); } catch (e) { return {}; }
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

export default function AdminPortal({ currentUser, loadingUser, token }) {
  const doFetch = React.useMemo(() => doFetchFactory(() => token), [token]);
  const [user, setUser] = useState(currentUser || null);
  const [customers, setCustomers] = useState([]);
  const [page, setPage] = useState(0);
  const [limit] = useState(25);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [permissionNotice, setPermissionNotice] = useState(null); // { message, ts }

  // Auto-dismiss permission notice after 5s
  useEffect(() => {
    if (!permissionNotice) return;
    const h = setTimeout(() => setPermissionNotice(null), 5000);
    return () => clearTimeout(h);
  }, [permissionNotice]);

  // Sync prop currentUser into local state when it changes
  useEffect(() => { if (currentUser && (!user || user.id !== currentUser.id)) setUser(currentUser); }, [currentUser]);

  useEffect(() => {
    if (currentUser) return; // parent already provides user
    (async () => {
      try {
        const me = await doFetch('/admin/api/me');
        if (me && me.user) setUser(me.user);
      } catch (e) {
        if (e && e.status === 401) {
          try { localStorage.removeItem('brewski_jwt'); } catch (err) {}
          setUser(null);
          try { if (typeof window !== 'undefined') window.dispatchEvent(new Event('brewski:logout')); } catch (err) {}
        }
      }
    })();
  }, [currentUser]);

  // Load paginated customers ONLY for admins (managers shouldn't call the admin-only endpoint and trigger 401s)
  useEffect(() => {
    if (user && Number(user.is_admin) === 1) {
      loadPage(page);
    }
  }, [page, user]);

  async function loadPage(p = 0) {
    if (!user || Number(user.is_admin) !== 1) return; // managers skip
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
      if (e && e.status === 401) {
        // Only clear token if we expected admin access
        try { localStorage.removeItem('brewski_jwt'); } catch (err) {}
        setUser(null);
        try { if (typeof window !== 'undefined') window.dispatchEvent(new Event('brewski:logout')); } catch (err) {}
        setLoading(false);
        return;
      }
      Alert.alert('Error', String(e && e.message));
    }
    setLoading(false);
  }

  async function createCustomer(payload) {
    try {
      await doFetch('/admin/api/customers', { method: 'POST', body: payload });
      setShowCreate(false); setPage(0); loadPage(0);
    } catch (e) { Alert.alert('Create failed', String(e && e.message)); }
  }

  async function updateCustomer(id, payload) {
    try {
      await doFetch(`/admin/api/customers/${id}`, { method: 'PUT', body: payload });
      setEditing(null); loadPage(page);
    } catch (e) { Alert.alert('Update failed', String(e && e.message)); }
  }

  if (loading) return <ActivityIndicator style={{ marginTop: 20 }} />;

  return (
    <View style={{ padding: 12, flex: 1 }}>
      <Text style={{ fontSize: 20, fontWeight: '700', marginBottom: 8 }}>Admin Portal</Text>
  {!user && !loadingUser && <Text>Please sign in with an admin or manager account.</Text>}
  {!user && loadingUser && <Text style={{ color: '#666' }}>Verifying access…</Text>}
      {user && Number(user.is_admin) === 1 && (
        <FlatList
          data={customers}
          keyExtractor={i => String(i.id)}
          renderItem={({item}) => <Row item={item} onEdit={setEditing} />}
          ListHeaderComponent={(
            <View style={{ paddingBottom: 4 }}>
              <View style={{ marginBottom: 8 }}>
                <Text>Signed in as: {user.username} ({user.email || 'no email'}){user.role ? ` — ${user.role}` : ''}</Text>
              </View>
              <View style={{ flexDirection: 'row', marginBottom: 8 }}>
                <TouchableOpacity onPress={() => setShowCreate(true)} style={{ backgroundColor: '#1b5e20', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 }}>
                  <Text style={{ color: '#fff' }}>Create Customer</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          ListFooterComponent={(
            <View style={{ paddingVertical: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <Button title="Prev" onPress={() => setPage(Math.max(0, page-1))} disabled={page<=0} />
                <Text style={{ alignSelf: 'center' }}>{page+1} / {Math.max(1, Math.ceil((total||customers.length)/limit))}</Text>
                <Button title="Next" onPress={() => setPage(page+1)} disabled={(page+1)*limit >= (total||customers.length)} />
              </View>
            </View>
          )}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}
      {user && Number(user.is_admin) !== 1 && user.role === 'manager' && (
        <View style={{ flex: 1 }}>
          <View style={{ marginBottom: 8 }}>
            <Text>Signed in as: {user.username} ({user.email || 'no email'}){user.role ? ` — ${user.role}` : ''}</Text>
          </View>
          {permissionNotice && (
            <PermissionNotice message={permissionNotice.message} onClose={() => setPermissionNotice(null)} />
          )}
          <ManagerPanel
            user={user}
            doFetch={doFetch}
            onPermissionDenied={(msg) => setPermissionNotice({ message: msg || 'You do not have permission to perform that action.', ts: Date.now() })}
          />
        </View>
      )}
      {user && Number(user.is_admin) !== 1 && user.role !== 'manager' && (
        <View>
          <Text>You do not have access to this portal.</Text>
        </View>
      )}

      <Modal visible={!!editing} animationType="slide">
        {editing && <CustomerEditor doFetch={doFetch} initial={editing} onCancel={() => setEditing(null)} onSave={(payload) => updateCustomer(editing.id, payload)} onDeleted={() => { setEditing(null); loadPage(0); }} />}
      </Modal>

      <Modal visible={showCreate} animationType="slide">
        <CustomerEditor doFetch={doFetch} onCancel={() => setShowCreate(false)} onSave={(payload) => createCustomer(payload)} />
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

function CustomerEditor({ initial, onCancel, onSave, onDeleted, doFetch }) {
  const [slug, setSlug] = useState(initial ? initial.slug : '');
  const [name, setName] = useState(initial ? initial.name : '');
  // New: support two host fields; fall back to legacy controller_ip if present
  const [controller_host1, setControllerHost1] = useState(initial ? (initial.controller_host1 || initial.controller_ip || '') : '');
  const [controller_host2, setControllerHost2] = useState(initial ? (initial.controller_host2 || '') : '');
  // controller_port is managed internally; remove from editable fields
  const [controller_port, setControllerPort] = useState('');
  const [metadata, setMetadata] = useState(initial ? (initial.metadata||'') : '');
  const [users, setUsers] = useState([]);
  const [newUser, setNewUser] = useState({ username: '', password: '', email: '', name: '', role: 'user' });
  const [topics, setTopics] = useState([]);
  const [newTopicKey, setNewTopicKey] = useState('');
  const [confirm, setConfirm] = useState(null);

  // Reset create-user form when switching to a new customer (create mode)
  useEffect(() => {
    if (!initial) setNewUser({ username: '', password: '', email: '', name: '', role: 'user' });
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
      await doFetch(`/admin/api/customers/${initial.id}/users`, { method: 'POST', body });
      setNewUser({ username:'', password:'', email:'', name:'', role: 'user' });
      loadUsers();
    } catch (e) { Alert.alert('Create user failed', String(e && e.message)); }
  }

  async function loadTopics() {
    if (!initial || !initial.id) return;
    try {
      const res = await doFetch(`/admin/api/customers/${initial.id}/topics`);
      if (res && res.topics) setTopics(res.topics);
    } catch (e) { console.error('loadTopics', e && e.message); setTopics([]); }
  }



  async function createTopic() {
    if (!initial || !initial.id) return;
    try {
      await doFetch(`/admin/api/customers/${initial.id}/topics`, { method: 'POST', body: { topic_key: newTopicKey } });
      setNewTopicKey('');
      loadTopics();
    } catch (e) { Alert.alert('Create topic failed', String(e && e.message)); }
  }

  useEffect(() => { loadUsers(); loadTopics(); }, []);


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
  async function deleteTopic(topicId) {
    if (!initial || !initial.id) return;
    setConfirm({
      title: 'Delete Topic',
      message: 'Are you sure you want to delete this topic?',
      onConfirm: async () => {
        try {
          const res = await doFetch(`/admin/api/customers/${initial.id}/topics/${topicId}`, { method: 'DELETE' });
          console.log('deleteTopic response', res);
          loadTopics();
          try { Alert.alert('Deleted', 'Topic deleted'); } catch (e) { if (typeof window !== 'undefined') window.alert('Topic deleted'); }
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
              <Text>{item.username} {item.role ? `(${item.role})` : ''} — {item.email || 'no email'}</Text>
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
          {/* Role picker: allow admin to assign 'user', 'privileged', or 'admin' */}
          <View style={{ marginTop: 8 }}>
            <Text style={{ marginBottom: 6 }}>Role</Text>
            <View style={{ flexDirection: 'row' }}>
              {['user','privileged','manager','admin'].map(r => (
                <TouchableOpacity key={r} onPress={() => setNewUser(s => ({ ...s, role: r }))} style={{ marginRight: 12 }}>
                  <Text style={{ color: newUser.role === r ? '#1b5e20' : '#666' }}>{newUser.role === r ? '☑' : '☐'} {r}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          {/* Admin status is determined by selecting the 'admin' role above; no direct toggle here. */}
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
            <TouchableOpacity onPress={createUser} style={{ backgroundColor: '#1b5e20', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6 }}>
              <Text style={{ color: '#fff' }}>Create User</Text>
            </TouchableOpacity>
          </View>

          {/* Sensors */}
          <View style={{ marginTop: 18 }}>
            <Text style={{ fontSize: 16, fontWeight: '700' }}>Topics</Text>
            <FlatList data={topics} keyExtractor={s => String(s.id)} renderItem={({item}) => (
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 }}>
                <Text>{item.topic_key || item.sensor_key || item.key} — {item.metadata || ''}</Text>
                <TouchableOpacity onPress={() => deleteTopic(item.id)} style={{ marginLeft: 12 }}>
                  <Text style={{ color: '#b71c1c' }}>Delete</Text>
                </TouchableOpacity>
              </View>
            )} />
            <TextInput value={newTopicKey} onChangeText={setNewTopicKey} placeholder="Topic key" style={styles.input} />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
              <TouchableOpacity onPress={createTopic} style={{ backgroundColor: '#1b5e20', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6 }}>
                <Text style={{ color: '#fff' }}>Add Topic</Text>
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

function ManagerPanel({ user, doFetch, onPermissionDenied }) {
  const [users, setUsers] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [newUser, setNewUser] = useState({ username: '', password: '', email: '', name: '' });

  async function load() {
    if (!user || !user.customer_id) return;
    if (!doFetch) { console.warn('ManagerPanel missing doFetch'); return; }
    try {
      const ures = await doFetch(`/admin/api/customers/${user.customer_id}/users`);
      if (ures && ures.users) setUsers(ures.users);
    } catch (e) { console.error('manager load users', e && e.message); }
    try {
      const cres = await doFetch(`/admin/api/customers/${user.customer_id}`);
      if (cres && cres.customer) setCustomer(cres.customer);
    } catch (e) { console.error('manager load customer', e && e.message); }
  }

  useEffect(() => { load(); }, []);

  async function createUser() {
    if (!user || !user.customer_id) return;
    if (!doFetch) { console.warn('ManagerPanel createUser missing doFetch'); return; }
    try {
      const body = { ...newUser, role: 'user' };
      await doFetch(`/admin/api/customers/${user.customer_id}/users`, { method: 'POST', body });
      setNewUser({ username:'', password:'', email:'', name: '' });
      load();
    } catch (e) { Alert.alert('Create user failed', String(e && e.message)); }
  }

  async function deleteUser(id) {
    if (!doFetch) { console.warn('ManagerPanel deleteUser missing doFetch'); return; }
    try {
      await doFetch(`/admin/api/users/${id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      if (e && e.status === 401) {
        if (onPermissionDenied) onPermissionDenied('You do not have permission to delete this user.');
      } else {
        Alert.alert('Delete failed', String(e && e.message));
      }
    }
  }

  return (
    <View>
      <Text style={{ fontSize: 16, fontWeight: '700' }}>{customer ? customer.name : 'Manager Console'}</Text>
      <Text style={{ marginTop: 8 }}>
        {customer ? `Manage users for ${customer.name} (ID: ${customer.id})` : `Manage users for your customer (ID: ${user.customer_id})`}
      </Text>
      <FlatList data={users} keyExtractor={u => String(u.id)} renderItem={({item}) => (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 }}>
          <Text>{item.username} {item.role ? `(${item.role})` : ''} — {item.email || 'no email'}</Text>
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
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
        <TouchableOpacity onPress={createUser} style={{ backgroundColor: '#1b5e20', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6 }}>
          <Text style={{ color: '#fff' }}>Create User</Text>
        </TouchableOpacity>
      </View>
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
  metadataInput: { height: 160, minHeight: 120, borderWidth: 1, borderColor: '#ddd', padding: 8, marginTop: 8, borderRadius: 4, backgroundColor: '#fff' },
  noticeWrap: { marginBottom: 10 },
  noticeBox: { backgroundColor: '#fdecea', borderColor: '#f5c2c0', borderWidth: 1, padding: 10, borderRadius: 6, flexDirection: 'row', alignItems: 'center' },
  noticeText: { flex: 1, color: '#8a1c13', fontSize: 13 },
  noticeClose: { marginLeft: 12, paddingHorizontal: 6, paddingVertical: 2 },
  noticeCloseText: { color: '#8a1c13', fontWeight: '700', fontSize: 12 }
});

function PermissionNotice({ message, onClose }) {
  return (
    <View style={styles.noticeWrap}>
      <View style={styles.noticeBox}>
        <Text style={styles.noticeText}>{message || 'Permission denied.'}</Text>
        <TouchableOpacity onPress={onClose} accessibilityLabel="Dismiss permission notice" style={styles.noticeClose}>
          <Text style={styles.noticeCloseText}>×</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
