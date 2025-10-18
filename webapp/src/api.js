import { API_HOST as IMPORTED_API_HOST, apiUrl } from './hosts';

export async function apiFetch(path, opts = {}) {
  // default options
  const init = Object.assign({ headers: {} }, opts);
  try {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('brewski_jwt') : null;
    if (token) init.headers['Authorization'] = `Bearer ${token}`;
  } catch (e) { /* ignore missing localStorage */ }

  // Resolve API_HOST from the imported hosts module, with a safe fallback
  const resolvedApiHost = IMPORTED_API_HOST || 'api.brewingremote.com';

  // Normalize path -> always prefix with leading slash for join safety
  let rel = typeof path === 'string' ? path : '';
  if (!rel.startsWith('/')) rel = '/' + rel;

  // Determine if we should use same-origin (SPA served from brewingremote.com) vs central API host.
  let finalPath = rel;
  try {
    const isWeb = (typeof window !== 'undefined' && typeof window.document !== 'undefined');
    if (isWeb) {
      const host = window.location.hostname || '';
  const isCentral = host === resolvedApiHost;
      // If we are on brewingremote.com (app host) use same-origin to avoid CORS and leverage tunnel.
      // If we're on api host OR a mobile/native runtime (non-web) then use the central API host.
      if (isCentral) {
        finalPath = apiUrl(rel);
      } else {
        // Force absolute URL for login endpoint so we never accidentally
        // fetch the SPA HTML when requesting JSON.
        if (rel.startsWith('/admin/api/login') || rel.startsWith('/admin/api/register') || rel.startsWith('/admin/api/forgot') || rel.startsWith('/admin/api/reset')) {
          finalPath = apiUrl(rel);
        }
        // Also route any central API paths to the API host to avoid same-origin
        // HTML responses when the SPA server doesn't serve API routes.
        else if (rel.startsWith('/admin/api/') || rel.startsWith('/api/')) {
          // For authenticated admin API calls and public API calls prefer the API host
          finalPath = apiUrl(rel);
        } else {
          finalPath = rel; // same-origin for non-api paths
        }
      }
    } else {
      // native context -> central host
  finalPath = apiUrl(rel);
    }
  } catch (e) {
    finalPath = rel; // fallback same-origin
  }

  // Ensure we explicitly prefer JSON and mark requests as XHR so some proxies
  // route API calls to the backend instead of returning the SPA HTML shell.
  if (!init.headers['Accept']) init.headers['Accept'] = 'application/json, text/plain;q=0.9,*/*;q=0.1';
  // Only add X-Requested-With for same-origin requests in web builds to avoid
  // triggering CORS preflight failures when calling the API host from a
  // different origin (e.g., brewingremote.com -> api.brewingremote.com).
  try {
    if (!init.headers['X-Requested-With']) {
      const isWeb = (typeof window !== 'undefined' && typeof window.document !== 'undefined');
      if (!isWeb) {
        // native/runtime contexts are OK to set
        init.headers['X-Requested-With'] = 'XMLHttpRequest';
      } else {
        // If finalPath is same-origin (relative or same hostname), mark as XHR
        try {
          const isAbsolute = /^https?:\/\//i.test(finalPath);
          if (!isAbsolute) {
            init.headers['X-Requested-With'] = 'XMLHttpRequest';
          } else {
            const fpHost = (new URL(finalPath)).hostname || '';
            const curHost = window.location.hostname || '';
            if (fpHost && curHost && fpHost === curHost) init.headers['X-Requested-With'] = 'XMLHttpRequest';
          }
        } catch (e) { /* ignore URL parse errors */ }
      }
    }
  } catch (e) {}
  if (init.body && typeof init.body !== 'string') {
    // If caller didn't serialize body, do it (unless already a FormData / Blob etc.)
    if (!(typeof FormData !== 'undefined' && init.body instanceof FormData)) {
      init.body = JSON.stringify(init.body);
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(finalPath, init);
  try {
    // Debug helpers: surface resolved URL and whether auth header was attached
    if (typeof window !== 'undefined' && window.console && window.console.debug) {
      try { console.debug('apiFetch ->', { url: finalPath, hasAuth: !!init.headers['Authorization'], method: init.method || 'GET' }); } catch (e) {}
    }
  } catch (e) {}
  if (res.status === 401) {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem('brewski_jwt'); } catch (e) {}
    return res;
  }
  // If server returns HTML at an API endpoint try a couple of safe fallbacks
  // so clients running behind proxies or the SPA server don't accidentally
  // receive the SPA HTML instead of JSON. Fall back order:
  // 1) same-origin fetch with credentials (browser) — useful when app is
  //    served from the API host and absolute host requests returned HTML
  // 2) if we have a JWT and Authorization header wasn't attached, retry
  //    using `?token=` query param against the API host (some proxies accept this)
  try {
    const contentType = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : '';
    if (contentType && contentType.toLowerCase().indexOf('text/html') !== -1) {
      try { console.warn('apiFetch: API returned HTML for', finalPath); } catch (e) {}

      // Browser same-origin retry: try relative path with credentials if available
      try {
        const isWeb = (typeof window !== 'undefined' && typeof window.document !== 'undefined');
        if (isWeb && (rel.startsWith('/admin/api/') || rel.startsWith('/api/'))) {
          try {
            const same = await fetch(rel, Object.assign({}, init, { credentials: 'same-origin' }));
            const ct = same.headers && typeof same.headers.get === 'function' ? (same.headers.get('content-type') || '') : '';
            if (same.ok && ct && ct.toLowerCase().indexOf('text/html') === -1) return same;
          } catch (e) {}
        }
      } catch (e) {}

      // If we have a token and no Authorization header was sent, try token query fallback
      try {
        let token = null;
        try { token = (typeof localStorage !== 'undefined') ? localStorage.getItem('brewski_jwt') : null; } catch (e) {}
        const hadAuth = init.headers && (!!init.headers['Authorization'] || !!init.headers['authorization']);
        if (token && !hadAuth) {
          try {
            const sep = finalPath.indexOf('?') === -1 ? '?' : '&';
            const qUrl = `${finalPath}${sep}token=${encodeURIComponent(token)}`;
            const qRes = await fetch(qUrl, init);
            const qCt = qRes.headers && typeof qRes.headers.get === 'function' ? (qRes.headers.get('content-type') || '') : '';
            if (qRes.ok && qCt && qCt.toLowerCase().indexOf('text/html') === -1) return qRes;
          } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (e) {}
  return res;
}

// Attach a convenience global in browser builds so legacy code can call window.apiFetch
try {
  if (typeof window !== 'undefined') window.apiFetch = apiFetch;
} catch (e) {}
