import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TextInput, Button, TouchableOpacity, Modal, ActivityIndicator, StyleSheet, Alert, Platform, ScrollView } from 'react-native';
import Header from '../components/Header';
// Accessible placeholder color (sufficient contrast on light backgrounds on mobile & web)
const PLACEHOLDER_COLOR = '#555';
import { apiFetch } from '../src/api';

// Toggle verbose debug logging for local troubleshooting. Set to true only when
// actively debugging; keep false in normal use to avoid noisy console output.
const DEBUG = false;

const doFetchFactory = (tokenProvider) => async (path, opts = {}) => {
  const API_HOST = 'api.brewingremote.com';
  const token = typeof tokenProvider === 'function' ? tokenProvider() : tokenProvider;
  const headers = Object.assign({}, opts.headers || {});
  if (token && !headers['Authorization']) headers['Authorization'] = `Bearer ${token}`;
  if (!headers['Accept']) headers['Accept'] = 'application/json';
  const method = opts.method || 'GET';
  const body = opts.body && method !== 'GET' ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined;

  // Build URL for admin paths. In browser contexts prefer same-origin relative paths
  // to avoid cross-origin requests and CORS issues. For native (no `window`) use the
  // configured API_HOST absolute URL.
  let finalUrl = path;
  if (typeof path === 'string' && (path.startsWith('/admin/api') || path.startsWith('/api/'))) {
    if (typeof window !== 'undefined') {
      // Browser: if the page is served from the API host already, use relative path.
      // Otherwise, call the API host directly so requests reach the real server.
      try {
        const pageHost = (window.location && window.location.hostname) ? window.location.hostname : null;
        if (pageHost && pageHost.toLowerCase() === API_HOST.toLowerCase()) {
          finalUrl = path; // same host
        } else {
          finalUrl = `https://${API_HOST}${path}`; // call API host directly (cross-origin)
        }
      } catch (e) {
        finalUrl = `https://${API_HOST}${path}`;
      }
    } else {
      // Native/Server: build absolute URL to the API host
      finalUrl = `https://${API_HOST}${path}`;
    }
  } else if (typeof path === 'string' && !/^https?:/i.test(path)) {
    // Non-admin relative path – leave as-is (same-origin) on web. On native, prefix the API host.
    if (typeof window === 'undefined') {
      finalUrl = `https://${API_HOST}${path.startsWith('/') ? path : '/' + path}`;
    }
  }

  // Use CORS mode when calling an absolute API host from a browser to ensure proper preflight
  const fetchOpts = { method, headers, body };
  try {
    if (typeof window !== 'undefined' && typeof finalUrl === 'string' && finalUrl.toLowerCase().indexOf(API_HOST.toLowerCase()) !== -1) {
      fetchOpts.mode = 'cors';
    }
  } catch (e) {}
  const res = await fetch(finalUrl, fetchOpts);
  if (res.status === 401) {
    if (token && DEBUG) {
      // Helpful diagnostic only when verbose debugging is enabled
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
    if (DEBUG) console.error('doFetch non-ok response', { url: finalUrl, status: res.status, body: txt });
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
      if (DEBUG) console.error('loadPage error', e && e.message);
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
        {editing && <CustomerEditor token={token} doFetch={doFetch} initial={editing} onCancel={() => setEditing(null)} onSave={(payload) => updateCustomer(editing.id, payload)} onDeleted={() => { setEditing(null); loadPage(0); }} />}
      </Modal>

      <Modal visible={showCreate} animationType="slide">
        <CustomerEditor token={token} doFetch={doFetch} onCancel={() => setShowCreate(false)} onSave={(payload) => createCustomer(payload)} />
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

function CustomerEditor({ initial, onCancel, onSave, onDeleted, doFetch, token }) {
  // Power label state
  const [powerStates, setPowerStates] = useState([]); // [{ topic, powerKeys: { POWER1: 'ON', ... }, labels: { POWER1: 'Pump', ... } }]
  const [powerLabels, setPowerLabels] = useState({}); // { topic|powerKey: label }
  const [loadingPower, setLoadingPower] = useState(false);

  // Provide Authorization header for same-origin window.fetch attempts
  const getAuthHeader = () => {
    try {
      let t = token;
      if ((!t || t === '') && typeof localStorage !== 'undefined') {
        t = localStorage.getItem('brewski_jwt');
      }
      if (t) return { Authorization: `Bearer ${t}` };
    } catch (e) { /* ignore */ }
    return {};
  };

  // Produce a set of canonical candidate keys for a topic so label lookups
  // behave the same as the Dashboard canonicalization. Return an array of
  // topic strings (without the "|POWERx" suffix). Consumers will append
  // the power key as needed.
  const canonicalCandidatesForTopic = (topic) => {
    if (!topic) return [];
    const candidates = new Set();
    try {
      candidates.add(topic);
      candidates.add(topic.toUpperCase());

      // tele/<cust>/<device>/STATE -> tele/<device>/STATE (legacy)
      const m = topic.match(/^tele\/([^/]+)\/([^/]+)\/STATE$/i);
      if (m) {
        const device = m[2];
        candidates.add(`tele/${device}/STATE`);
        candidates.add(`tele/${device}/STATE`.toUpperCase());
      }

      // Swap common customer tokens RAIL <-> BREW
      if (/\/RAIL\//i.test(topic)) {
        candidates.add(topic.replace(/\/RAIL\//i, '/BREW/'));
        candidates.add(topic.replace(/\/RAIL\//i, '/BREW/').toUpperCase());
      } else if (/\/BREW\//i.test(topic)) {
        candidates.add(topic.replace(/\/BREW\//i, '/RAIL/'));
        candidates.add(topic.replace(/\/BREW\//i, '/RAIL/').toUpperCase());
      }

      // Try topic without leading tele/
      if (/^tele\//i.test(topic)) {
        const noTele = topic.replace(/^tele\//i, '');
        candidates.add(noTele);
        candidates.add(noTele.toUpperCase());
      }
    } catch (e) {
      // swallow
    }
    return Array.from(candidates);
  };

  // Flexible lookup for label variants — topics may be stored with/without "tele/",
  // with different customer prefixes (RAIL vs BREW), or with different case. Try a
  // set of likely permutations and return the first non-empty label found.
  const lookupPowerLabel = (topic, powerKey) => {
    if (!topic || !powerKey) return '';
    const upKey = powerKey.toUpperCase();
    // Build candidates by combining canonical topic variants with both key cases
    const topicCandidates = canonicalCandidatesForTopic(topic);
    for (const t of topicCandidates) {
      const rawKey = `${t}|${powerKey}`;
      const upKeyRaw = `${t}|${upKey}`;
      if (powerLabels[rawKey] && String(powerLabels[rawKey]).trim()) return String(powerLabels[rawKey]).trim();
      if (powerLabels[upKeyRaw] && String(powerLabels[upKeyRaw]).trim()) return String(powerLabels[upKeyRaw]).trim();
    }
    // As a last resort, try original topic with both key casings
    const trial1 = `${topic}|${powerKey}`;
    const trial2 = `${topic}|${upKey}`;
    if (powerLabels[trial1] && String(powerLabels[trial1]).trim()) return String(powerLabels[trial1]).trim();
    if (powerLabels[trial2] && String(powerLabels[trial2]).trim()) return String(powerLabels[trial2]).trim();
    return '';
  };

  // Fetch latest STATE topics and power labels
  async function loadPowerLabelsAndStates() {
    if (!initial) return;
    setLoadingPower(true);
    try {
      // We'll primarily fetch power-labels from the server and surface them
      // in the editor. Relying on `/api/latest` for STATE rows fails when the
      // caller (admin) is viewing another customer's page and the public
      // snapshot is scoped to the logged-in user's tenant. Instead derive
      // editable rows from stored power-labels (which are global/admin-scoped)
      // and show any STATE topics we can discover.
      // Get all customer slugs for mapping (best-effort)
      let customerSlugs = [];
      try {
        const custRes = await doFetch('/admin/api/customers');
        if (custRes && custRes.customers) customerSlugs = custRes.customers.map(c => c.slug);
      } catch (e) {}

      // 1) Fetch all power labels for this customer (preferred). We'll try admin
      // and public endpoints using existing attempts below and then build rows
      // from the returned labels so admins can edit labels even when /api/latest
      // doesn't include the customer's STATE topics.
      // For admins editing a specific customer, request labels for that customer.
      // Support either numeric customer_id or customer_slug. Prefer same-origin
      // fetches (reduces CORS/tunnel exposure), then try admin endpoint
      // and finally public /api if needed.
      if (DEBUG) console.log(`AdminPortal: Fetching power labels for customer id=${initial.id} slug=${initial.slug}`);
      let labelRes = null;
      const tryAdmin = async (q) => {
        try {
          const path = q ? `/admin/api/power-labels?${q}` : `/admin/api/power-labels`;
          return await doFetch(path);
        } catch (e) { throw e; }
      };
      const tryPublic = async (q) => {
        try {
          const path = q ? `/api/power-labels?${q}` : `/api/power-labels`;
          return await doFetch(path);
        } catch (e) { throw e; }
      };

      const qById = initial.id ? `customer_id=${encodeURIComponent(initial.id)}` : null;
      const qBySlug = initial.slug ? `customer_slug=${encodeURIComponent(initial.slug)}` : null;

      // First try same-origin browser fetches (if available) to avoid cross-origin
      // tunnel/CORS problems. This will succeed when the webapp is served from the
      // API host directly (preferred for admin sessions).
      if (typeof window !== 'undefined') {
        try {
          // Try admin unfiltered first (admins can see all labels)
          const r0 = await window.fetch(`/admin/api/power-labels`, { credentials: 'same-origin', headers: Object.assign({ Accept: 'application/json' }, getAuthHeader()) });
          if (r0 && r0.ok) labelRes = await r0.json();
        } catch (e) { if (DEBUG) console.warn('AdminPortal: same-origin admin unfiltered failed', e && e.message); }
        try {
          if (!labelRes && qById) {
            const r1 = await window.fetch(`/admin/api/power-labels?${qById}`, { credentials: 'same-origin', headers: Object.assign({ Accept: 'application/json' }, getAuthHeader()) });
            if (r1 && r1.ok) labelRes = await r1.json();
          }
        } catch (e) { if (DEBUG) console.warn('AdminPortal: same-origin admin?id fetch failed', e && e.message); }
        try {
          if (!labelRes && qBySlug) {
            const r2 = await window.fetch(`/admin/api/power-labels?${qBySlug}`, { credentials: 'same-origin', headers: Object.assign({ Accept: 'application/json' }, getAuthHeader()) });
            if (r2 && r2.ok) labelRes = await r2.json();
          }
        } catch (e) { if (DEBUG) console.warn('AdminPortal: same-origin admin?slug fetch failed', e && e.message); }
      }

      // If same-origin didn't yield results, fall back to cross-origin attempts
      if (!labelRes) {
        const attempts = [];
        attempts.push(() => tryAdmin(null));
        if (qById) attempts.push(() => tryAdmin(qById));
        if (qBySlug) attempts.push(() => tryAdmin(qBySlug));
        if (qById) attempts.push(() => tryPublic(qById));
        if (qBySlug) attempts.push(() => tryPublic(qBySlug));
        for (const fn of attempts) {
          try {
            labelRes = await fn();
            if (labelRes) break;
          } catch (e) {
            if (DEBUG) console.warn('AdminPortal: power-label attempt failed', e && e.message);
            labelRes = null;
          }
        }
      }
      const labelMap = {};
      if (labelRes && labelRes.labels) {
        if (DEBUG) console.log(`AdminPortal: Received ${labelRes.labels.length} power labels`, labelRes.labels);
        labelRes.labels.forEach(l => {
          const key = `${l.topic}|${l.power_key}`;
          labelMap[key] = l.label;
          labelMap[key.toUpperCase()] = l.label;
          try {
            const candidates = canonicalCandidatesForTopic(l.topic);
            candidates.forEach(t => {
              const k1 = `${t}|${l.power_key}`;
              const k2 = `${t}|${l.power_key.toUpperCase()}`;
              if (!labelMap[k1]) labelMap[k1] = l.label;
              if (!labelMap[k2]) labelMap[k2] = l.label;
              if (!labelMap[`${t.toUpperCase()}|${l.power_key}`]) labelMap[`${t.toUpperCase()}|${l.power_key}`] = l.label;
              if (!labelMap[`${t.toUpperCase()}|${l.power_key.toUpperCase()}`]) labelMap[`${t.toUpperCase()}|${l.power_key.toUpperCase()}`] = l.label;
            });
          } catch (e) {}
        });
      } else {
        if (DEBUG) console.log('AdminPortal: No power labels received or invalid response:', labelRes);
      }

      // If the sensors snapshot didn't include STATE topics for this customer
      // (common when admin is viewing another tenant), derive editable rows
      // from the label records themselves so admins can edit labels for any
      // customer. Group labels by topic and expose the power_key slots.
      const topicToKeys = {};
      if (labelRes && Array.isArray(labelRes.labels)) {
        // prepare case-insensitive known slugs for robust matching
        const knownSlugsLower = (customerSlugs || []).map(s => String(s || '').toLowerCase());
        const initialSlugLower = initial && initial.slug ? String(initial.slug).toLowerCase() : '';
        for (const l of labelRes.labels) {
          try {
            if (!l || !l.topic) continue;
            const t = l.topic;
            // only consider STATE topics (where labels are meaningful)
            if (!/\/STATE$/i.test(t)) continue;
            // determine assigned customer from topic (level 2)
            const parts = t.split('/');
            let slug = parts.length >= 2 ? parts[1] : 'BREW';
            const slugLower = String(slug || '').toLowerCase();

            // If the second-level token doesn't match any known customer slug
            // and we're editing the BREW customer, treat it as BREW so that
            // non-standard topics (the BREW customer's edge case) surface
            // in the editor. This avoids losing labels when the org token is
            // missing or malformed.
            if (knownSlugsLower.length > 0 && knownSlugsLower.indexOf(slugLower) === -1) {
              if (initialSlugLower === 'brew') {
                slug = 'BREW';
              }
            }

            // final comparison should be case-insensitive
            if (String(slug || '').toLowerCase() !== initialSlugLower) continue;
            if (!topicToKeys[t]) topicToKeys[t] = {};
            topicToKeys[t][l.power_key] = '';
          } catch (e) {}
        }
      }

      // Build powerRows from topicToKeys
      const merged = Object.keys(topicToKeys).map(topic => ({ topic, powerKeys: topicToKeys[topic], assignedCustomer: initial.slug, labels: Object.keys(topicToKeys[topic]).reduce((acc, pk) => ({ ...acc, [pk]: labelMap[`${topic}|${pk}`] || labelMap[`${topic}|${pk.toUpperCase()}`] || '' }), {}) }));
      setPowerStates(merged);
      setPowerLabels(labelMap);
    } catch (e) { setPowerStates([]); setPowerLabels({}); }
    setLoadingPower(false);
  }

  // Save a label
  async function savePowerLabel(topic, powerKey, label) {
    try {
      // Prefer admin API; fall back to public API if admin is not accessible to this caller
      const bodyById = initial && initial.id ? { topic, power_key: powerKey, label, customer_id: initial.id } : null;
      const bodyBySlug = initial && initial.slug ? { topic, power_key: powerKey, label, customer_slug: initial.slug } : null;
      let saved = false;
      const tryPost = async (path, body) => {
        try { await doFetch(path, { method: 'POST', body }); return true; } catch (e) { if (DEBUG) console.warn('AdminPortal: post failed', path, e && e.message); return false; }
      };

      if (bodyById) saved = await tryPost('/admin/api/power-labels', bodyById);
      if (!saved && bodyBySlug) saved = await tryPost('/admin/api/power-labels', bodyBySlug);
      if (!saved && bodyById) saved = await tryPost('/api/power-labels', bodyById);
      if (!saved && bodyBySlug) saved = await tryPost('/api/power-labels', bodyBySlug);

      // Final attempt: try same-origin relative POSTs when running in browser
      // (try same-origin BEFORE cross-origin to avoid proxy/CORS races).
      if (!saved && typeof window !== 'undefined') {
        try {
          if (bodyById) {
            const r = await window.fetch('/admin/api/power-labels', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, getAuthHeader()), body: JSON.stringify(bodyById), credentials: 'same-origin' });
            if (r && r.ok) saved = true;
          }
        } catch (e) { if (DEBUG) console.warn('AdminPortal: same-origin admin post failed', e && e.message); }
        try {
          if (!saved && bodyBySlug) {
            const r2 = await window.fetch('/admin/api/power-labels', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, getAuthHeader()), body: JSON.stringify(bodyBySlug), credentials: 'same-origin' });
            if (r2 && r2.ok) saved = true;
          }
        } catch (e) { if (DEBUG) console.warn('AdminPortal: same-origin admin slug post failed', e && e.message); }
      }

      // If same-origin didn't work, fall back to doFetch cross-origin posts (already attempted earlier)

      // If any POST path appeared to succeed we still verify by fetching the authoritative labels.
      const verifySaved = async () => {
        try {
          const q = initial && initial.id ? `customer_id=${encodeURIComponent(initial.id)}&topic=${encodeURIComponent(topic)}` : (initial && initial.slug ? `customer_slug=${encodeURIComponent(initial.slug)}&topic=${encodeURIComponent(topic)}` : `topic=${encodeURIComponent(topic)}`);
          let labelRes = null;
          // reuse same attempt strategy used elsewhere
          const attempts = [
            () => doFetch(`/admin/api/power-labels?${q}`),
            () => doFetch(`/api/power-labels?${q}`)
          ];
          for (const fn of attempts) {
            try { labelRes = await fn(); if (labelRes) break; } catch (e) { if (DEBUG) console.warn('verifySaved attempt failed', e && e.message); labelRes = null; }
          }
          if (!labelRes && typeof window !== 'undefined') {
            try {
              const r = await window.fetch(`/admin/api/power-labels?${q}`, { credentials: 'same-origin', headers: Object.assign({ Accept: 'application/json' }, getAuthHeader()) });
              if (r && r.ok) labelRes = await r.json();
            } catch (e) { if (DEBUG) console.warn('verifySaved same-origin fetch failed', e && e.message); }
          }
          if (labelRes && Array.isArray(labelRes.labels)) {
            // find matching label for our power_key
            const found = labelRes.labels.find(l => String(l.topic) === String(topic) && String(l.power_key).toUpperCase() === String(powerKey).toUpperCase());
            if (found) {
              // consider saved if server stored the same label value (or any value)
              return String(found.label || '').trim() === String(label || '').trim() || String(found.label || '').trim().length > 0;
            }
          }
        } catch (e) { if (DEBUG) console.warn('verifySaved unexpected error', e && e.message); }
        return false;
      };

      const verified = saved ? await verifySaved() : await verifySaved();
      if (!verified) {
        // If verification failed, warn but still update local cache optimistically so UI isn't blocked.
        if (DEBUG) console.warn('AdminPortal: save not verified for', topic, powerKey, label);
        // Optimistic update
        setPowerLabels(l => ({ ...l, [`${topic}|${powerKey}`]: label }));
        // Kick off a background refresh attempt and inform the user
        try { await loadPowerLabelsAndStates(); } catch (e) {}
        Alert.alert('Save may have failed', 'The server did not confirm the save immediately. It may have succeeded; the UI will refresh shortly.');
        return;
      }

      // Verified: Update local cache under canonical variants so other views (Dashboard)
      // can immediately pick up the label regardless of stored topic formatting.
      setPowerLabels(l => {
        const next = { ...l };
        const upKey = powerKey.toUpperCase();
        // expand into all canonical topic candidates
        try {
          const candidates = canonicalCandidatesForTopic(topic);
          candidates.forEach(t => {
            next[`${t}|${powerKey}`] = label;
            next[`${t}|${upKey}`] = label;
            // Uppercased topic variant as well
            next[`${t.toUpperCase()}|${powerKey}`] = label;
            next[`${t.toUpperCase()}|${upKey}`] = label;
          });
        } catch (e) {
          // fallback to a few common variants
          next[`${topic}|${powerKey}`] = label;
          next[`${topic}|${upKey}`] = label;
          next[`${topic.toUpperCase()}|${powerKey}`] = label;
          next[`${topic.toUpperCase()}|${upKey}`] = label;
        }
        return next;
      });
      // Refresh authoritative labels from server so UI stays accurate and in-sync.
      try { await loadPowerLabelsAndStates(); } catch (e) { /* best-effort */ }
    } catch (e) {
      if (DEBUG) console.error('savePowerLabel final error', e && e.message);
      Alert.alert('Save failed', String(e && e.message));
    }
  }

  useEffect(() => { loadUsers(); loadTopics(); loadPowerLabelsAndStates(); }, []);
  // Also reload power labels/states whenever the selected customer changes
  useEffect(() => {
    if (initial) loadPowerLabelsAndStates();
  }, [initial && initial.id, initial && initial.slug]);
  const [slug, setSlug] = useState(initial ? initial.slug : '');
  const [name, setName] = useState(initial ? initial.name : '');
  // New: support two host fields; fall back to legacy controller_ip if present
  const [controller_host1, setControllerHost1] = useState(initial ? (initial.controller_host1 || initial.controller_ip || '') : '');
  const [controller_host2, setControllerHost2] = useState(initial ? (initial.controller_host2 || '') : '');
  // controller_port managed internally; removed from UI
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
    if (!initial) return;
    try {
      let res;
      // If we have a numeric id, use the per-customer path. Otherwise fall back
      // to a slug-based query so the mobile app (or proxies) can load users
      // even when the numeric id is not present.
      if (initial && initial.id && Number(initial.id) && !Number.isNaN(Number(initial.id))) {
        res = await doFetch(`/admin/api/customers/${initial.id}/users`);
      } else if (initial && initial.slug) {
        const q = `customer_slug=${encodeURIComponent(initial.slug)}`;
        res = await doFetch(`/admin/api/customers/users?${q}`);
      }
      if (res && res.users) setUsers(res.users);
    } catch (e) { if (DEBUG) console.error('loadUsers', e && e.message); }
  }

  async function createUser() {
    if (!initial) return;
    try {
      const body = Object.assign({}, newUser);
      // Prefer per-customer path when we have a numeric id. Otherwise POST
      // to the generic customers/users endpoint including customer_slug in
      // the body so the server can associate the new user with the correct
      // customer record.
      if (initial && initial.id && Number(initial.id) && !Number.isNaN(Number(initial.id))) {
        await doFetch(`/admin/api/customers/${initial.id}/users`, { method: 'POST', body });
      } else if (initial && initial.slug) {
        const bodyWithSlug = { ...body, customer_slug: initial.slug };
        await doFetch(`/admin/api/customers/users`, { method: 'POST', body: bodyWithSlug });
      } else {
        // No id or slug: attempt a best-effort POST to generic endpoint and hope
        // the server can infer association (not ideal but better than failing silently).
        await doFetch(`/admin/api/customers/users`, { method: 'POST', body });
      }
      setNewUser({ username:'', password:'', email:'', name:'', role: 'user' });
      loadUsers();
    } catch (e) { Alert.alert('Create user failed', String(e && e.message)); }
  }

  async function loadTopics() {
    if (!initial || !initial.id) return;
    try {
      // If initial.id looks numeric, use the per-customer path. Otherwise fallback
      // to the generic topics endpoint and filter by customer_slug to avoid
      // POSTing/GETting to /admin/api/customers/default/topics which the server
      // rejects with 400 when 'default' is not a numeric id.
      let res;
      if (initial && initial.id && Number(initial.id) && !Number.isNaN(Number(initial.id))) {
        res = await doFetch(`/admin/api/customers/${initial.id}/topics`);
      } else {
        // use generic endpoint and pass slug as query param
        const slug = initial && initial.slug ? encodeURIComponent(initial.slug) : '';
        res = await doFetch(`/admin/api/customers/topics?customer_slug=${slug}`);
      }
      if (res && res.topics) setTopics(res.topics);
    } catch (e) { if (DEBUG) console.error('loadTopics', e && e.message); setTopics([]); }
  }



  async function createTopic() {
    if (!initial || !initial.id) return;
    try {
      // Prefer per-customer path when we have a numeric id. Otherwise POST to
      // the generic topics endpoint and include customer_slug so server can
      // associate the topic correctly (avoids 400 for slug-like ids such as 'default').
      let attemptedPath, attemptedBody;
      if (initial && initial.id && Number(initial.id) && !Number.isNaN(Number(initial.id))) {
        attemptedPath = `/admin/api/customers/${initial.id}/topics`;
        attemptedBody = { topic_key: newTopicKey };
        await doFetch(attemptedPath, { method: 'POST', body: attemptedBody });
      } else {
        attemptedPath = `/admin/api/customers/topics`;
        attemptedBody = { topic_key: newTopicKey, customer_slug: initial && initial.slug ? initial.slug : undefined };
        await doFetch(attemptedPath, { method: 'POST', body: attemptedBody });
      }
      setNewTopicKey('');
      loadTopics();
    } catch (e) {
      try { console.warn('AdminPortal.createTopic failed', { attemptedPath, attemptedBody, error: (e && e.message) || e }); } catch (er) {}
      Alert.alert('Create topic failed', String(e && e.message));
    }
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
          if (DEBUG) console.log('deleteUser response', res);
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
          // Use per-customer delete when id is numeric; otherwise attempt
          // generic delete path to avoid malformed URLs like /admin/api/customers/default/topics/...
          let res;
          if (initial && initial.id && Number(initial.id) && !Number.isNaN(Number(initial.id))) {
            res = await doFetch(`/admin/api/customers/${initial.id}/topics/${topicId}`, { method: 'DELETE' });
          } else {
            res = await doFetch(`/admin/api/customers/topics/${topicId}`, { method: 'DELETE' });
          }
          if (DEBUG) console.log('deleteTopic response', res);
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
            if (DEBUG) console.log('deleteCustomer response', res);
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

  const roleColorNeutral = '#1b5e20';
  // In create mode we previously hid header+menu; now we still hide header for create mode, but SideMenu is removed.
  const showNav = !!initial; // only show header when editing existing customer
  return (
    <View style={{ flex: 1, backgroundColor: '#fafafa' }}>
      {showNav && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, marginLeft: 8 }}>
          <TouchableOpacity onPress={onCancel} accessibilityLabel="Back to Customers" style={{ marginRight: 12, padding: 4 }}>
            <Text style={{ fontSize: 24, color: '#1b5e20', fontWeight: '700' }}>{'←'}</Text>
          </TouchableOpacity>
          <Header
            title={initial ? 'Edit Customer' : 'Create Customer'}
            token={token}
            hideControls={true}
            onLogoutPress={() => { try { localStorage.removeItem('brewski_jwt'); if (typeof window !== 'undefined') window.dispatchEvent(new Event('brewski:logout')); } catch (e) {} if (onCancel) onCancel(); }}
            onLoginPress={() => { try { if (typeof window !== 'undefined') window.location.href = '/'; } catch (e) {} }}
          />
        </View>
      )}
      <ScrollView
        contentContainerStyle={styles.editorScroll}
        keyboardShouldPersistTaps="handled"
        accessibilityElementsHidden={false}
        importantForAccessibility='auto'
      >
        <View style={[styles.formCard, !showNav && { marginTop: 12 }] }>
          <Text style={styles.sectionTitle}>{initial ? 'Edit Customer' : 'Create Customer'}</Text>
          <TextInput value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={PLACEHOLDER_COLOR} style={styles.input} />
          <TextInput value={slug} onChangeText={setSlug} placeholder="Slug" placeholderTextColor={PLACEHOLDER_COLOR} style={styles.input} />
          <TextInput value={controller_host1} onChangeText={setControllerHost1} placeholder="Host (primary)" placeholderTextColor={PLACEHOLDER_COLOR} style={styles.input} />
          <TextInput value={controller_host2} onChangeText={setControllerHost2} placeholder="Host (secondary, optional)" placeholderTextColor={PLACEHOLDER_COLOR} style={styles.input} />
          <Text style={styles.inlineHint}>Ports are managed internally; leave blank.</Text>
          <TextInput value={metadata} onChangeText={setMetadata} placeholder="Metadata (JSON)" placeholderTextColor={PLACEHOLDER_COLOR} style={[styles.input, styles.metadataInput]} multiline textAlignVertical="top" />
        </View>
        {/* Move Save/Cancel to bottom, add Back button */}
        <View style={[styles.actionRow, { marginTop: 24, marginBottom: 8 }] }>
          <TouchableOpacity onPress={onCancel} style={[styles.btn, styles.btnSecondary]}><Text style={styles.btnSecondaryText}>Cancel</Text></TouchableOpacity>
          <TouchableOpacity onPress={save} style={[styles.btn, styles.btnPrimary]}><Text style={styles.btnPrimaryText}>Save</Text></TouchableOpacity>
        </View>
  {initial && initial.id ? (
          <View style={styles.sectionBlock}>
            <Text style={styles.sectionTitle}>Users ({users.length})</Text>
            <View style={styles.tableHeader}>
              <Text style={[styles.th, {flex:2}]}>User</Text>
              <Text style={[styles.th, {flex:1}]}>Role</Text>
              <Text style={[styles.th, {flex:2}]}>Email</Text>
              <Text style={[styles.th, styles.thAction]}>Actions</Text>
            </View>
            {users.length === 0 && <Text style={styles.emptyText}>No users yet.</Text>}
            {users.map((item, idx) => {
              const role = (item.role || 'user');
              return (
                <View key={item.id} style={[styles.userRow, idx % 2 === 1 && styles.userRowAlt]}>
                  <Text style={[styles.td, {flex:2}]}>{item.username}</Text>
                  <View style={[styles.td, {flex:1}]}> 
                    <Text style={[styles.roleBadgeNeutral]} accessibilityLabel={`Role: ${role}`}>{role}</Text>
                  </View>
                  <Text style={[styles.td, {flex:2}]}>{item.email || '—'}</Text>
                  <View style={[styles.td, styles.rowEnd]}>
                    <TouchableOpacity onPress={() => deleteUser(item.id)} accessibilityLabel={`Delete user ${item.username}`}>
                      <Text style={styles.deleteLink}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
            <View style={styles.subSection}>
              <Text style={styles.subSectionTitle}>Create User</Text>
              <View style={styles.inlineFormRow}><TextInput value={newUser.username} onChangeText={t => setNewUser(s => ({...s, username: t}))} placeholder="Username" placeholderTextColor={PLACEHOLDER_COLOR} style={[styles.input, styles.inlineInput]} /></View>
              <View style={styles.inlineFormRow}><TextInput value={newUser.password} onChangeText={t => setNewUser(s => ({...s, password: t}))} placeholder="Password" placeholderTextColor={PLACEHOLDER_COLOR} style={[styles.input, styles.inlineInput]} secureTextEntry /></View>
              <View style={styles.inlineFormRow}><TextInput value={newUser.name} onChangeText={t => setNewUser(s => ({...s, name: t}))} placeholder="Full name" placeholderTextColor={PLACEHOLDER_COLOR} style={[styles.input, styles.inlineInput]} /></View>
              <View style={styles.inlineFormRow}><TextInput value={newUser.email} onChangeText={t => setNewUser(s => ({...s, email: t}))} placeholder="Email" placeholderTextColor={PLACEHOLDER_COLOR} style={[styles.input, styles.inlineInput]} /></View>
              <Text style={styles.rolePickerLabel}>Role</Text>
              <View style={styles.rolePickerRow}>
                {['user','privileged','manager','admin'].map(r => (
                  <TouchableOpacity key={r} onPress={() => setNewUser(s => ({ ...s, role: r }))} style={styles.rolePickOption}>
                    <Text style={[styles.rolePickText, newUser.role === r && styles.rolePickTextActive]}>{newUser.role === r ? '☑' : '☐'} {r}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.formButtonsRight}>
                <TouchableOpacity onPress={createUser} style={[styles.btn, styles.btnPrimarySmall]}><Text style={styles.btnPrimaryText}>Create User</Text></TouchableOpacity>
              </View>
            </View>
            <View style={styles.subSection}>
              <Text style={styles.sectionTitle}>Topics ({topics.length})</Text>
              <View style={styles.tableHeader}>
                <Text style={[styles.th, {flex:2}]}>Key</Text>
                <Text style={[styles.th, {flex:3}]}>Metadata</Text>
                <Text style={[styles.th, styles.thAction]}>Actions</Text>
              </View>
              {topics.length === 0 && <Text style={styles.emptyText}>No topics yet.</Text>}
              {topics.map((item, idx) => (
                <View key={item.id} style={[styles.topicRow, idx % 2 === 1 && styles.userRowAlt]}>
                  <Text style={[styles.td, {flex:2}]}>{item.topic_key || item.sensor_key || item.key}</Text>
                  <Text style={[styles.td, {flex:3}]} numberOfLines={1}>{item.metadata || ''}</Text>
                  <View style={[styles.td, styles.rowEnd]}>
                    <TouchableOpacity onPress={() => deleteTopic(item.id)} accessibilityLabel={`Delete topic ${item.topic_key || item.key}`}>
                      <Text style={styles.deleteLink}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
              <View style={styles.inlineFormRow}>
                <TextInput value={newTopicKey} onChangeText={setNewTopicKey} placeholder="Topic key" placeholderTextColor={PLACEHOLDER_COLOR} style={[styles.input, styles.inlineInput]} />
              </View>
              <View style={styles.formButtonsRight}>
                <TouchableOpacity onPress={createTopic} style={[styles.btn, styles.btnPrimarySmall]}><Text style={styles.btnPrimaryText}>Add Topic</Text></TouchableOpacity>
              </View>
            </View>
            <View style={styles.subSection}>
              <Text style={styles.sectionTitle}>Power Labels</Text>
              {loadingPower && <ActivityIndicator style={{ marginVertical: 8 }} />}
              {!loadingPower && powerStates.length === 0 && <Text style={styles.emptyText}>No STATE topics with POWER keys found.</Text>}
              {!loadingPower && powerStates.length > 0 && powerStates.map((row, idx) => (
                <View key={row.topic} style={{ marginBottom: 16, backgroundColor: '#fff', borderRadius: 6, padding: 10, borderWidth: 1, borderColor: '#eee' }}>
                  <Text style={{ fontWeight: '700', marginBottom: 4 }}>{row.topic}</Text>
                  {Object.keys(row.powerKeys).map(pk => (
                    <View key={pk} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                      <Text style={{ width: 80 }}>{pk}: <Text style={{ color: '#1b5e20' }}>{row.powerKeys[pk]}</Text></Text>
                      <TextInput
                        value={lookupPowerLabel(row.topic, pk) || ''}
                        onChangeText={txt => setPowerLabels(l => ({ ...l, [`${row.topic}|${pk}`]: txt }))}
                        placeholder="Label"
                        placeholderTextColor={PLACEHOLDER_COLOR}
                        style={[styles.input, { flex: 1, marginLeft: 8, minWidth: 80 }]}
                      />
                      <TouchableOpacity
                        onPress={() => savePowerLabel(row.topic, pk, powerLabels[`${row.topic}|${pk}`] || '')}
                        style={{ marginLeft: 8, backgroundColor: '#1b5e20', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6 }}
                        accessibilityLabel={`Save label for ${pk}`}
                      >
                        <Text style={{ color: '#fff', fontWeight: '600' }}>Save</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              ))}
            </View>
            <View style={styles.dangerZone}>
              <Text style={styles.dangerTitle}>Danger Zone</Text>
              <Text style={styles.dangerDesc}>Delete this customer and ALL associated users and topics. This cannot be undone.</Text>
              <TouchableOpacity onPress={deleteCustomer} style={[styles.btn, styles.btnDanger]} accessibilityLabel="Delete customer">
                <Text style={styles.btnDangerText}>Delete Customer</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
        {confirm ? (
          <ConfirmModal visible={true} title={confirm.title} message={confirm.message} onCancel={confirm.onCancel} onConfirm={confirm.onConfirm} />
        ) : null}
        <View style={{ height: 40 }} />
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
    } catch (e) { if (DEBUG) console.error('manager load users', e && e.message); }
    try {
      const cres = await doFetch(`/admin/api/customers/${user.customer_id}`);
      if (cres && cres.customer) setCustomer(cres.customer);
    } catch (e) { if (DEBUG) console.error('manager load customer', e && e.message); }
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
      <FlatList data={users} keyExtractor={u => String(u.id)} renderItem={({item}) => {
        const role = item.role || 'user';
        const canDelete = ['user','privileged'].includes(role) && item.id !== user.id;
        return (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 }}>
            <Text>{item.username} {item.role ? `(${item.role})` : ''} — {item.email || 'no email'}</Text>
            {canDelete && (
              <TouchableOpacity onPress={() => deleteUser(item.id)} style={{ marginLeft: 12 }}>
                <Text style={{ color: '#b71c1c' }}>Delete</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      }} />
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
// Extended styles appended (kept original ones for backward compatibility)
Object.assign(styles, {
  editorScroll: { padding: 16, paddingBottom: 56 },
  formCard: { backgroundColor: '#fff', padding: 16, borderRadius: 8, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, elevation: 1 },
  sectionBlock: { marginTop: 24 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginTop: 4 },
  inlineHint: { fontSize: 12, color: '#666', marginTop: 6 },
  actionRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  btn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 6 },
  btnPrimary: { backgroundColor: '#1b5e20' },
  btnPrimarySmall: { backgroundColor: '#1b5e20', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  btnPrimaryText: { color: '#fff', fontWeight: '600' },
  btnSecondary: { backgroundColor: '#eee' },
  btnSecondaryText: { color: '#333', fontWeight: '600' },
  btnDanger: { backgroundColor: '#b71c1c', marginTop: 12 },
  btnDangerText: { color: '#fff', fontWeight: '700' },
  tableHeader: { flexDirection: 'row', marginTop: 12, borderBottomWidth: 1, borderColor: '#ddd', paddingVertical: 6 },
  th: { fontSize: 12, fontWeight: '700', color: '#444' },
  thAction: { width: 70, textAlign: 'right' },
  userRow: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderColor: '#f0f0f0' },
  topicRow: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderColor: '#f0f0f0' },
  userRowAlt: { backgroundColor: '#fafafa' },
  td: { fontSize: 13, color: '#222', paddingRight: 8 },
  rowEnd: { alignItems: 'flex-end', justifyContent: 'center' },
  deleteLink: { color: '#b71c1c', fontSize: 12, fontWeight: '600' },
  emptyText: { fontSize: 12, color: '#666', marginTop: 4 },
  roleBadge: { fontSize: 11, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, textTransform: 'capitalize', borderWidth: 1, overflow: 'hidden', alignSelf: 'flex-start' },
  roleBadgeNeutral: { fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: '#e5efe5', color: '#1b5e20', textTransform: 'capitalize', overflow: 'hidden', alignSelf: 'flex-start' },
  subSection: { marginTop: 24 },
  subSectionTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  inlineFormRow: { marginTop: 8 },
  inlineInput: { marginTop: 0 },
  rolePickerLabel: { marginTop: 12, fontSize: 12, fontWeight: '600', color: '#333' },
  rolePickerRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  rolePickOption: { marginRight: 12, marginBottom: 6 },
  rolePickText: { fontSize: 13, color: '#666' },
  rolePickTextActive: { color: '#1b5e20', fontWeight: '700' },
  formButtonsRight: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  dangerZone: { marginTop: 36, padding: 16, backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#f5d3d3' },
  dangerTitle: { fontSize: 14, fontWeight: '700', color: '#b71c1c' },
  dangerDesc: { fontSize: 12, color: '#7a2a2a', marginTop: 4, lineHeight: 16 }
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
