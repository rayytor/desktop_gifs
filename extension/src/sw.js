// Service worker (background script in Firefox): the only part that talks to
// Tenor. It hands the content script a short list of
// { id, title, preview, width, height }.
//
// YouTube only takes GIFs that Tenor rates G, and Tenor's pages do not say how
// a GIF is rated. Tenor's API does, and it answers to the key that every
// tenor.com page carries for the site's own scripts. Lists therefore come from
// the API, filtered to G. If the API does not answer, they come from the result
// data Tenor embeds in its pages, unrated, as they did before. The key is kept
// in storage once read, so the API keeps working when tenor.com itself cannot
// be reached.

const SPOOFED_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"

const TENOR = 'https://tenor.com';
const TENOR_API = 'https://tenor.googleapis.com/v2';
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 50;
const TENOR_TIMEOUT_MS = 10000;
// A request that fails to connect is tried once more after this long.
const NETWORK_RETRY_MS = 1000;
const RELEASES_API = 'https://api.github.com/repos/rayytor/desktop_gifs/releases/latest';
const RELEASES_PAGE = 'https://github.com/rayytor/desktop_gifs/releases/';
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;

// url -> { time, value }
const cache = new Map();

// Chrome does not run content scripts in tabs that were already open when the
// extension is installed, and after an update or a reload the copies in those
// tabs are cut off from it. So the scripts are injected here into every open
// YouTube tab, which then works without a refresh. Each file takes over from
// an older copy of itself, keeping a GIF that is attached to a comment box.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*', discarded: false });
  await Promise.all(tabs.map(async ({ id: tabId }) => {
    const target = { tabId };
    try {
      await chrome.scripting.executeScript({ target, files: ['src/main.js'], world: 'MAIN' });
      await chrome.scripting.insertCSS({ target, files: ['src/content.css'] });
      await chrome.scripting.executeScript({ target, files: ['src/content.js'] });
    } catch (e) { /* the tab closed or navigated away; it gets the scripts on its next load */ }
  }));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg && msg.type === 'update') {
    newerRelease().then(
      (release) => sendResponse({ ok: true, release }),
      () => sendResponse({ ok: true, release: null }),
    );
    return true;
  }
  handle(msg).then(
    (gifs) => sendResponse({ ok: true, gifs }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
  );
  return true;
});

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const path = new URL(details.url).pathname
    if (path === "/youtubei/v1/comment/create_comment" || path === "/youtubei/v1/comment/create_comment_reply") {
      const headers = details.requestHeaders
      const ua = headers.find(h => h.name.toLowerCase() === "user-agent")
      if (ua) {
        ua.value = SPOOFED_UA
      } else {
        console.warn("Desktop GIFs - User Agent couldnt be found to spoof") // hey rayytor, you can replace this warning with whatever sounds best to you
      }
      return { requestHeaders: headers }
    }
  },
  {
    urls: ["https://www.youtube.com/*"]
  },
  ["blocking", "requestHeaders"]
)

async function handle(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('Bad request.');
  if (msg.type === 'featured') return featured();
  if (msg.type === 'search' && typeof msg.query === 'string') return search(msg.query);
  if (msg.type === 'resolve' && typeof msg.input === 'string') return resolve(msg.input);
  if (msg.type === 'check' && typeof msg.id === 'string' && /^\d{1,20}$/.test(msg.id)) return check(msg.id);
  throw new Error('Bad request.');
}

async function cached(url, load) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.value;
  const value = await load();
  cache.set(url, { time: Date.now(), value });
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// fetch() rejects with a bare TypeError ("Failed to fetch" in Chromium,
// "NetworkError when attempting to fetch resource." in Firefox) when it cannot
// connect, and also when the extension may not reach the host, since the
// request then needs CORS headers that tenor.com does not send. Such a failure
// is tried once more, then explained.
async function tenorFetch(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...init, credentials: 'omit', signal: AbortSignal.timeout(TENOR_TIMEOUT_MS) });
    } catch (e) {
      if (e && e.name === 'TimeoutError') throw new Error('Tenor did not answer in time. Try again.');
      if (!e || e.name !== 'TypeError') throw e;
      if (attempt === 1) { await sleep(NETWORK_RETRY_MS); continue; }
      throw new Error(await unreachable(new URL(url).hostname));
    }
  }
}

async function unreachable(host) {
  let allowed = true;
  try {
    allowed = await chrome.permissions.contains({ origins: [`https://${host}/*`] });
  } catch (e) { /* unknown: assume it is allowed */ }
  return allowed
    ? `This browser could not reach ${host}. If ${host} does not open in a tab either, something on this network or computer is blocking it, such as a firewall, a DNS filter, or a school or work network.`
    : `Desktop GIFs is not allowed to reach ${host}. Allow it in the extension's site access settings, then try again.`;
}

// A tenor.com page as { store, keys }: the results it shows, and the two
// values its own scripts send to Tenor's API (null if they cannot be read).
function fetchPage(url) {
  return cached(url, async () => {
    const res = await tenorFetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(res.status === 404 ? 'Tenor could not find that GIF.' : `Tenor returned HTTP ${res.status}.`);
    if (new URL(res.url).origin !== TENOR) throw new Error('Tenor redirected somewhere unexpected.');
    const html = await res.text();
    const m = html.match(/<script id="store-cache" type="text\/x-cache"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('Tenor changed its page format; search is unavailable.');
    const keys = readKeys(html);
    if (keys) storeKeys(keys);
    return { store: JSON.parse(m[1]), keys };
  });
}

async function storedKeys() {
  try {
    const { tenorKeys: k } = await chrome.storage.local.get('tenorKeys');
    if (k && typeof k.key === 'string' && typeof k.client_key === 'string') return { key: k.key, client_key: k.client_key };
  } catch (e) { /* no storage: read the keys from tenor.com */ }
  return null;
}

// Neither waits: losing the stored key only costs a visit to tenor.com.
async function storeKeys(keys) {
  try { await chrome.storage.local.set({ tenorKeys: keys }); } catch (e) { /* see above */ }
}

async function forgetKeys() {
  try { await chrome.storage.local.remove('tenorKeys'); } catch (e) { /* see above */ }
}

// The site's settings are base64 JSON in a second script element.
function readKeys(html) {
  const m = html.match(/<script id="data" type="text\/x-cache"[^>]*>([\s\S]*?)<\/script>/);
  try {
    const data = JSON.parse(atob(m[1].trim()));
    if (typeof data.API_V2_KEY === 'string' && typeof data.API_V2_CLIENT_KEY === 'string') {
      return { key: data.API_V2_KEY, client_key: data.API_V2_CLIENT_KEY };
    }
  } catch (e) { /* no keys: the callers fall back to the page's own results */ }
  return null;
}

// One call to Tenor's API, returning its results array. contentfilter=high
// asks for G-rated GIFs only. A stored key that Tenor no longer takes is
// dropped, and the call is made again with the one tenor.com carries now.
async function fetchApi(path, params) {
  const stored = await storedKeys();
  if (stored) {
    try {
      return await callApi(stored, path, params);
    } catch (e) {
      if (!e.badKey) throw e;
      forgetKeys();
    }
  }
  const { keys } = await fetchPage(`${TENOR}/`);
  if (!keys) throw new Error('Tenor changed its page format; ratings are unavailable.');
  return callApi(keys, path, params);
}

function callApi(keys, path, params) {
  const query = new URLSearchParams({ ...keys, contentfilter: 'high', media_filter: 'tinygif,tinywebp,gif', ...params });
  const url = `${TENOR_API}${path}?${query}`;
  return cached(url, async () => {
    const res = await tenorFetch(url);
    if (!res.ok) {
      const e = new Error(`Tenor returned HTTP ${res.status}.`);
      e.badKey = res.status === 400 || res.status === 401 || res.status === 403;
      throw e;
    }
    const { results } = await res.json();
    if (!Array.isArray(results)) throw new Error('Tenor sent an answer that could not be read.');
    return results;
  });
}

// A result without a rating is not held back: YouTube has the last word, and
// main.js reports a GIF it turns down.
const ratedG = (r) => typeof r.content_rating !== 'string' || r.content_rating === 'G';

function toGif(r) {
  if (!r || !/^\d{1,20}$/.test(String(r.id)) || !r.media_formats) return null;
  const flags = r.flags || [];
  if (flags.includes('sticker') || flags.includes('static')) return null;
  const f = r.media_formats.tinygif || r.media_formats.tinywebp || r.media_formats.gif;
  if (!f || typeof f.url !== 'string' || !/^https:\/\/media\d*\.tenor\.com\//.test(f.url)) return null;
  const dims = Array.isArray(f.dims) ? f.dims : [];
  return {
    id: String(r.id),
    title: String(r.content_description || r.h1_title || 'GIF').slice(0, 200),
    preview: f.url,
    width: dims[0] || 220,
    height: dims[1] || 124,
    // Only Tenor's API gives ratings; results from its web pages have none.
    contentRating: typeof r.content_rating === 'string' ? r.content_rating : null,
  };
}

const toGifs = (results) => (results || []).map(toGif).filter(Boolean).slice(0, MAX_RESULTS);

async function featured() {
  try {
    return toGifs((await fetchApi('/featured', { limit: MAX_RESULTS })).filter(ratedG));
  } catch (e) { /* fall back to the page's own list */ }
  const { store } = await fetchPage(`${TENOR}/`);
  return toGifs(store.gifs && store.gifs.featured && store.gifs.featured.results);
}

async function search(query) {
  const slug = query.trim().toLowerCase().split(/\s+/).filter(Boolean).map(encodeURIComponent).join('-');
  if (!slug) return featured();
  try {
    return toGifs((await fetchApi('/search', { q: query.trim(), limit: MAX_RESULTS })).filter(ratedG));
  } catch (e) { /* fall back to the search page's own list */ }
  const { store } = await fetchPage(`${TENOR}/search/${slug}-gifs`);
  const searches = Object.values((store.universal && store.universal.search) || {});
  return toGifs(searches[0] && searches[0].results);
}

// Accepts a tenor.com page link, a tenor.com short link, a media.tenor.com
// file link or a bare numeric ID, and returns the one GIF it points at. The
// GIF's page gives its current ID, which an old link does not; the API then
// gives its rating.
async function resolve(input) {
  const text = input.trim();
  let pageUrl;
  if (/^\d{1,20}$/.test(text)) {
    pageUrl = `${TENOR}/view/x-gif-${text}`;
  } else {
    let url;
    try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch (e) { throw new Error('That is not a Tenor link.'); }
    if (/^media\d*\.tenor\.com$/.test(url.hostname)) {
      // media IDs are the base64 of the 64-bit GIF ID followed by a format code
      const mediaId = url.pathname.split('/').filter(Boolean).find((p) => /^[A-Za-z0-9_-]{16}$/.test(p));
      if (!mediaId) throw new Error('That is not a Tenor GIF link.');
      pageUrl = `${TENOR}/view/x-gif-${decodeMediaId(mediaId)}`;
    } else if (url.hostname === 'tenor.com' || url.hostname === 'www.tenor.com') {
      pageUrl = `${TENOR}${url.pathname}`;
    } else {
      throw new Error('That is not a Tenor link.');
    }
  }
  const { store } = await fetchPage(pageUrl);
  const entries = Object.values((store.gifs && store.gifs.byId) || {});
  const gifs = toGifs(entries.flatMap((e) => (e && e.results) || []).slice(0, 1));
  if (!gifs.length) throw new Error('That link does not point at a GIF.');
  let rated = [];
  try {
    rated = await fetchApi('/posts', { ids: gifs[0].id, contentfilter: 'off' });
  } catch (e) { /* rating unknown: offer the GIF and let YouTube decide */ }
  const post = rated.find((r) => r && String(r.id) === gifs[0].id);
  if (post && !ratedG(post)) {
    throw new Error(`YouTube only takes GIFs that Tenor rates G. This one is rated ${post.content_rating}.`);
  }
  if (post) gifs[0].contentRating = post.content_rating;
  return gifs;
}

// The exact GIF about to be posted, with its current rating, for one that was
// picked without a known rating (a favorite, or a result from Tenor's web
// pages). An empty list means Tenor did not return it.
async function check(id) {
  const results = await fetchApi('/posts', { ids: id, contentfilter: 'off' });
  const post = results.find((r) => r && String(r.id) === id);
  const gif = post && toGif(post);
  return gif ? [gif] : [];
}

function decodeMediaId(mediaId) {
  const bin = atob(mediaId.slice(0, 11).replace(/-/g, '+').replace(/_/g, '/') + '=');
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(bin.charCodeAt(i));
  return n.toString();
}

// The newest release on GitHub as { version, url } when it is newer than this
// copy, else null. A ZIP-installed extension cannot update itself, so the
// picker only says that a new version is out. GitHub is asked at most once a
// day, without cookies.
async function newerRelease() {
  const current = chrome.runtime.getManifest().version;
  const { latestRelease: saved } = await chrome.storage.local.get('latestRelease');
  let release = saved && Date.now() - saved.checkedAt < UPDATE_CHECK_MS ? saved : null;
  if (!release) {
    const res = await fetch(RELEASES_API, {
      credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TENOR_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
    const data = await res.json();
    const version = String(data.tag_name || '').replace(/^v/, '');
    const url = String(data.html_url || '');
    if (!/^\d+(\.\d+){0,3}$/.test(version) || !url.startsWith(RELEASES_PAGE)) throw new Error('GitHub sent an answer that could not be read.');
    release = { version, url, checkedAt: Date.now() };
    await chrome.storage.local.set({ latestRelease: release });
  }
  return newer(release.version, current) ? { version: release.version, url: release.url } : null;
}

function newer(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}
