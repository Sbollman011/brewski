import React, { useEffect, useState, useRef, useMemo } from 'react';
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

function deriveThreshold(key){
  const up = key.toUpperCase();
  if (up.includes('FERM')) return DEFAULT_THRESHOLDS.FERM;
  if (up.includes('MASH')) return DEFAULT_THRESHOLDS.MASH;
  if (up.includes('HLT')) return DEFAULT_THRESHOLDS.HLT;
  if (up.includes('BOIL')) return DEFAULT_THRESHOLDS.BOIL;
  return { min: 0, max: 220 };
}

export default function Dashboard({ token }) {
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
  const anim = useRef(new Animated.Value(0)).current;
  const needleAnim = useRef(new Animated.Value(0)).current;
  const spinAnim = useRef(new Animated.Value(0)).current;
  const [needlePct, setNeedlePct] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const alertMapRef = useRef(new Map()); // key -> last alert timestamp
  const ALERT_DEBOUNCE_MS = 30_000; // avoid spamming same device alert more than every 30s
  // dynamic threshold overrides per base (min/max) loaded from server
  const [thresholds, setThresholds] = useState({}); // { base: { min, max } }

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

  // derive the device list from known sensor/target keys + defaults
  const deviceList = useMemo(() => {
    const seen = new Map();
    defaultDevices.forEach(d => seen.set(d.key, d.label));
    const addKey = (k) => {
      if (!k) return;
      if (seen.has(k)) return;
      // generate a friendly label from the topic base
      const label = k.replace(/^DUMMY/i, '').replace(/([A-Z0-9]+)/g, ' $1').trim() || k;
      seen.set(k, label);
    };
    Object.keys(gSensors || {}).forEach(addKey);
    Object.keys(gTargets || {}).forEach(addKey);
    return Array.from(seen.entries()).map(([key, label]) => ({ key, label }));
  }, [gSensors, gTargets]);

  const [connectionError, setConnectionError] = useState(false);
  // diagnostics for missing Target currents
  const targetRequestCounts = useRef({}); // base -> count of get requests sent
  const targetReceiveCounts = useRef({}); // base -> count of current/ message target receipts

  // debug helper (disabled by default)
  const DEBUG = false; // set true for local debugging
  const debug = (...args) => { if (DEBUG) console.debug(...args); };

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
    // fallback to localhost
    return '127.0.0.1';
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

          if (obj.type === 'message' && obj.data && typeof obj.data.topic === 'string') {
            const topic = obj.data.topic;
            const lowerTopic = topic.toLowerCase();
            const n = Number(obj.data.payload);
            if (!Number.isNaN(n)) {
              // route to per-device sensor/target maps
              if (lowerTopic.endsWith('/sensor')) {
                const base = topic.replace(/\/[^/]*$/,'').replace(/\/Sensor$/,'').replace(/\/SENSOR$/,'');
                setGSensors(prev => ({ ...prev, [base]: n }));
                markConnected();
                debug('Sensor update', topic, n);
                // if we have sensor but no target yet for this base, trigger a one-time on-demand get
                if (!(base in gTargets)) {
                  const id = base + '-onDemandTarget';
                  safeSend(ws, { type: 'get', topic: `${base}/Target`, id }); targetRequestCounts.current[base] = (targetRequestCounts.current[base] || 0) + 1; debug('On-demand get Target for base', base);
                }
              }
              if (lowerTopic.endsWith('/target')) {
                const base = topic.replace(/\/Target$/i, '');
                setGTargets(prev => ({ ...prev, [base]: n }));
                // target messages should also mark the connection healthy so the overlay goes away
                markConnected();
                debug('Target message', topic, n);
                targetReceiveCounts.current[base] = (targetReceiveCounts.current[base] || 0) + 1;
              }
            }
          }
          // also accept 'current' responses from the bridge for sensor gets
          if (obj.type === 'current' && typeof obj.topic === 'string' && /\/sensor$/i.test(obj.topic)) {
            const base = obj.topic.replace(/\/Sensor$/i, '');
            const n = obj.payload === null ? null : Number(obj.payload);
            if (!Number.isNaN(n) && n !== null) {
              setGSensors(prev => ({ ...prev, [base]: n }));
              // clear connection error/timeout and hide spinner
              markConnected();
              debug('Current response (Sensor)', base, n);
            }
          }
          if (obj.type === 'current' && typeof obj.topic === 'string' && /\/target$/i.test(obj.topic)) {
            const base = obj.topic.replace(/\/Target$/i, '');
            // Accept 0 as valid; only treat undefined/NaN as invalid
            if (obj.payload !== null && obj.payload !== undefined && obj.payload !== '') {
              const n = Number(obj.payload);
              if (!Number.isNaN(n)) {
                setGTargets(prev => ({ ...prev, [base]: n }));
                markConnected();
                debug('Current response (Target)', base, n);
                targetReceiveCounts.current[base] = (targetReceiveCounts.current[base] || 0) + 1;
              } else {
                debug('Current response (Target) non-numeric payload', base, obj.payload);
              }
            } else {
              debug('Current response (Target) empty payload', base, obj.payload);
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
          // inventory snapshot
          if (obj.type === 'inventory' && obj.data && typeof obj.data === 'object') {
            const inv = obj.data || {};
            let any = false;
            const nextSensors = {};
            const nextTargets = {};
            Object.entries(inv).forEach(([topic, val]) => {
              if (/\/sensor$/i.test(topic)) { const base = topic.replace(/\/Sensor$/i,''); const n = Number(val); if (!Number.isNaN(n)) { nextSensors[base] = n; any = true; } }
              if (/\/target$/i.test(topic)) { const base = topic.replace(/\/Target$/i,''); const n = Number(val); if (!Number.isNaN(n)) { nextTargets[base] = n; any = true; } }
            });
            if (any) {
              if (Object.keys(nextSensors).length) setGSensors(prev => ({ ...nextSensors, ...prev }));
              if (Object.keys(nextTargets).length) setGTargets(prev => ({ ...nextTargets, ...prev }));
              debug('Applied inventory snapshot', Object.keys(nextSensors).length, 'sensors,', Object.keys(nextTargets).length, 'targets');
            }
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
    // close any existing socket tied to old token
  try { wsRef.current && wsRef.current.close(); } catch (e) {}
  // clear any pending reconnects when token changes
  if (reconnectMeta.current.timer) { clearTimeout(reconnectMeta.current.timer); reconnectMeta.current.timer = null; }
    connectWebSocket();
    // fetch thresholds once on mount
    (async () => {
      try {
        // Use a same-origin request so the browser's CSP 'connect-src "self"' policy allows it.
        // apiFetch will attach Authorization when present; fall back to fetch on the same origin.
        const path = '/thresholds';
        const res = await (typeof window !== 'undefined' && window.apiFetch ? window.apiFetch(path) : fetch(path));
        if (res.status === 401) {
          // notify app to clear stored token and show login
          try { window.dispatchEvent(new CustomEvent('brewski-unauthorized')); } catch (e) {}
          return;
        }
        const js = await res.json();
        if (js && js.overrides) setThresholds(js.overrides);
      } catch(e) {}
    })();
    // store the timeout in a ref so it can be cleared from ws.onmessage when data arrives
    connTimeoutRef.current = setTimeout(() => {
      // if still loading after 6s, show a connection error and allow retry
      setConnectionError(true);
      setLoading(false);
      connTimeoutRef.current = null;
    }, 6000);
    return () => {
      try { wsRef.current && wsRef.current.close(); } catch (e) {}
      try { if (wsRef.current && wsRef.current._retryTimer) clearInterval(wsRef.current._retryTimer); } catch (e) {}
      if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
      if (reconnectMeta.current.timer) { clearTimeout(reconnectMeta.current.timer); reconnectMeta.current.timer = null; }
    };
  }, [token]);

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
    // request current after a short delay to confirm authoritative value
    setTimeout(() => {
      try { wsRef.current && wsRef.current.send(JSON.stringify({ type: 'get', topic, id: id + '-get' })); } catch (e) {}
    }, 500);
  };
  // manual diagnostic: re-request all known targets (invoke from dev menu or future button if needed)
  const requeryAllTargets = () => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    const bases = new Set([...Object.keys(gSensors), ...Object.keys(gTargets), ...defaultDevices.map(d=>d.key)]);
    bases.forEach(base => {
      const id = base + '-manual-reget';
      try { wsRef.current.send(JSON.stringify({ type: 'get', topic: `${base}/Target`, id })); targetRequestCounts.current[base] = (targetRequestCounts.current[base] || 0) + 1; } catch (e) {}
    });
  debug('Manual requery targets', Object.fromEntries(Object.entries(targetRequestCounts.current)));
  };

  // sendNumber UI removed; keep helper if needed
  const sendNumber = () => {
    const n = Number(sendValue);
    if (Number.isNaN(n)) return;
    // publish using the first device as a sensible default when this helper is used
    if (deviceList && deviceList.length > 0) publishTargetForDevice(deviceList[0].key, n);
    setSendValue('');
  };
  const doReconnect = () => {
    try { wsRef.current && wsRef.current.close(); } catch (e) {}
    setLoading(true);
    setConnectAttempt(a => a + 1);
    connectWebSocket();
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

  return (
    <SafeAreaView style={styles.container}>
      {/* small spacer to keep content below any header/hamburger */}
      <View style={[styles.headerSpacer, { height: (Constants.statusBarHeight || 0) + 12 }]} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.contentContainer}>
        {!loading && (
          <>
            <View style={[styles.gaugeWrap, { flexDirection:'row', flexWrap:'wrap', justifyContent:'center', marginHorizontal: -(gap/2) }]}> 
              {deviceList.map((d, i) => {
                const sensorVal = gSensors[d.key] ?? null;
                const targetVal = gTargets[d.key] ?? null;
                let gStart = 0, gEnd = 220;
                const upKey = d.key.toUpperCase();
                if (upKey.includes('FERM')) { gStart = 55; gEnd = 80; }
                else if (upKey.includes('MASH')) { gStart = 150; gEnd = 160; }
                else if (upKey.includes('BOIL') || upKey.includes('HLT')) { gStart = 0; gEnd = 220; }
                return (
                  <View key={`gwrap-${d.key}`} style={{ width: columnWidth, padding: gap/2, alignItems:'center' }}>
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
                      greenStart={gStart}
                      greenEnd={gEnd}
                    />
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
