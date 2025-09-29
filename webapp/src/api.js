export async function apiFetch(path, opts = {}) {
  // default options
  const init = Object.assign({ headers: {} }, opts);
  try {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('brewski_jwt') : null;
    if (token) init.headers['Authorization'] = `Bearer ${token}`;
  } catch (e) { /* ignore missing localStorage */ }

  const res = await fetch(path, init);
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
