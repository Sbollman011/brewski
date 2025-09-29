export async function apiFetch(path, opts = {}) {
  // default options
  const init = Object.assign({ headers: {} }, opts);
  try {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('brewski_jwt') : null;
    if (token) init.headers['Authorization'] = `Bearer ${token}`;
  } catch (e) { /* ignore missing localStorage */ }

  const API_HOST = 'api.brewingremote.com'; // Option C split host

  // Normalize path -> always prefix with leading slash for join safety
  let rel = typeof path === 'string' ? path : '';
  if (!rel.startsWith('/')) rel = '/' + rel;

  // When running under native/Expo (non-web) OR when caller mistakenly passes a relative path
  // we construct an absolute URL to the API host.
  let finalPath = rel;
  try {
    const isWeb = (typeof window !== 'undefined' && typeof window.document !== 'undefined');
    // Always use the API host for absolute calls now (both web & native) to avoid any ambiguity
    finalPath = `https://${API_HOST}${rel}`;
  } catch (e) {
    finalPath = `https://${API_HOST}${rel}`;
  }

  const res = await fetch(finalPath, init);
  if (res.status === 401) {
    try { localStorage.removeItem('brewski_jwt'); } catch (e) {}
    return res;
  }
  return res;
}

// Attach a convenience global in browser builds so legacy code can call window.apiFetch
try {
  if (typeof window !== 'undefined') window.apiFetch = apiFetch;
} catch (e) {}
