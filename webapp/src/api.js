export async function apiFetch(path, opts = {}) {
  // default options
  const init = Object.assign({ headers: {} }, opts);
  try {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('brewski_jwt') : null;
    if (token) init.headers['Authorization'] = `Bearer ${token}`;
  } catch (e) { /* ignore missing localStorage */ }

  // When running under native/Expo (non-web), the packager/dev-server makes
  // relative fetch() calls go to the local dev server (which is not the
  // real backend). Detect native runtime and rewrite to the public hostname
  // so mobile builds target the origin at runtime.
  let finalPath = path;
  try {
    const isWeb = (typeof window !== 'undefined' && typeof window.document !== 'undefined');
    const isNative = !isWeb;
    if (isNative && typeof path === 'string' && path.startsWith('/')) {
      // Use the public host for native clients. Keep HTTPS to ensure TLS to edge.
      finalPath = `https://appli.railbrewouse.com${path}`;
    }
  } catch (e) {
    // If any detection fails, fall back to original path
    finalPath = path;
  }

  const res = await fetch(finalPath, init);
  if (res.status === 401) {
    try { localStorage.removeItem('brewski_jwt'); } catch (e) {}
    // we'll still return the response so callers can decide how to redirect
    return res;
  }
  return res;
}

// Attach a convenience global in browser builds so legacy code can call window.apiFetch
try {
  if (typeof window !== 'undefined') window.apiFetch = apiFetch;
} catch (e) {}
