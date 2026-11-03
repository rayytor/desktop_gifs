// Runs in the page's own JavaScript world. Wraps window.fetch so that a comment
// request whose text is an armed marker is rewritten into a GIF comment.
//
// The content script never sends anything itself: it appends a marker such as
// [[gif:<tenorId>:<nonce>]] to the text in YouTube's comment box and lets the
// page submit it. That way the page supplies the auth headers, context and
// attestation. The hook strips the marker and adds the GIF in its place.
(() => {
  // sw.js also injects this file into YouTube tabs that are already open when
  // the extension is installed, updated or reloaded. The page keeps one fetch
  // wrapper for good, since YouTube may hold on to it; the wrapper hands every
  // call to the newest copy of this file, and each copy retires the one before.
  const HOOK = Symbol.for('gcfy.hook');
  // 0.1.5 and older marked the page with true and cannot hand over. They take
  // the same messages, so that copy keeps working until the tab is refreshed.
  if (window[HOOK] === true) return;
  let hook = window[HOOK];
  if (!hook) {
    // At document_start the wrapper is in place before any of YouTube's code.
    // Injected into a page that has already loaded, it only works if YouTube
    // looks window.fetch up at call time, so it does not count as live until
    // one of YouTube's own API requests has come through it. Until then arming
    // is refused, and the content script never types a marker into the box.
    hook = { current: null, live: document.readyState === 'loading', originalFetch: window.fetch };
    Object.defineProperty(window, HOOK, { value: hook });
    window.fetch = function (input, init) {
      return hook.current.fetch(this, arguments);
    };
  }
  if (hook.current) hook.current.retire();

  // Every endpoint a ytd-commentbox can submit to (comments, replies, edits,
  // channel posts). Only the two create endpoints are ever rewritten; a marker
  // heading anywhere else is blocked so it cannot be published as text.
  const API_URL = /\/youtubei\/v1\//;
  const WATCHED_URL = /\/youtubei\/v1\/(comment|backstage)\//;
  const CREATE_URL = /\/youtubei\/v1\/comment\/create_comment(_reply)?(\?|$)/;
  const MARKER = /\[\[gif:(\d{1,20}):([a-z0-9]{8,32})\]\]/;
  const ARM_TTL_MS = 3 * 60 * 1000;
  // nonce -> { id, ratedG, expires }
  const armed = new Map();

  const toContent = (msg) => window.postMessage({ gcfy: 'to-content', ...msg }, location.origin);

  function onMessage(e) {
    if (e.source !== window || e.origin !== location.origin) return;
    const msg = e.data;
    if (!msg || msg.gcfy !== 'to-main') return;
    if (msg.type === 'arm' && /^\d{1,20}$/.test(msg.id) && /^[a-z0-9]{8,32}$/.test(msg.nonce)) {
      if (!hook.live) { toContent({ type: 'refused', nonce: msg.nonce }); return; }
      armed.set(msg.nonce, { id: msg.id, ratedG: msg.ratedG === true, expires: Date.now() + ARM_TTL_MS });
      toContent({ type: 'armed', nonce: msg.nonce });
    } else if (msg.type === 'disarm') {
      armed.delete(msg.nonce);
    }
  }
  window.addEventListener('message', onMessage);

  async function readBody(input, init) {
    const isRequest = input instanceof Request;
    // fetch(Request, init) sends init's body and headers when it has them.
    const headers = new Headers((init && init.headers) || (isRequest ? input.headers : {}));
    let buf;
    if (init && init.body != null) buf = await new Response(init.body).arrayBuffer();
    else if (isRequest) buf = await input.clone().arrayBuffer();
    else return null;
    // YouTube gzips request bodies between 500 bytes and 500 kB.
    const text = headers.get('content-encoding') === 'gzip'
      ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      : new TextDecoder().decode(buf);
    return { headers, text };
  }

  const { originalFetch } = hook;

  // A request this copy is already handling finishes here; only new ones go
  // to the copy that replaces it.
  hook.current = {
    fetch(self, args) {
      const [input, init] = args;
      let url = '';
      try {
        url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      } catch (e) { /* fall through to the original fetch */ }
      if (!hook.live && API_URL.test(url)) hook.live = true;
      if (!WATCHED_URL.test(url)) return originalFetch.apply(self, args);
      return handleWatched.call(self, url, input, init, args);
    },
    retire() {
      window.removeEventListener('message', onMessage);
      armed.clear();
    },
  };

  async function handleWatched(url, input, init, originalArgs) {
    let parsed = null;
    try {
      parsed = await readBody(input, init);
    } catch (e) { /* a body we cannot read: leave the request alone */ }

    const match = parsed && parsed.text.match(MARKER);
    if (!match) return originalFetch.apply(this, originalArgs);

    // From here on a marker is present, so the original request must never be
    // sent: it would publish the marker as visible text.
    const [whole, id, nonce] = match;
    const entry = armed.get(nonce);
    armed.delete(nonce);

    let body = null;
    try { body = JSON.parse(parsed.text); } catch (e) { /* handled below */ }
    // The marker sits at the very end of the comment; anything before it is
    // the user's own text and is posted alongside the GIF.
    const full = body && typeof body.commentText === 'string' ? body.commentText.trim() : '';
    const ownText = full.endsWith(whole) ? full.slice(0, -whole.length).trim() : null;
    const valid = body && CREATE_URL.test(url)
      && ownText !== null && !MARKER.test(ownText)
      && entry && entry.id === id && entry.expires >= Date.now();
    if (!valid) {
      toContent({ type: 'result', nonce, ok: false, error: 'This box cannot take a GIF, or the request expired. Nothing was posted.' });
      throw new TypeError('GIF comment marker blocked');
    }

    toContent({ type: 'seen', nonce });
    if (ownText) body.commentText = ownText;
    else delete body.commentText;
    body.tenorId = id;
    const headers = parsed.headers;
    headers.delete('content-encoding');
    const payload = JSON.stringify(body);
    // INVALID_ARGUMENT is a validation refusal, not a signal to retry the
    // unchanged payload. Since 14 October 2026 repeated desktop GIF requests
    // have also been reported as refused (#93). Send once per submission;
    // the content script retains the draft and GIF when YouTube rejects it.
    let response;
    try {
      response = await (input instanceof Request
        ? originalFetch.call(this, new Request(input, { ...init, body: payload, headers }))
        : originalFetch.call(this, input, { ...init, body: payload, headers }));
    } catch (e) {
      toContent({ type: 'result', nonce, ok: false, error: 'The request could not be sent. Nothing was posted.' });
      throw e;
    }
    const verdict = await judge(response);

    const detail = `HTTP ${verdict.httpStatus}${verdict.apiStatus ? `, ${verdict.apiStatus}` : ''}`;
    const said = !verdict.message ? '' : /[.!?]$/.test(verdict.message) ? ` ${verdict.message}` : ` ${verdict.message}.`;
    const error = verdict.kind === 'posted' ? null
      : verdict.kind === 'gif' ? (verdict.message
        ? `YouTube turned this GIF comment down:${said} Nothing was posted.`
        : 'YouTube does not accept this GIF. Try a different one. Nothing was posted.')
      : verdict.kind === 'blocked' ? (entry.ratedG
        ? 'YouTube rejected this GIF comment (HTTP 400, INVALID_ARGUMENT). GIF comments sent from desktop may be unavailable; see issue #93. The request was sent once. The YouTube phone app may still post GIFs. Nothing was posted.'
        : 'YouTube turned this GIF comment down. Either Tenor does not rate the GIF G, or YouTube is refusing GIF comments sent from desktop. Nothing was posted.')
      : verdict.kind === 'rejected' ? `YouTube rejected this GIF comment (${detail}).${said} Nothing was posted.`
      : `YouTube did not confirm this GIF comment (${detail}).${said} Check the comments before trying again.`;
    if (verdict.kind !== 'posted') {
      // Enough to tell the cases apart in a bug report, and nothing more: no
      // comment text, headers, credentials, attestation or response body.
      // A string, because Chromium's extension error list shows an object as
      // "[object Object]".
      console.warn('Desktop GIFs: comment not confirmed', JSON.stringify({
        endpoint: /create_comment_reply(\?|$)/.test(url) ? 'create_comment_reply' : 'create_comment',
        tenorId: id,
        ratedG: entry.ratedG,
        hasText: !!ownText,
        kind: verdict.kind,
        tries: 1,
        httpStatus: verdict.httpStatus,
        apiStatus: verdict.apiStatus,
        actionStatus: verdict.actionStatus,
        message: verdict.message,
      }));
    }
    toContent({ type: 'result', nonce, ok: verdict.kind === 'posted', error });
    return response;
  }

  function textOf(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    if (typeof value.simpleText === 'string') return value.simpleText;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.runs)) return value.runs.map((r) => (typeof r.text === 'string' ? r.text : '')).join('');
    return '';
  }

  // Every showErrorAction among a response's actions, including those nested
  // in a commandExecutorCommand, as its message text ('' when it has none).
  function errorActions(actions) {
    if (!Array.isArray(actions)) return [];
    return actions.flatMap((action) => {
      if (!action || typeof action !== 'object') return [];
      const own = action.showErrorAction ? [(() => {
        const error = action.showErrorAction.errorMessage;
        return textOf(error && error.messageRenderer && error.messageRenderer.text) || textOf(error);
      })()] : [];
      return [...own, ...errorActions(action.commandExecutorCommand && action.commandExecutorCommand.commands)];
    });
  }

  // Reads YouTube's answer as one kind:
  //   posted     the comment is up
  //   gif        HTTP 200 with a showErrorAction where the actionResult would
  //              be: YouTube looked the GIF up and will not take it (unknown
  //              ID, or not rated G)
  //   blocked    HTTP 400 INVALID_ARGUMENT: validation refused the modified
  //              request. The generic status does not identify the field or
  //              establish whether YouTube looked up the GIF.
  //   rejected   another refusal; nothing was posted
  //   uncertain  no readable confirmation either way; the comment may be up
  // with YouTube's own explanation, if it gave one.
  async function judge(response) {
    let json = null;
    try { json = await response.clone().json(); } catch (e) { /* unreadable: confirms nothing */ }
    const action = json && json.actionResult;
    const errors = json ? [
      ...errorActions(json.actions),
      ...errorActions(json.onResponseReceivedActions),
      ...errorActions(json.onResponseReceivedEndpoints),
    ] : [];
    const apiStatus = json && json.error && typeof json.error.status === 'string' ? json.error.status : null;
    const message = [...new Set([textOf(json && json.error && json.error.message), ...errors, textOf(action && action.feedbackText)]
      .filter(Boolean))].join(' ');
    const verdict = {
      httpStatus: response.status,
      apiStatus,
      actionStatus: action && typeof action.status === 'string' ? action.status : null,
      message,
    };
    const kind = response.ok && action && action.status === 'STATUS_SUCCEEDED' && !errors.length ? 'posted'
      : response.status === 400 && apiStatus === 'INVALID_ARGUMENT' ? 'blocked'
      : response.ok && !action && errors.length ? 'gif'
      : (response.status >= 400 && response.status < 500) || errors.length || verdict.actionStatus === 'STATUS_FAILED' ? 'rejected'
      : 'uncertain';
    return { kind, ...verdict };
  }
})();
