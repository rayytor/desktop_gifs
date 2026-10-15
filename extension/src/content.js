// Isolated-world content script: adds a GIF button to YouTube's comment boxes,
// shows the picker, attaches the chosen GIF to the box, and when the user posts
// hands it to the page-world hook (main.js) by submitting a one-time marker
// through YouTube's own comment box.
(() => {
  // sw.js also injects this file into YouTube tabs that are already open when
  // the extension is installed, updated or reloaded. Each copy tells the ones
  // before it to stop, then takes over what they left in the page: their GIF
  // buttons and picker are replaced, and a GIF attached to a comment box stays
  // attached. The text in the box belongs to YouTube and is left alone. An
  // older copy may already be dead (Firefox unloads them), so the new one
  // cleans up after it either way.
  const TAKEOVER = 'gcfy-takeover';
  // Sent by a stopped copy when it lets go of a GIF it was still posting.
  const RELEASED = 'gcfy-released';
  document.dispatchEvent(new CustomEvent(TAKEOVER));
  const life = new AbortController();
  const { signal } = life;
  let retired = false;

  const BOX_SCOPE = 'ytd-comment-simplebox-renderer, ytd-comment-thread-renderer';
  const POST_DIALOG = 'ytd-backstage-post-dialog-renderer';
  const PICKER_W = 340;
  const PICKER_H = 420;
  const SEARCH_DEBOUNCE_MS = 350;
  const ARM_TIMEOUT_MS = 1500;
  const SUBMIT_GRACE_MS = 4000;
  // Wait for the page's single request; a timeout does not prove rejection.
  const RESULT_TIMEOUT_MS = 60000;
  // How long a post waits for Tenor to rate a GIF picked without a rating.
  const CHECK_TIMEOUT_MS = 5000;
  const NO_FAVORITES = 'No favorites yet. Point at a GIF and click its star.';
  // How long a server refusal (HTTP 400) of a verified G-rated GIF is
  // remembered, or until a GIF goes through, so the picker can point at the
  // issue tracking it instead of leaving the next attempt to fail quietly.
  const BLOCKED_MEMORY_MS = 24 * 60 * 60 * 1000;
  const BLOCKED_ISSUE = 'https://github.com/rayytor/desktop_gifs/issues/93';

  const PICKER_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483647; }
    .panel {
      --bg: #fff; --fg: #0f0f0f; --muted: #606060; --line: rgba(0,0,0,.12); --field: rgba(0,0,0,.05); --accent: #065fd4; --err: #c00;
      --thumb: rgba(0,0,0,.25); --thumb-hover: rgba(0,0,0,.45);
      box-sizing: border-box; display: flex; flex-direction: column;
      width: ${PICKER_W}px; background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
      box-shadow: 0 8px 28px rgba(0,0,0,.35);
      font: 13px/1.4 Roboto, Arial, sans-serif;
    }
    .panel[data-dark] {
      --bg: #212121; --fg: #f1f1f1; --muted: #aaa; --line: rgba(255,255,255,.14); --field: rgba(255,255,255,.08); --accent: #3ea6ff; --err: #ff7b7b;
      --thumb: rgba(255,255,255,.25); --thumb-hover: rgba(255,255,255,.45);
    }
    .search { flex: none; display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--line); }
    input {
      box-sizing: border-box; flex: 1; min-width: 0; height: 34px; padding: 0 12px;
      border: 1px solid transparent; border-radius: 17px; outline: none;
      background: var(--field); color: var(--fg); font: inherit;
    }
    input:focus { border-color: var(--accent); }
    input::placeholder { color: var(--muted); }
    .fav-tab {
      flex: none; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 50%;
      background: var(--field); color: var(--muted); font: 16px/1 Arial, sans-serif; cursor: pointer;
    }
    .fav-tab[aria-pressed="true"] { background: var(--accent); color: var(--bg); }
    .fav-tab:focus-visible, .star:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .update {
      flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px;
      border-bottom: 1px solid var(--line); color: var(--fg);
    }
    .update[hidden] { display: none; }
    .update span { flex: 1; min-width: 0; }
    .update a { color: var(--accent); font-weight: 500; text-decoration: none; }
    .update a:hover { text-decoration: underline; }
    .update button {
      flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%;
      background: transparent; color: var(--muted); font: 16px/1 Arial, sans-serif; cursor: pointer;
    }
    .update button:hover { background: var(--field); }
    .update a:focus-visible, .update button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .blocked {
      flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px;
      border-bottom: 1px solid var(--line); color: var(--err);
    }
    .blocked[hidden] { display: none; }
    .blocked span { flex: 1; min-width: 0; }
    .blocked a { color: var(--accent); font-weight: 500; text-decoration: none; }
    .blocked a:hover { text-decoration: underline; }
    .blocked button {
      flex: none; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%;
      background: transparent; color: var(--muted); font: 16px/1 Arial, sans-serif; cursor: pointer;
    }
    .blocked button:hover { background: var(--field); }
    .blocked a:focus-visible, .blocked button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .status { flex: none; padding: 6px 12px 0; color: var(--muted); }
    .status:empty { display: none; }
    .status[data-kind="error"] { color: var(--err); }
    .grid {
      flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 8px 2px 8px 8px;
      display: flex; align-items: flex-start; gap: 6px;
      scrollbar-gutter: stable;
    }
    /* Slim rounded scrollbar: a 6px thumb inside a 12px transparent track. */
    .grid::-webkit-scrollbar { width: 12px; }
    .grid::-webkit-scrollbar-track { background: transparent; }
    .grid::-webkit-scrollbar-thumb {
      border: 3px solid transparent; border-radius: 6px;
      background: var(--thumb); background-clip: content-box;
    }
    .grid::-webkit-scrollbar-thumb:hover { background: var(--thumb-hover); background-clip: content-box; }
    @supports not selector(::-webkit-scrollbar) {
      .grid { scrollbar-width: thin; scrollbar-color: var(--thumb) transparent; padding-right: 8px; }
    }
    .col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .tile {
      display: block; width: 100%; margin: 0; padding: 0; border: 0; border-radius: 8px;
      overflow: hidden; background: var(--field); cursor: pointer;
    }
    .tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .tile:hover img { opacity: .82; }
    .tile img { display: block; width: 100%; height: auto; }
    /* The star is the tile's sibling, not its child: a button cannot hold another button. */
    .cell { position: relative; }
    .star {
      position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%;
      background: rgba(0,0,0,.6); color: #fff; font: 16px/1 Arial, sans-serif; cursor: pointer; opacity: 0;
    }
    .cell:hover .star, .star:focus-visible, .star[aria-pressed="true"] { opacity: 1; }
    .star[aria-pressed="true"] { color: #ffd45c; }
  `;

  // ---------------------------------------------------------------- page hook

  const fromMain = new Map(); // nonce -> callback(msg)

  // Not tied to signal: a copy that has been told to stop still hears how a
  // post it started ends.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const msg = e.data;
    if (!msg || msg.gcfy !== 'to-content' || typeof msg.nonce !== 'string') return;
    const cb = fromMain.get(msg.nonce);
    if (cb) cb(msg);
  });

  const toMain = (msg) => window.postMessage({ gcfy: 'to-main', ...msg }, location.origin);

  function newNonce() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------- GIF buttons

  function addButton(box) {
    if (box.querySelector('.gcfy-btn')) return;
    if (!box.closest(BOX_SCOPE) || box.closest(POST_DIALOG)) return;
    const footer = box.querySelector('#footer');
    if (!footer) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gcfy-btn';
    btn.title = 'Add a GIF';
    btn.setAttribute('aria-label', 'Add a GIF');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (picker.open && picker.anchor === btn) closePicker();
      else openPicker(btn, box);
    });
    const emoji = footer.querySelector('#emoji-button');
    if (emoji && emoji.parentElement === footer) emoji.after(btn);
    else footer.prepend(btn);
  }

  let scanQueued = false;
  function scan() {
    scanQueued = false;
    if (retired) return;
    for (const box of document.querySelectorAll('ytd-commentbox')) addButton(box);
  }
  const scanner = new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  });
  scanner.observe(document.documentElement, { childList: true, subtree: true });
  // Buttons and a picker left by an older copy, then the comment boxes that
  // are already there when this file is injected late.
  for (const el of document.querySelectorAll('.gcfy-btn, [data-gcfy-picker]')) el.remove();
  scan();

  // ------------------------------------------------------------------ picker

  const picker = { open: false, host: null, anchor: null, box: null, els: null, seq: 0, timer: 0, gifs: [], nonce: null, favorites: [], showingFavorites: false, updateAsked: false, blockedAt: 0, dismissedBlockedAt: 0 };

  function buildPicker() {
    const host = document.createElement('div');
    host.setAttribute('data-gcfy-picker', '');
    // The picker is placed inside its comment box, so a click in it counts as
    // a click inside a reply dialog, which would otherwise close. A manual
    // popover still draws above the dialog, unclipped by its containers.
    host.setAttribute('popover', 'manual');
    // Let the picker's own controls handle pointer events, then keep them from
    // YouTube's handlers. This must not check picker.open: picking a GIF
    // removes the picker while that same click is still bubbling.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    const root = host.attachShadow({ mode: 'open' });
    // A <style> element rather than adoptedStyleSheets: Firefox does not let a
    // content script assign constructed stylesheets to a page's shadow root.
    const style = document.createElement('style');
    style.textContent = PICKER_CSS;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Choose a GIF');

    const search = document.createElement('div');
    search.className = 'search';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search Tenor or paste a Tenor link';
    input.setAttribute('aria-label', 'Search Tenor or paste a Tenor link');
    input.autocomplete = 'off';
    input.spellcheck = false;
    const favTab = document.createElement('button');
    favTab.type = 'button';
    favTab.className = 'fav-tab';
    favTab.textContent = '★';
    favTab.title = 'Favorites';
    favTab.setAttribute('aria-label', 'Favorites');
    favTab.setAttribute('aria-pressed', 'false');
    search.append(input, favTab);

    const update = document.createElement('div');
    update.className = 'update';
    update.hidden = true;
    const updateText = document.createElement('span');
    const updateLink = document.createElement('a');
    updateLink.target = '_blank';
    updateLink.rel = 'noopener noreferrer';
    updateLink.textContent = 'Download';
    const updateClose = document.createElement('button');
    updateClose.type = 'button';
    updateClose.textContent = '×';
    updateClose.title = 'Hide until the next version';
    updateClose.setAttribute('aria-label', 'Hide until the next version');
    update.append(updateText, updateLink, updateClose);

    // Shown while a recent server refusal is remembered; see showBlocked.
    const blocked = document.createElement('div');
    blocked.className = 'blocked';
    blocked.hidden = true;
    const blockedText = document.createElement('span');
    const blockedLink = document.createElement('a');
    blockedLink.href = BLOCKED_ISSUE;
    blockedLink.target = '_blank';
    blockedLink.rel = 'noopener noreferrer';
    blockedLink.textContent = '#93';
    blockedText.append('YouTube rejected your last GIF comment (HTTP 400). See ', blockedLink, ' for what is known so far. Nothing was posted.');
    const blockedClose = document.createElement('button');
    blockedClose.type = 'button';
    blockedClose.textContent = '×';
    blockedClose.title = 'Hide this notice';
    blockedClose.setAttribute('aria-label', 'Hide this notice');
    blocked.append(blockedText, blockedClose);

    const status = document.createElement('div');
    status.className = 'status';
    status.setAttribute('role', 'status');

    const grid = document.createElement('div');
    grid.className = 'grid';

    panel.append(search, update, blocked, status, grid);
    root.append(style, panel);

    input.addEventListener('input', () => {
      clearTimeout(picker.timer);
      picker.timer = setTimeout(() => load(input.value), SEARCH_DEBOUNCE_MS);
    });
    favTab.addEventListener('click', () => {
      if (picker.showingFavorites) { load(input.value); return; }
      // A search that is waiting or under way must not replace the favorites.
      clearTimeout(picker.timer);
      picker.seq++;
      setFavoritesView(true);
      renderFavorites(false);
    });
    grid.addEventListener('click', (e) => {
      const star = e.target.closest('.star');
      const tile = e.target.closest('.tile');
      if (star) toggleFavorite(picker.gifs[Number(star.dataset.index)]);
      else if (tile) attach(picker.gifs[Number(tile.dataset.index)]);
    });

    updateClose.addEventListener('click', () => {
      update.hidden = true;
      chrome.storage.local.set({ dismissedUpdate: update.dataset.version }).catch(() => {});
      input.focus();
    });

    blockedClose.addEventListener('click', () => {
      blocked.hidden = true;
      picker.dismissedBlockedAt = picker.blockedAt;
      chrome.storage.local.set({ dismissedGifBlockedAt: picker.blockedAt }).catch(() => {});
      input.focus();
    });

    picker.host = host;
    picker.els = { panel, input, status, grid, favTab, update, updateText, updateLink, blocked };
  }

  // A ZIP-installed extension does not update itself, so the picker says when
  // a newer release is out, until it is installed or its notice is closed.
  // Asked once per page; the worker asks GitHub at most once a day.
  async function showUpdate() {
    if (picker.updateAsked) return;
    picker.updateAsked = true;
    let release = null;
    try {
      const [reply, { dismissedUpdate }] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'update' }),
        chrome.storage.local.get('dismissedUpdate'),
      ]);
      release = reply && reply.ok && reply.release && reply.release.version !== dismissedUpdate ? reply.release : null;
    } catch (e) { /* no notice */ }
    if (!release) return;
    const { update, updateText, updateLink } = picker.els;
    update.dataset.version = release.version;
    updateText.textContent = `Desktop GIFs ${release.version} is out.`;
    updateLink.href = release.url;
    update.hidden = false;
  }

  // The remembered refusal is shown while it is recent and has not been
  // dismissed; a newer refusal brings the notice back.
  const recentlyBlocked = () => picker.blockedAt > 0 && Date.now() - picker.blockedAt < BLOCKED_MEMORY_MS;

  function showBlocked() {
    if (!picker.els) return;
    picker.els.blocked.hidden = !recentlyBlocked() || picker.blockedAt === picker.dismissedBlockedAt;
  }

  function setStatus(text, kind) {
    picker.els.status.textContent = text || '';
    if (kind) picker.els.status.dataset.kind = kind;
    else delete picker.els.status.dataset.kind;
  }

  function place() {
    if (!picker.open) return;
    if (!picker.anchor.isConnected) { closePicker(); return; }
    const r = picker.anchor.getBoundingClientRect();
    const h = Math.min(PICKER_H, innerHeight - 16);
    picker.els.panel.style.height = `${h}px`;
    let top = r.top - h - 8;
    if (top < 8) top = Math.min(r.bottom + 8, innerHeight - h - 8);
    const left = Math.min(Math.max(8, r.left), innerWidth - PICKER_W - 8);
    picker.host.style.top = `${Math.max(8, top)}px`;
    picker.host.style.left = `${Math.max(8, left)}px`;
  }

  function openPicker(anchor, box) {
    if (!picker.host) buildPicker();
    if (picker.open) closePicker();
    picker.open = true;
    picker.anchor = anchor;
    picker.box = box;
    anchor.setAttribute('aria-expanded', 'true');
    picker.els.panel.toggleAttribute('data-dark', document.documentElement.hasAttribute('dark'));
    box.append(picker.host);
    picker.host.showPopover();
    place();
    showBlocked();
    picker.els.input.focus();
    load(picker.els.input.value);
    showUpdate();
  }

  function closePicker() {
    if (!picker.open) return;
    picker.open = false;
    clearTimeout(picker.timer);
    picker.seq++;
    picker.anchor.setAttribute('aria-expanded', 'false');
    picker.host.remove();
    if (picker.anchor.isConnected) picker.anchor.focus();
  }

  const looksLikeLink = (text) => /^\d{6,20}$/.test(text) || /^(https?:\/\/)?([\w-]+\.)*tenor\.com\//i.test(text);

  async function load(raw) {
    const text = raw.trim();
    const seq = ++picker.seq;
    setFavoritesView(false);
    setStatus(text ? 'Searching…' : 'Loading…');
    let reply;
    try {
      reply = await chrome.runtime.sendMessage(
        !text ? { type: 'featured' } : looksLikeLink(text) ? { type: 'resolve', input: text } : { type: 'search', query: text },
      );
    } catch (e) {
      reply = { ok: false, error: 'The extension was reloaded. Refresh this page.' };
    }
    if (seq !== picker.seq || !picker.open) return;
    if (!reply || !reply.ok) {
      render([]);
      setStatus((reply && reply.error) || 'Tenor could not be reached.', 'error');
      return;
    }
    render(reply.gifs);
    setStatus(reply.gifs.length ? '' : 'No GIFs found.');
  }

  function render(gifs) {
    picker.gifs = gifs;
    // Two columns that grow downwards; each GIF goes into the shorter one.
    const cols = [0, 1].map(() => {
      const col = document.createElement('div');
      col.className = 'col';
      return { el: col, height: 0 };
    });
    gifs.forEach((gif, i) => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.dataset.index = String(i);
      tile.title = gif.title;
      const img = document.createElement('img');
      // Before src: changing these afterwards loads the GIF again.
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.src = gif.preview;
      img.alt = gif.title;
      img.width = gif.width;
      img.height = gif.height;
      tile.append(img);
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'star';
      star.dataset.index = String(i);
      setStar(star, gif);
      cell.append(tile, star);
      const col = cols[0].height <= cols[1].height ? cols[0] : cols[1];
      col.el.append(cell);
      col.height += gif.height / gif.width;
    });
    picker.els.grid.replaceChildren(...cols.map((c) => c.el));
    picker.els.grid.scrollTop = 0;
  }

  // --------------------------------------------------------------- favorites

  function setFavoritesView(on) {
    picker.showingFavorites = on;
    picker.els.favTab.setAttribute('aria-pressed', String(on));
  }

  function setStar(star, gif) {
    const on = picker.favorites.some((f) => f.id === gif.id);
    star.textContent = on ? '★' : '☆';
    star.title = on ? 'Remove from favorites' : 'Add to favorites';
    star.setAttribute('aria-label', star.title);
    star.setAttribute('aria-pressed', String(on));
  }

  function renderFavorites(keepScroll) {
    const top = keepScroll ? picker.els.grid.scrollTop : 0;
    render(picker.favorites);
    picker.els.grid.scrollTop = top;
    setStatus(picker.favorites.length ? '' : NO_FAVORITES);
  }

  // Takes the stored list, on load and whenever any tab changes it, so every
  // tab works on the same list and none writes back an old copy.
  function useFavorites(stored) {
    picker.favorites = (Array.isArray(stored) ? stored : []).filter((g) => g
      && typeof g.id === 'string' && /^\d{1,20}$/.test(g.id) && typeof g.title === 'string' && typeof g.preview === 'string'
      && g.width > 0 && g.height > 0);
    if (!picker.open) return;
    if (picker.showingFavorites) renderFavorites(true);
    else for (const star of picker.els.grid.querySelectorAll('.star')) setStar(star, picker.gifs[Number(star.dataset.index)]);
  }

  // The remembered refusal and the notice's dismissal, read on load and on
  // every change, so every tab shows the same notice.
  function useBlocked(stored) {
    picker.blockedAt = typeof stored === 'number' ? stored : 0;
    showBlocked();
  }

  function useDismissedBlocked(stored) {
    picker.dismissedBlockedAt = typeof stored === 'number' ? stored : 0;
    showBlocked();
  }

  chrome.storage.local.get('favorites').then((items) => useFavorites(items.favorites));
  chrome.storage.local.get('gifBlockedAt').then((items) => useBlocked(items.gifBlockedAt)).catch(() => {});
  chrome.storage.local.get('dismissedGifBlockedAt').then((items) => useDismissedBlocked(items.dismissedGifBlockedAt)).catch(() => {});
  const onStorage = (changes, area) => {
    if (area !== 'local') return;
    if (changes.favorites) useFavorites(changes.favorites.newValue);
    if (changes.gifBlockedAt) useBlocked(changes.gifBlockedAt.newValue);
    if (changes.dismissedGifBlockedAt) useDismissedBlocked(changes.dismissedGifBlockedAt.newValue);
  };
  chrome.storage.onChanged.addListener(onStorage);

  // Only writes the list; the change listener above then shows it, here and
  // in every other tab.
  async function toggleFavorite(gif) {
    const rest = picker.favorites.filter((f) => f.id !== gif.id);
    try {
      await chrome.storage.local.set({ favorites: rest.length < picker.favorites.length ? rest : [gif, ...rest] });
    } catch (e) {
      setStatus('The favorite could not be saved. Refresh this page.', 'error');
    }
  }

  // ----------------------------------------------------------------- posting

  function selectRange(editor, range) {
    editor.focus();
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Adds the marker after whatever the user has typed, leaving their text
  // (and any emoji or mentions in it) as it is.
  function appendMarker(editor, marker) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selectRange(editor, range);
    let done = false;
    try { done = document.execCommand('insertText', false, marker); } catch (e) { /* fall back below */ }
    if (!done || !editor.textContent.includes(marker)) {
      editor.append(document.createTextNode(marker));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: marker }));
    }
  }

  function removeMarker(editor, marker) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(marker);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + marker.length);
      selectRange(editor, range);
      let done = false;
      try { done = document.execCommand('delete', false); } catch (e) { /* fall back below */ }
      if (!done || editor.textContent.includes(marker)) {
        node.data = node.data.replace(marker, '');
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
      return;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ------------------------------------------------------------- attachments

  // Picking a GIF only attaches it to its comment box. The marker is added when
  // the user presses YouTube's Comment button, so they can keep editing their
  // text until then.
  const attachments = new Map(); // ytd-commentbox -> { gif, chip, status, observer, posting }
  let passThrough = false;

  // YouTube greys its Comment button out by swapping its style class for a
  // disabled one: [disabled, enabled], current and older class names.
  const BUTTON_STYLES = [
    ['ytSpecButtonShapeNextDisabled', 'ytSpecButtonShapeNextMono'],
    ['yt-spec-button-shape-next--disabled', 'yt-spec-button-shape-next--mono'],
  ];
  const submitOf = (box) => box.querySelector('#submit-button button');
  const editorOf = (box) => box.querySelector('#contenteditable-root');

  function attach(gif) {
    const box = picker.box;
    const editor = box && box.isConnected && box.querySelector('#footer') && editorOf(box);
    if (!editor) {
      setStatus('The comment box was closed. Open it and try again.', 'error');
      return;
    }
    const old = attachments.get(box);
    if (old && old.posting) return;
    attachTo(box, gif);

    closePicker();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selectRange(editor, range);
  }

  // kept: what an older copy's chip showed, when this copy takes it over.
  function attachTo(box, gif, kept) {
    const footer = box.querySelector('#footer');
    detach(box, false);

    const chip = document.createElement('div');
    chip.className = 'gcfy-attachment';
    const frame = document.createElement('div');
    frame.className = 'gcfy-attachment-gif';
    const img = document.createElement('img');
    // Before src: changing the referrer policy afterwards loads the GIF again.
    img.referrerPolicy = 'no-referrer';
    img.src = gif.preview;
    img.alt = gif.title;
    img.width = gif.width;
    img.height = gif.height;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'gcfy-attachment-remove';
    remove.textContent = '×';
    remove.title = 'Remove the GIF';
    remove.setAttribute('aria-label', 'Remove the GIF');
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!att.posting) detach(box, true);
    });
    frame.append(img, remove);
    const status = document.createElement('div');
    status.className = 'gcfy-attachment-status';
    status.setAttribute('role', 'status');
    chip.append(frame, status);
    footer.before(chip);

    // YouTube disables its Comment button while the text is empty; a comment
    // that is only a GIF must still be postable.
    const observer = new MutationObserver(() => enableSubmit(box));
    const att = { gif, chip, status, observer, posting: false, greyed: (kept && kept.greyed) || [] };
    attachments.set(box, att);
    saveChip(att);
    if (kept) setChipStatus(att, kept.status, kept.kind);
    const submit = submitOf(box);
    if (submit) observer.observe(submit, { attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'class'] });
    enableSubmit(box);
  }

  // What a newer copy needs to take the chip over.
  function saveChip(att) {
    att.chip.dataset.gcfyGif = JSON.stringify({ gif: att.gif, greyed: att.greyed });
  }

  const isGif = (g) => g && typeof g.id === 'string' && /^\d{1,20}$/.test(g.id) && typeof g.title === 'string'
    && typeof g.preview === 'string' && g.width > 0 && g.height > 0;
  const isStyle = (s) => Array.isArray(s) && s.length === 2 && BUTTON_STYLES.some((b) => b[0] === s[0] && b[1] === s[1]);

  // Takes over the GIFs an older copy attached, except one it is still
  // posting: that one is handed over (RELEASED) if the post fails.
  function adoptChips() {
    if (retired) return;
    for (const chip of document.querySelectorAll('.gcfy-attachment[data-gcfy-gif]:not([data-busy])')) {
      if ([...attachments.values()].some((att) => att.chip === chip)) continue;
      const box = chip.closest('ytd-commentbox');
      let saved = null;
      try { saved = JSON.parse(chip.dataset.gcfyGif); } catch (e) { /* dropped below */ }
      const status = chip.querySelector('.gcfy-attachment-status');
      chip.remove();
      if (!box || !box.querySelector('#footer') || !saved || !isGif(saved.gif) || attachments.has(box)) continue;
      attachTo(box, saved.gif, {
        greyed: Array.isArray(saved.greyed) ? saved.greyed.filter(isStyle) : [],
        status: status ? status.textContent : '',
        kind: status ? status.dataset.kind : undefined,
      });
    }
  }

  function enableSubmit(box) {
    const submit = submitOf(box);
    const att = attachments.get(box);
    // Only a GIF with no text needs this. Once there is text, YouTube's own
    // checks and its sending state decide whether the button is usable.
    if (!submit || !att || att.posting || editorOf(box)?.textContent.trim()) return;
    if (submit.disabled) submit.disabled = false;
    if (submit.hasAttribute('aria-disabled')) submit.removeAttribute('aria-disabled');
    for (const style of BUTTON_STYLES) {
      if (!submit.classList.contains(style[0])) continue;
      submit.classList.replace(style[0], style[1]);
      if (!att.greyed.includes(style)) { att.greyed.push(style); saveChip(att); }
    }
  }

  function detach(box, restoreSubmit) {
    const att = attachments.get(box);
    if (!att) return;
    attachments.delete(box);
    att.observer.disconnect();
    att.chip.remove();
    const submit = submitOf(box);
    const editor = editorOf(box);
    if (restoreSubmit && submit && editor && !editor.textContent.trim()) {
      submit.disabled = true;
      for (const [disabled, enabled] of att.greyed) submit.classList.replace(enabled, disabled);
    }
  }

  function setChipStatus(att, text, kind) {
    att.status.textContent = text || '';
    if (kind) att.status.dataset.kind = kind;
    else delete att.status.dataset.kind;
  }

  async function post(box) {
    const att = attachments.get(box);
    const editor = editorOf(box);
    const submit = submitOf(box);
    if (retired || !att || att.posting || !editor || !submit) return;

    const nonce = newNonce();
    const marker = `[[gif:${att.gif.id}:${nonce}]]`;
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    let armedAck;
    const armedPromise = new Promise((resolve) => { armedAck = resolve; });
    let seen = false;
    let cancelled = false;
    fromMain.set(nonce, (msg) => {
      if (msg.type === 'armed') armedAck(true);
      else if (msg.type === 'refused') armedAck('refused');
      else if (msg.type === 'seen') seen = true;
      else if (msg.type === 'result') settle(msg);
    });

    att.posting = true;
    att.submitted = false;
    att.cancel = () => {
      cancelled = true;
      toMain({ type: 'disarm', nonce });
      armedAck(false);
      const error = att.submitted
        ? 'The comment request may already have been sent. Check the comments before trying again.'
        : 'The GIF submission was cancelled. Nothing was posted.';
      setChipStatus(att, error, 'error');
      settle({ ok: false, error });
      if (editor.isConnected) removeMarker(editor, marker);
    };
    att.chip.toggleAttribute('data-busy', true);
    setChipStatus(att, 'Posting…');
    try {
      // A favorite or a result from Tenor's web pages may have no rating yet.
      // A GIF Tenor does not rate G is never sent. One whose rating cannot be
      // read still is, and YouTube decides.
      let rating = att.gif.contentRating;
      if (rating !== 'G') {
        setChipStatus(att, 'Checking the GIF…');
        const checked = await Promise.race([
          chrome.runtime.sendMessage({ type: 'check', id: att.gif.id }).catch(() => null),
          sleep(CHECK_TIMEOUT_MS).then(() => null),
          settled.then(() => null),
        ]);
        if (cancelled) return;
        const found = checked && checked.ok && Array.isArray(checked.gifs) && checked.gifs.find((g) => g.id === att.gif.id);
        rating = found ? found.contentRating : null;
        if (rating && rating !== 'G') {
          setChipStatus(att, `YouTube only takes GIFs that Tenor rates G. This one is rated ${rating}. Nothing was posted.`, 'error');
          return;
        }
        // A reply dialog can be closed while Tenor answers.
        if (!box.isConnected || !editor.getClientRects().length) {
          setChipStatus(att, 'The comment box was closed. Open it and try again.', 'error');
          return;
        }
        setChipStatus(att, 'Posting…');
      }
      toMain({ type: 'arm', id: att.gif.id, ratedG: rating === 'G', nonce });
      // Without the page hook the marker would be posted as plain text, so
      // nothing is typed into the box until the hook has answered.
      const armed = await Promise.race([armedPromise, sleep(ARM_TIMEOUT_MS).then(() => false)]);
      if (cancelled) return;
      if (armed !== true) {
        setChipStatus(att, armed === 'refused'
          ? 'Not ready in this tab yet. Try again in a few seconds, or refresh this page.'
          : 'The page hook is not running. Refresh this page and try again.', 'error');
        return;
      }
      if (!box.isConnected || !editor.getClientRects().length) {
        toMain({ type: 'disarm', nonce });
        setChipStatus(att, 'The comment box was closed. Open it and try again.', 'error');
        return;
      }

      appendMarker(editor, marker);
      for (let i = 0; i < 20 && submit.disabled && !cancelled; i++) await sleep(50);
      if (cancelled) return;
      if (!box.isConnected || !editor.getClientRects().length) { att.cancel(); return; }
      att.submitted = true;
      passThrough = true;
      try { submit.click(); } finally { passThrough = false; }

      let result = await Promise.race([settled, sleep(SUBMIT_GRACE_MS).then(() => null)]);
      if (!result && seen) result = await Promise.race([settled, sleep(RESULT_TIMEOUT_MS).then(() => null)]);

      // Only a verified G-rated GIF turned down by the server counts as the
      // known desktop failure; an unrated one may have been refused for its
      // rating. Shared with every tab through storage, and cleared by a GIF
      // that goes through.
      if (result && result.kind === 'blocked' && rating === 'G') {
        picker.blockedAt = Date.now();
        chrome.storage.local.set({ gifBlockedAt: picker.blockedAt }).catch(() => {});
      } else if (result && result.ok) {
        picker.blockedAt = 0;
        chrome.storage.local.remove('gifBlockedAt').catch(() => {});
      }
      if (result && result.ok) {
        detach(box, false);
        return;
      }
      // Failed or never sent: take the marker back out of the box.
      toMain({ type: 'disarm', nonce });
      if (editor.isConnected) removeMarker(editor, marker);
      setChipStatus(att, (result && result.error) || (seen
        ? 'YouTube did not confirm this GIF comment in time. Check the comments before trying again.'
        : 'The GIF submission was not confirmed. Check the comments before trying again.'), 'error');
    } finally {
      toMain({ type: 'disarm', nonce });
      if (editor.isConnected) removeMarker(editor, marker);
      fromMain.delete(nonce);
      att.posting = false;
      att.cancel = null;
      att.chip.toggleAttribute('data-busy', false);
      if (retired) {
        release(box);
        document.dispatchEvent(new CustomEvent(RELEASED));
      } else {
        enableSubmit(box);
      }
    }
  }

  const boxIn = (path) => path.find((n) => n.localName === 'ytd-commentbox');

  // Capture phase on window, ahead of YouTube's own handlers: pressing Comment
  // in a box with a GIF attached posts the GIF instead.
  window.addEventListener('click', (e) => {
    if (passThrough) return;
    const path = e.composedPath();
    const box = boxIn(path);
    if (!box || !attachments.has(box)) return;
    const submit = box.querySelector('#submit-button');
    const cancel = box.querySelector('#cancel-button');
    if (submit && path.includes(submit)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      post(box);
    } else if (cancel && path.includes(cancel)) {
      if (attachments.get(box).posting) attachments.get(box).cancel();
      detach(box, false);
    }
  }, { capture: true, signal });

  window.addEventListener('keydown', (e) => {
    // The picker sits inside the comment box; Ctrl+Enter in its search field
    // must not post the GIF already attached to that box.
    if (inPicker(e)) return;
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    const box = boxIn(e.composedPath());
    if (!box || !attachments.has(box)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    post(box);
  }, { capture: true, signal });

  // ------------------------------------------------------- page interactions

  const inPicker = (e) => picker.open && e.composedPath().includes(picker.host);

  // Registered at document_start in the capture phase, ahead of YouTube's own
  // handlers, so typing in the search field does not trigger player shortcuts
  // and scrolling the grid does not flip to the next Short.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(type, (e) => {
      if (!inPicker(e)) return;
      e.stopImmediatePropagation();
      if (type !== 'keydown') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closePicker();
      } else if (e.key === 'Enter' && e.composedPath()[0] === picker.els.input && picker.gifs.length === 1) {
        e.preventDefault();
        attach(picker.gifs[0]);
      }
    }, { capture: true, signal });
  }
  window.addEventListener('wheel', (e) => { if (inPicker(e)) e.stopImmediatePropagation(); }, { capture: true, passive: true, signal });

  window.addEventListener('pointerdown', (e) => {
    if (!picker.open) return;
    const path = e.composedPath();
    if (!path.includes(picker.host) && !path.includes(picker.anchor)) closePicker();
  }, { capture: true, signal });

  let placeQueued = false;
  const queuePlace = () => {
    if (!picker.open || placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => { placeQueued = false; place(); });
  };
  window.addEventListener('scroll', queuePlace, { capture: true, passive: true, signal });
  window.addEventListener('resize', queuePlace, { passive: true, signal });
  window.addEventListener('yt-navigate-start', () => {
    closePicker();
    for (const [box, att] of attachments) {
      if (!att.posting) detach(box, false);
      else if (!att.submitted) att.cancel();
    }
  }, { signal });

  // ---------------------------------------------------------------- handover

  // Lets go of a GIF without removing it, for the copy that comes next.
  function release(box) {
    const att = attachments.get(box);
    if (!att) return;
    attachments.delete(box);
    att.observer.disconnect();
  }

  function retire() {
    retired = true;
    life.abort();
    scanner.disconnect();
    try { chrome.storage.onChanged.removeListener(onStorage); } catch (e) { /* this copy's extension is gone */ }
    closePicker();
    for (const [box, att] of attachments) {
      if (!att.posting) release(box);
      else if (!att.submitted) att.cancel();
    }
  }

  document.addEventListener(TAKEOVER, retire, { signal });
  document.addEventListener(RELEASED, adoptChips, { signal });
  adoptChips();
})();
