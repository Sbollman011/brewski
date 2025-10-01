export async function apiFetch(path, opts = {}) {
  // default options
  const init = Object.assign({ headers: {} }, opts);
  try {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('brewski_jwt') : null;
    if (token) init.headers['Authorization'] = `Bearer ${token}`;
  } catch (e) { /* ignore missing localStorage */ }

  const API_HOST = 'api.brewingremote.com'; // central API host

  // Normalize path -> always prefix with leading slash for join safety
  let rel = typeof path === 'string' ? path : '';
  if (!rel.startsWith('/')) rel = '/' + rel;

  // Determine if we should use same-origin (SPA served from brewingremote.com) vs central API host.
  let finalPath = rel;
  try {
    const isWeb = (typeof window !== 'undefined' && typeof window.document !== 'undefined');
    if (isWeb) {
      const host = window.location.hostname || '';
      const isCentral = host === API_HOST;
      // If we are on brewingremote.com (app host) use same-origin to avoid CORS and leverage tunnel.
      // If we're on api host OR a mobile/native runtime (non-web) then use the central API host.
      if (isCentral) {
        finalPath = `https://${API_HOST}${rel}`;
      } else {
        // Force absolute URL for login endpoint so we never accidentally
        // fetch the SPA HTML when requesting JSON.
        if (rel.startsWith('/admin/api/login') || rel.startsWith('/admin/api/register') || rel.startsWith('/admin/api/forgot') || rel.startsWith('/admin/api/reset')) {
          finalPath = `https://${API_HOST}${rel}`;
        } else if (rel.startsWith('/admin/api/')) {
          // For authenticated admin API calls we prefer the API host too to avoid HTML 200 responses
          // when the frontend server also handles /admin routes.
          finalPath = `https://${API_HOST}${rel}`;
        } else {
          finalPath = rel; // same-origin for non-admin-api paths
        }
      }
    } else {
      // native context -> central host
      finalPath = `https://${API_HOST}${rel}`;
    }
  } catch (e) {
    finalPath = rel; // fallback same-origin
  }

  // Ensure we explicitly prefer JSON
  if (!init.headers['Accept']) init.headers['Accept'] = 'application/json, text/plain;q=0.9,*/*;q=0.1';
  if (init.body && typeof init.body !== 'string') {
    // If caller didn't serialize body, do it (unless already a FormData / Blob etc.)
    if (!(typeof FormData !== 'undefined' && init.body instanceof FormData)) {
      init.body = JSON.stringify(init.body);
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(finalPath, init);
  if (res.status === 401) {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem('brewski_jwt'); } catch (e) {}
    return res;
  }
  return res;
}

// Attach a convenience global in browser builds so legacy code can call window.apiFetch
try {
  if (typeof window !== 'undefined') window.apiFetch = apiFetch;
} catch (e) {}
