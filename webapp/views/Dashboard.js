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
  const [mode, setMode] = useState(null); // will be set from customer info
  const [customerSlug, setCustomerSlug] = useState('default'); // user's actual customer slug
  // Store raw power messages that need customer context
  const [pendingPowerMessages, setPendingPowerMessages] = useState([]);

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
      const meta = gMeta[k];
      if (meta) {
        // Label strategy: metric (capitalized) + optional device if more than one device shares the metric.
        const metricLabel = meta.metric ? meta.metric.replace(/[-_]/g,' ').replace(/\b([a-z])/g, m => m.toUpperCase()) : k;
        seen.set(k, metricLabel + (meta.device ? ` (${meta.device})` : ''));
      } else {
        const label = k.replace(/^DUMMY/i, '').replace(/([A-Z0-9]+)/g, ' $1').trim() || k;
        seen.set(k, label);
      }
    };
    Object.keys(gSensors || {}).forEach(addKey);
    Object.keys(gTargets || {}).forEach(addKey);
    return Array.from(seen.entries()).map(([key, label]) => ({ key, label }));
  }, [gSensors, gTargets, gMeta]);

  // Filtered list according to mode: customer slug => includes that segment; BREW => excludes customer segments.
  const filteredDevices = useMemo(() => {
    if (!deviceList.length || !mode) return deviceList;
    const wantCustomer = mode !== 'BREW'; // if mode is not BREW, it's the customer slug
    const currentCustomerSlug = wantCustomer ? mode : null;
    
    return deviceList.filter(d => {
      const baseKey = d.key;
      const meta = gMeta[baseKey];
      const isDummy = /^DUMMY/i.test(baseKey);
      
      // Helper function to check if a device matches ANY known customer (not just current one)
      const matchesAnyCustomer = () => {
        if (meta && meta.device) {
          // Check if device matches any customer slug (RAIL, BREW, etc.)
          const deviceUpper = meta.device.toUpperCase();
          return deviceUpper === 'RAIL' || deviceUpper === 'BREW' || deviceUpper === currentCustomerSlug?.toUpperCase();
        } else {
          const segs = baseKey.split('/');
          if (segs.length >= 2) {
            const deviceUpper = (segs[1] || '').toUpperCase();
            return deviceUpper === 'RAIL' || deviceUpper === 'BREW' || deviceUpper === currentCustomerSlug?.toUpperCase();
          }
        }
        return false;
      };
      
      // Helper function to check if device matches current customer
      const matchesCurrentCustomer = () => {
        if (meta && meta.device) {
          return meta.device.toUpperCase() === (currentCustomerSlug || '').toUpperCase();
        } else {
          const segs = baseKey.split('/');
          if (segs.length >= 2) {
            return (segs[1] || '').toUpperCase() === (currentCustomerSlug || '').toUpperCase();
          }
        }
        return false;
      };

      // Case 1: We have a metric-bearing base (preferred modern schema)
      if (meta && meta.metric) {
        if (wantCustomer) {
          // Non-BREW users: show only devices that match their customer
          return matchesCurrentCustomer();
        } else {
          // BREW users: show only devices that DON'T match any specific customer (catch-all)
          return !matchesAnyCustomer();
        }
      }

      // Case 2: Legacy / short base without a metric
      if (!meta || (meta && !meta.metric)) {
        if (wantCustomer) return false;   // Never show legacy bases in customer view
        if (matchesAnyCustomer()) return false; // Don't show customer-specific legacy bases in BREW
        if (isDummy) return false;        // Still hide any DUMMY placeholders
        return true;                      // Show unclassified legacy bases in BREW view
      }
      return false; // fallback safeguard
    });
  }, [deviceList, mode, gMeta]);

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
            const parts = topic.split('/');
            if (parts.length < 2) return null; // must at least have <base>/<Terminal>
            let site = null, device = null, metric = null, terminal = null;
            // Terminal is always last segment for our purposes if it matches Sensor|Target
            const last = parts[parts.length - 1];
            if (!/^(Sensor|Target)$/i.test(last)) {
              // Not a terminal topic we currently care about
              return null;
            }
            terminal = last;
            if (parts.length === 2) {
              // <device>/<Terminal>
              [device] = parts;
            } else if (parts.length === 3) {
              // <device>/<metric>/<Terminal>
              [device, metric] = parts;
            } else if (parts.length >= 4) {
              // <site>/<device>/<metric>/<Terminal> (ignore deeper extra segments if ever appear)
              site = parts[0]; device = parts[1]; metric = parts[2];
            }
            return { site, device, metric, terminal };
          };

          const registerMeta = (baseKey, meta) => {
            if (!baseKey || !meta) return;
            setGMeta(prev => (prev[baseKey] ? prev : { ...prev, [baseKey]: meta }));
          };

          const applySensor = (topic, val) => {
            const meta = parseTopic(topic);
            if (!meta) return;
            let baseKey;
            if (meta.metric) {
              baseKey = meta.site ? `${meta.site}/${meta.device}/${meta.metric}` : `${meta.device}/${meta.metric}`;
            } else {
              baseKey = meta.site ? `${meta.site}/${meta.device}` : `${meta.device}`;
            }
            setGSensors(prev => ({ ...prev, [baseKey]: val }));
            registerMeta(baseKey, meta);
            if (!topic.startsWith('tele/') && !(baseKey in gTargets) && wsRef.current && wsRef.current.readyState === 1) {
              const reqId = baseKey + '-auto-target';
              try { wsRef.current.send(JSON.stringify({ type: 'get', topic: `${baseKey}/Target`, id: reqId })); targetRequestCounts.current[baseKey] = (targetRequestCounts.current[baseKey] || 0) + 1; } catch (e) {}
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
          };
          const applyTarget = (topic, val) => {
            const meta = parseTopic(topic);
            if (!meta) return;
            let baseKey;
            if (meta.metric) {
              baseKey = meta.site ? `${meta.site}/${meta.device}/${meta.metric}` : `${meta.device}/${meta.metric}`;
            } else {
              baseKey = meta.site ? `${meta.site}/${meta.device}` : `${meta.device}`;
            }
            setGTargets(prev => ({ ...prev, [baseKey]: val }));
            registerMeta(baseKey, meta);
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
              if (deviceName && mode) {
                // Map legacy devices to current customer context
                baseKey = `${mode}/${deviceName}`;
              } else if (deviceName && !mode) {
                // Queue for later processing when mode is available
                setPendingPowerMessages(prev => [...prev, { topic, powerStates, deviceName, type: 'legacy' }]);
                return;
              }
            }
            // Response Pattern: stat/<device>/(STATE|RESULT) - device control responses
            else if (parts[0].toLowerCase() === 'stat' && parts.length === 3) {
              deviceName = parts[1];
              if (deviceName && mode) {
                // Map stat responses to current customer context
                baseKey = `${mode}/${deviceName}`;
              } else if (deviceName && !mode) {
                // Queue for later processing when mode is available
                setPendingPowerMessages(prev => [...prev, { topic, powerStates, deviceName, type: 'stat' }]);
                return;
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
                const baseKey = parsed.site ? `${parsed.site}/${parsed.device}/${parsed.metric}` : `${parsed.device}/${parsed.metric}`;
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
              const baseKey = parsed.site ? `${parsed.site}/${parsed.device}/${parsed.metric}` : `${parsed.device}/${parsed.metric}`;
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
        const res = await (typeof window !== 'undefined' && window.apiFetch ? window.apiFetch(path) : fetch(path));
        if (res.status === 401) { try { window.dispatchEvent(new CustomEvent('brewski-unauthorized')); } catch (e) {} return; }
        const js = await res.json();
        if (js && js.overrides) setThresholds(js.overrides);
      } catch(e) {}
    })();
    // NEW: Snapshot hydrate from /api/latest so gauges render immediately after reload (before live MQTT)
    (async () => {
      try {
        const latestPath = '/api/latest';
        let res;
        if (typeof window !== 'undefined' && window.apiFetch) {
          res = await window.apiFetch(latestPath);
        } else {
          // Fallback: append token query param if available
            const url = token ? `${latestPath}?token=${encodeURIComponent(token)}` : latestPath;
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
          // Notify parent component about customer info for header title
          if (onCustomerLoaded) {
            onCustomerLoaded(js.customer);
          }
        }
        
        const addsSensors = {}; const addsMeta = {};
        js.sensors.forEach(row => {
          if (!row) return;
          const lv = row.last_value;
          if (lv === null || lv === undefined) return;
          const baseKey = (row.topic_key || row.key || '').trim();
          if (!baseKey) return;
          const num = Number(lv);
          if (Number.isNaN(num)) return;
          // Avoid overwriting fresher in-memory values (keep existing if present)
          if (addsSensors[baseKey] === undefined && gSensors[baseKey] === undefined) {
            addsSensors[baseKey] = num;
            // Reconstruct meta from baseKey structure
            const parts = baseKey.split('/');
            let site = null, device = null, metric = null;
            if (parts.length === 1) {
              device = parts[0];
            } else if (parts.length === 2) {
              [device, metric] = parts;
            } else if (parts.length >= 3) {
              [site, device, metric] = parts;
            }
            if (!addsMeta[baseKey]) addsMeta[baseKey] = { site, device, metric, terminal: 'Sensor' };
          }
        });
        if (Object.keys(addsSensors).length) setGSensors(prev => ({ ...addsSensors, ...prev }));
        if (Object.keys(addsMeta).length) setGMeta(prev => ({ ...addsMeta, ...prev }));
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

  return (
    <SafeAreaView style={styles.container}>
      {/* small spacer to keep content below any header/hamburger */}
      <View style={[styles.headerSpacer, { height: (Constants.statusBarHeight || 0) + 12 }]} />
      {/* Placeholder future: group filter UI (to filter deviceList by second topic segment/group) */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.contentContainer}>
        {!loading && (
          <>

            <View style={[styles.gaugeWrap, { flexDirection:'row', flexWrap:'wrap', justifyContent:'center', marginHorizontal: -(gap/2) }]}> 
              {filteredDevices.map((d, i) => {
                const sensorVal = gSensors[d.key] ?? null;
                const targetVal = gTargets[d.key] ?? null;
                const meta = gMeta[d.key];
                const gp = computeGaugeParams(d.key, meta, sensorVal);
                

                
                  // Enhanced power switch detection - expects customer-prefixed format
                const powerSwitches = mode ? Object.entries(gPower).find(([powerBaseKey]) => {                  // Must match current customer context (CUSTOMER/DEVICE format)
                  const customerPrefix = `${mode}/`;
                  if (!powerBaseKey.startsWith(customerPrefix)) {
                    return false;
                  }
                  
                  // Extract device name from power baseKey (format: CUSTOMER/DEVICE)
                  const deviceFromPowerKey = powerBaseKey.split('/')[1];
                  if (!deviceFromPowerKey) {
                    return false;
                  }
                  
                  // Check if gauge baseKey matches power baseKey directly or as prefix
                  // Gauge keys can be CUSTOMER/DEVICE or CUSTOMER/DEVICE/METRIC
                  // Power keys are always CUSTOMER/DEVICE
                  const gaugeCustomerDevice = d.key.includes('/') ? d.key.split('/').slice(0, 2).join('/') : null;
                  if (gaugeCustomerDevice && gaugeCustomerDevice === powerBaseKey) {
                    return true;
                  }
                  
                  // Extract device name from gauge key - handle various patterns
                  let gaugeDevice = null;
                  
                  // Method 1: Direct meta device match (if available)
                  if (meta && meta.device && meta.device !== 'tele' && meta.device !== 'stat') {
                    gaugeDevice = meta.device;
                  }
                  // Method 2: Extract device from gauge key patterns
                  else {
                    // Pattern: DUMMY<DEVICE> -> <DEVICE>
                    if (/^DUMMY/i.test(d.key)) {
                      gaugeDevice = d.key.replace(/^DUMMY/i, '');
                    }
                    // Pattern: tele/<CUSTOMER>/<DEVICE> (standard 3-level format)
                    else if (d.key.startsWith('tele/')) {
                      const parts = d.key.split('/');
                      if (parts.length >= 3) {
                        // Standard format: tele/CUSTOMER/DEVICE - device is at index 2
                        gaugeDevice = parts[2];
                      } else if (parts.length === 2) {
                        // Legacy format: tele/DEVICE - device is at index 1 (being phased out)
                        gaugeDevice = parts[1];
                      }
                    }
                    // Pattern: stat/<CUSTOMER>/<DEVICE> or stat/<DEVICE> (similar logic)
                    else if (d.key.startsWith('stat/')) {
                      const parts = d.key.split('/');
                      if (parts.length >= 3) {
                        // Standard format: stat/CUSTOMER/DEVICE - device is at index 2
                        gaugeDevice = parts[2];
                      } else if (parts.length === 2) {
                        // Legacy format: stat/DEVICE - device is at index 1
                        gaugeDevice = parts[1];
                      }
                    }
                    // Pattern: <CUSTOMER>/<DEVICE> or <DEVICE>/<METRIC> 
                    else {
                      const gaugeParts = d.key.split('/');
                      if (gaugeParts.length === 2) {
                        // Could be <CUSTOMER>/<DEVICE> or <DEVICE>/<METRIC>
                        const firstPart = gaugeParts[0];
                        const secondPart = gaugeParts[1];
                        
                        // If first part matches our customer mode, second is device
                        if (mode && firstPart.toUpperCase() === mode.toUpperCase()) {
                          gaugeDevice = secondPart;
                        } 
                        // Otherwise, first part might be the device (legacy)
                        else {
                          gaugeDevice = firstPart;
                        }
                      } else if (gaugeParts.length === 3) {
                        // Pattern: <CUSTOMER>/<DEVICE>/<METRIC>
                        gaugeDevice = gaugeParts[1];
                      } else {
                        // Single segment, treat as device
                        gaugeDevice = gaugeParts[0];
                      }
                    }
                  }
                  
                  if (!gaugeDevice) {
                    return false;
                  }
                  
                  // Match device names (case insensitive)
                  return gaugeDevice.toUpperCase() === deviceFromPowerKey.toUpperCase();
                }) : null;
                
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
                                // Generate more descriptive labels
                                const getLabel = (key) => {
                                  if (key === 'POWER') return 'PWR';
                                  if (key.startsWith('POWER')) return key.replace('POWER', 'PWR');
                                  return key;
                                };
                                
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
                                      {getLabel(powerKey)}
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
