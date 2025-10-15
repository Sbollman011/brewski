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
      // Prefer canonical API host first to avoid same-origin SPA HTML responses.
      const origins = [];
      try { if (typeof USE_PUBLIC_WS !== 'undefined' && USE_PUBLIC_WS && typeof PUBLIC_WS_HOST === 'string' && PUBLIC_WS_HOST) origins.push(`https://${PUBLIC_WS_HOST}`); } catch (e) {}
      // current origin (same origin requests) - fallback to hosted SPA origin
      try { if (typeof window !== 'undefined' && window.location && window.location.origin) origins.push(window.location.origin); } catch (e) {}
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
    try {
      // If Content-Type is not JSON, attempt a fallback to the absolute API host
      const contentType = res && res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : '';
      if (contentType && contentType.toLowerCase().indexOf('application/json') === -1) {
        // Read text body for diagnostics
        let bodyTxt = '';
        try { bodyTxt = await res.text(); } catch (e) { bodyTxt = '<unreadable body>'; }
        console.warn('Dashboard: fetchPowerLabels returned non-JSON response, trying direct API host', { url: res.url || null, status: res.status, contentType, bodySnippet: (bodyTxt && bodyTxt.slice ? bodyTxt.slice(0,200) : bodyTxt) });

        // Try direct requests to central API host as a recovery path
        try {
          const directPaths = ['/admin/api/power-labels', '/api/power-labels'];
          for (const p of directPaths) {
              try {
                // Use the centralized apiFetch helper so the request is routed to the
                // canonical API host (DEFAULT_API_HOST) and Authorization/Accept
                // headers are handled consistently. apiFetch already prefers the
                // api host for /api and /admin/api paths.
                const candidate = p; // e.g. '/admin/api/power-labels' or '/api/power-labels'
                let rr = null;
                try {
                  // Prefer window.apiFetch if available (it wraps apiFetch)
                  if (typeof window !== 'undefined' && window.apiFetch) {
                    rr = await window.apiFetch(candidate, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
                  } else {
                    rr = await apiFetch(candidate, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
                  }
                } catch (e) {
                  // If apiFetch itself throws, ignore and continue to next path
                  if (DEBUG) console.log('Dashboard: apiFetch candidate failed', candidate, e && e.message);
                  rr = null;
                }

                if (rr && rr.ok) {
                  const ct = rr.headers && typeof rr.headers.get === 'function' ? (rr.headers.get('content-type') || '') : '';
                  if (ct && ct.toLowerCase().indexOf('application/json') !== -1) {
                    const js = await rr.json().catch(() => null);
                    return js && js.labels ? js.labels : (Array.isArray(js) ? js : []);
                  }
                }
              } catch (e) { if (DEBUG) console.log('Dashboard: direct retry failed', e && e.message); }
            }
        } catch (e) { if (DEBUG) console.log('Dashboard: direct host fallback failed', e && e.message); }

        return [];
      }
      if (typeof res.json === 'function') {
        const js = await res.json().catch(async (err) => {
          // If JSON.parse failed, include the body for easier debugging
          let bodyTxt = '';
          try { bodyTxt = await res.text(); } catch (e) { bodyTxt = '<unreadable body>'; }
          console.warn('Dashboard: fetchPowerLabels failed to parse JSON', { url: res.url || null, status: res.status, bodySnippet: (bodyTxt && bodyTxt.slice ? bodyTxt.slice(0,200) : bodyTxt) });
          return null;
        });
        return js && js.labels ? js.labels : (Array.isArray(js) ? js : []);
      }
      // If it's already parsed (rare path)
      return res.labels || [];
    } catch (e) {
      console.error('Dashboard: fetchPowerLabels unexpected error while parsing response', e && e.message ? e.message : e);
      return [];
    }
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
      const site = partsRaw[0]; const device = partsRaw[1]; const metric = partsRaw.length >= 3 ? partsRaw[2] : null;
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
      if (maybeSite && maybeSite.toUpperCase() !== 'BREW') return `${maybeSite}/${device}`;
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
      if (mode && mode.toUpperCase() !== 'BREW') return `${mode}/${device}`;
      if (customerSlug) return `${customerSlug}/${device}`;
      return `BREW/${device}`;
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
  // Grouped by canonical base: { 'SITE/DEVICE': { POWER: 'Label', POWER1: 'Label2' } }
  const [powerLabelsByCanonical, setPowerLabelsByCanonical] = useState({});
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

              // Also add normalized SITE/DEVICE variants (e.g., RAIL/DEV or BREW/DEV)
              try {
                // Normalize the topic into a canonical base (SITE/DEVICE) if possible
                const maybeParts = String(l.topic).split('/').filter(Boolean);
                let candidateBase = null;
                if (maybeParts.length >= 2) {
                  // If topic is tele/<site>/<device>/STATE or similar
                  if (/^tele$/i.test(maybeParts[0])) {
                    candidateBase = `${maybeParts[1]}/${maybeParts[2] || maybeParts[1]}`;
                  } else {
                    candidateBase = `${maybeParts[0]}/${maybeParts[1]}`;
                  }
                } else if (maybeParts.length === 1) {
                  candidateBase = `BREW/${maybeParts[0]}`;
                }
                if (candidateBase) {
                  const norm = normalizeCanonicalBase(candidateBase, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
                  if (norm) {
                    const kA = `${norm}|${l.power_key}`;
                    const kB = `${norm}|${l.power_key.toUpperCase()}`;
                    if (!labelMap[kA]) labelMap[kA] = l.label || '';
                    if (!labelMap[kB]) labelMap[kB] = l.label || '';
                    // also add tele variants for normalized base
                    try {
                      const parts = norm.split('/').filter(Boolean);
                      if (parts.length >= 2) {
                        const tele1 = `tele/${parts[0]}/${parts[1]}/STATE`;
                        const tele2 = `tele/${parts[1]}/STATE`;
                        const t1 = `${tele1}|${l.power_key}`;
                        const t2 = `${tele2}|${l.power_key}`;
                        if (!labelMap[t1]) labelMap[t1] = l.label || '';
                        if (!labelMap[t2]) labelMap[t2] = l.label || '';
                        if (!labelMap[t1.toUpperCase()]) labelMap[t1.toUpperCase()] = l.label || '';
                        if (!labelMap[t2.toUpperCase()]) labelMap[t2.toUpperCase()] = l.label || '';
                      }
                    } catch (e) {}
                  }
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
        console.log('Dashboard: Power labels fetch result:', {
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
              canonicalMap[can][upk] = l.label || '';
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

        setPowerLabels(labelMap);
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

            // Initialize gPower entries (presence of keys enables power buttons)
            setGPower(prev => {
              const next = { ...(prev || {}) };
              Object.keys(labelMap || {}).forEach(k => {
                try {
                  const [topicPart, pk] = k.split('|');
                  if (!topicPart || !pk) return;
                  const parts = String(topicPart).split('/').filter(Boolean);
                  let cand = null;
                  if (parts.length >= 3 && parts[0].toLowerCase() === 'tele') cand = `${parts[1]}/${parts[2]}`;
                  else if (parts.length >= 2) cand = `${parts[0]}/${parts[1]}`;
                  else if (parts.length === 1) cand = `BREW/${parts[0]}`;
                  if (!cand) return;
                  const norm = normalizeCanonicalBase(cand, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || cand;
                  if (!next[norm]) next[norm] = {};
                  const upk = String(pk).toUpperCase();
                  if (next[norm][upk] === undefined) next[norm][upk] = false; // unknown/off by default
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
  // store numeric customer id if provided by /api/latest so we can POST admin updates
  const [customerId, setCustomerId] = useState(null);
  // Debug info for /admin/api/me hydration attempts (visible when DEBUG=true)
  const [meDebug, setMeDebug] = useState(null);
  // responsive layout measurements
  const { width: winWidth } = useWindowDimensions();
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
      // Prefer window.apiFetch when available
      if (typeof window !== 'undefined' && window.apiFetch) {
        try { res = await window.apiFetch(pathPublic); } catch (e) { /* try admin */ }
      }
      // Prefer the component helper which will route admin/public paths to the
      // canonical API host (avoids hitting the web SPA host and getting HTML).
      if (!res) {
        try {
          const urlPath = token ? `${pathAdmin}?token=${encodeURIComponent(token)}` : pathPublic;
          res = await doApiFetch(urlPath, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        } catch (e) {
          // fall back to direct absolute URL if doApiFetch is unavailable for some reason
          const urlPath = token ? `${pathAdmin}?token=${encodeURIComponent(token)}` : pathPublic;
          const API_HOST = 'api.brewingremote.com';
          const useApiHost = String(urlPath || '').startsWith('/admin/api') || String(urlPath || '').startsWith('/api/');
          const base = `https://${useApiHost ? API_HOST : resolveHost()}`;
          const url = `${base}${urlPath}`;
          res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        }
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
            else {
              try { const txt = await (r2 && r2.text ? r2.text() : Promise.resolve(null)); record.attempts.push({ method: 'doApiFetch?token', bodyText: txt }); } catch (e) {}
            }
          } catch (e) { record.attempts.push({ method: 'doApiFetch?token', ok: false, error: String(e) }); }
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
            const custUrl = `${base}/admin/api/customers/${encodeURIComponent(custId)}`;
            let cres = null;
            try { cres = await fetch(custUrl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }); record.attempts.push({ method: 'custFetch', url: custUrl, ok: cres && cres.ok, status: cres && cres.status }); } catch (e) { record.attempts.push({ method: 'custFetch', url: custUrl, ok: false, error: String(e) }); }
            if ((!cres || !cres.ok)) {
              try {
                const custQ = `${base}/admin/api/customers/${encodeURIComponent(custId)}?token=${encodeURIComponent(token)}`;
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
    const persistDiscoveredPowerKeys = async (baseKey, powerStates) => {
      try {
        if (!token) return false; // need admin/auth token to persist
        if (!baseKey || !powerStates || typeof powerStates !== 'object') return false;
        // Require numeric customerId for reliable per-customer persistence; fall back to slug
        if (!customerId && !customerSlug) return false;

        const keys = Object.keys(powerStates).map(k => String(k).toUpperCase());
        if (!keys.length) return false;

        let savedAny = false;
      for (const pk of keys) {
          try {
            // Only persist when we don't already have a server-known label locally
            const parts = String(baseKey).split('/').filter(Boolean);
            const site = parts[0];
            const device = parts[1] || parts[0];
            // candidate topics that AdminPortal commonly looks for
            const stateTopicGuess = `tele/${site}/${device}/STATE`;
            const baseStateVariant = `${baseKey}/STATE`;
            const teleDeviceState = `tele/${device}/STATE`;

            // If any of those variants already exists in local label map, skip
            const checkKeys = [ `${stateTopicGuess}|${pk}`, `${baseStateVariant}|${pk}`, `${teleDeviceState}|${pk}`, `${baseKey}|${pk}` ];
            let alreadyKnown = false;
            if (powerLabels) {
              for (const ck of checkKeys) {
                if (powerLabels[ck] || powerLabels[ck.toUpperCase()]) { alreadyKnown = true; break; }
              }
            }
            if (alreadyKnown) continue;

            // Build a single canonical payload to avoid creating duplicate DB rows
            const canonicalBase = normalizeCanonicalBase(baseKey, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || baseKey;
            const canonicalTopic = `${canonicalBase}/STATE`;
            const payload = customerId ? { topic: canonicalTopic, power_key: pk, label: '', customer_id: customerId } : { topic: canonicalTopic, power_key: pk, label: '', customer_slug: customerSlug };

            const tryPost = async (path, body) => {
              try {
                // Use the component-level doApiFetch helper which prefers window.apiFetch
                // and otherwise builds an absolute URL to the canonical API host.
                const res = await doApiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                if (res && (res.ok || (res.status && res.status >= 200 && res.status < 300))) {
                  if (DEBUG) console.log('Dashboard: POST success via doApiFetch', { path, status: res.status });
                  return true;
                }

                // read body for diagnostics
                let txt = '';
                try { txt = await (res && res.text ? res.text() : Promise.resolve('')); } catch (e) { txt = ''; }
                if (DEBUG) console.warn('Dashboard: POST failed via doApiFetch', { path, status: res && res.status, body: txt });

                // If server indicates bad_id for numeric-customer create attempts, try slug-based fallback
                try {
                  const lower = (txt || '').toLowerCase();
                  if (res && res.status === 400 && lower.includes('bad_id') && body && body.customer_id && customerSlug) {
                    const fallbackBody = Object.assign({}, body);
                    delete fallbackBody.customer_id;
                    fallbackBody.customer_slug = customerSlug;
                    if (DEBUG) console.log('Dashboard: trying slug-fallback POST for power-label via doApiFetch', { path, fallbackBody });
                    const res2 = await doApiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fallbackBody) });
                    if (res2 && (res2.ok || (res2.status && res2.status >= 200 && res2.status < 300))) {
                      if (DEBUG) console.log('Dashboard: slug-fallback POST success via doApiFetch', { path, status: res2.status });
                      return true;
                    }
                    try { const t2 = await (res2 && res2.text ? res2.text() : Promise.resolve('')); if (DEBUG) console.warn('Dashboard: slug-fallback failed', { status: res2 && res2.status, body: t2 }); } catch (e) {}
                  }
                } catch (e) { if (DEBUG) console.warn('Dashboard: slug-fallback exception', e && e.message); }
              } catch (e) { if (DEBUG) console.warn('Dashboard: POST exception via doApiFetch', e && e.message); }
              return false;
            };
            // Attempt a single POST to admin endpoint, then fallback to public endpoint
            try {
              if (DEBUG) console.log('Dashboard: persistDiscoveredPowerKeys try payload', payload);
              const ok1 = await tryPost(`/admin/api/power-labels`, payload);
              const ok2 = (!ok1) ? await tryPost(`/api/power-labels`, payload) : ok1;
              if (ok1 || ok2) savedAny = true;
            } catch (e) { if (DEBUG) console.warn('persistDiscoveredPowerKeys single-post exception', e && e.message); }
          } catch (e) {}
        }
        if (savedAny) {
              // Refresh labels map so UI shows editable slots quickly
              try {
                const labelsArr = await fetchPowerLabels(token);
                // convert to map like initial load does
                const labelMap = {};
                if (Array.isArray(labelsArr)) {
                  labelsArr.forEach(l => {
                    try {
                      if (l && l.topic && l.power_key) {
                        const key = `${l.topic}|${l.power_key}`;
                        labelMap[key] = l.label || '';
                        labelMap[key.toUpperCase()] = l.label || '';
                        const candidates = canonicalCandidatesForTopic(l.topic);
                        candidates.forEach(t => {
                          const k1 = `${t}|${l.power_key}`;
                          const k2 = `${t}|${l.power_key.toUpperCase()}`;
                          if (!labelMap[k1]) labelMap[k1] = l.label || '';
                          if (!labelMap[k2]) labelMap[k2] = l.label || '';
                        });
                      }
                    } catch (e) {}
                  });
                }
                setPowerLabels(l => ({ ...l, ...labelMap }));
                // Inform other parts of the SPA (AdminPortal) that power-labels changed
                try {
                  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
                    const ev = new CustomEvent('brewski:power-labels-synced', { detail: { timestamp: Date.now() } });
                    window.dispatchEvent(ev);
                  }
                } catch (e) {}
              } catch (e) {}
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
  // Compute a stable canonical base for a raw topic string. Prefer DB snapshot
  // entries and explicit mode/customerSlug when available so variants collapse
  // to a single representative.
  const canonicalForTopic = (topic) => {
    try {
      if (!topic || typeof topic !== 'string') return null;
      // If topic already looks canonical like SITE/DEVICE... return it
      if (/^[A-Z0-9_-]+\/[A-Z0-9_-]+/i.test(topic)) {
        // prefer DB-backed base when available
        const norm = normalizeCanonicalBase(topic, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode });
        return norm || topic;
      }
      // Fallback: normalize anyway
      return normalizeCanonicalBase(topic, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }) || topic;
    } catch (e) { return topic; }
  };

  const getPowerLabel = (baseKey, powerKey) => {
    if (!baseKey || !powerKey) return '';
    try {
      const pk = String(powerKey).toUpperCase();
      // Prefer canonical grouped labels (collapses tele/... and BREW/... variants)
      try {
        const can = canonicalForTopic(baseKey) || baseKey;
        if (powerLabelsByCanonical && powerLabelsByCanonical[can] && powerLabelsByCanonical[can][pk]) return powerLabelsByCanonical[can][pk];
      } catch (e) {}

      // First try exact direct matches
      const direct = `${baseKey}|${pk}`;
      if (powerLabels[direct]) return powerLabels[direct];
      if (powerLabels[direct.toUpperCase()]) return powerLabels[direct.toUpperCase()];

      // Prefer looking up by canonical grouping: convert known raw topics into
      // canonical bases and look for any label stored under that canonical base
      // (this groups tele/... and BREW/... variants together)
      const can = canonicalForTopic(baseKey) || baseKey;
      const canonicalKey = `${can}|${pk}`;
      if (powerLabels[canonicalKey]) return powerLabels[canonicalKey];
      if (powerLabels[canonicalKey.toUpperCase()]) return powerLabels[canonicalKey.toUpperCase()];

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
        // also try canonical-for-candidate
        const candCan = canonicalForTopic(c);
        if (candCan) {
          const kk = `${candCan}|${pk}`;
          if (powerLabels[kk]) return powerLabels[kk];
          if (powerLabels[kk.toUpperCase()]) return powerLabels[kk.toUpperCase()];
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
            try {
              // Prefer explicit runtime mode/customer slug when available
              const site = (mode || (customerSlug ? String(customerSlug).toUpperCase() : null));
              const primaryTopic = site ? `cmnd/${site}/${deviceName}/Power` : `cmnd/${deviceName}/Power`;
              safeSend(ws, { type: 'publish', topic: primaryTopic, payload: '', id: `init-pwq-${site || 'UNK'}-${deviceName}-${Date.now()}` });
            } catch (e) {}

            // Query additional power states for multi-switch devices
            const multiSwitchDevices = ['MASH', 'HLT', 'BOIL'];
            if (multiSwitchDevices.includes(deviceName)) {
              for (let i = 1; i <= 3; i++) {
                try {
                  const site = (mode || (customerSlug ? String(customerSlug).toUpperCase() : null));
                  const t = site ? `cmnd/${site}/${deviceName}/Power${i}` : `cmnd/${deviceName}/Power${i}`;
                  safeSend(ws, { type: 'publish', topic: t, payload: '', id: `init-pwq-${site || 'UNK'}-${deviceName}-p${i}-${Date.now()}` });
                } catch (e) {}
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
            let canonical = canonicalBaseFromMeta(meta) || (meta.metric ? `${meta.device}/${meta.metric}` : `${meta.device}`);
            if (!canonical) return;
            try { canonical = normalizeCanonicalBase(canonical, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }); } catch (e) {}
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

              // Use explicit customer/site prefix when available, otherwise fall back to device-only topic
              const primaryTopic = customerSlug ? `cmnd/${customerSlug}/${deviceName}/Power` : `cmnd/${deviceName}/Power`;
              try {
                wsRef.current.send(JSON.stringify({ type: 'publish', topic: primaryTopic, payload: '', id: `pwq-${deviceName}-${Date.now()}` }));
              } catch (e) {}

              // Query additional power states (POWER1, POWER2, POWER3) for multi-switch devices
              const commonMultiSwitchDevices = ['MASH', 'HLT', 'BOIL'];
              if (commonMultiSwitchDevices.some(d => deviceName.toUpperCase().includes(d))) {
                for (let i = 1; i <= 3; i++) {
                  try {
                    const t = customerSlug ? `cmnd/${customerSlug}/${deviceName}/Power${i}` : `cmnd/${deviceName}/Power${i}`;
                    wsRef.current.send(JSON.stringify({ type: 'publish', topic: t, payload: '', id: `pwq-${deviceName}-p${i}-${Date.now()}` }));
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
            let canonical = canonicalBaseFromMeta(meta) || (meta.metric ? `${meta.device}/${meta.metric}` : `${meta.device}`);
            if (!canonical) return;
            try { canonical = normalizeCanonicalBase(canonical, { knownSlugs, gMeta, dbSensorBases, customerSlug, mode }); } catch (e) {}
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
                const siteForLegacy = inferred || mode || 'BREW';
                baseKey = `${siteForLegacy}/${deviceName}`;
              }
            }
            // Response Pattern: stat/<device>/(STATE|RESULT) - device control responses
            else if (parts[0].toLowerCase() === 'stat' && parts.length === 3) {
              deviceName = parts[1];
              if (deviceName) {
                const inferred = findSiteForDevice(deviceName);
                const siteForStat = inferred || mode || 'BREW';
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
  // Also persist the JWT to localStorage.brewski_jwt so shared helpers (window.apiFetch)
  // and other modules that read from localStorage will include Authorization headers.
  // This is a minimal, safe write: only runs when a token is present and avoids
  // repeatedly writing the same value.
  useEffect(() => {
    if (!token) return;
    debug('[TOKEN ready] len=', token.length, 'head=', token.slice(0,10));
    try {
      if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.setItem === 'function') {
        const cur = window.localStorage.getItem('brewski_jwt');
        if (cur !== token) {
          window.localStorage.setItem('brewski_jwt', token);
          if (DEBUG) console.log('Dashboard: persisted token to localStorage.brewski_jwt');
        }
      }
    } catch (e) {
      if (DEBUG) console.warn('Dashboard: failed to persist token to localStorage', e && e.message);
    }
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
    (async () => {
      try {
  const path = '/thresholds';
  let res;
  try { res = await doApiFetch(path); } catch (e) { res = null; }
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
          const siteForStat = site || findSiteForDevice(device) || mode || (customerSlug ? String(customerSlug).toUpperCase() : null) || 'BREW';
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

          // Default missing site to BREW so snapshot canonicalization matches runtime
          if (!site) site = 'BREW';

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
                const baseCandidate = (site && device) ? `${site}/${device}` : (core && core.length ? (core.length >= 2 ? `${core[0]}/${core[1]}` : `BREW/${core[0]}`) : rawTopic);
                persistFound(baseCandidate, found, row.last_ts);
                return;
              }

              // Compact shape: { power_key: 'POWER1', state: 'ON' }
                  if (parsedLastRaw.power_key) {
                const pk = String(parsedLastRaw.power_key).toUpperCase();
                if (/^POWER\d*$/i.test(pk)) {
                  const st = parsedLastRaw.state;
                  const isOn = (typeof st === 'string') ? (st.toUpperCase() === 'ON' || st === '1' || st.toUpperCase() === 'TRUE') : !!st;
                  const baseCandidate = (site && device) ? `${site}/${device}` : (parts && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : (device ? `BREW/${device}` : rawTopic));
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
                  const baseCandidate = (site && device) ? `${site}/${device}` : (core && core.length ? (core.length >= 2 ? `${core[0]}/${core[1]}` : `BREW/${core[0]}`) : rawTopic);
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
              const baseCandidate = (site && device) ? `${site}/${device}` : (parts && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : (device ? `BREW/${device}` : rawTopic));
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

              // Also proactively request the device's STATE so we get fresh POWER/STATE JSON
              try {
                const parts = base.split('/').filter(Boolean);
                const deviceName = parts.length >= 2 ? parts[1] : parts[0];
                const site = parts.length >= 2 ? parts[0] : null;
                // Ask the bridge for the State topic and also send a non-mutating Status 0 probe
                try { ws.send(JSON.stringify({ type: 'get', topic: `${site ? `${site}/` : ''}${deviceName}/State`, id: `snap-get-state-${base}-${Date.now()}` })); } catch (e) {}
                try { ws.send(JSON.stringify({ type: 'publish', topic: site ? `cmnd/${site}/${deviceName}/Status` : `cmnd/${deviceName}/Status`, payload: '0', id: `snap-probe-status-${base}-${Date.now()}` })); } catch (e) {}
                // also call the local helper which sends a couple retries
                try { probeStateForDevice(site, deviceName); } catch (e) {}
              } catch (e) {}

          // Query power states using canonical base when possible
          try {
            const parts = base.split('/').filter(Boolean);
            const deviceName = parts.length >= 2 ? parts[1] : parts[0];
            const site = parts.length >= 2 ? parts[0] : null;
            if (deviceName) {
              // Primary power query: prefer site-prefixed topic
              const primaryTopic = site ? `cmnd/${site}/${deviceName}/Power` : `cmnd/${deviceName}/Power`;
              try { ws.send(JSON.stringify({ type: 'publish', topic: primaryTopic, payload: '', id: `snap-pwq-${site || 'UNK'}-${deviceName}-${Date.now()}` })); } catch(e) {}
                  // ask for state as well (ensure recent STATE is present)
                  try { ws.send(JSON.stringify({ type: 'get', topic: `${site ? `${site}/` : ''}${deviceName}/State`, id: `snap-get-state2-${base}-${Date.now()}` })); } catch (e) {}
              // Additional multi-switch queries (best-effort)
              for (let i = 1; i <= 3; i++) {
                const t = site ? `cmnd/${site}/${deviceName}/Power${i}` : `cmnd/${deviceName}/Power${i}`;
                try { ws.send(JSON.stringify({ type: 'publish', topic: t, payload: '', id: `snap-pwq-${site || 'UNK'}-${deviceName}-p${i}-${Date.now()}` })); } catch(e) {}
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
        try {
          const site = mode || (customerSlug ? String(customerSlug).toUpperCase() : null);
          const primaryTopic = site ? `cmnd/${site}/${deviceName}/Power` : `cmnd/${deviceName}/Power`;
          wsRef.current.send(JSON.stringify({ type: 'publish', topic: primaryTopic, payload: '', id: `customer-pwq-${site || 'UNK'}-${deviceName}-${Date.now()}` }));
        } catch (e) {}

        // Query additional power states for multi-switch devices
        const multiSwitchDevices = ['MASH', 'HLT', 'BOIL'];
        if (multiSwitchDevices.includes(deviceName)) {
          for (let i = 1; i <= 3; i++) {
            try {
              const site = mode || (customerSlug ? String(customerSlug).toUpperCase() : null);
              const t = site ? `cmnd/${site}/${deviceName}/Power${i}` : `cmnd/${deviceName}/Power${i}`;
              wsRef.current.send(JSON.stringify({ type: 'publish', topic: t, payload: '', id: `customer-pwq-${site || 'UNK'}-${deviceName}-p${i}-${Date.now()}` }));
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
    if (Number.isNaN(val)) return;
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    const id = Date.now() + '-' + Math.random().toString(36).slice(2,8);
    const topic = `${deviceKey}/Target`;
    try { wsRef.current.send(JSON.stringify({ type: 'publish', topic, payload: val, id })); debug('publish', topic, val, id); } catch (e) {}
    setTimeout(() => { try { wsRef.current && wsRef.current.send(JSON.stringify({ type: 'get', topic, id: id + '-get' })); } catch (e) {} }, 500);
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
    const topic = site ? `cmnd/${site}/${deviceName}/${cmdKey}` : `cmnd/${deviceName}/${cmdKey}`;
    const payload = nextOn ? 'ON' : 'OFF';
    const id = `pw-${site || 'UNK'}-${deviceName}-${cmdKey}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;

    try {
      wsRef.current.send(JSON.stringify({ type: 'publish', topic, payload, id }));

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

      // Ask device to publish its STATE so other clients / snapshot see authoritative state quickly
      try { probeStateForDevice(site, deviceName); } catch (e) {}

    } catch (e) {}
  };

  // Helper: after issuing a Power command, ask the device to publish its STATE
  // non-mutatingly so other clients and the server snapshot become consistent.
  const probeStateForDevice = (site, deviceName) => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    try {
      const statusTopic = site ? `cmnd/${site}/${deviceName}/Status` : `cmnd/${deviceName}/Status`;
      const idBase = `status-probe-${site || 'UNK'}-${deviceName}-${Date.now()}`;
      // Status 0 asks Tasmota to publish a full state (non-mutating)
      try { wsRef.current.send(JSON.stringify({ type: 'publish', topic: statusTopic, payload: '0', id: idBase + '-0' })); } catch (e) {}
      // Also ask the bridge for the current STATE (best-effort). Some bridges
      // respond to get requests for <SITE>/<DEVICE>/State and will emit a
      // current/message that applyPower will handle.
      try { wsRef.current.send(JSON.stringify({ type: 'get', topic: `${site}/${deviceName}/State`, id: idBase + '-get' })); } catch (e) {}

      // Two retries to help with flaky networks / device latency
      setTimeout(() => { try { wsRef.current.send(JSON.stringify({ type: 'publish', topic: statusTopic, payload: '0', id: idBase + '-r1' })); } catch (e) {} }, 250);
      setTimeout(() => { try { wsRef.current.send(JSON.stringify({ type: 'publish', topic: statusTopic, payload: '0', id: idBase + '-r2' })); } catch (e) {} }, 1000);
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

  // (In-app debug overlay removed after diagnosis.)

  return (
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
