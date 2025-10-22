import React, { useEffect, useState, useRef, useMemo } from 'react';
import { apiFetch } from '../src/api';
import { Image } from 'react-native';

// Global debug toggle for this module. This is runtime-aware: it will enable
// debug logging when ?debug=1 or localStorage.brewski.debug='true' is present,
// or when window.brewskiDebug is set. We expose helpers to toggle it from
// the console so you can enable logs without rebuilding.
let DEBUG = false;
    try {
      if (typeof window !== 'undefined') {
        try {
          const params = new URLSearchParams(window.location.search || '');
          if (params.get('debug') === '1' || params.get('debug') === 'true') DEBUG = true;
        } catch (e) {}
        try {
          // Prefer the module-safe storage shim when available; fall back to window.localStorage
          const ls = (typeof safeLocal !== 'undefined' && safeLocal && typeof safeLocal.getItem === 'function') ? safeLocal.getItem('brewski.debug') : (window.localStorage && typeof window.localStorage.getItem === 'function' ? window.localStorage.getItem('brewski.debug') : null);
          if (ls === 'true') DEBUG = true;
        } catch (e) {}
        try {
          if (window.brewskiDebug) DEBUG = true;
        } catch (e) {}

        // Convenience helpers to toggle debug at runtime from the browser console.
        try {
          window.enableBrewskiDebug = (persist = false) => {
            DEBUG = true;
            try {
              if (persist) {
                if (typeof safeLocal !== 'undefined' && safeLocal && typeof safeLocal.setItem === 'function') safeLocal.setItem('brewski.debug', 'true');
                else if (window.localStorage && typeof window.localStorage.setItem === 'function') window.localStorage.setItem('brewski.debug', 'true');
              }
            } catch (e) {}
            console.log('brewski: DEBUG enabled');
            return DEBUG;
          };
          window.disableBrewskiDebug = (persist = false) => {
            DEBUG = false;
            try {
              if (persist) {
                if (typeof safeLocal !== 'undefined' && safeLocal && typeof safeLocal.setItem === 'function') safeLocal.setItem('brewski.debug', 'false');
                else if (window.localStorage && typeof window.localStorage.setItem === 'function') window.localStorage.setItem('brewski.debug', 'false');
              }
            } catch (e) {}
            console.log('brewski: DEBUG disabled');
            return DEBUG;
          };
        } catch (e) {}
      }
    } catch (e) {}
// Simple module-level logger to avoid runtime ReferenceErrors when debug helpers
// are invoked before the Dashboard component mounts. This forces console output
// (no runtime gating) so logs always appear while we diagnose issues.
const brewskiLog = (...args) => { try { console.log('brewski:', ...args); } catch (e) {} };
// Ensure legacy `debug(...)` calls (leftover in some places) don't crash the app.
const debug = (...args) => { try { console.log('debug:', ...args); } catch (e) {} };
// Detect React Native at module load time and provide a default API host
const IS_REACT_NATIVE = (() => { try { return (typeof navigator !== 'undefined' && navigator.product === 'ReactNative'); } catch (e) { return false; } })();
const DEFAULT_API_HOST = (typeof process !== 'undefined' && process.env && process.env.SERVER_FQDN) ? process.env.SERVER_FQDN : 'api.brewingremote.com';
// Platform-safe synchronous local storage shim (used to avoid referencing
// window.localStorage directly which throws in some RN/Hermes environments).
const _inMemoryLocal_dashboard = new Map();
const safeLocal = {
  getItem: (k) => {
    try { if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.getItem === 'function') return window.localStorage.getItem(k); } catch (e) {}
    try { return _inMemoryLocal_dashboard.has(k) ? _inMemoryLocal_dashboard.get(k) : null; } catch (e) { return null; }
  },
  setItem: (k, v) => {
    try { if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.setItem === 'function') return window.localStorage.setItem(k, v); } catch (e) {}
    try { _inMemoryLocal_dashboard.set(k, String(v)); } catch (e) {}
  },
  removeItem: (k) => {
    try { if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.removeItem === 'function') return window.localStorage.removeItem(k); } catch (e) {}
    try { _inMemoryLocal_dashboard.delete(k); } catch (e) {}
  }
};
// React Native AsyncStorage (best-effort require). We try modern community package
// first and fall back to React Native's AsyncStorage if present. If neither is
// available (web), AsyncStorage remains null and we use `safeLocal` instead.
let AsyncStorage = null;
try {
  // community package exposes default
  const mod = require('@react-native-async-storage/async-storage');
  AsyncStorage = mod && (mod.default || mod);
} catch (e) {
  try {
    // older RN versions had AsyncStorage on react-native
    const rn = require('react-native');
    AsyncStorage = rn && rn.AsyncStorage ? rn.AsyncStorage : null;
  } catch (e) {
    AsyncStorage = null;
  }
}

const _STORAGE_KEYS = { customerSlug: 'brewski_customer_slug', customerId: 'brewski_customer_id' };

async function readPersistedCustomerSlug() {
  try {
    if (!AsyncStorage) return null;
    const v = await AsyncStorage.getItem(_STORAGE_KEYS.customerSlug);
    return v || null;
  } catch (e) { return null; }
}

async function persistCustomerSlugToStorage(slug) {
  try {
    if (!AsyncStorage) return;
    if (!slug) await AsyncStorage.removeItem(_STORAGE_KEYS.customerSlug);
    else await AsyncStorage.setItem(_STORAGE_KEYS.customerSlug, String(slug));
  } catch (e) { /* ignore storage failures */ }
}

async function persistCustomerIdToStorage(id) {
  try {
    if (!AsyncStorage) return;
    if (!id && id !== 0) await AsyncStorage.removeItem(_STORAGE_KEYS.customerId);
    else await AsyncStorage.setItem(_STORAGE_KEYS.customerId, String(id));
  } catch (e) { /* ignore storage failures */ }
}

async function readPersistedCustomerId() {
  try {
    if (!AsyncStorage) return null;
    const v = await AsyncStorage.getItem(_STORAGE_KEYS.customerId);
    if (!v) return null;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    return null;
  } catch (e) { return null; }
}

const TOKEN_STORAGE_KEY = 'brewski_jwt';

async function persistTokenToStorage(tok) {
  try {
    if (!AsyncStorage) return;
    if (!tok) await AsyncStorage.removeItem(TOKEN_STORAGE_KEY);
    else await AsyncStorage.setItem(TOKEN_STORAGE_KEY, String(tok));
  } catch (e) { /* ignore */ }
}

async function readPersistedToken() {
  try {
    if (!AsyncStorage) return null;
    const v = await AsyncStorage.getItem(TOKEN_STORAGE_KEY);
    return v || null;
  } catch (e) { return null; }
}
// In-flight promise cache for fetchPowerLabels to coalesce concurrent callers
const _inflightFetchPowerLabels = new Map();
// Short-lived cache for server-side power-label listings per-customer to avoid
// repeatedly calling `/api/power-labels` when many discovered bases trigger
// concurrent discovery flows. Keyed by `customerId` or `customerSlug`.
const _powerLabelsFetchCache = new Map(); // key -> { ts, existingKeys: Set }

// Helper to fetch power labels from the API. Accepts an optional JWT token
// and will try multiple fallbacks to handle different hosting/proxy setups.
async function fetchPowerLabels(token, customerId) {
  // Cache key includes customerId when provided so per-customer results are cached separately
  const cacheKey = customerId ? `id:${customerId}` : (token ? `tok:${token}` : '__anon__');
  if (_inflightFetchPowerLabels.has(cacheKey)) return await _inflightFetchPowerLabels.get(cacheKey);
  const doFetch = async () => {
    try {
      // Prefer window.apiFetch when available (web environments)
      if (typeof window !== 'undefined' && window.apiFetch) {
        try {
          const r = await window.apiFetch('/admin/api/power-labels');
          if (r && r.ok) {
            const js = (typeof r.json === 'function') ? await r.json().catch(() => null) : r;
            return js && js.labels ? js.labels : [];
          }
        } catch (e) { /* ignore and fallthrough */ }
      }

      // Direct fetch to canonical API host (works in React Native and other hosts)
      const API_HOST = DEFAULT_API_HOST || 'api.brewingremote.com';
      let adminUrl = `https://${API_HOST}/admin/api/power-labels`;
      let publicUrl = `https://${API_HOST}/api/power-labels`;
      // If a numeric customerId was provided, prefer the per-customer query to reduce noise
      if (customerId) {
        adminUrl = `${adminUrl}?customer_id=${encodeURIComponent(customerId)}`;
        publicUrl = `${publicUrl}?customer_id=${encodeURIComponent(customerId)}`;
      }

      // Try admin endpoint with Authorization header first
      try {
        const headers = { Accept: 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(adminUrl, { headers });
        if (res && res.ok) {
          const js = await res.json().catch(() => null);
          return js && js.labels ? js.labels : [];
        }
      } catch (e) { /* ignore */ }

      // Try admin endpoint with token query param (some setups accept token via query)
      if (token) {
        try {
          // If we already appended customer_id above, include token as an additional param
          const q = adminUrl.includes('?') ? `${adminUrl}&token=${encodeURIComponent(token)}` : `${adminUrl}?token=${encodeURIComponent(token)}`;
          const resQ = await fetch(q, { headers: { Accept: 'application/json' } });
          if (resQ && resQ.ok) {
            const jsq = await resQ.json().catch(() => null);
            return jsq && jsq.labels ? jsq.labels : [];
          }
        } catch (e) { /* ignore */ }
      }

      // Fallback to public API path on canonical host (with/without token)
      try {
        const headers2 = { Accept: 'application/json' };
        if (token) headers2.Authorization = `Bearer ${token}`;
        const res2 = await fetch(publicUrl, { headers: headers2 });
        if (res2 && res2.ok) {
          const js2 = await res2.json().catch(() => null);
          return js2 && js2.labels ? js2.labels : [];
        }
      } catch (e) { /* ignore */ }

      // As a last attempt, try public endpoint with token query param
      if (token) {
        try {
          const q2 = publicUrl.includes('?') ? `${publicUrl}&token=${encodeURIComponent(token)}` : `${publicUrl}?token=${encodeURIComponent(token)}`;
          const rq = await fetch(q2, { headers: { Accept: 'application/json' } });
          if (rq && rq.ok) {
            const jsq2 = await rq.json().catch(() => null);
            return jsq2 && jsq2.labels ? jsq2.labels : [];
          }
        } catch (e) { /* ignore */ }
      }

      return [];
    } catch (e) {
      return [];
    }
  };

  const p = doFetch();
  _inflightFetchPowerLabels.set(cacheKey, p);
  try { return await p; } finally { _inflightFetchPowerLabels.delete(cacheKey); }
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

// Normalize a candidate canonical base into a single SITE/DEVICE[/METRIC] form.
// Inputs are provided explicitly so this helper remains pure and testable.
// Preference rules:
//  - If the input already contains a non-BREW site, keep it.
//  - If input is a legacy or BREW-prefixed device and a non-BREW variant exists
//    in `dbSensorBases` or `gMeta`, prefer that non-BREW site.
//  - If no site is known, prefer `mode` or `customerSlug` (if present), else default to 'BREW'.
function normalizeCanonicalBase(origKey, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode } = {}) {
  try {
    if (!origKey || typeof origKey !== 'string') return origKey;
    const partsRaw = String(origKey).split('/').filter(Boolean);
    // If the incoming key already looks like SITE/DEVICE or SITE/DEVICE/METRIC, use it
    if (partsRaw.length >= 2 && partsRaw[0] && partsRaw[1]) {
      const site = partsRaw[0];
      const device = partsRaw[1];
      // Treat trailing tokens like STATE/RESULT as terminals, not as metrics
      const rawMetric = partsRaw.length >= 3 ? partsRaw[2] : null;
      const metric = rawMetric && !/^(STATE|RESULT)$/i.test(rawMetric) ? rawMetric : null;
      // Defensive: reject obviously bogus device tokens (e.g. SITE/STATE, SITE/BREW, device same as site)
      if (!device || /^(STATE|BREW|RAIL)$/i.test(String(device)) || String(device).toUpperCase() === String(site).toUpperCase()) {
        return null;
      }
      if (site.toUpperCase() !== 'BREW') {
        return metric ? `${site}/${device}/${metric}` : `${site}/${device}`;
      }
      // If site is BREW, see if a non-BREW variant exists in dbSensorBases or gMeta
      try {
        if (dbSensorBases && dbSensorBases.size) {
          for (const b of Array.from(dbSensorBases)) {
            if (!b) continue;
            const bp = String(b).split('/').filter(Boolean);
            if (bp.length >= 2 && bp[1].toUpperCase() === device.toUpperCase() && bp[0].toUpperCase() !== 'BREW') {
              return bp.length >= 3 ? `${bp[0]}/${bp[1]}/${bp[2]}` : `${bp[0]}/${bp[1]}`;
            }
          }
        }
      } catch (e) {}
      try {
        if (gMeta) {
          for (const k of Object.keys(gMeta || {})) {
            if (!k) continue;
            const kp = String(k).split('/').filter(Boolean);
            if (kp.length >= 2 && kp[1].toUpperCase() === device.toUpperCase() && kp[0].toUpperCase() !== 'BREW') {
              return kp.length >= 3 ? `${kp[0]}/${kp[1]}/${kp[2]}` : `${kp[0]}/${kp[1]}`;
            }
          }
        }
      } catch (e) {}
      // fallback: preserve BREW/device
      return metric ? `${site}/${device}/${metric}` : `${site}/${device}`;
    }

    // If single-segment or tele/stat legacy, extract device and prefer discovered sites
    // Handle tele/<device> or tele/<site>/<device>/... variants
  const telMatch = String(origKey).match(/^tele\/(?:([^/]+)\/)?([^/]+)(?:\/.*)?$/i) || String(origKey).match(/^stat\/(?:([^/]+)\/)?([^/]+)(?:\/.*)?$/i);
    if (telMatch) {
      const maybeSite = telMatch[1] || null;
      const device = telMatch[2];
      // If explicit non-BREW site present, honor it
      if (maybeSite && maybeSite.toUpperCase() !== 'BREW') {
        if (/^(STATE|BREW|RAIL)$/i.test(String(device))) return null;
        if (String(device).toUpperCase() === String(maybeSite).toUpperCase()) return null;
        return `${maybeSite}/${device}`;
      }
      // Search DB/gMeta for a preferred non-BREW site
      try {
        if (dbSensorBases && dbSensorBases.size) {
          for (const b of Array.from(dbSensorBases)) {
            if (!b) continue;
            const bp = String(b).split('/').filter(Boolean);
            if (bp.length >= 2 && bp[1].toUpperCase() === device.toUpperCase() && bp[0].toUpperCase() !== 'BREW') return bp.length >= 3 ? `${bp[0]}/${bp[1]}/${bp[2]}` : `${bp[0]}/${bp[1]}`;
          }
        }
      } catch (e) {}
      try {
        if (gMeta) {
          for (const k of Object.keys(gMeta || {})) {
            if (!k) continue;
            const kp = String(k).split('/').filter(Boolean);
            if (kp.length >= 2 && kp[1].toUpperCase() === device.toUpperCase() && kp[0].toUpperCase() !== 'BREW') return kp.length >= 3 ? `${kp[0]}/${kp[1]}/${kp[2]}` : `${kp[0]}/${kp[1]}`;
          }
        }
      } catch (e) {}

      // Prefer explicit mode/customerSlug if available
      if (!device || /^(STATE|BREW|RAIL)$/i.test(String(device))) return null;
      // Do not default to BREW for unscoped legacy topics. Require explicit mode/customerSlug.
      if (mode) return `${mode}/${device}`;
      if (customerSlug) return `${customerSlug}/${device}`;
      return null;
    }

    // If nothing else matched, return original
    return origKey;
  } catch (e) {
    return origKey;
  }
}
import { SafeAreaView, View, Text, StyleSheet, Pressable, Animated, Easing, TextInput, Button, ScrollView, useWindowDimensions } from 'react-native';
import Constants from 'expo-constants';
import Gauge from '../components/Gauge';

// Defensive polyfills for atob/btoa to avoid ReferenceErrors on Hermes / RN runtimes
try {
  if (typeof globalThis.atob === 'undefined') {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      globalThis.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
    } else {
      globalThis.atob = (s) => '';
    }
  }
} catch (e) {}
try {
  if (typeof globalThis.btoa === 'undefined') {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      globalThis.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
    } else {
      globalThis.btoa = (s) => '';
    }
  }
} catch (e) {}

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
  // Initialize runtime DEBUG flag from URL/localStorage/window.brewskiDebug so
  // the global runtime helpers (enableBrewskiDebug/disableBrewskiDebug) can
  // control logging consistently without needing a rebuild.
    try {
      if (typeof window !== 'undefined') {
        try {
          const params = new URLSearchParams(window.location.search || '');
          if (params.get('debug') === '1' || params.get('debug') === 'true') DEBUG = true;
        } catch (e) {}
        try {
          const ls = safeLocal.getItem && safeLocal.getItem('brewski.debug');
          if (ls === 'true') DEBUG = true;
        } catch (e) {}
        try { if (window.brewskiDebug) DEBUG = true; } catch (e) {}
      }
    } catch (e) {}
  // Power label state: { `${topic}|${powerKey}`: label }
  const [powerLabels, setPowerLabels] = useState({});
  // Grouped by canonical base: { 'SITE/DEVICE': { POWER: 'Label', POWER1: 'Label2' } }
  const [powerLabelsByCanonical, setPowerLabelsByCanonical] = useState({});
  // store numeric customer id if provided by /api/latest so we can POST admin updates
  // const [customerId, setCustomerId] = useState(null); // <-- REMOVE this duplicate
  // Fetch power labels on mount (and when token changes)
  useEffect(() => {
    let mounted = true;
    (async () => {
      const labelsArr = await fetchPowerLabels(token, customerId);
      // Convert array to map if needed
      let labelMap = {};
      if (Array.isArray(labelsArr)) {
        labelsArr.forEach(l => {
          try {
            if (l && l.topic && l.power_key) {
              const rawTopic = String(l.topic).trim();
              const pk = String(l.power_key).toUpperCase();
              const labelVal = String(l.label || '').trim();
              // skip empty labels (we don't want blank placeholders to enable buttons)
              if (!labelVal) return;

              // Helper to add multiple variants into the map
              const add = (t, k) => {
                try {
                  const kk = `${t}|${k}`;
                  if (labelMap[kk] === undefined) labelMap[kk] = labelVal;
                } catch (e) {}
              };

              // Add raw topic as-is (both case forms)
              add(rawTopic, pk);
              add(rawTopic.toUpperCase(), pk);

              // Add canonicalized SITE/DEVICE/STATE form
              try {
                const canon = canonicalForTopic(rawTopic) || normalizeCanonicalBase(rawTopic, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || rawTopic;
                if (canon) {
                  add(canon, pk);
                  add((canon.endsWith('/STATE') ? canon : `${canon}/STATE`), pk);
                  add(canon.toUpperCase(), pk);
                }
              } catch (e) {}

              // Add tele variants for site-prefixed forms only. Avoid adding
              // device-only tele/<device>/STATE variants which can match across
              // unrelated prefixes and cause labels to bleed into other sites.
              try {
                const parts = rawTopic.split('/').filter(Boolean);
                let site = null; let device = null;
                if (parts.length >= 3 && /^(tele|stat)$/i.test(parts[0])) { site = parts[1]; device = parts[2]; }
                else if (parts.length >= 2) { site = parts[0]; device = parts[1]; }
                // Only add tele variants when an explicit site is present. Do not add
                // tele/<device>/STATE for device-only topics as that is too permissive.
                if (device && site) {
                  add(`tele/${site}/${device}/STATE`, pk);
                  add(`tele/${site}/${device}/STATE`.toUpperCase(), pk);
                }
              } catch (e) {}

              // Also add device-only BREW-prefixed variant (legacy storage)
              try {
                const maybeParts = rawTopic.split('/').filter(Boolean);
                const candidateBase = maybeParts.length >= 2 ? `${maybeParts[0]}/${maybeParts[1]}` : `BREW/${maybeParts[0] || rawTopic}`;
                const norm = normalizeCanonicalBase(candidateBase, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || candidateBase;
                // Defensive: avoid mapping ambiguous prefixes (e.g. RAIL/<DEVICE>/...) into
                // a SITE/DEVICE canonical that would incorrectly apply labels across
                // different orgs. Only add the normalized variant when the original
                // first segment looks like a known slug/site (or is tele/stat) or when
                // the normalized first segment matches a known slug or current customer.
                try {
                  const origFirst = (maybeParts[0] || '').toUpperCase();
                  const normFirst = String(norm).split('/').filter(Boolean)[0] || '';
                  const isTeleStat = /^(TELE|STAT)$/.test(origFirst);
                  const origLooksLikeSlug = origFirst && knownSlugs && knownSlugs.has(origFirst);
                  const normLooksLikeSlug = normFirst && knownSlugs && knownSlugs.has(normFirst);
                  const matchesCurrentCustomer = (mode && mode === normFirst) || (customerSlug && String(customerSlug).toUpperCase() === normFirst);
                  if (isTeleStat || origLooksLikeSlug || normLooksLikeSlug || matchesCurrentCustomer) {
                    add(norm, pk);
                    add(`${norm}/STATE`, pk);
                    add(norm.toUpperCase(), pk);
                  } else {
                    // Fallback: add the raw candidateBase variants but avoid the
                    // normalized (cross-customer) mapping which caused labels to
                    // bleed across unrelated devices.
                    add(candidateBase, pk);
                    add(`${candidateBase}/STATE`, pk);
                    add(candidateBase.toUpperCase(), pk);
                  }
                } catch (e) {
                  add(norm, pk);
                  add(`${norm}/STATE`, pk);
                  add(norm.toUpperCase(), pk);
                }
              } catch (e) {}
            }
          } catch (e) { /* ignore */ }
        });
      } else if (labelsArr && typeof labelsArr === 'object') {
        labelMap = labelsArr;
      }
      
      // Debug logging
      if (DEBUG) {
        brewskiLog('Dashboard: Power labels fetch result:', {
          labelsCount: Object.keys(labelMap).length,
          labelKeys: Object.keys(labelMap),
          fullLabelMap: labelMap
        });
      }
      
      if (mounted) {
        // Build canonical-indexed map so UI can group variants under one canonical base
        const canonicalMap = {};
        if (Array.isArray(labelsArr)) {
          labelsArr.forEach(l => {
            try {
              if (!l || !l.topic || !l.power_key) return;
              const can = canonicalForTopic(l.topic) || normalizeCanonicalBase((String(l.topic).split('/').filter(Boolean).slice(-2).join('/')) || l.topic, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
              if (!can) return;
              if (!canonicalMap[can]) canonicalMap[can] = {};
              const upk = String(l.power_key).toUpperCase();
              const labelVal = String(l.label || '').trim();
              if (!labelVal) return; // ignore empty labels
              canonicalMap[can][upk] = labelVal;
            } catch (e) { }
          });
        } else if (labelsArr && typeof labelsArr === 'object') {
          // if server already returned a map, try to normalize into canonical buckets
          Object.keys(labelsArr || {}).forEach(k => {
            try {
              const [topicPart, pk] = k.split('|');
              if (!topicPart || !pk) return;
              const can = canonicalForTopic(topicPart) || topicPart;
              if (!canonicalMap[can]) canonicalMap[can] = {};
              canonicalMap[can][pk.toUpperCase()] = labelsArr[k] || '';
            } catch (e) {}
          });
        }

  if (DEBUG) console.log('Dashboard: setting powerLabels from fetch', { count: Object.keys(labelMap || {}).length, sample: Object.keys(labelMap || {}).slice(0,5) });
        if (DEBUG) console.log('Dashboard: merging fetched power labels into local cache', { fetched: Object.keys(labelMap || {}).length, existing: Object.keys(powerLabels || {}).length });
        setPowerLabels(prev => {
          try {
            const next = Object.assign({}, prev || {});
            Object.keys(labelMap || {}).forEach(k => {
              try {
                const v = String(labelMap[k] || '').trim();
                if (!v) return;
                next[k] = v;
              } catch (e) {}
            });
            // ensure uppercase variants are set for non-empty labels
            Object.keys(labelMap || {}).forEach(k => {
              try {
                const v = String(labelMap[k] || '').trim();
                if (!v) return;
                next[k.toUpperCase()] = v;
              } catch (e) {}
            });
            return next;
          } catch (e) { return labelMap; }
        });
        setPowerLabelsByCanonical(canonicalMap);

        // Derive canonical base keys from fetched labels so we can render
        // power buttons immediately from DB state (no MQTT required).
        try {
          const bases = new Set();
          Object.keys(labelMap || {}).forEach(k => {
            try {
              const [topicPart] = k.split('|');
              if (!topicPart) return;
              // Normalize topicPart into SITE/DEVICE base if possible
              const parts = String(topicPart).split('/').filter(Boolean);
              let candidateBase = null;
              if (parts.length >= 3 && parts[0].toLowerCase() === 'tele') {
                candidateBase = `${parts[1]}/${parts[2]}`;
              } else if (parts.length >= 2) {
                candidateBase = `${parts[0]}/${parts[1]}`;
              } else if (parts.length === 1) {
                candidateBase = `BREW/${parts[0]}`;
              }
              if (candidateBase) {
                const norm = normalizeCanonicalBase(candidateBase, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
                if (norm) bases.add(norm);
              }
            } catch (e) {}
          });
          if (bases.size) {
            setDbSensorBases(prev => {
              const s = new Set(Array.from(prev || []));
              for (const b of Array.from(bases)) s.add(b);
              return s;
            });

            // Initialize gPower entries (presence of keys enables power buttons).
            // Use the canonicalized base for each stored label so we only create
            // power entries for exact SITE/DEVICE canonical matches. This avoids
            // labels stored under prefixes like RAIL/<DEVICE> from bleeding into
            // MODE/<device> pages.
            setGPower(prev => {
              const next = { ...(prev || {}) };
              Object.keys(labelMap || {}).forEach(k => {
                try {
                  const v = String(labelMap[k] || '').trim();
                  // Only create gPower entries for non-empty labels or explicit '-hide' marker
                  if (!v && v !== '-hide') return;
                  const [topicPart, pk] = k.split('|');
                  if (!topicPart || !pk) return;
                  // Derive a canonical SITE/DEVICE base for the topicPart
                  const candidateBase = (() => {
                    try {
                      const parts = String(topicPart).split('/').filter(Boolean);
                      if (parts.length >= 3 && parts[0].toLowerCase() === 'tele') return `${parts[1]}/${parts[2]}`;
                      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
                      if (parts.length === 1) return `BREW/${parts[0]}`;
                      return null;
                    } catch (e) { return null; }
                  })();
                  if (!candidateBase) return;
                  const canon = canonicalForTopic(topicPart) || normalizeCanonicalBase(candidateBase, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
                  if (!canon) return;
                  const partsCanon = String(canon).split('/').filter(Boolean);
                  if (partsCanon.length < 2) return;
                  const norm = `${partsCanon[0].toUpperCase()}/${partsCanon[1].toUpperCase()}`;
                  if (!next[norm]) next[norm] = {};
                  const upk = String(pk).toUpperCase();
                  if (next[norm][upk] === undefined) next[norm][upk] = false;
                } catch (e) {}
              });
              return next;
            });
          }
        } catch (e) {}
      }
    })();
    return () => { mounted = false; };
  }, [token]);

  // When we learn a numeric customerId, re-fetch power labels specifically
  // for that customer to ensure dashboard uses customer-scoped labels.
  useEffect(() => {
    let mounted = true;
    // Only trigger when we have a numeric customerId
    if (!customerId) return;
    (async () => {
      try {
        const labelsArr = await fetchPowerLabels(token, customerId);
        if (!mounted) return;
        let labelMap = {};
        if (Array.isArray(labelsArr)) {
          labelsArr.forEach(l => {
            try {
              if (l && l.topic && l.power_key) {
                const rawTopic = String(l.topic).trim();
                const pk = String(l.power_key).toUpperCase();
                const labelVal = String(l.label || '').trim();
                if (!labelVal) return; // ignore empty labels for customer-scoped fetch
                const add = (t, k) => {
                  try { const kk = `${t}|${k}`; if (labelMap[kk] === undefined) labelMap[kk] = labelVal; } catch (e) {}
                };
                add(rawTopic, pk);
                add(rawTopic.toUpperCase(), pk);
                try {
                  const can = canonicalForTopic(rawTopic) || normalizeCanonicalBase(rawTopic, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || rawTopic;
                  if (can) {
                    // Only accept canonicalized entries when they don't appear to be
                    // the result of swapping site/device due to ambiguous prefixes.
                    const rawFirst = String(rawTopic || '').split('/').filter(Boolean)[0] || '';
                    const canFirst = String(can || '').split('/').filter(Boolean)[0] || '';
                    const acceptCanon = (rawFirst && (/^(tele|stat)$/i.test(rawFirst) || (knownSlugs && knownSlugs.has(rawFirst.toUpperCase()))) ) || (knownSlugs && knownSlugs.has(canFirst.toUpperCase())) || ((mode || customerSlug) && canFirst && ((mode && mode === canFirst) || (customerSlug && String(customerSlug).toUpperCase() === canFirst)));
                    if (acceptCanon) {
                      add(can, pk);
                      add((can.endsWith('/STATE') ? can : `${can}/STATE`), pk);
                      add(can.toUpperCase(), pk);
                    } else {
                      // Be conservative: include the rawTopic variants but avoid
                      // promoting the possibly-swapped canonical value.
                      add(rawTopic, pk);
                      add(rawTopic.toUpperCase(), pk);
                    }
                  }
                } catch (e) {}
              }
            } catch (e) {}
          });
        } else if (labelsArr && typeof labelsArr === 'object') {
          labelMap = labelsArr;
        }

        // Merge into existing powerLabels and powerLabelsByCanonical
        setPowerLabels(prev => {
          try {
            const next = Object.assign({}, prev || {});
            Object.keys(labelMap || {}).forEach(k => {
              try {
                const v = String(labelMap[k] || '').trim();
                if (!v) return;
                next[k] = v;
                next[k.toUpperCase()] = v;
              } catch (e) {}
            });
            return next;
          } catch (e) { return labelMap; }
        });

        // Recompute canonical grouping
        const canonicalMap = {};
        if (Array.isArray(labelsArr)) {
          labelsArr.forEach(l => {
            try {
              if (!l || !l.topic || !l.power_key) return;
              const can = canonicalForTopic(l.topic) || normalizeCanonicalBase((String(l.topic).split('/').filter(Boolean).slice(-2).join('/')) || l.topic, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
              if (!can) return;
              if (!canonicalMap[can]) canonicalMap[can] = {};
              const upk = String(l.power_key).toUpperCase();
              const labelVal = String(l.label || '').trim();
              if (!labelVal) return; // ignore empty labels
              canonicalMap[can][upk] = labelVal;
            } catch (e) {}
          });
        } else if (labelsArr && typeof labelsArr === 'object') {
          Object.keys(labelsArr || {}).forEach(k => {
            try {
              const [topicPart, pk] = k.split('|');
              if (!topicPart || !pk) return;
              const can = canonicalForTopic(topicPart) || topicPart;
              if (!canonicalMap[can]) canonicalMap[can] = {};
              canonicalMap[can][pk.toUpperCase()] = labelsArr[k] || '';
            } catch (e) {}
          });
        }
        setPowerLabelsByCanonical(prev => {
          try {
            const next = Object.assign({}, prev || {});
            Object.keys(canonicalMap || {}).forEach(k => { try { next[k] = Object.assign({}, next[k] || {}, canonicalMap[k]); } catch (e) {} });
            return next;
          } catch (e) { return canonicalMap; }
        });
      } catch (e) {
        if (DEBUG) brewskiLog('Dashboard: customer-specific power labels fetch error', e && e.message);
      }
    })();
    return () => { mounted = false; };
  }, [customerId, token]);
  
  // Debug info for /admin/api/me hydration attempts (visible when DEBUG=true)
  const [meDebug, setMeDebug] = useState(null);
  // responsive layout measurements
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const wsRef = useRef(null);
  // While hydrating from /api/latest we may want to prefer live replies that
  // arrive immediately after probes. Use these refs to defer applying the
  // snapshot for a short window so live stat/STATE messages can override it.
  const snapshotPendingRef = useRef(false);
  const liveUpdatedBasesRef = useRef(new Set());
  const pendingSnapshotRef = useRef({ addsSensors: {}, addsMeta: {}, addsPower: {}, seenDbBases: new Set() });
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
  // Meta information about gPower entries: whether they were observed live
  // (via applyPower/applyStatPower) and last-seen timestamp. This prevents
  // snapshot-only entries from immediately creating interactive buttons.
  const [gPowerMeta, setGPowerMeta] = useState({});
  // meta map: baseKey -> { site, device, metric }
  const [gMeta, setGMeta] = useState({});
  // Known company slugs discovered from the server (preferred) or inferred locally.
  const [knownSlugs, setKnownSlugs] = useState(new Set());

  // React Native: try to hydrate a previously-persisted customer slug very early
  // so snapshot filtering doesn't hide gauges while network requests finish.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // Only on RN environments; on web rely on safeLocal/localStorage
        if (!isReactNative) return;
        let persisted = await readPersistedCustomerSlug();
        if (!mounted) return;
        // If we don't have a persisted slug, try reading a persisted token and parse it
        if (!persisted) {
          try {
            const tok = await readPersistedToken();
            if (tok) {
              const payload = parseJwtPayloadEarly(tok);
              const maybeSlug = (payload && ((payload.customer && payload.customer.slug) || payload.customer_slug || payload.site || payload.org)) || null;
              const looksLikeSlug = (s) => { try { return typeof s === 'string' && /[A-Za-z]/.test(s) && String(s).length >= 2; } catch (e) { return false; } };
              if (maybeSlug && looksLikeSlug(maybeSlug)) persisted = maybeSlug;
            }
          } catch (e) {}
        }
        if (persisted && !customerSlug) {
          try { setCustomerSlug(persisted); } catch (e) {}
          try { setMode(String(persisted).toUpperCase()); } catch (e) {}
        }

        // Also attempt to hydrate a persisted numeric customerId
        try {
          const pid = await readPersistedCustomerId();
          if (pid && !customerId) {
            try { setCustomerId(pid); } catch (e) {}
          }
        } catch (e) {}

        if (!persisted && !AsyncStorage) {
          // On a full native build without AsyncStorage available, log a helpful message
          if (DEBUG) brewskiLog('Dashboard: AsyncStorage not available — RN cold-start may lack persisted customer context');
        }
      } catch (e) {}
    })();
    return () => { mounted = false; };
  }, []);

  // Persist customerSlug changes to AsyncStorage (RN) so next cold start has context
  useEffect(() => {
    try {
      if (!isReactNative) return;
      // best-effort async persist; don't await to avoid blocking UI
      persistCustomerSlugToStorage(customerSlug).catch(() => {});
    } catch (e) {}
  }, [customerSlug]);



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

  // Normalize canonical keys for consistent state indexing. We uppercase the
  // site/slug segment so lookups across snapshots, live MQTT and local discovery
  // don't suffer from case mismatches that can cause devices to disappear.
  const normalizeCanonicalKey = (k) => {
    try {
      if (!k && k !== 0) return k;
      const s = String(k || '').split('/').filter(Boolean);
      if (!s.length) return String(k || '');
      s[0] = String(s[0]).toUpperCase();
      return s.join('/');
    } catch (e) { return k; }
  };

  const normalizeObjectKeys = (obj) => {
    try {
      if (!obj || typeof obj !== 'object') return obj;
      const out = {};
      Object.entries(obj).forEach(([k, v]) => {
        try { out[normalizeCanonicalKey(k)] = v; } catch (e) { out[k] = v; }
      });
      return out;
    } catch (e) { return obj; }
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
  if (DEBUG) brewskiLog('Dashboard: JWT fast-path rejected candidate (not a slug):', maybeSlug);
      }
    } catch (e) {}
  }, [token]);

  // Persist customerId to AsyncStorage and safeLocal when it changes
  useEffect(() => {
    try {
      // Async persist
      persistCustomerIdToStorage(customerId).catch(() => {});
    } catch (e) {}
    try {
      if (typeof safeLocal !== 'undefined' && safeLocal && typeof safeLocal.setItem === 'function') {
        if (customerId === null || customerId === undefined) safeLocal.removeItem(_STORAGE_KEYS.customerId);
        else safeLocal.setItem(_STORAGE_KEYS.customerId, String(customerId));
      }
    } catch (e) {}
  }, [customerId]);

  // Persist customerSlug to safeLocal when it changes so synchronous reads during
  // first render have context (helps RN cold-start). AsyncStorage is used too
  // for long-term persistence.
  useEffect(() => {
    try {
      if (typeof safeLocal !== 'undefined' && safeLocal && typeof safeLocal.setItem === 'function') {
        if (!customerSlug) safeLocal.removeItem(_STORAGE_KEYS.customerSlug);
        else safeLocal.setItem(_STORAGE_KEYS.customerSlug, String(customerSlug));
      }
    } catch (e) {}
    try { persistCustomerSlugToStorage(customerSlug).catch(() => {}); } catch (e) {}
    if (DEBUG) brewskiLog('Dashboard: persisted customerSlug ->', customerSlug, 'mode->', mode, 'customerId->', customerId);
  }, [customerSlug, mode, customerId]);

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

        // Use doApiFetch (prefers window.apiFetch) so we hit the canonical API host
        // and avoid getting the SPA HTML from the web host.
        let res = null;
        try {
          res = await doApiFetch('/admin/api/me', { headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : undefined });
          record.attempts.push({ method: 'doApiFetch', url: '/admin/api/me', ok: res && res.ok, status: res && res.status });
        } catch (e) { record.attempts.push({ method: 'doApiFetch', ok: false, error: String(e) }); }

        // If that failed, try ?token fallback using doApiFetch as well
        if (!res || !res.ok) {
          try {
            const qPath = `/admin/api/me?token=${encodeURIComponent(token)}`;
            const r2 = await doApiFetch(qPath);
            record.attempts.push({ method: 'doApiFetch?token', url: qPath, ok: r2 && r2.ok, status: r2 && r2.status });
            if (r2 && r2.ok) res = r2;
          } catch (e) { record.attempts.push({ method: 'doApiFetch?token', ok: false, error: String(e) }); }
        }
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
            let cres = null;
            try {
              // Use centralized helper so requests go to canonical API host and follow same routing as other calls
              cres = await doApiFetch(`/admin/api/customers/${encodeURIComponent(custId)}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
              record.attempts.push({ method: 'custFetch', url: `/admin/api/customers/${encodeURIComponent(custId)}`, ok: cres && cres.ok, status: cres && cres.status });
            } catch (e) { record.attempts.push({ method: 'custFetch', url: `/admin/api/customers/${encodeURIComponent(custId)}`, ok: false, error: String(e) }); }

            // If that failed, try the token query-string fallback via the same helper
            if ((!cres || !cres.ok)) {
              try {
                const qPath = `/admin/api/customers/${encodeURIComponent(custId)}?token=${encodeURIComponent(token)}`;
                const cres2 = await doApiFetch(qPath);
                record.attempts.push({ method: 'custFetch?token', url: qPath, ok: cres2 && cres2.ok, status: cres2 && cres2.status });
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
  if (DEBUG) brewskiLog('Dashboard: /admin/api/me hydrate error', e);
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
    // Track which placeholder power_label posts we've recently attempted so we don't repeat them
    const placeholderPostedRef = useRef(new Map()); // key -> timestamp ms
  // Legacy-nosite tracking removed: we no longer default to BREW or strip
  // site prefixes for historical topics. Keep a placeholder ref to avoid
  // extensive refactor churn elsewhere in the file.
  const legacyNoSiteDevicesRef = useRef(new Set());
    // Debounce timer to consolidate label refreshes after multiple posts
    const labelsRefreshTimerRef = useRef(null);

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

        // Use the component-level doApiFetch helper so all admin/public API
        // calls are routed consistently to the canonical API host.
        const res = await doApiFetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
          let bodyTxt = '';
          try {
            bodyTxt = await res.text().catch(() => '');
            console.warn('Dashboard: failed to persist base', { baseKey, status: res.status, path, payload, body: bodyTxt });
          } catch (e) {
            if (DEBUG) console.log('Dashboard: failed to persist base', baseKey, res && res.status);
          }

          // If server responded with 400/bad_id for numeric-customer endpoint, try generic admin topics endpoint
          // by including customer_slug in the payload. This helps when server expects slug-based create.
              try {
                const lower = (bodyTxt || '').toLowerCase();
                if (res && res.status === 400 && lower.includes('bad_id') && customerSlug) {
                  const fallbackPath = `/admin/api/customers/topics`;
                  const fallbackPayload = { ...payload, customer_slug: customerSlug };
                  if (DEBUG) console.log('Dashboard: attempting slug-fallback persist', { fallbackPath, fallbackPayload });
                  const res2 = await doApiFetch(fallbackPath, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(fallbackPayload),
                  });
                  if (res2 && res2.ok) {
                    persistedBasesRef.current.add(baseKey);
                    try { setDbSensorBases(prev => { const s = new Set(Array.from(prev || [])); s.add(baseKey); return s; }); } catch (e) {}
                    if (DEBUG) console.log('Dashboard: slug-fallback persisted base to topics DB', baseKey, fallbackPath, fallbackPayload);
                    return true;
                  } else {
                    try { const t2 = await res2.text().catch(() => ''); if (DEBUG) console.warn('Dashboard: slug-fallback failed', { status: res2.status, body: t2 }); } catch (e) {}
                  }
                }
              } catch (e) { if (DEBUG) console.warn('Dashboard: slug-fallback exception', e && e.message); }
        }
      } catch (e) { if (DEBUG) console.log('Dashboard: persistBaseToDB error', e && e.message); }
      return false;
    };

    // Persist discovered power keys for a canonical base to the server so AdminPortal
    // can render editable slots for POWER/POWER1/.. keys even if labels don't yet exist.
    // This implementation is intentionally concise and defensive to avoid nested
    // control-flow that previously led to a mismatched-brace syntax error.
    const persistDiscoveredPowerKeys = async (baseKey, powerStates) => {
      try {
        if (!token) return false;
        if (!baseKey || !powerStates || typeof powerStates !== 'object') return false;
        if (!customerId && !customerSlug) return false;

        const keys = Object.keys(powerStates || {}).map(k => String(k).toUpperCase());
        if (!keys.length) return false;

        const canonicalBase = normalizeCanonicalBase(baseKey, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || baseKey;
        const canonicalTopic = `${canonicalBase}/STATE`;

        // Fetch existing server labels for this customer so we can detect any
        // non-empty label for the same device+power_key across topic variants
        // (including legacy NOSITE rows). This prevents posting blank placeholders
        // that would otherwise create duplicate/overlapping rows.
        let existingKeys = new Set(); // set of POWER keys already present for this device
        try {
          // Use a short-lived cache keyed by numeric customerId or customerSlug to avoid
          // hammering the /api/power-labels endpoint during discovery bursts.
          const cacheKey = customerId ? `id:${customerId}` : (customerSlug ? `slug:${customerSlug}` : '__anon__');
          const ttlMs = 10_000; // 10 seconds
          const cached = _powerLabelsFetchCache.get(cacheKey);
          let js = null;
          if (cached && (Date.now() - cached.ts) < ttlMs) {
            js = { labels: Array.from(cached.existing || []) };
          } else {
            let fetchPath = null;
            if (customerId) fetchPath = `/admin/api/power-labels?customer_id=${encodeURIComponent(customerId)}`;
            else if (customerSlug) fetchPath = `/api/power-labels?customer_slug=${encodeURIComponent(customerSlug)}`;
            else fetchPath = `/api/power-labels`;

            let r = null;
            try { r = await doApiFetch(fetchPath); } catch (e) { r = null; }
            if (!r || !r.ok) {
              try { r = await doApiFetch(`/api/power-labels`); } catch (e) { r = r || null; }
            }
            if (r && r.ok) js = await r.json().catch(() => null);

            // Populate simple cache set of existing non-empty label keys by device/power_key
            try {
              if (js && Array.isArray(js.labels)) {
                const cacheSet = new Set();
                js.labels.forEach(l => {
                  try {
                    if (!l || !l.topic || !l.power_key) return;
                    const raw = String(l.topic || '');
                    let s = raw.replace(/^(tele|stat)\//i, '');
                    const parts = s.split('/').filter(Boolean).map(p => String(p).toUpperCase());
                    while (parts.length && parts[parts.length - 1] === 'STATE') parts.pop();
                    if (!parts.length) return;
                    const storedDevice = parts.length >= 2 ? parts[1] : parts[0];
                    const upk = String(l.power_key).toUpperCase();
                    const hasLabel = String(l.label || '').trim().length > 0;
                    if (hasLabel && storedDevice) cacheSet.add(`${storedDevice}|${upk}`);
                  } catch (e) {}
                });
                _powerLabelsFetchCache.set(cacheKey, { ts: Date.now(), existing: cacheSet });
              }
            } catch (e) {}
          }

          if (js && Array.isArray(js.labels)) {
            const targetParts = String(canonicalBase || '').split('/').filter(Boolean);
            const targetDevice = targetParts.length >= 2 ? String(targetParts[1]).toUpperCase() : (targetParts[0] || '').toUpperCase();
            js.labels.forEach(l => {
              try {
                if (!l || !l.topic || !l.power_key) return;
                const raw = String(l.topic || '');
                let s = raw.replace(/^(tele|stat)\//i, '');
                const parts = s.split('/').filter(Boolean).map(p => String(p).toUpperCase());
                while (parts.length && parts[parts.length - 1] === 'STATE') parts.pop();
                if (!parts.length) return;
                const storedDevice = parts.length >= 2 ? parts[1] : parts[0];
                if (!storedDevice) return;
                const upk = String(l.power_key).toUpperCase();
                const hasLabel = String(l.label || '').trim().length > 0;
                if (hasLabel && storedDevice === targetDevice) existingKeys.add(upk);
              } catch (e) {}
            });
          }
        } catch (e) { /* ignore fetch errors and proceed to attempt posts */ }

        let savedAny = false;
        for (const pk of keys) {
          try {
            if (existingKeys.has(pk)) continue; // server already knows this key for this device
            const placeholderKey = `${canonicalTopic}|${pk}`;
            const lastPosted = placeholderPostedRef.current.get(placeholderKey) || 0;
            const now = Date.now();
            if (now - lastPosted < 60_000) continue; // rate-limit reposts

            // Build payload; include numeric customer_id when available
            const payload = { topic: canonicalTopic, power_key: pk, label: '' };
            if (customerId) payload.customer_id = customerId;

            // Try admin endpoint first, then public fallback
            let ok = false;
            try {
              const res = await doApiFetch('/admin/api/power-labels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
              if (res && (res.ok || (res.status && res.status >= 200 && res.status < 300))) ok = true;
            } catch (e) { /* ignore */ }
            if (!ok) {
              try {
                const res2 = await doApiFetch('/api/power-labels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (res2 && (res2.ok || (res2.status && res2.status >= 200 && res2.status < 300))) ok = true;
              } catch (e) { /* ignore */ }
            }

            if (ok) {
              savedAny = true;
              placeholderPostedRef.current.set(placeholderKey, Date.now());
            }
          } catch (e) { /* per-key error is non-fatal */ }
        }

        if (savedAny) {
          // Debounced refresh to consolidate multiple posts
          if (labelsRefreshTimerRef.current) clearTimeout(labelsRefreshTimerRef.current);
          labelsRefreshTimerRef.current = setTimeout(async () => {
            try {
              const labelsArr = await fetchPowerLabels(token, customerId);
              const labelMap = {};
              if (Array.isArray(labelsArr)) {
                labelsArr.forEach(l => {
                  try {
                    if (l && l.topic && l.power_key) {
                      const val = String(l.label || '').trim();
                      if (!val) return; // skip empty labels
                      const key = `${l.topic}|${l.power_key}`;
                      labelMap[key] = val;
                      labelMap[key.toUpperCase()] = val;
                      const candidates = canonicalCandidatesForTopic(l.topic);
                      candidates.forEach(t => {
                        try {
                          const k1 = `${t}|${l.power_key}`;
                          const k2 = `${t}|${l.power_key.toUpperCase()}`;
                          if (!labelMap[k1]) labelMap[k1] = val;
                          if (!labelMap[k2]) labelMap[k2] = val;
                        } catch (e) {}
                      });
                    }
                  } catch (e) {}
                });
              }
              setPowerLabels(l => ({ ...l, ...labelMap }));
              try { if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent('brewski:power-labels-synced', { detail: { timestamp: Date.now() } })); } catch (e) {}
            } catch (e) {}
          }, 800);
        }

        return savedAny;
      } catch (e) { return false; }
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
  // store numeric customer id if provided by /api/latest so we can POST admin updates
  const [customerId, setCustomerId] = useState(() => {
    try {
      const v = safeLocal.getItem(_STORAGE_KEYS.customerId);
      const n = v ? Number(v) : null;
      return Number.isFinite(n) ? n : null;
    } catch (e) { return null; }
  });
  // UI filter: customer slug (dynamic based on user's customer)
  // Seed customerSlug and mode synchronously from safeLocal so initial render
  // has effectiveMode available (helps RN cold-starts where AsyncStorage is async).
  const [mode, setMode] = useState(() => {
    try {
      const s = safeLocal.getItem(_STORAGE_KEYS.customerSlug);
      return s ? String(s).toUpperCase() : null;
    } catch (e) { return null; }
  });
  const [customerSlug, setCustomerSlug] = useState(() => {
    try {
      const s = safeLocal.getItem(_STORAGE_KEYS.customerSlug);
      return s || null;
    } catch (e) { return null; }
  });
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

  // Note: removed legacy placeholder defaultDevices (DUMMY*).
  // Devices are discovered dynamically from the server snapshot and live topics.
  const connTimeoutRef = useRef(null);
  // Set of canonical base keys (e.g., "BREW/Device" or "RAIL/Device[/Metric]") derived
  // from the server-side topics DB via /api/latest. This is authoritative for which
  // gauges should be created. Populated during snapshot hydrate and kept for runtime.
  const [dbSensorBases, setDbSensorBases] = useState(new Set());

    // Auto-sync: when gPower changes, ensure discovered bases and power keys exist in server DB.
    // This runs best-effort in background and avoids repeated work via a ref cache.
    const syncedPowerRef = useRef(new Set());
    useEffect(() => {
      try {
        const entries = Object.entries(gPower || {});
        if (!entries.length) return;
        (async () => {
          for (const [baseKeyRaw, states] of entries) {
            try {
              const baseKey = normalizeCanonicalBase(baseKeyRaw, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
              if (!baseKey) continue;
              // Skip DUMMYs
              if (/\bDUMMY/i.test(baseKey)) continue;
              const cacheKey = `${baseKey}|${Object.keys(states || {}).join(',')}`;
              if (syncedPowerRef.current.has(cacheKey)) continue;
              // Persist canonical base (topics DB) if missing
              await persistBaseToDB(baseKey, baseKeyRaw, gMeta && gMeta[baseKeyRaw] ? gMeta[baseKeyRaw] : null);
              // Persist discovered POWER keys as empty power_label rows so AdminPortal can edit them
              await persistDiscoveredPowerKeys(baseKey, states);
              syncedPowerRef.current.add(cacheKey);
            } catch (e) { /* swallow per-entry errors */ }
          }
        })();
      } catch (e) {}
    }, [gPower, knownSlugs, gMeta, dbSensorBases, customerSlug, mode, token]);

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
        // Normalize using helper (prefers DB/gMeta-discovered non-BREW variants)
        return normalizeCanonicalBase(origKey, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
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
          // DB-backed gating is optional. When dbSensorBases contains entries
          // we used to *always* reject canonical bases not present in that set.
          // That prevents rendering newly-seen devices (like BREWHOUSE) when the
          // server snapshot lags. Make this behaviour opt-in via
          // REQUIRE_DB_SENSOR_BASES=1 so by default any device with a Sensor
          // topic will be rendered.
          const dbSet = dbSensorBases;
          const requireDbGating = (typeof process !== 'undefined' && process.env && process.env.REQUIRE_DB_SENSOR_BASES === '1');
          if (requireDbGating && dbSet && dbSet.size) {
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

    // Include gPower bases only when they are backed by sensor meta or
    // explicitly present in the server-provided dbSensorBases snapshot.
    // Previously we unconditionally added power-only bases which caused
    // labels stored under other prefixes (e.g. RAIL/...) to leak controls
    // into unrelated MODE pages. Be conservative: only promote gPower keys
    // that are sensor-backed or known to the DB snapshot.
    Object.keys(gPower || {}).forEach(k => {
      try {
        if (!k || typeof k !== 'string') return;
        // Normalize the candidate so comparisons are consistent
        const norm = normalizeCanonicalBase(k, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || k;
        // Check for explicit sensor meta under the normalized base
        const hasMetaSensor = (() => {
          try {
            if (gMeta && gMeta[norm] && gMeta[norm].terminal && String(gMeta[norm].terminal).toLowerCase() === 'sensor') return true;
            for (const mk of Object.keys(gMeta || {})) {
              if (mk && mk.startsWith(norm + '/') && gMeta[mk] && gMeta[mk].terminal && String(gMeta[mk].terminal).toLowerCase() === 'sensor') return true;
            }
          } catch (e) {}
          return false;
        })();
        const inDb = dbSensorBases && dbSensorBases.has(norm);
        if (hasMetaSensor || inDb) candidateKeys.add(k);
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

            // If we have authoritative DB entries but no customer context yet, prefer
            // to show only unscoped/BREW entries rather than hiding everything.
            // Hiding all devices here caused native clients to render an empty list
            // when the snapshot arrived before `mode`/`customerSlug` was established.
            // Keep the later per-device site checks so customer-prefixed bases remain
            // hidden until `mode` is available.

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
  // Compute a stable canonical base for a raw topic string. Prefer DB snapshot
  // entries and explicit mode/customerSlug when available so variants collapse
  // to a single representative.
  const canonicalForTopic = (topic) => {
    try {
      if (!topic || typeof topic !== 'string') return null;
      // Normalize topic by stripping tele/stat prefix and trailing STATE/RESULT
      let s = String(topic).trim();
      s = s.replace(/^(tele|stat)\//i, '');
      s = s.replace(/\/(STATE|RESULT)$/i, '');
      // Try normalized core first
      const norm = normalizeCanonicalBase(s, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
      if (norm) {
        try {
          const parts = String(norm).split('/').filter(Boolean);
          if (parts.length >= 1) parts[0] = parts[0].toUpperCase();
          return parts.join('/');
        } catch (e) { return norm; }
      }
      // Fallback: try original topic
      const norm2 = normalizeCanonicalBase(topic, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
      if (norm2) {
        try {
          const parts = String(norm2).split('/').filter(Boolean);
          if (parts.length >= 1) parts[0] = parts[0].toUpperCase();
          return parts.join('/');
        } catch (e) { return norm2; }
      }
      return null;
    } catch (e) { return null; }
  };

  const getPowerLabel = (baseKey, powerKey) => {
    if (!baseKey || !powerKey) return '';
    try {
      const pk = String(powerKey).toUpperCase();
      // Quick preference: if we have an active site (mode or customerSlug),
      // try explicit site-prefixed keys first so labels for the current
      // customer take precedence over other customers' entries.
      try {
        const activeSite = (mode || (customerSlug ? String(customerSlug).toUpperCase() : null));
        if (activeSite) {
          const parts = String(baseKey || '').split('/').filter(Boolean);
          const device = parts.length >= 2 ? parts[1] : parts[0];
          if (device) {
            const tryKeys = [
              `${activeSite}/${device}|${pk}`,
              `${activeSite}/${device}/STATE|${pk}`,
              `tele/${activeSite}/${device}/STATE|${pk}`
            ];
            for (const k of tryKeys) {
              if (!k) continue;
              if (powerLabels[k]) return powerLabels[k];
              if (powerLabels[k.toUpperCase()]) return powerLabels[k.toUpperCase()];
            }
          }
        }
      } catch (e) {}
      // 1) Prefer grouped canonical map from server (SITE/DEVICE -> { POWER: label })
      try {
        const can = canonicalForTopic(baseKey) || baseKey;
        if (can && powerLabelsByCanonical && powerLabelsByCanonical[can] && powerLabelsByCanonical[can][pk]) return powerLabelsByCanonical[can][pk];
      } catch (e) {}

      // 2) Direct exact matches
      const direct = `${baseKey}|${pk}`;
      if (powerLabels[direct]) return powerLabels[direct];
      if (powerLabels[direct.toUpperCase()]) return powerLabels[direct.toUpperCase()];

      // 3) Check canonical SITE/DEVICE keys in powerLabels (with and without /STATE)
      try {
        const can = canonicalForTopic(baseKey) || null;
        if (can) {
          const canonicalKey = `${can}|${pk}`;
          const canonicalStateKey = `${can}/STATE|${pk}`;
          if (powerLabels[canonicalKey]) return powerLabels[canonicalKey];
          if (powerLabels[canonicalKey.toUpperCase()]) return powerLabels[canonicalKey.toUpperCase()];
          if (powerLabels[canonicalStateKey]) return powerLabels[canonicalStateKey];
          if (powerLabels[canonicalStateKey.toUpperCase()]) return powerLabels[canonicalStateKey.toUpperCase()];
        }
      } catch (e) {}

      // 4) Try canonical candidate topics (tele/... and legacy variants)
      const candidates = canonicalCandidatesForTopic(baseKey || '') || [];
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
        if (!c) continue;
        const k = `${c}|${pk}`;
        if (powerLabels[k]) return powerLabels[k];
        if (powerLabels[k.toUpperCase()]) return powerLabels[k.toUpperCase()];
        // also try canonical-for-candidate -> then try canonical/STATE variant
        const candCan = canonicalForTopic(c);
        if (candCan) {
          const kk = `${candCan}|${pk}`;
          if (powerLabels[kk]) return powerLabels[kk];
          if (powerLabels[kk.toUpperCase()]) return powerLabels[kk.toUpperCase()];
          // also try candCan/STATE canonical key (server canonical form)
          try {
            const kkState = `${candCan}/STATE|${pk}`;
            if (powerLabels[kkState]) return powerLabels[kkState];
            if (powerLabels[kkState.toUpperCase()]) return powerLabels[kkState.toUpperCase()];
          } catch (e) {}
        }
      }

      // Special-case normalization: some devices arrive as legacy/unprefixed and
      // are placed into the BREW bucket while AdminPortal stores labels under
      // the real org slug (or vice-versa). Try swapping prefixes between BREW
      // and any known slug to find a matching label before falling back to
      // device-name-only heuristics.
      try {
        const parts = String(baseKey).split('/').filter(Boolean);
        if (parts.length >= 2) {
          const site = parts[0];
          const device = parts[1];
          // If this base is under BREW, try known slugs that match a customer and
          // look up labels under that prefix (e.g., BREW/FOO -> FOO/Device)
          if (site.toUpperCase() === 'BREW' && knownSlugs && knownSlugs.size) {
            for (const s of Array.from(knownSlugs)) {
              if (!s) continue;
              const alt = `${s}/${device}|${pk}`;
              if (powerLabels[alt]) return powerLabels[alt];
              if (powerLabels[alt.toUpperCase()]) return powerLabels[alt.toUpperCase()];
            }
          }
          // Conversely, if baseKey is under a customer slug but admin labels were
          // stored under BREW, try the BREW-prefixed variant.
          if (site.toUpperCase() !== 'BREW') {
            const alt2 = `BREW/${device}|${pk}`;
            if (powerLabels[alt2]) return powerLabels[alt2];
            if (powerLabels[alt2.toUpperCase()]) return powerLabels[alt2.toUpperCase()];
          }
        }
      } catch (e) {}

      // Last resort: try matching by device name across powerLabels keys but only
      // when the stored label's canonical base equals the requested canonical base.
      // This prevents labels under prefixes like RAIL/<DEVICE> from bleeding into
      // MODE/DEVICE canonical entries.
      const parts = baseKey.split('/').filter(Boolean);
      const deviceName = parts.length >= 2 ? parts[1] : parts[0];
      if (deviceName) {
        const upDev = deviceName.toUpperCase();
        const requestedCanon = canonicalForTopic(baseKey) || normalizeCanonicalBase(baseKey, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || baseKey;
        for (const k of Object.keys(powerLabels || {})) {
          try {
            const [topicPart, keyPart] = k.split('|');
            if (!keyPart) continue;
            if (keyPart.toUpperCase() !== pk) continue;
            if (!topicPart) continue;
            // Only consider stored labels whose canonical base equals requestedCanon
            const storedCanon = canonicalForTopic(topicPart) || normalizeCanonicalBase(topicPart, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || topicPart;
            if (!storedCanon || storedCanon !== requestedCanon) continue;
            // If the topicPart ends with the device name or contains `/device` then prefer it
            const toks = (topicPart || '').split('/').filter(Boolean);
            const candDev = toks.length >= 2 ? toks[1] : toks[0];
            if (!candDev) continue;
            const t = candDev.toUpperCase();
            if (t === upDev) {
              const v = powerLabels[k] || powerLabels[k.toUpperCase()];
              if (v && String(v).trim()) return v;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    // Diagnostic: surface missing mapping when we have labels loaded but no match
    try {
      const hasAny = Object.keys(powerLabels || {}).length > 0;
      if (hasAny) {
        if (DEBUG) console.warn('Dashboard: getPowerLabel - no label found', { baseKey, powerKey, sampleKeys: Object.keys(powerLabels || {}).slice(0,10) });
      } else {
        if (DEBUG) console.warn('Dashboard: getPowerLabel - powerLabels map empty');
      }
    } catch (e) {}
    return '';
  };

  // Indicator renderers for special label suffixes (lowercase keys).
  // Each renderer receives an object { isOn } and should return a JSX element.
  const INDICATOR_RENDERERS = {
    // Example: HEATING-heatingindicator -> render a small red 'lamp' when ON
    heatingindicator: ({ isOn }) => (
      <View style={{ width: '100%', alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: isOn ? '#d32f2f' : '#cfd8dc', borderWidth: 1, borderColor: isOn ? '#b71c1c' : '#b0bec5', shadowColor: '#000', shadowOffset: { width: 0, height: isOn ? 2 : 1 }, shadowOpacity: isOn ? 0.25 : 0.08, shadowRadius: isOn ? 3 : 1 }} />
      </View>
    ),
    // Example: COOLING-coolingindicator -> render a small blue 'cool' lamp when ON
    coolingindicator: ({ isOn }) => (
      <View style={{ width: '100%', alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: isOn ? '#1976d2' : '#cfd8dc', borderWidth: 1, borderColor: isOn ? '#0d47a1' : '#b0bec5', shadowColor: '#000', shadowOffset: { width: 0, height: isOn ? 2 : 1 }, shadowOpacity: isOn ? 0.22 : 0.08, shadowRadius: isOn ? 3 : 1 }} />
      </View>
    ),
    // future indicators can be added here
  };

  const [connectionError, setConnectionError] = useState(false);
  // diagnostics for missing Target currents
  const targetRequestCounts = useRef({}); // base -> count of get requests sent
  const targetReceiveCounts = useRef({}); // base -> count of current/ message target receipts

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

  // Centralized helper for making admin/public API calls from the Dashboard.
  // Prefer `window.apiFetch` when available (it may return parsed JSON). When
  // not available, build an absolute URL to the canonical API host so requests
  // don't go to the web host and accidentally return SPA HTML.
  const doApiFetch = async (path, opts) => {
    try {
      if (typeof window !== 'undefined' && window.apiFetch) {
        try {
          const r = await window.apiFetch(path, opts);
          // If window.apiFetch returned a Response-like object, return it.
          if (r && typeof r === 'object' && ('ok' in r || 'status' in r)) return r;
          // Otherwise wrap the parsed JSON into a Response-like object
          return {
            ok: true,
            status: 200,
            json: async () => r,
            text: async () => (typeof r === 'string' ? r : JSON.stringify(r)),
          };
        } catch (e) {
          // fallthrough to direct fetch
          if (DEBUG) console.warn('Dashboard: window.apiFetch failed, falling back to direct fetch', e && e.message);
        }
      }
    } catch (e) {}

    const base = `https://${resolveHost()}`;
    const url = `${base}${path}`;
    const headers = Object.assign({}, (opts && opts.headers) || {});
    // Prefer JSON responses and mark as XHR so some proxies/servers route to API
    if (!headers['Accept']) headers['Accept'] = 'application/json, text/plain;q=0.9,*/*;q=0.1';
    // Avoid adding X-Requested-With for cross-origin requests to prevent CORS
    // preflight failures when the SPA origin differs from the API host.
    try {
      if (!headers['X-Requested-With']) {
        const isWeb = (typeof window !== 'undefined' && typeof window.document !== 'undefined');
        if (!isWeb) {
          headers['X-Requested-With'] = 'XMLHttpRequest';
        } else {
          try {
            const isAbsolute = /^https?:\/\//i.test(url);
            if (!isAbsolute) headers['X-Requested-With'] = 'XMLHttpRequest';
            else {
              const fpHost = (new URL(url)).hostname || '';
              const curHost = window.location.hostname || '';
              if (fpHost && curHost && fpHost === curHost) headers['X-Requested-With'] = 'XMLHttpRequest';
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    if (token && !headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${token}`;
    const merged = Object.assign({}, opts || {}, { headers });
    const res = await fetch(url, merged);
    return res;
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
        // request current target and sensor for the default devices once connected
        const sendInitialGets = () => {
          // Request current Target/Sensor for any discovered DB-backed devices
          // derived from the deviceList (built from gMeta/gSensors/gPower and dbSensorBases).
          try {
            (deviceList || []).forEach(d => {
              if (!d || !d.key) return;
              safeSend(ws, { type: 'get', topic: `${d.key}/Target`, id: `${d.key}-init-target` });
              safeSend(ws, { type: 'get', topic: `${d.key}/Sensor`, id: `${d.key}-init-sensor` });
              targetRequestCounts.current[d.key] = (targetRequestCounts.current[d.key] || 0) + 1;
            });
          } catch (e) {}
        };
        // ask bridge for a snapshot inventory to populate cache without extra GET churn
  safeSend(ws, { type: 'inventory', id: 'initial-inventory' });
        // initial burst, plus retries after 1s and 3s to handle missed replies
        setTimeout(sendInitialGets, 200);
        setTimeout(sendInitialGets, 1000);
        setTimeout(sendInitialGets, 3000);
        
        // Query power states for known devices
            const queryAllPowerStates = () => {
              // Derive device names from the current deviceList to avoid hardcoded probes.
              try {
                const deviceNames = Array.from(new Set((deviceList || []).map(d => {
                  try { const parts = String(d.key || '').split('/').filter(Boolean); return parts.length >= 2 ? parts[1] : parts[0]; } catch (e) { return null; }
                }).filter(Boolean)));
                deviceNames.forEach(deviceName => {
                  try {
                    const site = (mode || (customerSlug ? String(customerSlug).toUpperCase() : null));
                    const primaryTopic = buildCmdTopic(site, deviceName, 'Power');
                    const parts = primaryTopic.split('/'); if (parts && parts.length) parts[0] = parts[0].toLowerCase(); const outTopic = parts.join('/');
                    // Use a 'get' request to query current power state instead of publishing an empty payload
                    safeSend(ws, { type: 'get', topic: outTopic, id: `init-pwq-${site || 'UNK'}-${deviceName}-${Date.now()}` });
                  } catch (e) {}

                  // Query additional power states for multi-switch devices if present
                  const multiSwitchDevices = ['MASH', 'HLT', 'BOIL'];
                  if (multiSwitchDevices.includes(deviceName)) {
                    for (let i = 1; i <= 3; i++) {
                      try {
                        const site = (mode || (customerSlug ? String(customerSlug).toUpperCase() : null));
                        const t = buildCmdTopic(site, deviceName, `Power${i}`);
                        const parts = t.split('/'); if (parts && parts.length) parts[0] = parts[0].toLowerCase(); const out = parts.join('/');
                        // Query auxiliary power switches via 'get' instead of publish
                        safeSend(ws, { type: 'get', topic: out, id: `init-pwq-${site || 'UNK'}-${deviceName}-p${i}-${Date.now()}` });
                      } catch (e) {}
                    }
                  }
                });
              } catch (e) {}
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
          // exclude DUMMY placeholders from retry probing
          const bases = (deviceList || []).map(d => d.key).filter(Boolean);
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
            // If site missing, prefer discovery inference; otherwise do not default to BREW
            if (!meta.site) {
              const inferred = findSiteForDevice(meta.device);
              if (inferred) meta.site = inferred;
              else {
                // leave meta.site null to indicate unscoped/legacy topic
                meta.site = null;
              }
            }
            // build canonical base using current mode/customerSlug
            let canonical = canonicalBaseFromMeta(meta) || (meta.metric ? `${meta.device}/${meta.metric}` : `${meta.device}`);
            if (!canonical) return;
            try { canonical = normalizeCanonicalBase(canonical, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }); } catch (e) {}
            // ensure canonical key uses normalized site-case
            const canonicalNorm = (() => {
              try { const p = String(canonical).split('/').filter(Boolean); if (p.length) p[0] = p[0].toUpperCase(); return p.join('/'); } catch (e) { return canonical; }
            })();
            setGSensors(prev => ({ ...prev, [canonicalNorm]: val }));
            // register enriched meta under canonical base
            const enrichedMeta = { site: (meta.site || (mode ? mode : (customerSlug || null))), device: meta.device, metric: meta.metric || null, terminal: 'Sensor' };
            registerMeta(canonicalNorm, enrichedMeta);
            // Auto-request target for canonical base if missing
            if (!(canonicalNorm in gTargets) && wsRef.current && wsRef.current.readyState === 1) {
              const reqId = canonicalNorm + '-auto-target';
              try { wsRef.current.send(JSON.stringify({ type: 'get', topic: `${canonicalNorm}/Target`, id: reqId })); targetRequestCounts.current[canonicalNorm] = (targetRequestCounts.current[canonicalNorm] || 0) + 1; } catch (e) {}
            }
            // Auto-query power states for newly discovered devices
            const queryPowerStates = (customerSlug, deviceName) => {
              if (!wsRef.current || wsRef.current.readyState !== 1) return;

              const baseKey = `${customerSlug}/${deviceName}`;
              if (gPower[baseKey]) return; // Already have power state

              // Use explicit customer/site prefix when available, otherwise fall back to device-only topic
                try {
                  const pt = buildCmdTopic(customerSlug, deviceName, 'Power');
                  // Query power state via 'get' to avoid emitting control publishes with empty payload
                  wsRef.current.send(JSON.stringify({ type: 'get', topic: pt.split('/').map((p,i)=> i===0? p.toLowerCase():p).join('/'), id: `pwq-${deviceName}-${Date.now()}` }));
                } catch (e) {}

              // Query additional power states (POWER1, POWER2, POWER3) for multi-switch devices
              const commonMultiSwitchDevices = ['MASH', 'HLT', 'BOIL'];
              if (commonMultiSwitchDevices.some(d => deviceName.toUpperCase().includes(d))) {
                for (let i = 1; i <= 3; i++) {
                  try {
                    try {
                      const t = buildCmdTopic(customerSlug, deviceName, `Power${i}`);
                      wsRef.current.send(JSON.stringify({ type: 'get', topic: t.split('/').map((p,i)=> i===0? p.toLowerCase():p).join('/'), id: `pwq-${deviceName}-p${i}-${Date.now()}` }));
                    } catch (e) {}
                  } catch (e) {}
                }
              }
            };
            
            // Detect device patterns and query power states
            const customerSensorMatch = topic.match(/^tele\/([^/]+)\/([^/]+)\/SENSOR$/i);
            if (customerSensorMatch) {
              const [, customerSlugFromTopic, dev] = customerSensorMatch;
              queryPowerStates(customerSlugFromTopic, dev);
            }
            
            // Also check for direct device topics without customer prefix. We do
            // not mark devices as legacy-nosite anymore. If we have a runtime
            // mode (customer slug) we'll attempt to query power states, otherwise
            // skip probing.
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
                persistBaseToDB(canonicalNorm, rawTopicGuess, enrichedMeta).catch(e => {});
              }
            } catch (e) {}
          };
          const applyTarget = (topic, val) => {
            const meta = parseTopic(topic);
            if (!meta) return;
            // If site missing, prefer discovery inference; otherwise do not default to BREW
            if (!meta.site) {
              const inferred = findSiteForDevice(meta.device);
              if (inferred) meta.site = inferred;
              else meta.site = null;
            }
            let canonical = canonicalBaseFromMeta(meta) || (meta.metric ? `${meta.device}/${meta.metric}` : `${meta.device}`);
            if (!canonical) return;
            try { canonical = normalizeCanonicalBase(canonical, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }); } catch (e) {}
            const canonicalNormT = (() => { try { const p = String(canonical).split('/').filter(Boolean); if (p.length) p[0] = p[0].toUpperCase(); return p.join('/'); } catch (e) { return canonical; } })();
            setGTargets(prev => ({ ...prev, [canonicalNormT]: val }));
            const enrichedMetaT = { site: (meta.site || (mode ? mode : (customerSlug || null))), device: meta.device, metric: meta.metric || null, terminal: 'Target' };
            registerMeta(canonicalNormT, enrichedMetaT);
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
                // Prefer explicit site when present in topic; treat it as authoritative
                baseKey = `${customerFromTopic}/${deviceName}`;
                // Normalize minimally to keep site/device as-is (don't prefer DB BREW over explicit site)
                try { var normBaseExplicit = `${customerFromTopic}/${deviceName}`; } catch (e) { var normBaseExplicit = baseKey; }
              }
            }
            // Legacy Pattern: tele/<device>/(STATE|RESULT) - direct device (being phased out)
            else if (parts[0].toLowerCase() === 'tele' && parts.length === 3) {
              deviceName = parts[1];
              if (deviceName) {
                // Try to infer site from existing meta first, else prefer explicit mode, then BREW
                const inferred = findSiteForDevice(deviceName);
                const siteForLegacy = inferred || mode || null; // do NOT default to BREW
                // Do not treat topics without an explicit site as BREW: require
                // an inferred site (via discovery) or runtime mode/customerSlug.
                if (!siteForLegacy) return;
                baseKey = `${siteForLegacy}/${deviceName}`;
              }
            }
            // Response Pattern: stat/<device>/(STATE|RESULT) - device control responses
            else if (parts[0].toLowerCase() === 'stat' && parts.length === 3) {
              deviceName = parts[1];
              if (deviceName) {
                const inferred = findSiteForDevice(deviceName);
                const siteForStat = inferred || mode || null; // do not default to BREW
                // If site cannot be inferred, ignore stat/<device> legacy messages
                if (!siteForStat) return;
                baseKey = `${siteForStat}/${deviceName}`;
              }
            }

            if (!baseKey || !deviceName) return;
            
            // Update meta information
            setGMeta(prev => {
              const existing = prev[baseKey];
              if (!existing && baseKey.includes('/')) {
                const [customerSlugFromKey, deviceFromKey] = baseKey.split('/');
                return { ...prev, [baseKey]: { site: customerSlugFromKey, device: deviceFromKey, metric: null } };
              }
              return prev;
            });

            // Update power states: if the topic contained an explicit site (normBaseExplicit),
            // treat that as authoritative and write under that key. Otherwise normalize.
            try {
              let normBase;
              if (typeof normBaseExplicit !== 'undefined' && normBaseExplicit) {
                normBase = normBaseExplicit;
              } else {
                normBase = normalizeCanonicalBase(baseKey, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
              }
              // Update meta information under normalized key
              setGMeta(prev => {
                const existing = prev[normBase] || prev[baseKey];
                if (!existing && normBase && normBase.includes('/')) {
                  const [customerSlugFromKey, deviceFromKey] = normBase.split('/');
                  return { ...prev, [normBase]: { site: customerSlugFromKey, device: deviceFromKey, metric: null } };
                }
                return prev;
              });

              // Persist canonical base to topics DB if missing (best-effort). Use the
              // original topic string as a rawTopic hint so server can create a sensible record.
              try {
                if (normBase) {
                  if (DEBUG) console.debug('Dashboard: persistBaseToDB attempt for', normBase, topic);
                  persistBaseToDB(normBase, topic, { site: (normBase.split('/')[0] || null), device: (normBase.split('/')[1] || null) }).catch(() => {});
                }
              } catch (e) {}

              setGPower(prev => {
                const cur = { ...(prev[normBase] || {}) };
                Object.assign(cur, powerStates);
                const next = { ...prev, [normBase]: cur };
                // Persist discovered power keys in background (best-effort)
                try { persistDiscoveredPowerKeys(normBase, cur).catch(() => {}); } catch (e) {}
                return next;
              });
              // Mark this base as live (received from a real STATE/RESULT message)
              try { setGPowerMeta(prev => ({ ...(prev || {}), [normBase]: { live: true, ts: Date.now() } })); } catch (e) {}
            } catch (e) {
              setGPower(prev => {
                const cur = { ...(prev[baseKey] || {}) };
                Object.assign(cur, powerStates);
                return { ...prev, [baseKey]: cur };
              });
            }
          };

          // Handle stat/<device>/POWER and stat/<device>/POWERn topics where payload is a simple ON/OFF or 1/0.
          // Treat these as authoritative per-key reports and update gPower immediately.
          const applyStatPower = (topic, rawPayload) => {
            try {
              if (!topic || typeof topic !== 'string') return;
              const parts = topic.split('/').filter(Boolean);
              if (parts.length < 3) return;
              if (parts[0].toLowerCase() !== 'stat') return;
              const last = parts[parts.length - 1];
              if (!/^POWER\d*$/i.test(last)) return;
              const powerKey = String(last).toUpperCase();

              // Support both stat/<device>/POWER and stat/<site>/<device>/POWER
              let site = null; let device = null;
              if (parts.length === 3) {
                // stat/<device>/POWER
                device = parts[1];
              } else if (parts.length >= 4) {
                // stat/<site>/<device>/POWER (or longer)
                site = parts[1]; device = parts[2];
              }
              if (!device) return;

              // Determine site preference
              const siteForStat = site || findSiteForDevice(device) || mode || (customerSlug ? String(customerSlug).toUpperCase() : null) || 'BREW';
              // Do not mark devices as legacy-nosite; require explicit site or inference
              // from discovery/runtime mode. If none available, skip handling.
              const normBase = normalizeCanonicalBase(`${siteForStat}/${device}`, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || `${siteForStat}/${device}`;

              // Interpret payload
              let isOn = false;
              try {
                if (typeof rawPayload === 'string') {
                  const up = rawPayload.trim().toUpperCase();
                  isOn = (up === 'ON' || up === '1' || up === 'TRUE');
                } else if (typeof rawPayload === 'number') {
                  isOn = rawPayload === 1;
                } else if (typeof rawPayload === 'boolean') {
                  isOn = rawPayload;
                }
              } catch (e) {}

              if (DEBUG) {
                try { console.debug('Dashboard: applyStatPower', { topic, normBase, powerKey, isOn }); } catch (e) {}
              }

              // Update meta for base if missing
              setGMeta(prev => {
                const existing = prev[normBase];
                if (!existing && normBase.includes('/')) {
                  const [s, d] = normBase.split('/');
                  return { ...prev, [normBase]: { site: s, device: d, metric: null } };
                }
                return prev;
              });

              setGPower(prev => {
                const cur = { ...(prev[normBase] || {}) };
                cur[powerKey] = isOn;
                const next = { ...prev, [normBase]: cur };
                try { persistDiscoveredPowerKeys(normBase, cur).catch(() => {}); } catch (e) {}
                return next;
              });
              // Mark as live update from stat topic
              try { setGPowerMeta(prev => ({ ...(prev || {}), [normBase]: { live: true, ts: Date.now() } })); } catch (e) {}
            } catch (e) {}
          };

          if (obj.type === 'message' && obj.data && typeof obj.data.topic === 'string') {
            const topic = obj.data.topic;
            const lowerTopic = topic.toLowerCase();
            let raw = obj.data.payload;
            // quick path: handle stat/<device>/POWER* topics directly
            try { applyStatPower(topic, raw); } catch (e) {}
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
            if (!Number.isNaN(n) && n !== null) { applySensor(obj.topic, n); markConnected();}
          }
          if (obj.type === 'current' && typeof obj.topic === 'string' && /\/target$/i.test(obj.topic)) {
            if (obj.payload !== null && obj.payload !== undefined && obj.payload !== '') {
              const n = Number(obj.payload);
              if (!Number.isNaN(n)) { applyTarget(obj.topic, n); markConnected();  }
            }
          }
          // also accept 'current' responses from the bridge for sensor gets
          // DUMMYtest special-case removed: dashboards now rely on server snapshot and discovery
          // grouped inventory snapshot (new message type from bridge)
          if (obj.type === 'grouped-inventory' && obj.data && typeof obj.data === 'object') {
            const groups = obj.data;
            const sensorAdds = {}; const targetAdds = {}; const metaAdds = {};
            Object.values(groups).forEach(g => {
              if (!g || !g.topics) return;
              Object.entries(g.topics).forEach(([topic, val]) => {
                  const parsed = parseTopic(topic);
                  if (!parsed) return;
                      // If site missing in grouped inventory, prefer discovery inference but do NOT default to BREW.
                      if (!parsed.site) {
                        try {
                          const inferred = findSiteForDevice(parsed.device);
                          if (inferred) parsed.site = inferred;
                          else {
                            // leave parsed.site null; we'll skip adding unscoped bases until we have mode/customer context
                            try { legacyNoSiteDevicesRef.current.add(String(parsed.device).toUpperCase()); } catch (e) {}
                          }
                        } catch (e) {}
                      }
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
            // quick path: handle stat/<device>/POWER* topics directly
            try { applyStatPower(obj.topic, raw); } catch (e) {}
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
                      // If discovery provided no site token, mark device as legacy-nosite
                      if (!site && device) {
                        try { legacyNoSiteDevicesRef.current.add(String(device).toUpperCase()); } catch (e) {}
                      }
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
                // If site missing, do NOT default to BREW. Leave parsed.site null so
                // entries without explicit site are ignored until we have a mode/customer context.
                // This prevents creating BREW-prefixed entries from inventories that omit site.
                // if (!parsed.site) parsed.site = 'BREW';
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
  // Also persist the JWT to localStorage.brewski_jwt so shared helpers (window.apiFetch)
  // and other modules that read from localStorage will include Authorization headers.
  // This is a minimal, safe write: only runs when a token is present and avoids
  // repeatedly writing the same value.
  useEffect(() => {
    if (!token) return;
    debug('[TOKEN ready] len=', token.length, 'head=', token.slice(0,10));
    try {
      try {
        if (typeof safeLocal !== 'undefined' && safeLocal && typeof safeLocal.setItem === 'function') {
          const cur = safeLocal.getItem && safeLocal.getItem('brewski_jwt');
          if (cur !== token) {
            safeLocal.setItem('brewski_jwt', token);
            if (DEBUG) console.log('Dashboard: persisted token to safeLocal (brewski_jwt)');
          }
        } else if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.setItem === 'function') {
          const cur = window.localStorage.getItem('brewski_jwt');
          if (cur !== token) {
            window.localStorage.setItem('brewski_jwt', token);
            if (DEBUG) console.log('Dashboard: persisted token to localStorage.brewski_jwt');
          }
        }
        // Also persist token to AsyncStorage for RN so cold starts can hydrate
        try { persistTokenToStorage(token).catch(() => {}); } catch (e) {}
      } catch (e) {
        if (DEBUG) console.warn('Dashboard: failed to persist token to storage', e && e.message);
      }
    } catch (e) {}
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
    // NOTE: Removed localStorage hydration — rely on authoritative DB snapshot and live MQTT only
    // NEW: Snapshot hydrate from /api/latest so gauges and POWER states render immediately after reload (before live MQTT)
    (async () => {
      try {
        const latestPath = '/api/latest';
        let res;
        try {
          // prefer central helper which may return parsed JSON
          res = await doApiFetch(latestPath);
        } catch (e) { res = null; }
        if ((!res || (res && !res.ok)) && token) {
          try { res = await doApiFetch(`${latestPath}?token=${encodeURIComponent(token)}`); } catch (e) { res = res || null; }
        }
        if (!res || !res.ok) return; // ignore failures silently
        const js = await res.json();
        if (!js || !js.sensors || !Array.isArray(js.sensors)) return;

        if (DEBUG) {
          try {
            const sample = (js.sensors || []).slice(0,10).map(r => ({ key: r.key, topic_key: r.topic_key, type: r.type, last_value: r.last_value, last_ts: r.last_ts }));
            console.debug('Dashboard: /api/latest hydrate sample rows:', { sensorsCount: (js.sensors || []).length, sample, hasServerStatList: !!(js.latest_stats || js.stat_messages || js.stats || js.stat_messages_list) });
          } catch (e) {}
        }

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
  // track per-base/per-powerKey timestamps so we apply the most recent snapshot value
  const addsPowerTs = {};
  // collect authoritative DB-backed sensor bases from the snapshot
  const seenDbBases = new Set();
  // If the server exposes a pre-computed list of recent stat/ messages (per-key POWER reports),
  // prefer those as authoritative for initial UI state. Support flexible property names.
  const statLists = js.latest_stats || js.stat_messages || js.stats || js.stat_messages_list || null;
  // Map of canonicalBase -> Set of POWER keys provided by server stats so snapshot doesn't override.
  const statProvidedMap = {};
  if (Array.isArray(statLists) && statLists.length) {
    try {
      statLists.forEach(s => {
        try {
          // Accept objects with { topic, payload } or { topic, value } or raw row shapes
          const topic = s.topic || s.top || s.key || s.stat_topic || null;
          const rawPayload = (s.payload !== undefined) ? s.payload : (s.value !== undefined ? s.value : (s.raw !== undefined ? s.raw : (s.last_value !== undefined ? s.last_value : null)));
          if (!topic) return;

          // Attempt to parse power key from topic (stat/<device>/POWER or stat/<site>/<device>/POWERn)
          const parts = String(topic).split('/').filter(Boolean);
          if (parts.length < 3) return; // expect at least stat/<device>/<POWER>
          if (parts[0].toLowerCase() !== 'stat') return;
          const last = parts[parts.length - 1];
          if (!/^POWER\d*$/i.test(last)) return;
          const powerKey = String(last).toUpperCase();

          // derive site/device like applyStatPower does
          let site = null; let device = null;
          if (parts.length === 3) { device = parts[1]; }
          else if (parts.length >= 4) { site = parts[1]; device = parts[2]; }
          if (!device) return;
          // Do NOT default to 'BREW' for missing site — require explicit site, discovery
          // inference (findSiteForDevice) or runtime mode/customerSlug. If none are
          // available, skip applying this stat message so we don't synthesize BREW entries.
          const siteForStat = site || findSiteForDevice(device) || mode || (customerSlug ? String(customerSlug).toUpperCase() : null);
          if (!siteForStat) return;
          const normBase = normalizeCanonicalBase(`${siteForStat}/${device}`, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || `${siteForStat}/${device}`;

          // mark provided key so snapshot doesn't overwrite
          if (!statProvidedMap[normBase]) statProvidedMap[normBase] = new Set();
          statProvidedMap[normBase].add(powerKey);

          // Call existing applyStatPower helper so client state is seeded exactly like live messages
          try { applyStatPower(topic, rawPayload); } catch (e) {}
        } catch (e) {}
      });
    } catch (e) {}
  }
  else {
    if (DEBUG) console.debug('Dashboard: no server-side stat list found in /api/latest response; relying on sensor rows only');
  }
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

          // If site is missing in the inventory snapshot, do NOT synthesize a
          // 'BREW' prefix. Leave site null so we treat this as a device-only entry.
          if (!site) {
            // historically we tracked legacy no-site devices here; we no longer
            // populate that set and we do not assign a default site.
          }

          // Reconstruct canonical baseKey matching applySensor logic
          let baseKey;
          if (metric) baseKey = site ? `${site}/${device}/${metric}` : `${device}/${metric}`;
          else if (site && device) baseKey = `${site}/${device}`;
          else if (device) baseKey = `${device}`;
          else baseKey = rawTopic;

          // Normalize the canonical base so BREW vs non-BREW duplicates collapse
          try {
            baseKey = normalizeCanonicalBase(baseKey, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
          } catch (e) {}

          // If this snapshot row is not a STATE/RESULT-only entry, record the base
          // as an authoritative DB-backed sensor base. We avoid using STATE/RESULT
          // entries (control/state-only) to drive gauge creation.
          if (!(hasTerminal && /^(STATE|RESULT)$/i.test(lastPart))) {
            seenDbBases.add(baseKey);
          }

          // Hydrate POWER states. Prefer structured raw JSON where possible (row.last_raw / row.last_value).
          const powerLastSeg = rawTopic.split('/').slice(-1)[0];

          // helper to persist found states into addsPower under a normalized base
          const persistFound = (baseCandidate, foundMap, ts) => {
            try {
              if (!baseCandidate) return;
              let powerBaseKey = baseCandidate;
              try { powerBaseKey = normalizeCanonicalBase(powerBaseKey, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }); } catch (e) {}
              if (!powerBaseKey) return;
              if (!addsPower[powerBaseKey]) addsPower[powerBaseKey] = {};
              if (!addsPowerTs[powerBaseKey]) addsPowerTs[powerBaseKey] = {};
              const tsNum = Number(ts) || 0;
              // For each discovered power key, only accept it if it's newer-or-equal to any
              // previously-seen snapshot value for the same base/key. This prevents older
              // compact rows from overwriting newer structured STATE rows.
              Object.entries(foundMap || {}).forEach(([pk, pv]) => {
                try {
                  const upk = String(pk).toUpperCase();
                  // If the server-provided stat list already supplied this base/key, prefer it and skip snapshot apply
                  try {
                    if (statProvidedMap[powerBaseKey] && statProvidedMap[powerBaseKey].has(upk)) {
                      if (DEBUG) console.debug('Dashboard: snapshot.persistFound - skipping because server-stat provided', { powerBaseKey, key: upk });
                      return;
                    }
                  } catch (e) {}
                  const prevTs = Number(addsPowerTs[powerBaseKey][upk] || 0);
                  if (tsNum >= prevTs) {
                    addsPower[powerBaseKey][upk] = pv;
                    addsPowerTs[powerBaseKey][upk] = tsNum;
                  } else {
                    if (DEBUG) {
                      try { console.debug('Dashboard: snapshot.persistFound - skipping older value', { powerBaseKey, key: upk, tsNum, prevTs }); } catch (e) {}
                    }
                  }
                } catch (e) {}
              });
              if (!addsMeta[powerBaseKey]) addsMeta[powerBaseKey] = { site, device, metric: null };
              if (DEBUG) {
                try { console.debug('Dashboard: snapshot.persistFound', { powerBaseKey, addedNow: foundMap, currentAdds: addsPower[powerBaseKey], addsPowerTs: addsPowerTs[powerBaseKey] }); } catch (e) {}
              }
            } catch (e) {}
          };

          // Try parsing row.last_raw first (preferred). Fall back to last_value if needed.
          let parsedLastRaw = null;
          try {
            if (row.last_raw) {
              parsedLastRaw = (typeof row.last_raw === 'string') ? JSON.parse(row.last_raw) : row.last_raw;
            }
          } catch (e) { parsedLastRaw = null; }

          // If last_raw contained POWER keys (e.g., { POWER1: 'OFF', POWER2: 'ON' }), prefer these.
              if (parsedLastRaw && typeof parsedLastRaw === 'object') {
            try {
              const found = {};
              Object.entries(parsedLastRaw).forEach(([k, v]) => {
                try {
                  const up = String(k).toUpperCase();
                  if (up === 'POWER' || /^POWER\d+$/.test(up)) {
                    const isOn = (typeof v === 'string') ? (v.toUpperCase() === 'ON' || v === '1' || v.toUpperCase() === 'TRUE') : !!v;
                    found[up] = isOn;
                  }
                } catch (e) {}
              });
              if (Object.keys(found).length) {
                // If no site is present, prefer device-only base (e.g. `Device`) rather
                // than synthesizing `BREW/Device`.
                const baseCandidate = (site && device) ? `${site}/${device}` : (core && core.length ? (core.length >= 2 ? `${core[0]}/${core[1]}` : `${core[0]}`) : rawTopic);
                persistFound(baseCandidate, found, row.last_ts);
                return;
              }

              // Compact shape: { power_key: 'POWER1', state: 'ON' }
                  if (parsedLastRaw.power_key) {
                const pk = String(parsedLastRaw.power_key).toUpperCase();
                if (/^POWER\d*$/i.test(pk)) {
                  const st = parsedLastRaw.state;
                  const isOn = (typeof st === 'string') ? (st.toUpperCase() === 'ON' || st === '1' || st.toUpperCase() === 'TRUE') : !!st;
                  const baseCandidate = (site && device) ? `${site}/${device}` : (parts && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : (device ? `${device}` : rawTopic));
                  persistFound(baseCandidate, { [pk]: isOn }, row.last_ts);
                  return;
                }
              }
            } catch (e) {}
          }

          // If last_raw didn't yield results, try last_value when it's a JSON string (STATE/RESULT rows)
          if (!parsedLastRaw && hasTerminal && /^(STATE|RESULT)$/i.test(lastPart) && typeof row.last_value === 'string') {
            try {
              const pv = JSON.parse(row.last_value);
              if (pv && typeof pv === 'object') {
                const found = {};
                Object.entries(pv).forEach(([k, v]) => {
                  try {
                    const up = String(k).toUpperCase();
                    if (up === 'POWER' || /^POWER\d+$/.test(up)) {
                      const isOn = (typeof v === 'string') ? (v.toUpperCase() === 'ON' || v === '1' || v.toUpperCase() === 'TRUE') : !!v;
                      found[up] = isOn;
                    }
                  } catch (e) {}
                });
                if (Object.keys(found).length) {
                  const baseCandidate = (site && device) ? `${site}/${device}` : (core && core.length ? (core.length >= 2 ? `${core[0]}/${core[1]}` : `${core[0]}`) : rawTopic);
                  persistFound(baseCandidate, found, row.last_ts);
                  return;
                }
              }
            } catch (e) {}
          }

          // Prefer raw JSON, but if none available, fall back to explicit row.type indicating a POWER key
          if (row.type && /^POWER\d*$/i.test(String(row.type))) {
            try {
              const pk = String(row.type).toUpperCase();
              // prefer any state info in last_raw, else last_value
              let isOn = false;
              try {
                if (row.last_raw) {
                  const lr = (typeof row.last_raw === 'string') ? JSON.parse(row.last_raw) : row.last_raw;
                  if (lr && typeof lr === 'object' && lr.state !== undefined) {
                    const s = lr.state;
                    isOn = (typeof s === 'string') ? (s.toUpperCase() === 'ON' || s === '1' || s.toUpperCase() === 'TRUE') : !!s;
                  }
                }
              } catch (e) {}
              try { if (!isOn && (row.last_value === 1 || row.last_value === '1' || row.last_value === true)) isOn = true; } catch (e) {}
              const baseCandidate = (site && device) ? `${site}/${device}` : (parts && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : (device ? `${device}` : rawTopic));
              persistFound(baseCandidate, { [pk]: isOn }, row.last_ts);
              return;
            } catch (e) {}
          }

          // Legacy: topic itself ends with POWER/POWER1 etc (per-key rows)
          if (/^POWER\d*$/i.test(powerLastSeg)) {
            if (site && device) {
              try {
                const powerKey = powerLastSeg.toUpperCase();
                let isOn = false;
                if (typeof lv === 'string') {
                  isOn = lv === 'ON' || lv === '1' || lv === 'true';
                } else if (typeof lv === 'number') {
                  isOn = lv === 1;
                } else if (typeof lv === 'boolean') {
                  isOn = lv;
                }
                const baseCandidate = `${site}/${device}`;
                persistFound(baseCandidate, { [powerKey]: isOn }, row.last_ts);
              } catch (e) {}
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
  if (Object.keys(addsSensors).length) setGSensors(prev => ({ ...prev, ...addsSensors }));
  if (Object.keys(addsMeta).length) {
    if (DEBUG) { try { console.debug('Dashboard: snapshot.addsMeta', addsMeta); } catch (e) {} }
    setGMeta(prev => ({ ...prev, ...addsMeta }));
  }
  if (Object.keys(addsPower).length) {
    if (DEBUG) { try { console.debug('Dashboard: snapshot.addsPower (before apply)', addsPower); } catch (e) {} }
    setGPower(prev => ({ ...prev, ...addsPower }));
    if (DEBUG) {
      // schedule a microtask to log resulting gPower (best-effort; may log previous value if state hasn't updated yet)
      try { setTimeout(() => { try { console.debug('Dashboard: snapshot.applied gPower (post-apply)'); } catch (e) {} }, 250); } catch (e) {}
    }
  }
  if (seenDbBases.size || Object.keys(addsPower).length) {
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
          // Centralized helper will request Sensor/Target/State and probe device
          try { requestCurrentForBase(base); } catch (e) {}
          // Use explicit probeStateForDevice instead of empty-payload POWER publishes
          try {
            const parts = base.split('/').filter(Boolean);
            const deviceName = parts.length >= 2 ? parts[1] : parts[0];
            const site = parts.length >= 2 ? parts[0] : null;
            if (deviceName) {
              try { probeStateForDevice(site, deviceName); } catch(e) {}
              try { ws.send(JSON.stringify({ type: 'get', topic: `${site ? `${site}/` : ''}${deviceName}/State`, id: `snap-get-state2-${base}-${Date.now()}` })); } catch (e) {}
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
  // Removed static device probing for FERM2, FERM4, FERM5, MASH, HLT, BOIL.
  // All device discovery and probing is now dynamic and DB-driven.
  // No static device arrays or DUMMY* references remain.

  // Persist gauge-related state so reloads restore immediately before network traffic
  // Removed client-side localStorage persistence (DB is source-of-truth).

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
    if (Number.isNaN(val)) {
      debug && debug('publishTargetForDevice: invalid numeric value', n, deviceKey);
      return;
    }
    if (!wsRef.current || wsRef.current.readyState !== 1) {
      try { brewskiLog('publishTargetForDevice: ws not open, attempting reconnect and scheduling retry', { readyState: wsRef.current && wsRef.current.readyState }); } catch (e) {}
      try { connectWebSocket(); } catch (e) {}
      setTimeout(() => {
        try { publishTargetForDevice(deviceKey, n); } catch (e) {}
      }, 500);
      return;
    }
    const id = Date.now() + '-' + Math.random().toString(36).slice(2,8);

    // deviceKey is expected to be canonical SITE/DEVICE or DEVICE. Derive
    // site/device pieces and build a topic using the new targ/<MODE>/<DEVICE>Target format.
    let site = null; let deviceName = null;
    try {
      const parts = String(deviceKey || '').split('/').filter(Boolean);
      if (parts.length >= 2) { site = parts[0]; deviceName = parts[1]; }
      else if (parts.length === 1) { deviceName = parts[0]; }
    } catch (e) {}

    // If site missing, prefer runtime mode (uppercase) or customerSlug when present
    if (!site) {
      if (mode) site = mode;
      else if (customerSlug) site = String(customerSlug).toUpperCase();
    }

    if (!deviceName) return;

    // Build the new topic: targ/<MODE>/<DEVICE>Target
    let pubTopic = null;
    if (site) {
      pubTopic = `targ/${site}/${deviceName}Target`;
    } else {
      // New: build targ/<MODE>/<DEVICE>Target for non-BREW devices. If site is present
      // prefer targ/<site>/<device>Target; otherwise fall back to targ/<device>Target.
      try {
        if (site) pubTopic = `targ/${site}/${deviceName}Target`;
        else pubTopic = `targ/${deviceName}Target`;
      } catch (e) {
        // Fallback: preserve previous behavior if template building fails
      }
    }

    // Optimistic UI update: set local known target immediately so sliders don't wait for round-trip
    let canonicalForUpdate = null;
    try {
      canonicalForUpdate = normalizeCanonicalBase(deviceKey, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || (site ? `${site}/${deviceName}` : deviceName);
    } catch (e) { canonicalForUpdate = (site ? `${site}/${deviceName}` : deviceName); }

    try {
      try { brewskiLog('[publishTarget] send', { topic: pubTopic, payload: val, id, readyState: wsRef.current && wsRef.current.readyState }); } catch (e) {}
      wsRef.current.send(JSON.stringify({ type: 'publish', topic: pubTopic, payload: val, id }));
      brewskiLog('publish', pubTopic, val, id);
      if (canonicalForUpdate) setGTargets(prev => ({ ...(prev || {}), [canonicalForUpdate]: val }));
    } catch (e) {}

    setTimeout(() => {
      try {
        if (wsRef.current) {
          const getId = id + '-get';
          brewskiLog('publishTargetForDevice: scheduling GET for', pubTopic, getId);
          wsRef.current.send(JSON.stringify({ type: 'get', topic: pubTopic, id: getId }));
        }
      } catch (e) { brewskiLog('publishTargetForDevice: GET send failed', e && e.message); }
    }, 500);

    try { requestCurrentForBase(canonicalForUpdate); } catch (e) {}
  };
  // Build a cmnd topic, stripping the BREW site for devices we know historically published without a site.
  // Returns a string like `cmnd/<device>/<Cmd>` or `cmnd/<site>/<device>/<Cmd>`.
  const buildCmdTopic = (site, deviceName, cmdKey) => {
    try {
      const sRaw = site ? String(site) : null;
      const s = sRaw ? String(sRaw).toUpperCase() : null;
      const d = deviceName ? String(deviceName) : '';
      const cmd = cmdKey ? String(cmdKey) : '';

      // Defensive: ensure we have a device and a command
      if (!d || !cmd) return `cmnd/${d}/${cmd}`;

      // If this device is known to be legacy-nosite and the site is BREW (or missing), omit the site prefix
      try {
        if ((s === 'BREW' || !s) && legacyNoSiteDevicesRef.current && legacyNoSiteDevicesRef.current.has(String(d).toUpperCase())) {
          // device and cmd should be uppercased for broker compatibility
          return `cmnd/${String(d).toUpperCase()}/${String(cmd).toUpperCase()}`;
        }
      } catch (e) {
        // ignore and fall through
      }

      // If we have a non-empty site, include it
      if (s && s.length) {
        // Keep prefix as cmnd/<SITE>/<DEVICE>/<CMD> but ensure DEVICE and CMD are uppercase
        return `cmnd/${String(s)}/${String(d).toUpperCase()}/${String(cmd).toUpperCase()}`;
      }

      // Fallback: device-only topic
      return `cmnd/${String(d).toUpperCase()}/${String(cmd).toUpperCase()}`;
    } catch (e) {
      return `cmnd/${String(deviceName).toUpperCase()}/${String(cmdKey).toUpperCase()}`;
    }
  };

  const publishPower = (baseKey, powerKey, nextOn) => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;

    // baseKey is expected to be canonical (SITE/DEVICE). If it already
    // contains a site portion use it; otherwise attempt to derive site from
    // mode/customerSlug or fall back to device-name-only topic as legacy.
    let site = null;
    let deviceName = null;
    try {
      const parts = String(baseKey || '').split('/').filter(Boolean);
      if (parts.length >= 2) {
        site = parts[0];
        deviceName = parts[1];
      } else if (parts.length === 1) {
        deviceName = parts[0];
      }
    } catch (e) {}

    // If site missing, prefer runtime mode (which is uppercase customer slug)
    if (!site) {
      if (mode) site = mode;
      else if (customerSlug) site = String(customerSlug).toUpperCase();
    }

    if (!deviceName) {
      console.warn('publishPower: unable to determine device name from baseKey:', baseKey);
      return;
    }

    // Tasmota command topics: cmnd/<[site/]Device>/<Power or Power1/Power2/etc>
  const cmdKey = powerKey === 'POWER' ? 'Power' : powerKey.replace(/^POWER/, 'Power');
  // Build topic using helper that may strip BREW for legacy-nosite devices
  // Ensure device and command segments are uppercased when building the cmd topic
  const topic = buildCmdTopic(site, deviceName, cmdKey);
    const payload = nextOn ? 'ON' : 'OFF';
    const id = `pw-${site || 'UNK'}-${deviceName}-${cmdKey}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

      try {
        // normalize prefix (first segment) to lowercase for broker expectations
        const parts = String(topic).split('/');
        if (parts && parts.length) parts[0] = parts[0].toLowerCase();
        const outTopic = parts.join('/');
        brewskiLog('publishPower send', { topic: outTopic, payload, id, readyState: wsRef.current && wsRef.current.readyState });
        wsRef.current.send(JSON.stringify({ type: 'publish', topic: outTopic, payload, id }));
      } catch (e) {
        brewskiLog('publishPower send fallback', { topic, payload, id, err: e && e.message });
        wsRef.current.send(JSON.stringify({ type: 'publish', topic, payload, id }));
      }

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


      // Also proactively request current state for this base so the dashboard reconciles
      try { requestCurrentForBase(baseKey); } catch (e) {}
  };

  // Helper: request current Sensor/Target/State and probe device for a given canonical base
  const requestCurrentForBase = (base) => {
    try {
      if (!base) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== 1) return;
      // Normalize base into site/device parts
      const parts = String(base).split('/').filter(Boolean);
      const site = parts.length >= 2 ? parts[0] : null;
      const deviceName = parts.length >= 2 ? parts[1] : (parts[0] || null);
      if (!deviceName) return;

      // Ask the bridge for current Sensor and Target values
      try {
        const idS = `reqcur-sensor-${base}-${Date.now()}`;
        ws.send(JSON.stringify({ type: 'get', topic: `${base}/Sensor`, id: idS }));
        targetRequestCounts.current[base] = (targetRequestCounts.current[base] || 0) + 1;
      } catch (e) {}
      try {
        const idT = `reqcur-target-${base}-${Date.now()}`;
        ws.send(JSON.stringify({ type: 'get', topic: `${base}/Target`, id: idT }));
        targetRequestCounts.current[base] = (targetRequestCounts.current[base] || 0) + 1;
      } catch (e) {}

      // Also request State/Status so POWER JSON arrives
      try {
        const stateTopic = `${site ? `${site}/` : ''}${deviceName}/State`;
        const idSt = `reqcur-state-${base}-${Date.now()}`;
        ws.send(JSON.stringify({ type: 'get', topic: stateTopic, id: idSt }));
      } catch (e) {}

      // No legacy BREW raw/cmnd probes: only request normalized base topics.

    } catch (e) {}
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

  // RN-aware small spacer: used for early render paths (waiting for auth) so
  // mobile apps don't get a large top gap.
  const headerSpacerHeight = (Constants && Constants.statusBarHeight ? Constants.statusBarHeight : 0) + (IS_REACT_NATIVE ? 4 : 12);

  if (!token) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={[styles.headerSpacer, { height: headerSpacerHeight }]} />
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

  // (In-app debug overlay removed after diagnosis.)
  // (In-app debug overlay removed after diagnosis.)

  // compute a responsive watermark size and vertical placement
  // Use a single consolidated block to avoid duplicate declarations from iterative edits.
  // Target a larger watermark for visibility but cap it per viewport class to avoid overflow.
  const _base = Math.floor(Math.min(winWidth, winHeight) * 0.18);
  // Increase visual prominence: scale target up further from base
  const _target = Math.floor(_base * 3.2);
  const _capDesktop = 700;
  const _capTablet = 480;
  const _capMobile = 320;
  const _cap = winWidth >= 1200 ? _capDesktop : (winWidth >= 820 ? _capTablet : _capMobile);
  const _min = 80;
  // scale watermark up for stronger branding, but clamp to a safe maximum
  const _scaledTarget = _target * 3;
  const _maxWm = 1200;
  const _wmSize = Math.max(_min, Math.min(Math.min(_cap, _scaledTarget), _maxWm));
  // Use the RN-aware headerSpacerHeight defined earlier and add a larger offset
  // for watermark anchoring on desktop/tablet. Use a much smaller offset on RN
  // so the mobile app doesn't show an excessive top gap.
  const headerSpacerH = headerSpacerHeight + (IS_REACT_NATIVE ? 8 : 52);
  // Anchor the watermark a bit higher to appear visually centered
  // Compute a true centered top based on viewport and watermark size, then clamp
  const centeredTop = Math.floor((winHeight - _wmSize) / 2);
  const bottomLimit = Math.floor(winHeight - _wmSize - 40);
  const topPx = Math.max(headerSpacerH + (IS_REACT_NATIVE ? 4 : 12), Math.min(bottomLimit, centeredTop));
  // Increase opacity and scale; nudge so centered content doesn't fully cover it.
  // On RN use a much smaller nudge so the watermark appears a bit higher.
  const wmNudge = Math.floor(_wmSize * (IS_REACT_NATIVE ? 0.02 : 0.12));
  const wmStyle = { position: 'absolute', width: _wmSize, height: _wmSize, opacity: 0.30, top: Math.max(24, topPx + wmNudge), left: Math.floor((winWidth - _wmSize) / 2), zIndex: 0, pointerEvents: 'none' };
  // headerSpacerHeight was declared earlier for the auth/waiting path; reuse it here

  return (
    <>
      {/* Watermark image absolutely positioned and responsive (single source) */}
      <Image source={require('../assets/logo.png')} style={wmStyle} pointerEvents="none" resizeMode="contain" />
    <SafeAreaView style={styles.container}>
  {/* In-app debug panel for RN / DEBUG mode (removed) */}
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
  <View style={[styles.headerSpacer, { height: headerSpacerHeight }]} />
      {/* Placeholder future: group filter UI (to filter deviceList by second topic segment/group) */}
  {/* Add a generous bottom padding on RN so the bottom nav does not overlap content. */}
  <ScrollView style={styles.scroll} contentContainerStyle={[styles.contentContainer, IS_REACT_NATIVE ? { paddingBottom: 140 } : {}]}>
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
                // compute a modest min height so cards align but don't become oversized
                // smaller than previous attempt to avoid excessive whitespace
                const cardMin = Math.round(gaugeSize + 80);
                

                
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
                    else if (parts.length === 2) { /* only the device segment */ deviceNameCandidates.add(parts[1].toUpperCase()); }
                    else if (parts.length >= 3) { deviceNameCandidates.add(parts[1].toUpperCase()); }
                  } catch (e) {}

                  // Prefer exact canonical equality: only match stored gPower entries
                  // whose canonical SITE/DEVICE equals the gauge's canonical base. This
                  // prevents entries like RAIL/BREWHOUSE from matching BREWHOUSE/<dev>.
                  const requestedCanon = d.key;
                  for (const [powerBaseKey, states] of Object.entries(gPower)) {
                    try {
                      const storedCanon = canonicalForTopic(powerBaseKey) || normalizeCanonicalBase(powerBaseKey, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
                      if (!storedCanon) continue;
                      if (String(storedCanon).toUpperCase() === String(requestedCanon).toUpperCase()) {
                        // Only expose if this base was observed live or if we have
                        // a non-empty label for at least one power key for this base.
                        try {
                          const meta = gPowerMeta && gPowerMeta[powerBaseKey];
                          if (meta && meta.live) return [powerBaseKey, states];
                          // check for any non-empty label for the base
                          const anyLabeled = Object.keys(states || {}).some(pk => {
                            try { return !!getPowerLabel(powerBaseKey, pk); } catch (e) { return false; }
                          });
                          if (anyLabeled) return [powerBaseKey, states];
                        } catch (e) {}
                      }
                    } catch (e) {}
                  }
                  return null;
                })();
                
                return (
                  <View key={`gwrap-${d.key}`} style={{ width: columnWidth, padding: gap/2, alignItems:'center' }}>
                    <View style={styles.gaugeCardWrapper}>
                      <View style={[styles.gaugeCard, { minHeight: cardMin }]}>
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
                            {(() => {
                              const entries = Object.entries(powerSwitches[1] || {});
                              // If any numbered POWERn (POWER1/POWER2/..) exists, prefer those and
                              // omit the generic POWER entry to avoid duplicate buttons for the
                              // same physical device which can happen due to legacy topic variants.
                              const hasNumbered = entries.some(([k]) => /^POWER\d+$/i.test(k));
                              const filteredEntries = entries.filter(([k]) => !(k === 'POWER' && hasNumbered));
                              return filteredEntries
                                .sort(([a], [b]) => {
                                  // Sort POWER before POWER1, POWER2, etc. (if POWER still present)
                                  if (a === 'POWER' && b !== 'POWER') return -1;
                                  if (b === 'POWER' && a !== 'POWER') return 1;
                                  return a.localeCompare(b);
                                })
                                .map(([powerKey, isOn], idx, arr) => {
                                // Resolve label via helper that tries canonical + tele/ variants and device-name fallbacks
                                const baseKey = powerSwitches[0]; // e.g., "RAIL/FERM2" or "BREW/FERM2"
                                let label = getPowerLabel(baseKey, powerKey);
                                if (!label) label = powerKey === 'POWER' ? 'PWR' : powerKey.replace('POWER', 'PWR');

                                // Support special label suffixes like "HEATING-heatingindicator"
                                // where the suffix after '-' names a registered indicator renderer.
                                // Also support a special suffix `-hide` which causes the button to be omitted.
                                let indicatorRenderer = null;
                                let displayLabel = label;
                                let hideButton = false;
                                try {
                                  // Split on common dash characters (hyphen-minus, en-dash, em-dash)
                                  // Preserve empty left-side segments so labels like "-heatingindicator"
                                  // are treated as indicator-only (no display text) rather than ignored.
                                  if (label && typeof label === 'string') {
                                    const rawParts = String(label).split(/[-–—]/).map(s => (s || '').trim());
                                    const startsWithDash = /^\s*[-–—]/.test(String(label));
                                    // Treat as indicator when we have at least two parts OR the label
                                    // started with a dash (e.g. "-heatingindicator").
                                    if (rawParts.length >= 2 || (rawParts.length === 1 && startsWithDash)) {
                                      // right-most is indicator key; left side(s) form displayLabel (may be empty)
                                      const indicatorKey = String(rawParts[rawParts.length - 1] || '').toLowerCase();
                                      if (indicatorKey === 'hide') {
                                        // Hide this button entirely (useful for placeholder/administrative labels)
                                        hideButton = true;
                                        displayLabel = '';
                                      } else if (indicatorKey && INDICATOR_RENDERERS[indicatorKey]) {
                                        indicatorRenderer = INDICATOR_RENDERERS[indicatorKey];
                                        displayLabel = rawParts.slice(0, rawParts.length - 1).join(' - ');
                                        // ensure empty displayLabel is represented as an empty string (not undefined)
                                        if (!displayLabel) displayLabel = '';
                                      }
                                    }
                                  }
                                } catch (e) {}

                                // Debug logging
                                if (DEBUG) {
                                  console.log('Dashboard Power Label Debug:', { baseKey, powerKey, foundLabel: label, sampleLabels: Object.keys(powerLabels || {}).slice(0,10) });
                                }

                                // Get device name for context when multiple switches
                                const deviceName = powerSwitches[0].split('/')[1] || '';
                                const showDeviceContext = arr.length > 1;

                                // If label instructed to hide the button, skip rendering entirely
                                if (hideButton) return null;

                                return (
                                  <Pressable
                                    key={powerKey}
                                    onPress={() => { if (!indicatorRenderer) publishPower(powerSwitches[0], powerKey, !isOn); }}
                                    disabled={!!indicatorRenderer}
                                    accessibilityRole={indicatorRenderer ? 'text' : 'button'}
                                    style={{ 
                                      paddingVertical: 6, 
                                      paddingHorizontal: 10, 
                                      borderRadius: 8, 
                                      backgroundColor: indicatorRenderer ? '#f3f4f6' : (isOn ? '#4caf50' : '#f8f9fa'),
                                      borderWidth: 1,
                                      borderColor: indicatorRenderer ? '#e9ecef' : (isOn ? '#4caf50' : '#dee2e6'),
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
                                    {indicatorRenderer ? (
                                      <View style={{ alignItems: 'center' }}>
                                        {/* show the textual label above the indicator when a prefix label exists */}
                                        {displayLabel ? (
                                          <Text style={{ color: isOn ? '#fff' : '#495057', fontSize: arr.length === 1 ? 11 : 10, fontWeight: '700', textAlign: 'center' }}>{displayLabel}</Text>
                                        ) : null}
                                        {indicatorRenderer({ isOn })}
                                        <Text style={{ color: isOn ? '#e8f5e8' : '#6c757d', fontSize: 8, fontWeight: '600', textAlign: 'center', marginTop: 1 }}>{isOn ? 'ON' : 'OFF'}</Text>
                                      </View>
                                    ) : (
                                      <>
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
                                      </>
                                    )}
                                  </Pressable>
                                );
                              })
                            })()}
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
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'flex-start', padding: 16, paddingTop: 24 },
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
  ,
  watermarkImage: { position: 'absolute', width: 220, height: 220, opacity: 0.12, top: '45%', left: '50%', transform: [{ translateX: -110 }, { translateY: -110 }], zIndex: 0, resizeMode: 'contain' }
  ,
  gaugeCardWrapper: { width: '100%', alignItems: 'center', justifyContent: 'center' },
  gaugeCard: {
    width: '100%',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.75)',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.04)',
    // subtle shadow
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 4,
  }
});

// Debug overlay component (visible when DEBUG=true)
function DebugOverlay({ mode, customerSlug, knownSlugs, gMeta, gSensors, gTargets, gPower, deviceList, filteredDevices, pendingSensorMessages, pendingPowerMessages, clearPending, dumpToConsole }) {
  const small = { fontSize: 11, color: '#222' };
  // Platform-aware container style: React Native does not support 'position: fixed',
  // string-based sizes like '60vh' or 'overflow: auto'. Use numeric fallbacks for
  // native and CSS-friendly values for web to avoid runtime style errors.
  const isWeb = (typeof window !== 'undefined' && typeof document !== 'undefined');
  const containerStyle = isWeb ? {
    position: 'fixed', right: 12, top: 72, width: 420, maxHeight: '60vh', backgroundColor: 'rgba(255,255,255,0.95)', borderWidth: 1, borderColor: '#ddd', padding: 8, borderRadius: 6, overflow: 'auto', zIndex: 9999
  } : {
    position: 'absolute', right: 12, top: 72, width: 340, maxHeight: 300, backgroundColor: 'rgba(255,255,255,0.95)', borderWidth: 1, borderColor: '#ddd', padding: 8, borderRadius: 6, overflow: 'hidden', zIndex: 9999
  };

  return (
    <View style={containerStyle}>
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
