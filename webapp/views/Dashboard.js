import React, { useEffect, useState, useRef, useMemo } from 'react';
import { apiFetch } from '../src/api';

// Global debug toggle for this module. Set to true only while actively
// troubleshooting — leave false for normal operation to avoid noisy logs.
const DEBUG = false;
// Detect React Native at module load time and provide a default API host
const IS_REACT_NATIVE = (() => { try { return (typeof navigator !== 'undefined' && navigator.product === 'ReactNative'); } catch (e) { return false; } })();
const DEFAULT_API_HOST = (typeof process !== 'undefined' && process.env && process.env.SERVER_FQDN) ? process.env.SERVER_FQDN : 'api.brewingremote.com';
// Helper to fetch power labels from the API. Accepts an optional JWT token
// and will try multiple fallbacks to handle different hosting/proxy setups.
async function fetchPowerLabels(token) {
  try {
    let res = null;

    // 1) Prefer window.apiFetch if present (it knows how to attach auth headers)
    try {
      if (typeof window !== 'undefined' && window.apiFetch) {
        try { res = await window.apiFetch('/api/power-labels'); } catch (e) { /* fallthrough */ }
        if ((!res || !res.ok) && window.apiFetch) {
          try { res = await window.apiFetch('/admin/api/power-labels'); } catch (e) { /* fallthrough */ }
        }
      }
    } catch (e) { /* ignore */ }

    // 2) If we still don't have a good response, try classical fetch to likely origins.
    if (!res || (typeof res.ok !== 'undefined' && !res.ok)) {
      const candidatePaths = ['/api/power-labels', '/admin/api/power-labels'];
  const origins = [];
      // current origin (same origin requests) - useful for hosted SPA
      try { if (typeof window !== 'undefined' && window.location && window.location.origin) origins.push(window.location.origin); } catch (e) {}
      // public API host (if configured in this module)
      try { if (typeof USE_PUBLIC_WS !== 'undefined' && USE_PUBLIC_WS && typeof PUBLIC_WS_HOST === 'string' && PUBLIC_WS_HOST) origins.push(`https://${PUBLIC_WS_HOST}`); } catch (e) {}

  // If no origins were discovered (e.g. React Native), fall back to the configured default host
  try { if (!origins.length) origins.push(`https://${DEFAULT_API_HOST}`); } catch (e) {}

  // Try each origin + path with Authorization header (if token provided) then with token query param
      for (const origin of origins) {
        for (const path of candidatePaths) {
          const url = `${origin}${path}`;
          try {
            const headers = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;
            if (DEBUG) console.log('Dashboard: attempting fetch', { url, headers });
            const r = await (typeof window !== 'undefined' && window.fetch ? window.fetch(url, { headers, mode: 'cors' }) : fetch(url, { headers }));
            if (r && r.ok) { res = r; break; }
            // try with token query param as a last resort
            if (token) {
              const sep = url.includes('?') ? '&' : '?';
              const urlWithToken = `${url}${sep}token=${encodeURIComponent(token)}`;
              try {
                if (DEBUG) console.log('Dashboard: attempting fetch with token query param', { url: urlWithToken });
                const r2 = await (typeof window !== 'undefined' && window.fetch ? window.fetch(urlWithToken, { mode: 'cors' }) : fetch(urlWithToken));
                if (r2 && r2.ok) { res = r2; break; }
              } catch (e) { if (DEBUG) console.log('Dashboard: fetch attempt failed', e && e.message ? e.message : e); }
            }
          } catch (e) { if (DEBUG) console.log('Dashboard: fetch attempt failed', e && e.message ? e.message : e); }
        }
        if (res && res.ok) break;
      }
    }

    // 3) If res is a Response-like object parse JSON
    if (!res) return [];
    if (typeof res.json === 'function') {
      const js = await res.json();
      return js && js.labels ? js.labels : [];
    }
    // If it's already parsed
    return res.labels || [];
  } catch (e) {
    console.error('Dashboard: All power label APIs failed:', e && e.message ? e.message : e);
    return [];
  }
}
// Produce a set of canonical candidate keys for a topic so label lookups
// behave the same as the AdminPortal canonicalization. Return an array of
// topic strings (without the "|POWERx" suffix). Consumers will append
// the power key as needed.
function canonicalCandidatesForTopic(topic) {
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
}
import { SafeAreaView, View, Text, StyleSheet, Pressable, Animated, Easing, TextInput, Button, ScrollView, useWindowDimensions } from 'react-native';
import Constants from 'expo-constants';
import Gauge from '../components/Gauge';

// try to load react-native-svg for a nicer circular gauge; fall back if not installed
let Svg = null, Circle = null, Line = null, SvgText = null, G = null;
try {
  const svg = require('react-native-svg');
  Svg = svg.Svg; Circle = svg.Circle; Line = svg.Line; SvgText = svg.Text; G = svg.G;
} catch (e) {
  Svg = null; Circle = null; Line = null; SvgText = null; G = null;
}

// constants
const SENSOR_MIN = 0;
const SENSOR_MAX = 220; // use Fahrenheit-ish scale to match gauge labels
const GAUGE_R = 70;
const GAUGE_C = 2 * Math.PI * GAUGE_R;
const GAUGE_SIZE = 160;

const DEFAULT_THRESHOLDS = {
  FERM: { min: 60, max: 80 },
  MASH: { min: 148, max: 162 },
  HLT: { min: 0, max: 220 },
  BOIL: { min: 200, max: 220 }
};

// Metric-based defaults (level3). These provide green band recommendations and
// fallback min/max (in gauge domain 0-220 unless specified). Extend as needed.
// If a metric name does not exist here we fall back to deriveThreshold logic.
const METRIC_DEFAULTS = {
  Temp:        { greenStart: 148, greenEnd: 162, min: 0,   max: 220 },
  MashTemp:    { greenStart: 148, greenEnd: 162, min: 120, max: 180 },
  FermentTemp: { greenStart: 60,  greenEnd: 80,  min: 50,  max: 90 },
  BoilTemp:    { greenStart: 200, greenEnd: 212, min: 150, max: 220 },
  Gravity:     { greenStart: 1.010, greenEnd: 1.020, min: 1.000, max: 1.120 },
  Pressure:    { greenStart: 8,   greenEnd: 12,  min: 0,   max: 30 },
};

function deriveThreshold(key){
  const up = key.toUpperCase();
  if (up.includes('FERM')) return DEFAULT_THRESHOLDS.FERM;
  if (up.includes('MASH')) return DEFAULT_THRESHOLDS.MASH;
  if (up.includes('HLT')) return DEFAULT_THRESHOLDS.HLT;
  if (up.includes('BOIL')) return DEFAULT_THRESHOLDS.BOIL;
  return { min: 0, max: 220 };
}

// Helper: compute gauge params (greenStart/greenEnd/min/max) for a baseKey using metric meta or fallback
function computeGaugeParams(baseKey, meta, sensorVal) {
  // meta.metric is level3 metric
  const metric = meta && meta.metric ? meta.metric : null;
  if (metric && METRIC_DEFAULTS[metric]) {
    const d = METRIC_DEFAULTS[metric];
    return { greenStart: d.greenStart, greenEnd: d.greenEnd, min: d.min, max: d.max };
  }
  // fallback: deriveThreshold with legacy heuristic (returns min/max only)
  const { min, max } = deriveThreshold(baseKey);
  return { greenStart: min, greenEnd: max, min, max };
}

export default function Dashboard({ token, onCustomerLoaded }) {
  // Lightweight runtime debug toggle: enable with ?debug=1 in the URL or
  // by setting localStorage.setItem('brewski.debug','true') in the console.
  const DEBUG = (() => {
    try {
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search || '');
        if (params.get('debug') === '1' || params.get('debug') === 'true') return true;
        const ls = window.localStorage && window.localStorage.getItem && window.localStorage.getItem('brewski.debug');
        if (ls === 'true') return true;
      }
    } catch (e) {}
    return false;
  })();
  // Power label state: { `${topic}|${powerKey}`: label }
  const [powerLabels, setPowerLabels] = useState({});
  // Fetch power labels on mount (and when token changes)
  useEffect(() => {
    let mounted = true;
    (async () => {
      const labelsArr = await fetchPowerLabels(token);
      // Convert array to map if needed
      let labelMap = {};
      if (Array.isArray(labelsArr)) {
        labelsArr.forEach(l => {
          try {
            if (l && l.topic && l.power_key) {
              const key = `${l.topic}|${l.power_key}`;
              labelMap[key] = l.label || '';
              labelMap[key.toUpperCase()] = l.label || '';
              // expand into canonical topic variants so lookups succeed
              const candidates = canonicalCandidatesForTopic(l.topic);
              candidates.forEach(t => {
                const k1 = `${t}|${l.power_key}`;
                const k2 = `${t}|${l.power_key.toUpperCase()}`;
                if (!labelMap[k1]) labelMap[k1] = l.label || '';
                if (!labelMap[k2]) labelMap[k2] = l.label || '';
              });
            }
          } catch (e) { /* ignore */ }
        });
      } else if (labelsArr && typeof labelsArr === 'object') {
        labelMap = labelsArr;
      }
      
      // Debug logging
      if (DEBUG) {
        console.log('Dashboard: Power labels fetch result:', {
          labelsCount: Object.keys(labelMap).length,
          labelKeys: Object.keys(labelMap),
          fullLabelMap: labelMap
        });
      }
      
      if (mounted) setPowerLabels(labelMap);
    })();
    return () => { mounted = false; };
  }, [token]);
  // store numeric customer id if provided by /api/latest so we can POST admin updates
  const [customerId, setCustomerId] = useState(null);
  // Debug info for /admin/api/me hydration attempts (visible when DEBUG=true)
  const [meDebug, setMeDebug] = useState(null);
  // responsive layout measurements
  const { width: winWidth } = useWindowDimensions();
  const wsRef = useRef(null);
  const [sensorValue, setSensorValue] = useState(null);
  const [displayedSensorValue, setDisplayedSensorValue] = useState(null);
  // target values are authoritative from the broker; start as null until broker returns a value
  const [targetValue, setTargetValue] = useState(null);
  const [sendValue, setSendValue] = useState('');
  // removed messages list per user request; keep an ephemeral var for potential future use
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const [trackWidth, setTrackWidth] = useState(200);
  // per-gauge targets (5 gauges)
  // we'll maintain maps of sensor and target values keyed by topic string
  const [gTargets, setGTargets] = useState({});
  const [gSensors, setGSensors] = useState({});
  // Power states for RAIL devices (baseKey RAIL/<Device>) -> { POWER, POWER1, ... }
  const [gPower, setGPower] = useState({});
  // meta map: baseKey -> { site, device, metric }
  const [gMeta, setGMeta] = useState({});
  // Known company slugs discovered from the server (preferred) or inferred locally.
  const [knownSlugs, setKnownSlugs] = useState(new Set());

  // Fetch known company slugs from the server so canonicalization scales as new companies are added.
  async function fetchCompanySlugs(token) {

// Lightweight JWT payload parser (no verification) to surface customer slug early
function parseJwtPayload(tok) {
  try {
    if (!tok || typeof tok !== 'string') return null;
    const parts = tok.split('.');
    if (!parts[1]) return null;
    // base64url -> base64
    let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    // pad
    while (b.length % 4) b += '=';
    const json = atob(b);
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}
    try {
      let res;
      const pathPublic = '/api/companies';
      const pathAdmin = '/admin/api/companies';
      if (typeof window !== 'undefined' && window.apiFetch) {
        try { res = await window.apiFetch(pathPublic); } catch (e) { /* try admin */ }
      }
      if (!res) {
        const urlPath = token ? `${pathAdmin}?token=${encodeURIComponent(token)}` : pathPublic;
        const base = (IS_REACT_NATIVE || !(typeof window !== 'undefined' && window.apiFetch)) ? `https://${resolveHost()}` : '';
        const url = base ? `${base}${urlPath}` : urlPath;
        res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      }
      if (!res || !res.ok) return new Set();
      const js = await res.json();
      if (!js || !Array.isArray(js.companies)) return new Set();
      const s = new Set(js.companies.map(c => String(c.slug || c).toUpperCase()));
      return s;
    } catch (e) {
      return new Set();
    }
  }

  useEffect(() => {
    let mounted = true;
    (async () => {
      const s = await fetchCompanySlugs(token);
      if (!mounted) return;
      setKnownSlugs(s);
    })();
    return () => { mounted = false; };
  }, [token]);

  // Lightweight JWT payload parser (no verification) to surface customer slug early
  // and avoid transiently showing BREW devices while /api/latest hydrates.
  const parseJwtPayloadEarly = (tok) => {
    try {
      if (!tok || typeof tok !== 'string') return null;
      const parts = tok.split('.');
      if (!parts[1]) return null;
      let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      // atob may not be available in some RN envs; try Buffer fallback
      let json = null;
      try { json = typeof atob === 'function' ? atob(b) : null; } catch (e) {}
      if (!json) {
        try { json = Buffer.from(b, 'base64').toString('utf8'); } catch (e) { return null; }
      }
      return JSON.parse(json);
    } catch (e) { return null; }
  };

  // Use the JWT claim as a fast-path to set customerSlug/mode until /api/latest provides authoritative values.
  useEffect(() => {
    if (!token) return;
    // don't override values if snapshot already hydrated them
    if (mode || customerSlug) return;
    try {
      const payload = parseJwtPayloadEarly(token);
      if (!payload) return;
      // Prefer explicit customer.slug or customer_slug claim which should be a string slug.
      // Ignore numeric-only claims (these are likely user ids or tenant ids).
      const maybeSlug = (payload.customer && payload.customer.slug) || payload.customer_slug || payload.site || payload.org || null;
      const pick = (v) => {
        if (!v && v !== 0) return null;
        if (typeof v === 'string') return v;
        // sometimes claims are numeric ids; don't accept numbers
        return null;
      };
      const candidate = pick(maybeSlug) || null;
      // Only accept candidate if it contains at least one ASCII letter (avoid numeric ids like '34')
      const looksLikeSlug = (s) => { try { return typeof s === 'string' && /[A-Za-z]/.test(s) && String(s).length >= 2; } catch (e) { return false; } };
      if (candidate && looksLikeSlug(candidate)) {
        const norm = String(candidate).toUpperCase();
        setCustomerSlug(candidate);
        setMode(norm);
      } else {
        if (DEBUG) console.log('Dashboard: JWT fast-path rejected candidate (not a slug):', maybeSlug);
      }
    } catch (e) {}
  }, [token]);

  // Also attempt to hydrate authoritative current user/customer info from the server
  // when a token is present. This mirrors AdminPortal behavior and helps mobile
  // clients which may not receive customer id/slug via props or local snapshot yet.
  useEffect(() => {
    if (!token) return;
    let mounted = true;
    (async () => {
      try {
        const record = { attempts: [] };

        // 1) Try window.apiFetch (may return parsed JSON)
        if (typeof window !== 'undefined' && window.apiFetch) {
          try {
            const r = await window.apiFetch('/admin/api/me', { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
            record.attempts.push({ method: 'window.apiFetch', ok: true, body: r });
            if (mounted && r) {
              // apply if we got customer info
              try { setMeDebug(record); } catch (e) {}
              const js = r;
              if (js.customer && js.customer.slug) {
                if (!customerSlug) setCustomerSlug(js.customer.slug);
                if (!mode) setMode(String(js.customer.slug).toUpperCase());
                if (js.customer.id && !customerId) setCustomerId(js.customer.id);
                if (onCustomerLoaded) onCustomerLoaded(js.customer);
                return;
              }
              // fallthrough to further attempts if js.user only or minimal
            }
          } catch (e) { record.attempts.push({ method: 'window.apiFetch', ok: false, error: String(e) }); }
        }

        // Build base URL (absolute for RN or when apiFetch absent)
        const base = (IS_REACT_NATIVE || !(typeof window !== 'undefined' && window.apiFetch)) ? `https://${resolveHost()}` : '';
        const primaryUrl = base ? `${base}/admin/api/me` : '/admin/api/me';

        // 2) Try fetch with Authorization header
        let res = null;
        try {
          res = await fetch(primaryUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
          record.attempts.push({ method: 'fetch', url: primaryUrl, ok: res && res.ok, status: res && res.status });
        } catch (e) { record.attempts.push({ method: 'fetch', url: primaryUrl, ok: false, error: String(e) }); }

        // 3) If that failed, try ?token fallback
        if (!res || !res.ok) {
          try {
            const qUrl = base ? `${base}/admin/api/me?token=${encodeURIComponent(token)}` : `/admin/api/me?token=${encodeURIComponent(token)}`;
            const r2 = await fetch(qUrl);
            record.attempts.push({ method: 'fetch?token', url: qUrl, ok: r2 && r2.ok, status: r2 && r2.status });
            if (r2 && r2.ok) res = r2;
            else {
              try { const txt = await (r2 && r2.text ? r2.text() : Promise.resolve(null)); record.attempts.push({ method: 'fetch?token', bodyText: txt }); } catch (e) {}
            }
          } catch (e) { record.attempts.push({ method: 'fetch?token', ok: false, error: String(e) }); }
        }

        // Parse response JSON if available
        let js = null;
        if (res) {
          try { js = await res.json(); record.attempts.push({ method: 'parseJson', ok: true }); } catch (e) { record.attempts.push({ method: 'parseJson', ok: false, error: String(e) }); }
        }

        if (!mounted) return;
        record.final = js || null;
        try { setMeDebug(record); } catch (e) {}

        if (js && js.customer && js.customer.slug) {
          if (!customerSlug) setCustomerSlug(js.customer.slug);
          if (!mode) setMode(String(js.customer.slug).toUpperCase());
          if (js.customer.id && !customerId) setCustomerId(js.customer.id);
          if (onCustomerLoaded) onCustomerLoaded(js.customer);
          return;
        }

        // If we only have a numeric customer_id (e.g., js.user.customer_id), try fetching the customer
        const custId = js && js.user && js.user.customer_id ? js.user.customer_id : (js && js.customer && js.customer.id ? js.customer.id : null);
        if (custId) {
          try {
            const custUrl = base ? `${base}/admin/api/customers/${encodeURIComponent(custId)}` : `/admin/api/customers/${encodeURIComponent(custId)}`;
            let cres = null;
            try { cres = await fetch(custUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }); record.attempts.push({ method: 'custFetch', url: custUrl, ok: cres && cres.ok, status: cres && cres.status }); } catch (e) { record.attempts.push({ method: 'custFetch', url: custUrl, ok: false, error: String(e) }); }
            if ((!cres || !cres.ok)) {
              try {
                const custQ = base ? `${base}/admin/api/customers/${encodeURIComponent(custId)}?token=${encodeURIComponent(token)}` : `/admin/api/customers/${encodeURIComponent(custId)}?token=${encodeURIComponent(token)}`;
                const cres2 = await fetch(custQ); record.attempts.push({ method: 'custFetch?token', url: custQ, ok: cres2 && cres2.ok, status: cres2 && cres2.status });
                if (cres2 && cres2.ok) cres = cres2;
              } catch (e) { record.attempts.push({ method: 'custFetch?token', ok: false, error: String(e) }); }
            }
            if (cres && cres.ok) {
              try {
                const cjs = await cres.json();
                record.customer = cjs;
                try { setMeDebug(record); } catch (e) {}
                if (cjs && cjs.customer && cjs.customer.slug) {
                  const cs = cjs.customer;
                  if (!customerSlug) setCustomerSlug(cs.slug);
                  if (!customerId && cs.id) setCustomerId(cs.id);
                  if (!mode && cs.slug) setMode(String(cs.slug).toUpperCase());
                  if (onCustomerLoaded) onCustomerLoaded(cs);
                  return;
                }
              } catch (e) { record.customerParseError = String(e); try { setMeDebug(record); } catch (e) {} }
            }
          } catch (e) { record.custFetchError = String(e); try { setMeDebug(record); } catch (e) {} }
        }
      } catch (e) {
        if (DEBUG) console.log('Dashboard: /admin/api/me hydrate error', e);
        try { setMeDebug({ error: String(e) }); } catch (e) {}
      }
    })();
    return () => { mounted = false; };
  }, [token]);

  // Helper: try to resolve a site/customer slug for a device name by scanning gMeta.
  // Useful when legacy topics (tele/<device>/Sensor) arrive before we know `mode`.
  const findSiteForDevice = (deviceName) => {
    if (!deviceName) return null;
    try {
      const keys = Object.keys(gMeta || {});
      for (const k of keys) {
        const m = gMeta[k];
        if (!m) continue;
        if (m.device && String(m.device).toUpperCase() === String(deviceName).toUpperCase()) {
          if (m.site) return m.site;
          // fallback: parse site from key like SITE/DEVICE
          const parts = k.split('/').filter(Boolean);
          if (parts.length >= 2) return parts[0];
        }
        // also check canonical key patterns
        const partsK = k.split('/').filter(Boolean);
        if (partsK.length >= 2 && partsK[1].toUpperCase() === String(deviceName).toUpperCase()) return partsK[0];
      }
    } catch (e) {}
    return null;
  };
    // Track which bases we've already attempted to persist so we don't spam the admin API
    const persistedBasesRef = useRef(new Set());

    // Persist a discovered base (canonical) into the server topics DB via admin API.
    // This attempts a single POST and on success adds the base to dbSensorBases so
    // the UI treats it as authoritative immediately.
    const persistBaseToDB = async (baseKey, rawTopic, meta) => {
      try {
        if (!token) return false; // need admin/auth token to persist
        if (!baseKey) return false;
        if (persistedBasesRef.current.has(baseKey)) return false;
        // Avoid persisting obvious test/dev placeholders
        if (/\bDUMMY/i.test(baseKey)) {
          if (DEBUG) console.log('Dashboard: skipping persist of DUMMY base', baseKey);
          return false;
        }
        // prefer numeric customer id path when available. If we only have a slug
        // (or the special 'default' slug), avoid POSTing to
        // /admin/api/customers/<slug>/topics as that endpoint expects a numeric
        // id; instead use the generic admin topics endpoint and include
        // customer_slug in the payload so the server can associate it.
        // Only attempt to persist when we have a numeric customerId. Posting to
        // the generic endpoint without a numeric id has been observed to return
        // 400/bad_id from the server; avoid noisy retries by skipping in that
        // case. If you want client-side discovery to persist for slug-only
        // customers, the server API must accept customer_slug or provide a
        // specific endpoint — adjust here after server-side changes.
        if (!customerId) {
          if (DEBUG) console.warn('Dashboard: cannot persist base without numeric customerId, skipping', { baseKey, customerSlug });
          return false;
        }
        const path = `/admin/api/customers/${encodeURIComponent(customerId)}/topics`;

        const payload = {
          topic_key: rawTopic || baseKey,
          site: meta && meta.site ? meta.site : (baseKey && baseKey.split('/')[0]) || null,
          device: meta && meta.device ? meta.device : (baseKey && baseKey.split('/')[1]) || null,
          metric: meta && meta.metric ? meta.metric : null,
        };

        const base = (IS_REACT_NATIVE || !(typeof window !== 'undefined' && window.apiFetch)) ? `https://${resolveHost()}` : '';
        const url = base ? `${base}${path}` : path;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify(payload),
        });

        if (res && res.ok) {
          // mark as persisted so we don't retry
          persistedBasesRef.current.add(baseKey);
          // add to dbSensorBases so UI treats it as authoritative immediately
          try { setDbSensorBases(prev => { const s = new Set(Array.from(prev || [])); s.add(baseKey); return s; }); } catch (e) {}
          if (DEBUG) console.log('Dashboard: persisted base to topics DB', baseKey, path, payload);
          return true;
        } else {
          // Try to surface response body for easier debugging
          try {
            const txt = await res.text().catch(() => '');
            console.warn('Dashboard: failed to persist base', { baseKey, status: res.status, path, payload, body: txt });
          } catch (e) {
            if (DEBUG) console.log('Dashboard: failed to persist base', baseKey, res && res.status);
          }
        }
      } catch (e) { if (DEBUG) console.log('Dashboard: persistBaseToDB error', e && e.message); }
      return false;
    };
  const anim = useRef(new Animated.Value(0)).current;
  const needleAnim = useRef(new Animated.Value(0)).current;
  const spinAnim = useRef(new Animated.Value(0)).current;
  const [needlePct, setNeedlePct] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const alertMapRef = useRef(new Map()); // key -> last alert timestamp
  const ALERT_DEBOUNCE_MS = 30_000; // avoid spamming same device alert more than every 30s
  // dynamic threshold overrides per base (min/max) loaded from server
  const [thresholds, setThresholds] = useState({}); // { base: { min, max } }
  // UI filter: customer slug (dynamic based on user's customer)
  // Default customerSlug to BREW so we have a conservative fallback for lookups
  // (power detection will still work via device-name fallback). Leave `mode`
  // unset until /api/latest provides the authoritative customer slug so the
  // filter logic doesn't get pre-forced to a value that may be incorrect.
  const [mode, setMode] = useState(null); // will be set from customer info
  // Do not assume BREW by default — leave customerSlug null until /api/latest
  // provides the authenticated user's customer. This prevents the dashboard
  // from showing BREW-specific devices for non-BREW users.
  const [customerSlug, setCustomerSlug] = useState(null);
  // Store raw power messages that need customer context
  const [pendingPowerMessages, setPendingPowerMessages] = useState([]);
  // Queue sensor/target messages that arrive before we know 'mode' so we can canonicalize them
  const [pendingSensorMessages, setPendingSensorMessages] = useState([]);

  // Host resolution: auto-detect dev server host when running inside Expo in LAN mode.
  // For now this is hardcoded to your laptop LAN IP so the phone can reach the local WS bridge.
  const FORCED_HOST = '172.20.10.5'; // <-- hardcoded LAN IP
  // If you want the app to connect to the public Cloudflare endpoint instead, set USE_PUBLIC_WS
  // to true and ensure PUBLIC_WS_HOST matches your hostname (wss://<PUBLIC_WS_HOST>/ws)
  const USE_PUBLIC_WS = true; // flip to `false` for local LAN development
  const PUBLIC_WS_HOST = 'api.brewingremote.com';
  // Use an alternate public path to avoid edge redirects on `/ws`
  const PUBLIC_WS_PATH = '/_ws'; // try '/_ws' instead of '/ws'

  // default devices (kept for initial get requests). We'll also dynamically discover devices
  // from incoming sensor/target topics and render gauges for those as they appear.
  const defaultDevices = [
    { key: 'DUMMYBOIL', label: 'Boil' },
    { key: 'DUMMYHLT', label: 'HLT' },
    { key: 'DUMMYMASH', label: 'Mash' },
    { key: 'DUMMYFERM2', label: 'Ferm 2' },
    { key: 'DUMMYFERM3', label: 'Ferm 3' },
    { key: 'DUMMYFERM4', label: 'Ferm 4' },
    { key: 'DUMMYFERM5', label: 'Ferm 5' },
  ];
  const connTimeoutRef = useRef(null);
  // Set of canonical base keys (e.g., "BREW/Device" or "RAIL/Device[/Metric]") derived
  // from the server-side topics DB via /api/latest. This is authoritative for which
  // gauges should be created. Populated during snapshot hydrate and kept for runtime.
  const [dbSensorBases, setDbSensorBases] = useState(new Set());

  // derive the device list from known sensor/target keys + defaults
  const deviceList = useMemo(() => {
    // Use a canonical base of ORG/DEVICE for grouping. Keep a representative originalKey
    // for sensor/target lookups (which may have metric segments).
    const seen = new Map(); // canonicalBase -> { label, representative }

      const canonicalBaseFromKey = (origKey) => {
      if (!origKey || typeof origKey !== 'string') return null;
      // Prefer explicit meta when present
      const m = gMeta[origKey];
      if (m && m.site && m.device) return `${m.site}/${m.device}`;

      // Use server-provided known slugs when available; fall back to customerSlug/gMeta heuristics
      const slugs = (knownSlugs && knownSlugs.size) ? knownSlugs : (() => {
        const s = new Set();
        try { Object.values(gMeta || {}).forEach(m => { if (m && m.site) s.add(String(m.site).toUpperCase()); }); } catch (e) {}
        if (customerSlug) s.add(String(customerSlug).toUpperCase());
        return s;
      })();
      const parts = origKey.split('/').filter(Boolean);

      // Preferred pattern: tele/<ORG>/<DEVICE>/Sensor or tele/<ORG>/<DEVICE>/... -> use ORG/DEVICE
      // Only treat this as org-prefixed when there are at least 4 segments (tele, org, device, terminal/extra)
      if (parts.length >= 4 && (parts[0] && (parts[0].toLowerCase() === 'tele' || parts[0].toLowerCase() === 'stat'))) {
        const orgCandidate = parts[1];
        const device = parts[2];
        if (orgCandidate && device) {
          // If the orgCandidate matches a known slug, use it; otherwise if we have
          // a current customerSlug (mode) treat unknown orgs as BREW so admins see them
          if (slugs.has(orgCandidate.toUpperCase())) return `${orgCandidate}/${device}`;
          // Legacy or unknown orgs map to BREW by default
          return `BREW/${device}`;
        }
      }

      // Legacy pattern: tele/<DEVICE>/Sensor or stat/<DEVICE>/Sensor (no org segment)
      // Default these to BREW by policy — DB topics (AdminPortal) are authoritative and
      // unprefixed topics should belong to the catch-all BREW customer.
      if (parts.length >= 2 && (parts[0] && (parts[0].toLowerCase() === 'tele' || parts[0].toLowerCase() === 'stat'))) {
        const device = parts[1];
        if (device) {
          return `BREW/${device}`;
        }
      }

      // If already in ORG/DEVICE form (or DEVICE/METRIC), prefer to use the first two parts
      if (parts.length >= 2) {
        const first = parts[0]; const second = parts[1];
        if (slugs.has(first.toUpperCase())) return `${first}/${second}`;
        // If the first part looks like a known customer slug or uppercase token, map to that
        if (/^[A-Z0-9_-]{2,32}$/.test(first)) return `${first}/${second}`;
        // treat unknown first part as belonging to BREW
        return `BREW/${second}`;
      }

      // Single segment -> treat as device under BREW by default
      if (parts.length === 1) {
        return `BREW/${parts[0]}`;
      }
      return origKey;
    };

    const addOrigKey = (origKey) => {
      try {
        if (!origKey) return;
        const canonical = canonicalBaseFromKey(origKey);
        if (!canonical) return;
        if (seen.has(canonical)) return;

        // Choose label from meta when available, prefer device name only (user preference)
        const metaForOrig = gMeta[origKey] || gMeta[canonical];
        let label = null;
        if (metaForOrig && metaForOrig.device) {
          label = metaForOrig.device;
        } else {
          // Fallback to canonical device segment
          const segs = canonical.split('/');
          label = segs[1] || canonical;
        }

  // Only add canonical entries that are backed by a Sensor terminal in metadata.
        // This avoids treating POWER/TARGET/other topics as gauges. We accept a
        // representative when either the exact origKey has meta.terminal === 'Sensor' or
        // any gMeta key that startsWith the canonical base has terminal 'Sensor'.
        const hasSensorMeta = (() => {
          try {
            // Fast path: raw topic explicitly in tele|stat/<ORG>/<DEVICE>/Sensor form
            if (/^(tele|stat)\/[^/]+\/[^/]+\/Sensor$/i.test(origKey)) return true;

            // Exact meta entry for this origKey indicates Sensor terminal
            const exact = gMeta && gMeta[origKey];
            if (exact && exact.terminal && exact.terminal.toLowerCase() === 'sensor') return true;

            // look for any meta entry that starts with the canonical base and is a Sensor
            const keys = Object.keys(gMeta || {});
            for (const k of keys) {
              if (!k) continue;
              if (k === origKey || k.startsWith(canonical + '/')) {
                const m = gMeta[k];
                if (m && m.terminal && m.terminal.toLowerCase() === 'sensor') return true;
                // Also accept meta keys that end with '/Sensor' as an explicit sensor topic
                if (typeof k === 'string' && /\/Sensor$/i.test(k)) return true;
              }
            }
          } catch (e) {}
          return false;
        })();

        if (!hasSensorMeta) {
          if (DEBUG) console.log('Dashboard: skipping non-sensor-backed candidate', { origKey, canonical });
          return; // skip non-sensor-backed bases (targets/power only)
        }

        // Enforce DB-backed gating: when dbSensorBases contains entries, only allow
        // canonical bases that are present (or that are a prefix of a metric-bearing
        // DB base). This prevents tele/stat legacy or DUMMY placeholders from
        // producing gauges when the server-side topics DB is authoritative.
        try {
          const dbSet = dbSensorBases;
          if (dbSet && dbSet.size) {
            let allowed = false;
            for (const b of dbSet) {
              if (!b) continue;
              if (b === canonical) { allowed = true; break; }
              if (b.startsWith(canonical + '/')) { allowed = true; break; }
              if (canonical.startsWith(b + '/')) { allowed = true; break; }
            }
            if (!allowed) {
              if (DEBUG) console.log('Dashboard: canonical not present in DB snapshot, skipping', { canonical });
              return;
            }
          }
        } catch (e) {}

        seen.set(canonical, { label, representative: origKey });
      } catch (e) { /* ignore */ }
    };

    // Note: no default seeding — gauges must be derived from DB-backed sensor topics

    // Build gauge candidates from explicit metadata keys (gMeta) that indicate Sensor terminals
    // or from gSensors entries that correspond to a /Sensor topic. This ensures we only
    // create gauges for actual sensor topics (one per canonical base) and avoid tele/stat
    // control messages producing duplicate gauges.
    const candidateKeys = new Set();

    // Prefer gMeta entries that explicitly mark terminal === 'Sensor'
    Object.keys(gMeta || {}).forEach(k => {
      try {
        const m = gMeta[k];
        if (!m) return;
        // Accept explicit Sensor terminal, or keys that end with '/Sensor'
        if ((m.terminal && String(m.terminal).toLowerCase() === 'sensor') || /\/Sensor$/i.test(k)) {
          candidateKeys.add(k);
        }
      } catch (e) {}
    });

    // Also include any gSensors keys that look like Sensor topics but may not have meta entries yet
    Object.keys(gSensors || {}).forEach(k => {
      try {
        if (/\/Sensor$/i.test(k) || /\/sensor$/i.test(k)) candidateKeys.add(k);
      } catch (e) {}
    });

    // Include any power-only bases discovered in gPower so devices that only publish
    // POWER states (no Sensor terminal) still appear as devices with power buttons.
    Object.keys(gPower || {}).forEach(k => {
      try {
        if (k && typeof k === 'string') candidateKeys.add(k);
      } catch (e) {}
    });

    // For each candidate key, add its canonical base (via addOrigKey) but prefer richer representatives
    // so when multiple sensor topics map to the same canonical base we keep the one with site+metric first.
    const candidates = Array.from(candidateKeys);
    // Sort candidates to prefer those containing metric segments (longer core path) and site info
    candidates.sort((a, b) => {
      const ca = (a.match(/\//g) || []).length;
      const cb = (b.match(/\//g) || []).length;
      // More segments -> prefer
      return cb - ca;
    });
    candidates.forEach(addOrigKey);

    const arr = Array.from(seen.entries()).map(([key, val]) => ({ key, label: val.label, representative: val.representative }));
    // sort by label for stable alphabetical ordering (case-insensitive, numeric-aware)
    arr.sort((a, b) => {
      try {
        const A = String(a.label || a.key || '').toUpperCase();
        const B = String(b.label || b.key || '').toUpperCase();
        if (A === B) return 0;
        return A < B ? -1 : 1;
      } catch (e) { return 0; }
    });
    return arr;
  }, [gSensors, gTargets, gMeta, gPower, mode, customerSlug, dbSensorBases]);

  // Filtered list according to mode: customer slug => includes that segment; BREW => excludes customer segments.
  // If `mode` is not set yet, fall back to `customerSlug` (snapshot /api/latest may provide it).
        const filteredDevices = useMemo(() => {
          if (!deviceList.length) return deviceList;
          const effectiveMode = mode || (customerSlug ? String(customerSlug).toUpperCase() : null);
          const wantCustomer = effectiveMode && effectiveMode !== 'BREW';
          const currentCustomer = wantCustomer ? effectiveMode : null;

          // Helper: derive the site (customer slug) portion from a canonical baseKey like "RAIL/Device".
          const siteOf = (baseKey) => {
            if (!baseKey || typeof baseKey !== 'string') return null;
                    const parts = baseKey.split('/').filter(Boolean);
                    if (parts.length >= 2) {
                      // If gMeta has an explicit site for this base, prefer it (handles legacy/tele arrivals)
                      try {
                        const meta = gMeta && (gMeta[baseKey] || gMeta[`${parts[0]}/${parts[1]}`]);
                        if (meta && meta.site) return String(meta.site).toUpperCase();
                      } catch (e) {}
                      return parts[0].toUpperCase();
                    }
                    return null;
          };

          return deviceList.filter(d => {
            const baseKey = d.key;
            if (!baseKey) return false;
            // Always exclude DUMMY placeholders
            if (/^DUMMY/i.test(baseKey)) return false;

            // If the server provided dbSensorBases, enforce that only those bases are visible.
            if (dbSensorBases && dbSensorBases.size > 0) {
              // The db set may contain metric-bearing bases; allow prefix matches (e.g., site/device and site/device/metric)
              const matchesDb = Array.from(dbSensorBases).some(b => {
                if (!b) return false;
                if (b === baseKey) return true;
                // allow db entry "SITE/Device/Metric" to also authorize "SITE/Device"
                if (b.startsWith(baseKey + '/')) return true;
                // allow db entry "SITE/Device" to authorize a metric-bearing canonical baseKey
                if (baseKey.startsWith(b + '/')) return true;
                return false;
              });
              if (!matchesDb) return false;
            }

            // If we have authoritative DB entries but no customer context yet, don't show anything.
            // This prevents prematurely showing BREW devices to customers who belong to another org.
            if (dbSensorBases && dbSensorBases.size > 0 && !effectiveMode) return false;

            // Prefer site reported in gMeta for this canonical base (handles topics that arrived
            // without explicit org prefix and were later associated via discovery).
            const site = siteOf(baseKey);
            if (wantCustomer) {
              // show only bases that belong to the customer's site
              return site === currentCustomer;
            } else {
              // For BREW or unscoped, hide customer-prefixed bases (explicit site other than BREW)
              return !site || site === 'BREW';
            }
          });
        }, [deviceList, mode, customerSlug, dbSensorBases]);

  // Helper to resolve a power label for a given canonical base and powerKey.
  // This will try direct matches, canonical candidate variants, uppercase keys,
  // and finally a device-name scoped fallback so labels appear in the right customer context.
  const getPowerLabel = (baseKey, powerKey) => {
    if (!baseKey || !powerKey) return '';
    try {
      const pk = String(powerKey).toUpperCase();
      const direct = `${baseKey}|${pk}`;
      if (powerLabels[direct]) return powerLabels[direct];
      // try uppercase direct
      if (powerLabels[direct.toUpperCase()]) return powerLabels[direct.toUpperCase()];

      // Try canonical candidate topics (admin stored topics may use tele/... variants)
      const candidates = canonicalCandidatesForTopic(baseKey);
      // If baseKey looks like SITE/DEVICE, also try tele/<site>/<device>/STATE and
      // legacy tele/<device>/STATE variants so labels stored under those topics are found.
      try {
        const parts = String(baseKey || '').split('/').filter(Boolean);
        if (parts.length >= 2) {
          const site = parts[0];
          const device = parts[1];
          candidates.push(`tele/${site}/${device}/STATE`);
          candidates.push(`tele/${device}/STATE`);
          candidates.push(`tele/${site}/${device}/STATE`.toUpperCase());
          candidates.push(`tele/${device}/STATE`.toUpperCase());
        } else if (parts.length === 1) {
          const device = parts[0];
          candidates.push(`tele/${device}/STATE`);
          candidates.push(`tele/${device}/STATE`.toUpperCase());
        }
      } catch (e) {}
      for (const c of candidates) {
        const k = `${c}|${pk}`;
        if (powerLabels[k]) return powerLabels[k];
        if (powerLabels[k.toUpperCase()]) return powerLabels[k.toUpperCase()];
      }

      // Last resort: try matching by device name across powerLabels keys where customer matches
      const parts = baseKey.split('/').filter(Boolean);
      const deviceName = parts.length >= 2 ? parts[1] : parts[0];
      if (deviceName) {
        const upDev = deviceName.toUpperCase();
        for (const k of Object.keys(powerLabels || {})) {
          try {
            const [topicPart, keyPart] = k.split('|');
            if (!keyPart) continue;
            if (keyPart.toUpperCase() !== pk) continue;
            // If the topicPart ends with the device name or contains `/device` then prefer it
            const t = (topicPart || '').toUpperCase();
            if (t.endsWith(`/${upDev}`) || t.includes(`/${upDev}/`) || t === upDev) return powerLabels[k];
          } catch (e) {}
        }
      }
    } catch (e) {}
    return '';
  };

  const [connectionError, setConnectionError] = useState(false);
  // diagnostics for missing Target currents
  const targetRequestCounts = useRef({}); // base -> count of get requests sent
  const targetReceiveCounts = useRef({}); // base -> count of current/ message target receipts

  // debug helper (reads module-level DEBUG toggle)
  const debug = (...args) => { if (DEBUG) console.log('Dashboard DEBUG:', ...args); };

  const resolveHost = () => {
    if (USE_PUBLIC_WS) return PUBLIC_WS_HOST;
    if (FORCED_HOST) return FORCED_HOST;
    // Expo provides debuggerHost in Constants.manifest (or Constants.manifest2) when in dev.
    try {
      const manifest = Constants.manifest || (Constants.expoConfig || {});
      const dh = manifest.debuggerHost || manifest.packagerOpts?.url || manifest.bundleUrl || '';
      if (typeof dh === 'string' && dh.includes(':')) {
        const parts = dh.split(':');
        const host = parts[0];
        // strip possible protocol
        return host.replace(/\/.*/, '').replace('http://', '').replace('https://', '');
      }
    } catch (e) {}
    // fallback to configured public host or server FQDN
    try { if (typeof PUBLIC_WS_HOST === 'string' && PUBLIC_WS_HOST) return PUBLIC_WS_HOST; } catch (e) {}
    return (process.env.SERVER_FQDN || 'api.brewingremote.com');
  };

  const reconnectMeta = useRef({ attempts: 0, timer: null });

  const scheduleReconnect = () => {
    if (!token) return; // no reconnect without auth
    const meta = reconnectMeta.current;
    // exponential-ish backoff with a cap ( 0:0.5s,1:1s,2:2s,3:3s,4+:5s )
    const a = meta.attempts;
    const delay = a === 0 ? 500 : a === 1 ? 1000 : a === 2 ? 2000 : a === 3 ? 3000 : 5000;
    if (meta.timer) clearTimeout(meta.timer);
    meta.timer = setTimeout(() => {
      connectWebSocket();
    }, delay);
  };

  const isReactNative = (() => {
    try { return (typeof navigator !== 'undefined' && navigator.product === 'ReactNative'); } catch (e) { return false; }
  })();

  const connectWebSocket = async () => {
    if (!token) return false; // don't attempt without JWT
    const host = resolveHost();
    const base = USE_PUBLIC_WS ? `wss://${host}${PUBLIC_WS_PATH}` : `ws://${host}:8080`;
    // include token as query param (primary). We'll add a fallback retry with a single subprotocol only if needed.
    const url = `${base}?token=${encodeURIComponent(token)}`;
    debug('[WS attempt] primary url=', url, 'token.len=', token && token.length);
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      // helper to avoid sending on sockets that are not OPEN
      const safeSend = (socket, payload) => {
        try {
          if (!socket) return;
          if (socket.readyState !== 1) return;
          socket.send(JSON.stringify(payload));
        } catch (e) { /* swallow send errors */ }
      };

      ws.onopen = () => {
        // reset attempts
        reconnectMeta.current.attempts = 0;
        // clear any connection error state on open
        try { setConnectionError(false); } catch (e) {}
  debug('WS open -> requesting initial gets for default devices');
        // request current target and sensor for the default devices once connected
        const sendInitialGets = () => {
          defaultDevices.forEach(d => {
            safeSend(ws, { type: 'get', topic: `${d.key}/Target`, id: `${d.key}-init-target` });
            safeSend(ws, { type: 'get', topic: `${d.key}/Sensor`, id: `${d.key}-init-sensor` });
            targetRequestCounts.current[d.key] = (targetRequestCounts.current[d.key] || 0) + 1;
          });
        };
        // ask bridge for a snapshot inventory to populate cache without extra GET churn
  safeSend(ws, { type: 'inventory', id: 'initial-inventory' });
        // initial burst, plus retries after 1s and 3s to handle missed replies
        setTimeout(sendInitialGets, 200);
        setTimeout(sendInitialGets, 1000);
        setTimeout(sendInitialGets, 3000);
        
        // Query power states for known devices
        const queryAllPowerStates = () => {
          const devices = ['FERM2', 'FERM4', 'FERM5', 'MASH', 'HLT', 'BOIL'];
          devices.forEach(deviceName => {
            // Query primary power state
            try { 
              safeSend(ws, { 
                type: 'publish', 
                topic: `cmnd/${deviceName}/Power`, 
                payload: '', 
                id: `init-pwq-${deviceName}-${Date.now()}` 
              }); 
            } catch(e) {}
            
            // Query additional power states for multi-switch devices
            const multiSwitchDevices = ['MASH', 'HLT', 'BOIL'];
            if (multiSwitchDevices.includes(deviceName)) {
              for (let i = 1; i <= 3; i++) {
                try {
                  safeSend(ws, { 
                    type: 'publish', 
                    topic: `cmnd/${deviceName}/Power${i}`, 
                    payload: '', 
                    id: `init-pwq-${deviceName}-p${i}-${Date.now()}` 
                  }); 
                } catch(e) {}
              }
            }
          });
        };
        
        // Query power states on connection and with retries
        setTimeout(queryAllPowerStates, 500);
        setTimeout(queryAllPowerStates, 2000);
        setTimeout(queryAllPowerStates, 5000);
        // targeted retry loop: every 4s for first 30s only for bases missing either sensor or target
        let retryCount = 0;
        const retryTimer = setInterval(() => {
          retryCount += 1;
          if (retryCount > 7) { clearInterval(retryTimer); return; } // ~28s window
          const bases = defaultDevices.map(d=>d.key);
          bases.forEach(base => {
            const haveSensor = gSensors[base] !== undefined && gSensors[base] !== null;
            const haveTarget = gTargets[base] !== undefined && gTargets[base] !== null;
            if (!haveSensor) {
              const id = base + '-retry-sensor-' + retryCount;
              safeSend(ws, { type: 'get', topic: `${base}/Sensor`, id });
            }
            if (!haveTarget) {
              const id = base + '-retry-target-' + retryCount;
              safeSend(ws, { type: 'get', topic: `${base}/Target`, id }); targetRequestCounts.current[base] = (targetRequestCounts.current[base] || 0) + 1;
            }
          });
        }, 4000);
        // store timer on ref for cleanup
        ws._retryTimer = retryTimer;
      };
      ws.onmessage = (ev) => {
        try {
          const obj = JSON.parse(ev.data);
          debug('WS message', obj.type, obj.topic || obj.data?.topic || 'no-topic');
          // helper to mark the connection healthy (clear the 6s timeout and overlay)
          const markConnected = () => {
            try { setConnectionError(false); setLoading(false); } catch (e) {}
            if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
          };

          // Topic parsing helper (expects <site>/<device>/<metric>/<Sensor|Target>)
          const parseTopic = (topic) => {
            if (!topic || typeof topic !== 'string') return null;
            const parts = topic.split('/').filter(Boolean);
            if (parts.length < 2) return null; // must have at least a terminal and one element
            const last = parts[parts.length - 1];
            if (!/^(Sensor|Target)$/i.test(last)) return null;
            const terminal = last;

            // Remove optional leading 'tele' or 'stat' prefix so remaining parts are the core path
            let startIdx = 0;
            if (parts[0] && (parts[0].toLowerCase() === 'tele' || parts[0].toLowerCase() === 'stat')) startIdx = 1;
            const core = parts.slice(startIdx, parts.length - 1); // drop terminal
            let site = null, device = null, metric = null;
            if (core.length === 1) {
              // <device>/Sensor  (legacy)
              device = core[0];
            } else if (core.length === 2) {
              // <site>/<device>/Sensor
              site = core[0]; device = core[1];
            } else if (core.length >= 3) {
              // <site>/<device>/<metric>/Sensor (or longer)
              site = core[0]; device = core[1]; metric = core[2];
            }
            return { site, device, metric, terminal };
          };

          const registerMeta = (baseKey, meta) => {
            if (!baseKey || !meta) return;
            setGMeta(prev => (prev[baseKey] ? prev : { ...prev, [baseKey]: meta }));
          };
          // Helper to derive a canonical base (CUSTOMER/DEVICE[/METRIC]) from parsed topic meta
          const canonicalBaseFromMeta = (m) => {
            if (!m) return null;
            const metric = m.metric || null;
            let site = m.site || null;
            const device = m.device || null;
            if (!device) return null;
            // If site missing, map legacy topic into current customer context if available
            if (!site) {
              // Prefer explicit mode (customer slug) if it's set and not 'BREW'
              if (mode && mode !== 'BREW') site = mode;
              else if (customerSlug) site = customerSlug;
              else site = null; // will be handled by caller (queue) if needed
            }
            if (!site) return null;
            if (metric) return `${site}/${device}/${metric}`;
            return `${site}/${device}`;
          };
            const applySensor = (topic, val) => {
            const meta = parseTopic(topic);
            if (!meta) return;
            // If site missing, prefer discovery inference; otherwise default to BREW
            if (!meta.site) {
              const inferred = findSiteForDevice(meta.device);
              meta.site = inferred || 'BREW';
            }
            // build canonical base using current mode/customerSlug
            const canonical = canonicalBaseFromMeta(meta) || (meta.metric ? `${meta.device}/${meta.metric}` : `${meta.device}`);
            if (!canonical) return;
            setGSensors(prev => ({ ...prev, [canonical]: val }));
            // register enriched meta under canonical base
            const enrichedMeta = { site: (meta.site || (mode && mode !== 'BREW' ? mode : customerSlug || 'BREW')), device: meta.device, metric: meta.metric || null, terminal: 'Sensor' };
            registerMeta(canonical, enrichedMeta);
            // Auto-request target for canonical base if missing
            if (!(canonical in gTargets) && wsRef.current && wsRef.current.readyState === 1) {
              const reqId = canonical + '-auto-target';
              try { wsRef.current.send(JSON.stringify({ type: 'get', topic: `${canonical}/Target`, id: reqId })); targetRequestCounts.current[canonical] = (targetRequestCounts.current[canonical] || 0) + 1; } catch (e) {}
            }
            // Auto-query power states for newly discovered devices
            const queryPowerStates = (customerSlug, deviceName) => {
              if (!wsRef.current || wsRef.current.readyState !== 1) return;
              
              const baseKey = `${customerSlug}/${deviceName}`;
              if (gPower[baseKey]) return; // Already have power state
              
              // Query primary power state
              try { 
                wsRef.current.send(JSON.stringify({ 
                  type: 'publish', 
                  topic: `cmnd/${deviceName}/Power`, 
                  payload: '', 
                  id: `pwq-${deviceName}-${Date.now()}` 
                })); 
              } catch(e) {}
              
              // Query additional power states (POWER1, POWER2, POWER3) for multi-switch devices
              const commonMultiSwitchDevices = ['MASH', 'HLT', 'BOIL'];
              if (commonMultiSwitchDevices.some(d => deviceName.toUpperCase().includes(d))) {
                for (let i = 1; i <= 3; i++) {
                  try {
                    wsRef.current.send(JSON.stringify({ 
                      type: 'publish', 
                      topic: `cmnd/${deviceName}/Power${i}`, 
                      payload: '', 
                      id: `pwq-${deviceName}-p${i}-${Date.now()}` 
                    })); 
                  } catch(e) {}
                }
              }
            };
            
            // Detect device patterns and query power states
            const customerSensorMatch = topic.match(/^tele\/([^/]+)\/([^/]+)\/SENSOR$/i);
            if (customerSensorMatch) {
              const [, customerSlugFromTopic, dev] = customerSensorMatch;
              queryPowerStates(customerSlugFromTopic, dev);
            }
            
            // Also check for direct device topics without customer prefix
            const directSensorMatch = topic.match(/^tele\/([^/]+)\/SENSOR$/i);
            if (directSensorMatch && mode) {
              const [, dev] = directSensorMatch;
              queryPowerStates(mode, dev);
            }

            // Persist discovered canonical base back to server topics DB if it's a defaulted/legacy mapping
            try {
              // If dbSensorBases has entries, only persist bases that are missing from it
              const hasDbEntries = dbSensorBases && dbSensorBases.size;
              const alreadyPersisted = persistedBasesRef.current.has(canonical) || (dbSensorBases && dbSensorBases.has(canonical));
              if (!alreadyPersisted) {
                // Construct a rawTopic guess that matches legacy patterns (tele/<device>/Sensor) when original topic lacked site
                const rawTopicGuess = topic;
                persistBaseToDB(canonical, rawTopicGuess, enrichedMeta).catch(e => {});
              }
            } catch (e) {}
          };
          const applyTarget = (topic, val) => {
            const meta = parseTopic(topic);
            if (!meta) return;
            // If site missing, prefer discovery inference; otherwise default to BREW
            if (!meta.site) {
              const inferred = findSiteForDevice(meta.device);
              meta.site = inferred || 'BREW';
            }
            const canonical = canonicalBaseFromMeta(meta) || (meta.metric ? `${meta.device}/${meta.metric}` : `${meta.device}`);
            if (!canonical) return;
            setGTargets(prev => ({ ...prev, [canonical]: val }));
            const enrichedMeta = { site: (meta.site || (mode && mode !== 'BREW' ? mode : customerSlug || 'BREW')), device: meta.device, metric: meta.metric || null, terminal: 'Target' };
            registerMeta(canonical, enrichedMeta);
          };
          // Enhanced POWER state extractor for multiple topic patterns
          const applyPower = (topic, payloadObj) => {
            if (!payloadObj || typeof payloadObj !== 'object') return;
            if (!/^(tele|stat)\//i.test(topic)) return; // Tasmota telemetry/state
            const parts = topic.split('/');
            
            // Helper to extract power states from payload
            const extractPowerStates = (obj) => {
              const found = {};
              Object.entries(obj).forEach(([k, v]) => {
                const up = k.toUpperCase();
                if (up === 'POWER' || /^POWER\d+$/.test(up)) {
                  const isOn = typeof v === 'string' ? v.toUpperCase() === 'ON' : !!v;
                  found[up] = isOn;
                }
              });
              return found;
            };
            
            const endSeg = parts[parts.length - 1].toUpperCase();
            if (!['STATE', 'RESULT'].includes(endSeg)) return;
            
            const powerStates = extractPowerStates(payloadObj);
            if (!Object.keys(powerStates).length) return;
            
            let baseKey = null;
            let deviceName = null;
            
            // Primary Pattern: tele/<customer>/<device>/(STATE|RESULT) - customer-prefixed (proper format)
            if (parts[0].toLowerCase() === 'tele' && parts.length === 4) {
              const customerFromTopic = parts[1];
              deviceName = parts[2];
              if (customerFromTopic && deviceName) {
                baseKey = `${customerFromTopic}/${deviceName}`;
              }
            }
            // Legacy Pattern: tele/<device>/(STATE|RESULT) - direct device (being phased out)
            else if (parts[0].toLowerCase() === 'tele' && parts.length === 3) {
              deviceName = parts[1];
              if (deviceName) {
                // Map legacy devices to current customer context; prefer mode, fall back to BREW
                const siteForLegacy = mode || 'BREW';
                baseKey = `${siteForLegacy}/${deviceName}`;
              }
            }
            // Response Pattern: stat/<device>/(STATE|RESULT) - device control responses
            else if (parts[0].toLowerCase() === 'stat' && parts.length === 3) {
              deviceName = parts[1];
              if (deviceName) {
                const siteForStat = mode || 'BREW';
                baseKey = `${siteForStat}/${deviceName}`;
              }
            }
            
            if (!baseKey || !deviceName) return;
            
            // Update meta information
            setGMeta(prev => {
              const existing = prev[baseKey];
              if (!existing && baseKey.includes('/')) {
                // Customer/Device format - store customer as site, device as device
                const [customerSlugFromKey, deviceFromKey] = baseKey.split('/');
                return { ...prev, [baseKey]: { site: customerSlugFromKey, device: deviceFromKey, metric: null } };
              }
              return prev;
            });
            
            // Update power states
            setGPower(prev => {
              const cur = { ...(prev[baseKey] || {}) };
              Object.assign(cur, powerStates);
              return { ...prev, [baseKey]: cur };
            });
          };

          if (obj.type === 'message' && obj.data && typeof obj.data.topic === 'string') {
            const topic = obj.data.topic;
            const lowerTopic = topic.toLowerCase();
            let raw = obj.data.payload;
            let n = Number(raw);
            let parsedJson = null;
            if (Number.isNaN(n) && /\/sensor$/i.test(topic)) {
              if (typeof raw === 'string') {
                try {
                  const js = JSON.parse(raw); parsedJson = js;
                  if (js && typeof js === 'object') {
                    if (typeof js.Temperature === 'number') n = js.Temperature;
                    if (Number.isNaN(n) && js.DS18B20 && typeof js.DS18B20.Temperature === 'number') n = js.DS18B20.Temperature;
                    if (Number.isNaN(n)) {
                      for (const v of Object.values(js)) {
                        if (v && typeof v === 'object' && typeof v.Temperature === 'number') { n = v.Temperature; break; }
                      }
                    }
                  }
                } catch (e) {}
              }
            }
            if (!parsedJson && raw && typeof raw === 'object') parsedJson = raw; // handle already-parsed objects
            if (!parsedJson && typeof raw === 'string' && /\/(state|result)$/i.test(topic)) { try { parsedJson = JSON.parse(raw); } catch(e) {} }
            if (parsedJson) applyPower(topic, parsedJson);
            if (!Number.isNaN(n)) {
              if (lowerTopic.endsWith('/sensor')) { applySensor(topic, n); markConnected(); }
              else if (lowerTopic.endsWith('/target')) { applyTarget(topic, n); markConnected(); }
            }
          }
          // also accept 'current' responses from the bridge for sensor gets
          if (obj.type === 'current' && typeof obj.topic === 'string' && /\/sensor$/i.test(obj.topic)) {
            const n = obj.payload === null ? null : Number(obj.payload);
            if (!Number.isNaN(n) && n !== null) { applySensor(obj.topic, n); markConnected(); debug('Current response (Sensor)', obj.topic, n); }
          }
          if (obj.type === 'current' && typeof obj.topic === 'string' && /\/target$/i.test(obj.topic)) {
            if (obj.payload !== null && obj.payload !== undefined && obj.payload !== '') {
              const n = Number(obj.payload);
              if (!Number.isNaN(n)) { applyTarget(obj.topic, n); markConnected(); debug('Current response (Target)', obj.topic, n); }
            }
          }
          // also accept 'current' responses from the bridge for sensor gets
          if (obj.type === 'current' && obj.topic === 'DUMMYtest/Sensor') {
            const n = obj.payload === null ? null : Number(obj.payload);
            if (!Number.isNaN(n) && n !== null) {
              setSensorValue(n);
              // mark connected
              markConnected();
              debug('Current DUMMYtest/Sensor', n);
            }
          }
          if (obj.type === 'current' && obj.topic === 'DUMMYtest/Target') {
            const n = obj.payload === null ? null : Number(obj.payload);
            if (n === null || Number.isNaN(n)) return;
            // broker is source-of-truth: update app-level and also update all known/default device targets
            setTargetValue(n);
            setGTargets(prev => {
              const next = { ...prev };
              defaultDevices.forEach(d => { next[d.key] = n; });
              return next;
            });
            // mark connected when DUMMYtest target arrives
            markConnected();
            debug('Current DUMMYtest/Target', n);
          }
          // grouped inventory snapshot (new message type from bridge)
          if (obj.type === 'grouped-inventory' && obj.data && typeof obj.data === 'object') {
            const groups = obj.data;
            const sensorAdds = {}; const targetAdds = {}; const metaAdds = {};
            Object.values(groups).forEach(g => {
              if (!g || !g.topics) return;
              Object.entries(g.topics).forEach(([topic, val]) => {
                  const parsed = parseTopic(topic);
                  if (!parsed) return;
                  // If site missing in grouped inventory, default to BREW (DB is source-of-truth)
                  if (!parsed.site) parsed.site = 'BREW';
                  // Canonicalize baseKey using parsed.site
                  const cand = canonicalBaseFromMeta(parsed);
                  let baseKey = null;
                  if (cand) baseKey = cand;
                const num = Number(val);
                if (/\/sensor$/i.test(topic) && !Number.isNaN(num)) sensorAdds[baseKey] = num;
                if (/\/target$/i.test(topic) && !Number.isNaN(num)) targetAdds[baseKey] = num;
                if (!metaAdds[baseKey]) metaAdds[baseKey] = parsed;
              });
            });
            if (Object.keys(sensorAdds).length) setGSensors(prev => ({ ...sensorAdds, ...prev }));
            if (Object.keys(targetAdds).length) setGTargets(prev => ({ ...targetAdds, ...prev }));
            if (Object.keys(metaAdds).length) setGMeta(prev => ({ ...prev, ...metaAdds }));
            markConnected();
          }
          // real-time every message broadcast
          if (obj.type === 'mqtt-message' && typeof obj.topic === 'string') {
            const lowerTopic = obj.topic.toLowerCase();
            let raw = obj.payload;
            // Special-case: tasmota discovery messages provide authoritative site/device info
            try {
              if (typeof obj.topic === 'string' && obj.topic.toLowerCase().startsWith('tasmota/discovery/')) {
                // payload may be JSON string or object
                let js = raw;
                if (typeof raw === 'string') {
                  try { js = JSON.parse(raw); } catch (e) { js = raw; }
                }
                // discovery config message may be under /config or /sensors topics
                const cfg = js || {};
                // config messages include a 't' field which may be 'RAIL/DEVICE' or 'DEVICE'
                const tfield = cfg.t || (cfg.config && cfg.config.t) || null;
                const sensorsObj = cfg.sn || cfg.sensors || null;
                if (tfield) {
                  try {
                    const tparts = String(tfield).split('/').filter(Boolean);
                    let site = null, device = null;
                    if (tparts.length >= 2) { site = tparts[0]; device = tparts.slice(1).join('/'); }
                    else { device = tparts[0]; }
                    if (device) {
                      const canonical = site ? `${site}/${device}` : `${device}`;
                      setGMeta(prev => ({ ...prev, [canonical]: { site: site || null, device, metric: null } }));
                      // If sensors payload exists, extract first Temperature reading
                      try {
                        const sn = sensorsObj || cfg.sensors || null;
                        if (sn && typeof sn === 'object') {
                          // Find any nested object that contains Temperature
                          const entries = Object.values(sn || {});
                          for (const e of entries) {
                            if (e && typeof e === 'object' && typeof e.Temperature === 'number') {
                              const temp = e.Temperature;
                              setGSensors(prev => ({ ...prev, [canonical]: temp }));
                              break;
                            }
                          }
                        }
                      } catch (e) {}
                    }
                  } catch (e) {}
                }
                // continue processing as usual after registering discovery
              }
            } catch (e) {}
            let n = Number(raw);
            let parsedJson = null;
            if (Number.isNaN(n) && /\/sensor$/i.test(obj.topic) && typeof raw === 'string') {
              try {
                const js = JSON.parse(raw); parsedJson = js;
                if (js && typeof js === 'object') {
                  if (typeof js.Temperature === 'number') n = js.Temperature;
                  if (Number.isNaN(n) && js.DS18B20 && typeof js.DS18B20.Temperature === 'number') n = js.DS18B20.Temperature;
                  if (Number.isNaN(n)) {
                    for (const v of Object.values(js)) {
                      if (v && typeof v === 'object' && typeof v.Temperature === 'number') { n = v.Temperature; break; }
                    }
                  }
                }
              } catch (e) {}
            }
            if (!parsedJson && raw && typeof raw === 'object') parsedJson = raw;
            if (!parsedJson && typeof raw === 'string' && /\/(state|result)$/i.test(obj.topic)) { try { parsedJson = JSON.parse(raw); } catch(e) {} }
            if (parsedJson) applyPower(obj.topic, parsedJson);
            if (!Number.isNaN(n)) {
              if (lowerTopic.endsWith('/sensor')) { applySensor(obj.topic, n); markConnected(); }
              else if (lowerTopic.endsWith('/target')) { applyTarget(obj.topic, n); markConnected(); }
            }
          }
          // inventory snapshot
          if (obj.type === 'inventory' && obj.data && typeof obj.data === 'object') {
            const inv = obj.data || {};
            const sensorAdds = {}; const targetAdds = {}; const metaAdds = {};
            Object.entries(inv).forEach(([topic, val]) => {
              const parsed = parseTopic(topic);
              if (!parsed) return;
                // If site missing, default to BREW so DB-backed snapshot entries are canonicalized
                if (!parsed.site) parsed.site = 'BREW';
                const baseKey = canonicalBaseFromMeta(parsed) || (parsed.metric ? `${parsed.device}/${parsed.metric}` : `${parsed.device}`);
              const n = Number(val);
              if (/\/sensor$/i.test(topic) && !Number.isNaN(n)) sensorAdds[baseKey] = n;
              if (/\/target$/i.test(topic) && !Number.isNaN(n)) targetAdds[baseKey] = n;
              if (!metaAdds[baseKey]) metaAdds[baseKey] = parsed;
            });
            if (Object.keys(sensorAdds).length) setGSensors(prev => ({ ...sensorAdds, ...prev }));
            if (Object.keys(targetAdds).length) setGTargets(prev => ({ ...targetAdds, ...prev }));
            if (Object.keys(metaAdds).length) setGMeta(prev => ({ ...prev, ...metaAdds }));
            debug('Applied inventory snapshot (parsed)', Object.keys(sensorAdds).length, 'sensors,', Object.keys(targetAdds).length, 'targets');
          }
        } catch (e) {
          // ignore per-message parse errors
        }
      };
      ws.onclose = () => {
        // clear any retry timer associated with this socket so it won't try to send on a closed socket
        try { if (ws && ws._retryTimer) { clearInterval(ws._retryTimer); ws._retryTimer = null; } } catch (e) {}
        wsRef.current = null;
        // attempt reconnect if token still valid and user hasn't logged out
        if (token) {
          reconnectMeta.current.attempts += 1;
          scheduleReconnect();
        }
      };
      ws.onerror = () => {
        wsRef.current = null;
      };
      return true;
    } catch (e) {
      return false;
    }
  };

  // Fallback: if first connection attempt after mount/token doesn't reach OPEN state within 1.2s, try again once with a single Bearer subprotocol carrying token.
  useEffect(() => {
    if (!token) return;
    // Only consider adding fallback on the very first attempt sequence
    if (reconnectMeta.current.attempts !== 0) return;
    const timer = setTimeout(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== 1) {
        // abort any half-open socket
        try { ws && ws.close(); } catch (e) {}
        const host = resolveHost();
        const base = USE_PUBLIC_WS ? `wss://${host}${PUBLIC_WS_PATH}` : `ws://${host}:8080`;
        const fallbackUrl = `${base}?token=${encodeURIComponent(token)}`;
        try {
          // Fallback attempt without a subprotocol. Previous code used a subprotocol string
          // with a space ("Bearer <token>") which is not RFC6455-compliant (tokens cannot contain spaces).
          // Token is already conveyed via the query parameter, so we omit subprotocol entirely here.
          let alt;
          if (isReactNative) {
            // React Native's WebSocket implementation supports a headers options object as 2nd/3rd param.
            // Attempt with Authorization header in case query param is being stripped or cached strangely.
            try {
              // Some RN versions accept (url, null, { headers }); others (url, [], { headers })
              alt = new WebSocket(fallbackUrl, [], { headers: { Authorization: `Bearer ${token}` } });
              debug('[WS fallback] RN header attempt with Authorization, url=', fallbackUrl);
            } catch (e) {
              debug('[WS fallback] header attempt failed to construct, falling back to plain url', e && e.message);
              alt = new WebSocket(fallbackUrl);
            }
          } else {
            alt = new WebSocket(fallbackUrl);
          }
          wsRef.current = alt;
          alt.onopen = () => {
            reconnectMeta.current.attempts = 0;
            try { setConnectionError(false); } catch (e) {}
          };
          alt.onclose = () => { wsRef.current = null; if (token) { reconnectMeta.current.attempts += 1; scheduleReconnect(); } };
          alt.onerror = () => { wsRef.current = null; };
        } catch (e) { /* ignore */ }
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [token, connectAttempt]);

  // Log token arrival timing relative to initial mount to detect race where first attempt has no token
  useEffect(() => {
    if (!token) return;
    debug('[TOKEN ready] len=', token.length, 'head=', token.slice(0,10));
  }, [token]);

  useEffect(() => {
    if (!token) return; // wait until token provided
    setConnectionError(false);
    setLoading(true);
    // Mode will be set from customer info in /api/latest response
    try { wsRef.current && wsRef.current.close(); } catch (e) {}
    if (reconnectMeta.current.timer) { clearTimeout(reconnectMeta.current.timer); reconnectMeta.current.timer = null; }
    connectWebSocket();
    // Hydrate last-known values from localStorage for immediate UX (web only)
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const s = window.localStorage.getItem('brewski.gsensors'); if (s) setGSensors(prev=>({ ...JSON.parse(s), ...prev }));
        const t = window.localStorage.getItem('brewski.gtargets'); if (t) setGTargets(prev=>({ ...JSON.parse(t), ...prev }));
        const m = window.localStorage.getItem('brewski.gmeta'); if (m) setGMeta(prev=>({ ...JSON.parse(m), ...prev }));
        const p = window.localStorage.getItem('brewski.gpower'); if (p) setGPower(prev=>({ ...JSON.parse(p), ...prev }));
      }
    } catch(e) {}
    (async () => {
      try {
        const path = '/thresholds';
        const base = (IS_REACT_NATIVE || !(typeof window !== 'undefined' && window.apiFetch)) ? `https://${resolveHost()}` : '';
        const url = base ? `${base}${path}` : path;
        const res = await (typeof window !== 'undefined' && window.apiFetch ? window.apiFetch(path) : fetch(url));
        if (res.status === 401) { try { window.dispatchEvent(new CustomEvent('brewski-unauthorized')); } catch (e) {} return; }
        const js = await res.json();
        if (js && js.overrides) setThresholds(js.overrides);
      } catch(e) {}
    })();
    // NEW: Snapshot hydrate from /api/latest so gauges and POWER states render immediately after reload (before live MQTT)
    (async () => {
      try {
        const latestPath = '/api/latest';
        let res;
        if (typeof window !== 'undefined' && window.apiFetch) {
          try { res = await window.apiFetch(latestPath); } catch (e) { res = null; }
        }
        if (!res) {
          // Fallback to absolute URL in RN or when apiFetch absent
          const base = (IS_REACT_NATIVE || !(typeof window !== 'undefined' && window.apiFetch)) ? `https://${resolveHost()}` : '';
          const url = token ? `${base}${latestPath}?token=${encodeURIComponent(token)}` : `${base}${latestPath}`;
          res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
        }
        if (!res || !res.ok) return; // ignore failures silently
        const js = await res.json();
        if (!js || !js.sensors || !Array.isArray(js.sensors)) return;

        // Extract customer information for dynamic filtering
        if (js.customer && js.customer.slug) {
          setCustomerSlug(js.customer.slug);
          // Set mode to user's actual customer slug (BREW users get BREW, others get their slug)
          setMode(js.customer.slug.toUpperCase());
          // store numeric customer id if present so we can persist topics via admin API
          if (js.customer.id) setCustomerId(js.customer.id);
          // Notify parent component about customer info for header title
          if (onCustomerLoaded) {
            onCustomerLoaded(js.customer);
          }
        }

  const addsSensors = {}, addsMeta = {}, addsPower = {};
  // collect authoritative DB-backed sensor bases from the snapshot
  const seenDbBases = new Set();
        js.sensors.forEach(row => {
          if (!row) return;
          const lv = row.last_value;
          if (lv === null || lv === undefined) return;
          const rawTopic = (row.topic_key || row.key || '').trim();
          if (!rawTopic) return;

          // Parse snapshot topic similarly to live parseTopic: strip tele/stat prefix,
          // drop terminal (Sensor/Target/State) and build canonical baseKey.
          const parts = rawTopic.split('/').filter(Boolean);
          // detect and remove trailing terminal if present
          const lastPart = parts[parts.length - 1];
          const hasTerminal = /^(SENSOR|TARGET|STATE|RESULT)$/i.test(lastPart);
          let startIdx = 0;
          if (parts[0] && (parts[0].toLowerCase() === 'tele' || parts[0].toLowerCase() === 'stat')) startIdx = 1;
          const core = parts.slice(startIdx, hasTerminal ? parts.length - 1 : parts.length);
          let site = null, device = null, metric = null, terminal = (hasTerminal ? lastPart : null);
          if (core.length === 1) {
            device = core[0];
          } else if (core.length === 2) {
            site = core[0]; device = core[1];
          } else if (core.length >= 3) {
            site = core[0]; device = core[1]; metric = core[2];
          }

          // Default missing site to BREW so snapshot canonicalization matches runtime
          if (!site) site = 'BREW';

          // Reconstruct canonical baseKey matching applySensor logic
          let baseKey;
          if (metric) baseKey = site ? `${site}/${device}/${metric}` : `${device}/${metric}`;
          else if (site && device) baseKey = `${site}/${device}`;
          else if (device) baseKey = `${device}`;
          else baseKey = rawTopic;

          // If this snapshot row is not a STATE/RESULT-only entry, record the base
          // as an authoritative DB-backed sensor base. We avoid using STATE/RESULT
          // entries (control/state-only) to drive gauge creation.
          if (!(hasTerminal && /^(STATE|RESULT)$/i.test(lastPart))) {
            seenDbBases.add(baseKey);
          }

          // Hydrate POWER states: topic may end with POWER or POWER1 etc.
          const powerLastSeg = rawTopic.split('/').slice(-1)[0];
          if (/^POWER\d*$/i.test(powerLastSeg)) {
            // Determine power base key (site/device) from parsed parts
            if (site && device) {
              const powerBaseKey = `${site}/${device}`;
              const powerKey = powerLastSeg.toUpperCase();
              if (!addsPower[powerBaseKey]) addsPower[powerBaseKey] = {};
              let isOn = false;
              if (typeof lv === 'string') {
                isOn = lv === 'ON' || lv === '1' || lv === 'true';
              } else if (typeof lv === 'number') {
                isOn = lv === 1;
              } else if (typeof lv === 'boolean') {
                isOn = lv;
              }
              addsPower[powerBaseKey][powerKey] = isOn;
              if (!addsMeta[powerBaseKey]) addsMeta[powerBaseKey] = { site, device, metric: null };
            }
            return;
          }

          // Normal sensor hydration
          const num = Number(lv);
          if (Number.isNaN(num)) return;
          if (addsSensors[baseKey] === undefined && gSensors[baseKey] === undefined) {
            addsSensors[baseKey] = num;
            if (!addsMeta[baseKey]) addsMeta[baseKey] = { site, device, metric, terminal: 'Sensor' };
          }
        });
  if (Object.keys(addsSensors).length) setGSensors(prev => ({ ...addsSensors, ...prev }));
  if (Object.keys(addsMeta).length) setGMeta(prev => ({ ...addsMeta, ...prev }));
  if (Object.keys(addsPower).length) setGPower(prev => ({ ...addsPower, ...prev }));
  if (seenDbBases.size) {
    const newDbSet = new Set(Array.from(seenDbBases));
    setDbSensorBases(newDbSet);

    // Snapshot hydrate completed: clear loading overlay and cancel the connection timeout
    try {
      setLoading(false);
      if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
    } catch (e) {}

    // If the WebSocket is already open, proactively request current Sensor/Target
    // values and query device power states so the UI renders immediately without
    // waiting for live MQTT messages to arrive.
    try {
      const ws = wsRef.current;
      if (ws && ws.readyState === 1) {
        for (const base of Array.from(newDbSet)) {
          if (!base) continue;
          // Request Sensor and Target for the canonical base
          try {
            const idS = `snap-get-sensor-${base}-${Date.now()}`;
            ws.send(JSON.stringify({ type: 'get', topic: `${base}/Sensor`, id: idS }));
            targetRequestCounts.current[base] = (targetRequestCounts.current[base] || 0) + 1;
          } catch (e) {}
          try {
            const idT = `snap-get-target-${base}-${Date.now()}`;
            ws.send(JSON.stringify({ type: 'get', topic: `${base}/Target`, id: idT }));
            targetRequestCounts.current[base] = (targetRequestCounts.current[base] || 0) + 1;
          } catch (e) {}

          // Query power states by device name (derive from canonical base)
          try {
            const parts = base.split('/').filter(Boolean);
            const deviceName = parts.length >= 2 ? parts[1] : parts[0];
            if (deviceName) {
              // Primary power query
              try { ws.send(JSON.stringify({ type: 'publish', topic: `cmnd/${deviceName}/Power`, payload: '', id: `snap-pwq-${deviceName}-${Date.now()}` })); } catch(e) {}
              // Additional multi-switch queries (best-effort)
              for (let i = 1; i <= 3; i++) {
                try { ws.send(JSON.stringify({ type: 'publish', topic: `cmnd/${deviceName}/Power${i}`, payload: '', id: `snap-pwq-${deviceName}-p${i}-${Date.now()}` })); } catch(e) {}
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
      } catch(e) {
        // swallow snapshot errors; UI will still populate from live stream
      }
    })();
    connTimeoutRef.current = setTimeout(() => { setConnectionError(true); setLoading(false); connTimeoutRef.current = null; }, 6000);
    return () => {
      try { wsRef.current && wsRef.current.close(); } catch (e) {}
      try { if (wsRef.current && wsRef.current._retryTimer) clearInterval(wsRef.current._retryTimer); } catch (e) {}
      if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
      if (reconnectMeta.current.timer) { clearTimeout(reconnectMeta.current.timer); reconnectMeta.current.timer = null; }
    };
  }, [token]);

  // No more mode persistence or auto-switching - users see their assigned customer's devices

  // Process queued power messages when mode becomes available
  useEffect(() => {
    if (!mode || !pendingPowerMessages.length) return;
    
    pendingPowerMessages.forEach(({ topic, powerStates, deviceName, type }) => {
      const baseKey = `${mode}/${deviceName}`;
      
      // Update meta information
      setGMeta(prev => {
        const existing = prev[baseKey];
        if (!existing) {
          return { ...prev, [baseKey]: { site: mode, device: deviceName, metric: null } };
        }
        return prev;
      });
      
      // Update power states
      setGPower(prev => {
        const cur = { ...(prev[baseKey] || {}) };
        Object.assign(cur, powerStates);
        return { ...prev, [baseKey]: cur };
      });
    });
    
    // Clear the queue
    setPendingPowerMessages([]);
  }, [mode, pendingPowerMessages]);

  // Process queued sensor/target messages when mode becomes available
  useEffect(() => {
    if (!mode || !pendingSensorMessages.length) return;
    pendingSensorMessages.forEach(m => {
      try {
        if (m.type === 'sensor') {
          // reuse existing applySensor logic by invoking parsed flow
          const parsed = null;
          // call the same parsing machinery by sending through applySensor local function
          // we emulate by calling onmessage handler via direct function - replicate minimal logic
          const topic = m.topic; const val = m.val;
          // parse and apply using same helpers
          const tmpMeta = (function parseTopicInline(topicStr) {
            const parts = topicStr.split('/').filter(Boolean);
            if (parts.length < 2) return null;
            const last = parts[parts.length - 1];
            if (!/^(Sensor|Target)$/i.test(last)) return null;
            let startIdx = 0; if (parts[0] && (parts[0].toLowerCase() === 'tele' || parts[0].toLowerCase() === 'stat')) startIdx = 1;
            const core = parts.slice(startIdx, parts.length - 1);
            let site = null, device = null, metric = null;
            if (core.length === 1) device = core[0];
            else if (core.length === 2) { site = core[0]; device = core[1]; }
            else if (core.length >= 3) { site = core[0]; device = core[1]; metric = core[2]; }
            return { site, device, metric, terminal: last };
          })(topic);
          if (!tmpMeta) return;
          // Try to infer site if missing
          if (!tmpMeta.site) tmpMeta.site = findSiteForDevice(tmpMeta.device) || null;
          const canonical = (function canonicalBaseFromMetaInline(m) {
            if (!m) return null; const metric = m.metric || null; let site = m.site || null; const device = m.device || null; if (!device) return null; if (!site) site = mode || customerSlug || null; if (!site) return null; if (metric) return `${site}/${device}/${metric}`; return `${site}/${device}`;
          })(tmpMeta);
          if (!canonical) return;
          setGSensors(prev => ({ ...prev, [canonical]: m.val }));
          setGMeta(prev => ({ ...prev, [canonical]: { site: tmpMeta.site || mode || customerSlug, device: tmpMeta.device, metric: tmpMeta.metric || null, terminal: 'Sensor' } }));
        }
        if (m.type === 'target') {
          const topic = m.topic; const val = m.val;
          const tmpMeta = (function parseTopicInline(topicStr) {
            const parts = topicStr.split('/').filter(Boolean);
            if (parts.length < 2) return null;
            const last = parts[parts.length - 1];
            if (!/^(Sensor|Target)$/i.test(last)) return null;
            let startIdx = 0; if (parts[0] && (parts[0].toLowerCase() === 'tele' || parts[0].toLowerCase() === 'stat')) startIdx = 1;
            const core = parts.slice(startIdx, parts.length - 1);
            let site = null, device = null, metric = null;
            if (core.length === 1) device = core[0];
            else if (core.length === 2) { site = core[0]; device = core[1]; }
            else if (core.length >= 3) { site = core[0]; device = core[1]; metric = core[2]; }
            return { site, device, metric, terminal: last };
          })(topic);
          if (!tmpMeta) return;
          if (!tmpMeta.site) tmpMeta.site = findSiteForDevice(tmpMeta.device) || null;
          const canonical = (function canonicalBaseFromMetaInline(m) {
            if (!m) return null; const metric = m.metric || null; let site = m.site || null; const device = m.device || null; if (!device) return null; if (!site) site = mode || customerSlug || null; if (!site) return null; if (metric) return `${site}/${device}/${metric}`; return `${site}/${device}`;
          })(tmpMeta);
          if (!canonical) return;
          setGTargets(prev => ({ ...prev, [canonical]: m.val }));
          setGMeta(prev => ({ ...prev, [canonical]: { site: tmpMeta.site || mode || customerSlug, device: tmpMeta.device, metric: tmpMeta.metric || null, terminal: 'Target' } }));
        }
      } catch (e) {}
    });
    setPendingSensorMessages([]);
  }, [mode, pendingSensorMessages]);

  // Query power states when mode is established and WebSocket is connected
  useEffect(() => {
    if (!mode || !wsRef.current || wsRef.current.readyState !== 1) return;
    
    // Query power states for all known devices
    const queryPowerStatesForCustomer = () => {
      const devices = ['FERM2', 'FERM4', 'FERM5', 'MASH', 'HLT', 'BOIL'];
      
      devices.forEach(deviceName => {
        // Query primary power state
        try { 
          wsRef.current.send(JSON.stringify({ 
            type: 'publish', 
            topic: `cmnd/${deviceName}/Power`, 
            payload: '', 
            id: `customer-pwq-${deviceName}-${Date.now()}` 
          })); 
        } catch(e) {}
        
        // Query additional power states for multi-switch devices
        const multiSwitchDevices = ['MASH', 'HLT', 'BOIL'];
        if (multiSwitchDevices.includes(deviceName)) {
          for (let i = 1; i <= 3; i++) {
            try {
              wsRef.current.send(JSON.stringify({ 
                type: 'publish', 
                topic: `cmnd/${deviceName}/Power${i}`, 
                payload: '', 
                id: `customer-pwq-${deviceName}-p${i}-${Date.now()}` 
              })); 
            } catch(e) {}
          }
        }
      });
    };
    
    // Query immediately and with a small delay
    setTimeout(queryPowerStatesForCustomer, 100);
    setTimeout(queryPowerStatesForCustomer, 1000);
  }, [mode]);

  // Persist gauge-related state so reloads restore immediately before network traffic
  useEffect(() => {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      window.localStorage.setItem('brewski.gsensors', JSON.stringify(gSensors));
      window.localStorage.setItem('brewski.gtargets', JSON.stringify(gTargets));
      window.localStorage.setItem('brewski.gmeta', JSON.stringify(gMeta));
      window.localStorage.setItem('brewski.gpower', JSON.stringify(gPower));
    } catch (e) { /* ignore quota / serialization issues */ }
  }, [gSensors, gTargets, gMeta, gPower]);

  // animate displayedSensorValue toward sensorValue
  useEffect(() => {
    if (sensorValue === null) return;
    if (displayedSensorValue === null) { setDisplayedSensorValue(sensorValue); return; }
    let id = setInterval(() => {
      setDisplayedSensorValue(prev => {
        if (prev === null) return sensorValue;
        const diff = sensorValue - prev;
        if (Math.abs(diff) < 0.1) { clearInterval(id); return sensorValue; }
        return prev + diff * 0.25;
      });
    }, 50);
    return () => clearInterval(id);
  }, [sensorValue]);

  useEffect(() => {
    const pct = displayedSensorValue === null ? 0 : Math.max(0, Math.min(100, ((displayedSensorValue - SENSOR_MIN) / (SENSOR_MAX - SENSOR_MIN)) * 100));
    Animated.timing(anim, { toValue: pct, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    // smooth the needle
    Animated.timing(needleAnim, { toValue: pct, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [displayedSensorValue]);

  // spinner animation
  useEffect(() => {
    Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    ).start();
    const id = needleAnim.addListener(({ value }) => setNeedlePct(value));
    return () => {
      needleAnim.removeListener(id);
    };
  }, []);

  const publishTargetForDevice = (deviceKey, n) => {
    const val = Number(n);
    if (Number.isNaN(val)) return;
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    const id = Date.now() + '-' + Math.random().toString(36).slice(2,8);
    const topic = `${deviceKey}/Target`;
    try { wsRef.current.send(JSON.stringify({ type: 'publish', topic, payload: val, id })); debug('publish', topic, val, id); } catch (e) {}
    setTimeout(() => { try { wsRef.current && wsRef.current.send(JSON.stringify({ type: 'get', topic, id: id + '-get' })); } catch (e) {} }, 500);
  };
  const publishPower = (baseKey, powerKey, nextOn) => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    
    // baseKey should be in CUSTOMER/DEVICE format
    const parts = baseKey.split('/');
    if (parts.length !== 2) {
      console.warn('Invalid baseKey format, expected CUSTOMER/DEVICE:', baseKey);
      return;
    }
    
    const [customerSlug, deviceName] = parts;
    if (!customerSlug || !deviceName) {
      console.warn('Missing customer or device in baseKey:', baseKey);
      return;
    }
    
    // Tasmota command topics: cmnd/<Device>/<Power or Power1/Power2/etc>
    const cmdKey = powerKey === 'POWER' ? 'Power' : powerKey.replace(/^POWER/, 'Power');
    const topic = `cmnd/${deviceName}/${cmdKey}`;
    const payload = nextOn ? 'ON' : 'OFF';
    const id = `pw-${customerSlug}-${deviceName}-${cmdKey}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    
    try { 
      wsRef.current.send(JSON.stringify({ 
        type: 'publish', 
        topic, 
        payload, 
        id 
      })); 
      
      // Optimistically update local state for immediate UI feedback
      setGPower(prev => {
        const current = prev[baseKey] || {};
        return {
          ...prev,
          [baseKey]: {
            ...current,
            [powerKey]: nextOn
          }
        };
      });
      
    } catch(e) {}
  };

  const doReconnect = () => {
    setConnectionError(false);
    setConnectAttempt(prev => prev + 1);
  };

  // Responsive gauge layout calculations
  const { cols, gaugeSize, columnWidth, gap } = useMemo(() => {
    // base horizontal padding in container is 16 (from styles.container)
    const horizontalPadding = 32; // left + right
    const contentWidth = Math.max(0, (winWidth || 0) - horizontalPadding);
    // Determine column count via breakpoints
    let c = 1;
    if (contentWidth >= 520) c = 2;
    if (contentWidth >= 820) c = 3;
    if (contentWidth >= 1150) c = 4;
    // Don't exceed number of devices (at least 1)
    // (deviceList not yet defined here; adjust later after definition if needed)
    const gapVal = 16; // px between columns
    const colWidth = (contentWidth - gapVal * (c - 1)) / c;
    // Gauge internal width expands ~1.36x size (size * 1.12 + padding). Derive size from column width.
    const rawGaugeSize = colWidth / 1.36;
    const sized = Math.max(130, Math.min(rawGaugeSize, 210));
    return { cols: c, gaugeSize: sized, columnWidth: colWidth, gap: gapVal };
  }, [winWidth]);

  if (!token) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={[styles.headerSpacer, { height: (Constants.statusBarHeight || 0) + 12 }]} />
        <View style={styles.loadingWrap}><Text style={styles.loadingText}>Waiting for authentication...</Text></View>
      </SafeAreaView>
    );
  }

  // Debug runtime snapshot to help diagnose filteredDevices behavior in RN
  if (DEBUG) {
    try {
      const effectiveMode = mode || (customerSlug ? String(customerSlug).toUpperCase() : null);
      console.log('Dashboard DEBUG: mode=', mode, 'customerSlug=', customerSlug, 'effectiveMode=', effectiveMode, 'deviceList=', deviceList.length, 'filteredDevices=', filteredDevices.length);
      if (!customerSlug) console.log('Dashboard DEBUG: customerSlug is null - will not assume BREW for filtering until /api/latest hydrates');
    } catch (e) {}
  }

  // RN / in-app visible debug overlay: when DEBUG or running in React Native, render a small
  // readable panel on-screen so developers can see runtime state without access to console logs.
  const InAppDebug = () => {
    if (!DEBUG && !isReactNative) return null;
    try {
      const eff = mode || (customerSlug ? String(customerSlug).toUpperCase() : '');
      const dbCount = dbSensorBases ? (dbSensorBases.size || 0) : 0;
      const samplePower = Object.keys(powerLabels || {}).slice(0,6).join(', ');
      return (
        <View style={{ position: 'absolute', left: 8, right: 8, top: (Constants.statusBarHeight || 20) + 8, backgroundColor: 'rgba(255,255,255,0.92)', padding: 8, borderRadius: 8, borderWidth: 1, borderColor: '#ddd', zIndex: 9999 }}>
          <Text style={{ fontSize: 12, fontWeight: '700' }}>DEBUG</Text>
          <Text style={{ fontSize: 11 }}>mode: {String(mode)}</Text>
          <Text style={{ fontSize: 11 }}>customerSlug: {String(customerSlug)}</Text>
            <Text style={{ fontSize: 11 }}>customerId: {String(customerId)}</Text>
            {meDebug ? <Text style={{ fontSize: 10, color: '#444' }} numberOfLines={3}>me: {JSON.stringify(meDebug)}</Text> : null}
          <Text style={{ fontSize: 11 }}>effectiveMode: {String(eff)}</Text>
          <Text style={{ fontSize: 11 }}>deviceList: {deviceList ? deviceList.length : 0}  filtered: {filteredDevices ? filteredDevices.length : 0}</Text>
          <Text style={{ fontSize: 11 }}>dbSensorBases: {dbCount}</Text>
          <Text style={{ fontSize: 11 }}>powerLabels sample: {samplePower || 'none'}</Text>
        </View>
      );
    } catch (e) { return null; }
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* In-app debug panel for RN / DEBUG mode */}
      <InAppDebug />
      {DEBUG && (
        <DebugOverlay
          mode={mode}
          customerSlug={customerSlug}
          knownSlugs={knownSlugs}
          gMeta={gMeta}
          gSensors={gSensors}
          gTargets={gTargets}
          gPower={gPower}
          deviceList={deviceList}
          filteredDevices={filteredDevices}
          pendingSensorMessages={pendingSensorMessages}
          pendingPowerMessages={pendingPowerMessages}
          clearPending={() => { setPendingSensorMessages([]); setPendingPowerMessages([]); console.log('Cleared pending queues'); }}
          dumpToConsole={() => { console.log('DEBUG DUMP', { mode, customerSlug, knownSlugs: Array.from(knownSlugs || []), gMeta, gSensors, gTargets, gPower, deviceList, filteredDevices, pendingSensorMessages, pendingPowerMessages }); }}
        />
      )}
      {/* small spacer to keep content below any header/hamburger */}
      <View style={[styles.headerSpacer, { height: (Constants.statusBarHeight || 0) + 12 }]} />
      {/* Placeholder future: group filter UI (to filter deviceList by second topic segment/group) */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.contentContainer}>
        {!loading && (
          <>

            <View style={[styles.gaugeWrap, { flexDirection:'row', flexWrap:'wrap', justifyContent:'center', marginHorizontal: -(gap/2) }]}> 
              {filteredDevices.filter(d => {
                // Only render gauges for devices that are sensor-backed. Use gMeta
                // where possible: either the canonical key or any meta that starts
                // with the canonical base should have terminal 'Sensor'.
                const metaExact = gMeta[d.key];
                if (metaExact && metaExact.terminal && metaExact.terminal.toLowerCase() === 'sensor') return true;
                const anySensor = Object.keys(gMeta || {}).some(k => (k === d.representative || k.startsWith(d.key + '/')) && gMeta[k] && gMeta[k].terminal && gMeta[k].terminal.toLowerCase() === 'sensor');
                if (anySensor) return true;
                // As a final fallback, check representative string pattern for tele/stat/.../Sensor
                if (/^(tele|stat)\/[^/]+\/[^/]+\/Sensor$/i.test(d.representative)) return true;
                return false;
              }).map((d, i) => {
                // d.key is canonical ORG/DEVICE. The underlying sensor/target entries may
                // be stored under variants (ORG/DEVICE/METRIC or DEVICE/METRIC). Attempt
                // representative lookups: prefer exact match, otherwise find first key that
                // starts with the canonical base.
                const findPrefixed = (mapObj, base) => {
                  if (!mapObj) return null;
                  if (mapObj[base] !== undefined) return mapObj[base];
                  const pref = Object.keys(mapObj).find(k => k.startsWith(base + '/'));
                  return pref ? mapObj[pref] : null;
                };

                const sensorVal = findPrefixed(gSensors, d.key) ?? null;
                const targetVal = findPrefixed(gTargets, d.key) ?? null;
                // For meta, prefer exact canonical meta, else fall back to any meta starting with canonical
                let meta = gMeta[d.key] || null;
                if (!meta) {
                  const metaKey = Object.keys(gMeta || {}).find(k => k.startsWith(d.key + '/')) || Object.keys(gMeta || {}).find(k => k === d.representative);
                  if (metaKey) meta = gMeta[metaKey];
                }
                const gp = computeGaugeParams(d.key, meta, sensorVal);
                

                
                  // Enhanced power switch detection - expects customer-prefixed format
                // Attempt to find any matching gPower entry for this gauge.
                // Prefer strict mode-prefixed matches when `mode` is available, but
                // fall back to a device-name based heuristic so RN (or early state)
                // can still render power buttons even before /api/latest hydrates.
                const powerSwitches = (function findPowerForGauge() {
                  if (!gPower) return null;

                  // 1) Try strict match when mode available
                  if (mode) {
                    const customerPrefix = `${mode}/`;
                    const strict = Object.entries(gPower).find(([powerBaseKey]) => {
                      if (!powerBaseKey.startsWith(customerPrefix)) return false;
                      // quick device compare
                      const deviceFromPowerKey = powerBaseKey.split('/')[1];
                      if (!deviceFromPowerKey) return false;
                      // derive gauge device name
                      let gaugeDevice = null;
                      if (meta && meta.device && meta.device !== 'tele' && meta.device !== 'stat') gaugeDevice = meta.device;
                      else {
                        const gaugeParts = d.key.split('/');
                        if (gaugeParts.length === 2) {
                          const firstPart = gaugeParts[0]; const secondPart = gaugeParts[1];
                          if (mode && firstPart.toUpperCase() === mode.toUpperCase()) gaugeDevice = secondPart;
                          else gaugeDevice = firstPart;
                        } else if (gaugeParts.length === 3) gaugeDevice = gaugeParts[1];
                        else gaugeDevice = gaugeParts[0];
                      }
                      if (!gaugeDevice) return false;
                      return gaugeDevice.toUpperCase() === deviceFromPowerKey.toUpperCase();
                    });
                    if (strict) return strict;
                  }

                  // 2) Fallback: match by device name across any gPower entries (ignore customer prefix)
                  const deviceNameCandidates = new Set();
                  if (meta && meta.device) deviceNameCandidates.add(String(meta.device).toUpperCase());
                  // derive common candidates from d.key patterns
                  try {
                    const parts = d.key.split('/').filter(Boolean);
                    if (parts.length === 1) deviceNameCandidates.add(parts[0].toUpperCase());
                    else if (parts.length === 2) { deviceNameCandidates.add(parts[0].toUpperCase()); deviceNameCandidates.add(parts[1].toUpperCase()); }
                    else if (parts.length >= 3) { deviceNameCandidates.add(parts[1].toUpperCase()); }
                  } catch (e) {}

                  for (const [powerBaseKey, states] of Object.entries(gPower)) {
                    try {
                      const segs = powerBaseKey.split('/').filter(Boolean);
                      const pdev = (segs.length >= 2 ? segs[1] : segs[0]) || '';
                      if (deviceNameCandidates.has(pdev.toUpperCase())) return [powerBaseKey, states];
                    } catch (e) {}
                  }
                  return null;
                })();
                
                return (
                  <View key={`gwrap-${d.key}`} style={{ width: columnWidth, padding: gap/2, alignItems:'center' }}>
                    <View style={{ width: '100%', alignItems: 'center' }}>
                      <Gauge
                        key={`g-${d.key}`}
                        size={gaugeSize}
                        title={d.label}
                        sensorValue={sensorVal}
                        targetValue={targetVal}
                        onSetTarget={(v) => { publishTargetForDevice(d.key, v); }}
                        id={i}
                        sensorTopic={`${d.key}/Sensor`}
                        targetTopic={`${d.key}/Target`}
                        greenStart={gp.greenStart}
                        greenEnd={gp.greenEnd}
                        min={gp.min}
                        max={gp.max}
                      />
                      
                      {/* Integrated power switches directly below gauge */}
                      {powerSwitches && (
                        <View style={{ width: '100%', marginTop: 8, alignItems: 'center' }}>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }}>
                            {Object.entries(powerSwitches[1])
                              .sort(([a], [b]) => {
                                // Sort POWER before POWER1, POWER2, etc.
                                if (a === 'POWER' && b !== 'POWER') return -1;
                                if (b === 'POWER' && a !== 'POWER') return 1;
                                return a.localeCompare(b);
                              })
                              .map(([powerKey, isOn], idx, arr) => {
                                // Resolve label via helper that tries canonical + tele/ variants and device-name fallbacks
                                const baseKey = powerSwitches[0]; // e.g., "RAIL/FERM2" or "BREW/FERM2"
                                let label = getPowerLabel(baseKey, powerKey);
                                if (!label) label = powerKey === 'POWER' ? 'PWR' : powerKey.replace('POWER', 'PWR');

                                // Debug logging
                                if (DEBUG) {
                                  console.log('Dashboard Power Label Debug:', { baseKey, powerKey, foundLabel: label, sampleLabels: Object.keys(powerLabels || {}).slice(0,10) });
                                }

                                // Get device name for context when multiple switches
                                const deviceName = powerSwitches[0].split('/')[1] || '';
                                const showDeviceContext = arr.length > 1;

                                return (
                                  <Pressable 
                                    key={powerKey} 
                                    onPress={() => publishPower(powerSwitches[0], powerKey, !isOn)} 
                                    style={{ 
                                      paddingVertical: 6, 
                                      paddingHorizontal: 10, 
                                      borderRadius: 8, 
                                      backgroundColor: isOn ? '#4caf50' : '#f8f9fa',
                                      borderWidth: 1,
                                      borderColor: isOn ? '#4caf50' : '#dee2e6',
                                      minWidth: arr.length === 1 ? 60 : 45,
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      elevation: isOn ? 2 : 1,
                                      shadowColor: '#000',
                                      shadowOffset: { width: 0, height: isOn ? 2 : 1 },
                                      shadowOpacity: isOn ? 0.15 : 0.1,
                                      shadowRadius: isOn ? 3 : 2,
                                      transform: [{ scale: isOn ? 1.02 : 1 }]
                                    }}
                                  >
                                    <Text style={{ 
                                      color: isOn ? '#fff' : '#495057', 
                                      fontSize: arr.length === 1 ? 11 : 10, 
                                      fontWeight: '700',
                                      textAlign: 'center'
                                    }}>
                                      {label}
                                    </Text>
                                    <Text style={{ 
                                      color: isOn ? '#e8f5e8' : '#6c757d', 
                                      fontSize: 8,
                                      fontWeight: '600',
                                      textAlign: 'center',
                                      marginTop: 1
                                    }}>
                                      {isOn ? 'ON' : 'OFF'}
                                    </Text>
                                  </Pressable>
                                );
                              })
                            }
                          </View>
                          {/* Show device name context for multi-switch devices */}
                          {Object.keys(powerSwitches[1]).length > 1 && (
                            <Text style={{ 
                              fontSize: 9, 
                              color: '#6c757d', 
                              marginTop: 4, 
                              fontWeight: '500',
                              textAlign: 'center'
                            }}>
                              {powerSwitches[0].split('/')[1]} Controls
                            </Text>
                          )}
                        </View>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>
      {(loading || connectionError) && (
        <View style={styles.fullscreenOverlay} pointerEvents="auto">
          <View style={styles.overlayInner}>
            {!connectionError ? (
              <>
                <Animated.View style={[styles.spinner, { transform: [{ rotate: spinAnim.interpolate({ inputRange: [0,1], outputRange: ['0deg','360deg'] }) }] }]} />
                <Text style={styles.loadingText}>Please wait...</Text>
              </>
            ) : (
              <>
                <Text style={styles.loadingText}>Cannot connect to the bridge.</Text>
                <Text style={{ marginTop:8, color:'#666' }}>Tap Retry to try again.</Text>
                <Pressable onPress={doReconnect} style={[styles.retryBtn, { marginTop:12 }]}>
                  <Text style={{ color:'#fff' }}>Retry</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f6f7f9', alignItems: 'center', justifyContent: 'flex-start', padding: 16, paddingTop: 24 },
  content: { width: '100%', maxWidth: 420, paddingHorizontal: 12, paddingBottom: 18, alignItems: 'center' },
  scroll: { flex: 1, width: '100%' },
  contentContainer: { alignItems: 'center', paddingBottom: 60 },
  heading: { fontSize: 16, fontWeight: '700', color: '#222' },
  gaugeWrap: { marginTop: 12, alignItems: 'center', justifyContent: 'center' },
  gaugeCenter: { position: 'absolute', left: 0, top: 0, width: 160, height: 160, alignItems: 'center', justifyContent: 'center' },
  gaugeText: { fontSize: 28, fontWeight: '700', color: '#111' },
  gaugeGrid: { flexDirection: 'column', flexWrap: 'nowrap', alignItems: 'center', justifyContent: 'center' },
  gaugeBarWrap: { width: 160, height: 24, backgroundColor: '#eee', borderRadius: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  gaugeBarFill: { height: '100%', backgroundColor: '#4caf50' },
  sliderRow: { flexDirection: 'row', alignItems: 'center', width: '100%', marginTop: 10 },
  smallBtn: { width: 40, height: 36, borderRadius: 6, backgroundColor: '#eee', alignItems: 'center', justifyContent: 'center' },
  btnText: { fontSize: 18, fontWeight: '700' },
  sliderTrack: { flex: 1, height: 36, marginHorizontal: 12, backgroundColor: '#f0f0f0', borderRadius: 8, overflow: 'hidden', justifyContent: 'center' },
  sliderFill: { height: 12, backgroundColor: '#2196f3', marginHorizontal: 8, borderRadius: 6 },
  input: { borderWidth: 1, padding: 8, flex: 1, marginRight: 8, borderRadius: 6, borderColor: '#ddd' },
  loadingWrap: { width: '100%', alignItems: 'center', justifyContent: 'center', paddingVertical: 28 },
  loadingText: { marginTop: 12, color: '#444' },
  spinner: { width: 48, height: 48, borderRadius: 24, borderWidth: 4, borderColor: '#eee', borderTopColor: '#4caf50', marginBottom: 6 },
  gaugeValue: { marginTop: 8, fontSize: 18, fontWeight: '700', color: '#111' },
  retryBtn: { marginTop: 8, backgroundColor: '#4caf50', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 }
  ,
  headerSpacer: { height: 8, width: '100%' },
  fullscreenOverlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.18)', alignItems: 'center', justifyContent: 'center' },
  overlayInner: { alignItems: 'center', justifyContent: 'center', padding: 16, borderRadius: 12, backgroundColor: 'transparent' }
});

// Debug overlay component (visible when DEBUG=true)
function DebugOverlay({ mode, customerSlug, knownSlugs, gMeta, gSensors, gTargets, gPower, deviceList, filteredDevices, pendingSensorMessages, pendingPowerMessages, clearPending, dumpToConsole }) {
  const small = { fontSize: 11, color: '#222' };
  return (
    <View style={{ position: 'fixed', right: 12, top: 72, width: 420, maxHeight: '60vh', backgroundColor: 'rgba(255,255,255,0.95)', borderWidth: 1, borderColor: '#ddd', padding: 8, borderRadius: 6, overflow: 'auto', zIndex: 9999 }}>
      <Text style={{ fontWeight: '700', marginBottom: 6 }}>Debug</Text>
      <Text style={small}>mode: {String(mode)}</Text>
      <Text style={small}>customerSlug: {String(customerSlug)}</Text>
      <Text style={small}>knownSlugs: {(knownSlugs && Array.from(knownSlugs).slice(0,10).join(', ')) || '[]'}</Text>
      <Text style={[small, { marginTop: 6 }]}>gMeta: {Object.keys(gMeta || {}).length} keys — sample: {Object.keys(gMeta||{}).slice(0,6).join(', ')}</Text>
      <Text style={small}>gSensors: {Object.keys(gSensors || {}).length} — sample: {Object.keys(gSensors||{}).slice(0,6).join(', ')}</Text>
      <Text style={small}>gTargets: {Object.keys(gTargets || {}).length} — sample: {Object.keys(gTargets||{}).slice(0,6).join(', ')}</Text>
      <Text style={small}>gPower: {Object.keys(gPower || {}).length} — sample: {Object.keys(gPower||{}).slice(0,6).join(', ')}</Text>
      <Text style={small}>deviceList: {deviceList ? deviceList.length : 0}</Text>
      <Text style={small}>filteredDevices: {filteredDevices ? filteredDevices.length : 0}</Text>
      <Text style={[small, { marginTop: 6 }]}>pendingSensorMessages: {pendingSensorMessages ? pendingSensorMessages.length : 0}</Text>
      <Text style={small}>pendingPowerMessages: {pendingPowerMessages ? pendingPowerMessages.length : 0}</Text>
      <View style={{ flexDirection: 'row', marginTop: 8, gap: 8 }}>
        <Pressable onPress={clearPending} style={{ backgroundColor: '#f44336', padding: 6, borderRadius: 6 }}><Text style={{ color: '#fff', fontSize: 12 }}>Clear Pending</Text></Pressable>
        <Pressable onPress={dumpToConsole} style={{ backgroundColor: '#1976d2', padding: 6, borderRadius: 6 }}><Text style={{ color: '#fff', fontSize: 12 }}>Dump Console</Text></Pressable>
      </View>
      <Text style={{ marginTop: 8, fontSize: 11, color: '#666' }}>Tip: use Dump Console then copy the console output into the issue for me to analyze.</Text>
    </View>
  );
}
