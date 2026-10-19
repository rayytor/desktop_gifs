const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(process.env.GIF_HOOK_SOURCE || path.join(__dirname, '../extension/src/main.js'), 'utf8');
const origin = 'https://www.youtube.com';
const create = `${origin}/youtubei/v1/comment/create_comment?prettyPrint=false`;
const id = '13723327785995541767';
const nonce = 'regression123456';
const marker = `[[gif:${id}:${nonce}]]`;
const invalid = { error: { status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } };
const success = { actionResult: { status: 'STATUS_SUCCEEDED' } };

function hook(reply = { actionResult: { status: 'STATUS_SUCCEEDED' } }, status = 200, retryReply, retryStatus = 200, preload = false) {
  const messages = [];
  const requests = [];
  const warnings = [];
  let onMessage;
  const listeners = new Set();
  const response = new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status });
  const responses = [response];
  if (retryReply !== undefined) responses.push(new Response(typeof retryReply === 'string' ? retryReply : JSON.stringify(retryReply), { status: retryStatus }));
  const window = {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return responses[Math.min(requests.length - 1, responses.length - 1)];
    },
    addEventListener: (type, listener) => { if (type === 'message') { onMessage = listener; listeners.add(listener); } },
    removeEventListener: (type, listener) => { if (type === 'message') listeners.delete(listener); },
    postMessage: (message) => messages.push(message),
  };
  const document = { readyState: 'loading' };
  // Runs one more copy of main.js in the same page, as sw.js does after an
  // update or a reload.
  const load = () => vm.runInNewContext(source, {
    window, location: { origin }, document,
    Request, Response, Headers, Blob, DecompressionStream, TextDecoder,
    console: { warn: (...args) => warnings.push(args) },
    // Retry delays elapse at once, so the tests do not wait for them.
    setTimeout: (callback) => setTimeout(callback, 0),
  });
  if (!preload) load();
  return {
    window, response, responses, requests, messages, warnings, listeners, document, load,
    arm: (rated = false) => onMessage({ source: window, origin, data: { gcfy: 'to-main', type: 'arm', id, nonce, ratedG: rated } }),
    result: () => messages.findLast((message) => message.type === 'result'),
    send: (text = `hello ${marker}`, url = create) => window.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB' } }, createCommentParams: 'original-params', commentText: text, botguardResponse: 'page-attestation' }),
    }),
  };
}

test('a confirmed post strips the marker, retains text and page attestation, and returns the original response', async () => {
  const h = hook();
  h.arm();
  assert.equal(await h.send(), h.response);
  const body = await h.requests[0].json();
  assert.equal(body.commentText, 'hello');
  assert.equal(body.tenorId, id);
  assert.equal(body.createCommentParams, 'original-params');
  assert.equal(body.botguardResponse, 'page-attestation');
  assert.equal(body.context.client.clientName, 'WEB');
  assert.equal(h.result().ok, true);
  assert.equal(h.warnings.length, 0);
  assert.equal((await h.response.json()).actionResult.status, 'STATUS_SUCCEEDED');
});

test('GIF-only replies use the reply endpoint with no marker text', async () => {
  const h = hook();
  h.arm();
  await h.send(marker, `${origin}/youtubei/v1/comment/create_comment_reply`);
  const body = await h.requests[0].json();
  assert.equal(body.tenorId, id);
  assert.equal('commentText' in body, false);
  assert.equal(h.result().ok, true);
});

test('HTTP 200 showErrorAction keeps the actual YouTube explanation', async () => {
  const h = hook({ actions: [{ showErrorAction: { errorMessage: { messageRenderer: { text: { runs: [{ text: 'GIF comments are ' }, { text: 'not available for this account.' }] } } } } }] });
  h.arm();
  await h.send();
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /GIF comments are not available for this account\./);
  assert.doesNotMatch(h.result().error, /different one|rates G/);
});

test('HTTP 200 showErrorAction without text says the GIF itself was not taken, without a retry', async () => {
  const h = hook({ actions: [{ showErrorAction: {} }] });
  h.arm(true);
  await h.send();
  assert.equal(h.requests.length, 1);
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /does not accept this GIF\. Try a different one/);
});

test('INVALID_ARGUMENT for a GIF of unknown rating names both causes and is not retried', async () => {
  const h = hook(invalid, 400, success);
  h.arm(false);
  await h.send();
  assert.equal(h.requests.length, 1);
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /Either Tenor does not rate the GIF G, or YouTube is refusing GIF comments sent from desktop/);
});

test('INVALID_ARGUMENT for a G-rated GIF is retried, then blamed on YouTube, not the GIF', async () => {
  const h = hook(invalid, 400);
  h.arm(true);
  const returned = await h.send();
  assert.equal(h.requests.length, 12);
  assert.equal(returned.status, 400);
  for (const request of h.requests) assert.equal((await request.json()).tenorId, id);
  assert.deepEqual(h.messages.filter((m) => m.type === 'retrying').map((m) => [m.attempt, m.tries]), Array.from({ length: 11 }, (_, i) => [i + 2, 12]));
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /refusing GIF comments sent from desktop \(tried 12 times\)\. The GIF is not the cause/);
  assert.doesNotMatch(h.result().error, /different one/);
  assert.equal(JSON.parse(h.warnings[0][1]).tries, 12);
});

test('a G-rated GIF blocked once and then accepted is posted on the second try', async () => {
  const h = hook(invalid, 400, success);
  h.arm(true);
  const returned = await h.send();
  assert.equal(h.requests.length, 2);
  assert.equal(returned, h.responses[1]);
  assert.equal(h.result().ok, true);
  assert.equal(h.warnings.length, 0);
});

test('nested response commands expose their error text', async () => {
  const h = hook({ onResponseReceivedEndpoints: [{ commandExecutorCommand: { commands: [{ showErrorAction: { errorMessage: { messageRenderer: { text: { simpleText: 'Please sign in again.' } } } } }] } }] });
  h.arm();
  await h.send();
  assert.match(h.result().error, /Please sign in again\./);
});

test('explicit failure keeps action feedback', async () => {
  const h = hook({ actionResult: { status: 'STATUS_FAILED', feedbackText: { runs: [{ text: 'Comments are disabled.' }] } } });
  h.arm();
  await h.send();
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /Comments are disabled\./);
});

for (const [name, reply] of [['HTML', '<html>Service unavailable</html>'], ['empty JSON', {}], ['null JSON', null]]) {
  test(`HTTP 200 with ${name} does not confirm a post or invite a blind retry`, async () => {
    const h = hook(reply);
    h.arm();
    await h.send();
    assert.equal(h.result().ok, false);
    assert.match(h.result().error, /Check the comments before trying again/);
    assert.doesNotMatch(h.result().error, /Nothing was posted/);
  });
}

test('a success beside an error neither confirms nor denies a post', async () => {
  const h = hook({ actionResult: { status: 'STATUS_SUCCEEDED' }, actions: [{ showErrorAction: { errorMessage: { simpleText: 'Posting was rejected.' } } }] });
  h.arm(true);
  await h.send();
  // A contradictory answer is not worth another try, and could mean the
  // comment is up: it must not be called a failure either.
  assert.equal(h.requests.length, 1);
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /Posting was rejected/);
  assert.match(h.result().error, /Check the comments before trying again/);
  assert.doesNotMatch(h.result().error, /Nothing was posted/);
  assert.equal(JSON.parse(h.warnings[0][1]).kind, 'uncertain');
});

test('a top-level API error beside a success status does not confirm a post', async () => {
  const h = hook({ actionResult: { status: 'STATUS_SUCCEEDED' }, error: { status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } });
  h.arm(true);
  await h.send();
  assert.equal(h.requests.length, 1);
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /INVALID_ARGUMENT/);
  assert.match(h.result().error, /Check the comments before trying again/);
  assert.doesNotMatch(h.result().error, /Nothing was posted/);
  assert.equal(JSON.parse(h.warnings[0][1]).kind, 'uncertain');
});

test('a 200 that carries only an API error confirms nothing and is not retried', async () => {
  const h = hook({ error: { status: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
  h.arm(true);
  await h.send();
  assert.equal(h.requests.length, 1);
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /HTTP 200, INTERNAL_ERROR/);
  assert.match(h.result().error, /Check the comments before trying again/);
  assert.equal(JSON.parse(h.warnings[0][1]).kind, 'uncertain');
});

test('an unreadable server failure leaves the posting outcome uncertain', async () => {
  const h = hook('Service unavailable', 503);
  h.arm();
  await h.send();
  assert.equal(h.result().ok, false);
  assert.match(h.result().error, /HTTP 503/);
  assert.match(h.result().error, /Check the comments before trying again/);
  assert.doesNotMatch(h.result().error, /Nothing was posted/);
});

test('diagnostics omit the comment, request headers, attestation and response data', async () => {
  const h = hook({ error: { status: 'PERMISSION_DENIED', message: 'Access denied.' }, privateAccountData: 'private-response-data' }, 403);
  h.arm();
  await h.send(`private-comment-text ${marker}`);
  assert.equal(h.warnings.length, 1);
  assert.equal(typeof h.warnings[0][1], 'string');
  const detail = JSON.parse(h.warnings[0][1]);
  assert.equal(detail.tenorId, id);
  assert.equal(detail.hasText, true);
  assert.equal(detail.endpoint, 'create_comment');
  const diagnostics = JSON.stringify(h.warnings);
  assert.match(diagnostics, /PERMISSION_DENIED/);
  assert.doesNotMatch(diagnostics, /private-comment-text|page-attestation|private-response-data|original-params/);
});

test('Request init overrides are read and preserved during rewriting', async () => {
  const h = hook();
  h.arm();
  const original = new Request(create, {
    method: 'POST', headers: { 'X-Test': 'original' }, body: JSON.stringify({ commentText: 'old body' }),
  });
  const controller = new AbortController();
  await h.window.fetch(original, {
    headers: { 'Content-Type': 'application/json', 'X-Test': 'override' },
    body: JSON.stringify({ commentText: `new body ${marker}` }),
    credentials: 'include', signal: controller.signal,
  });
  assert.equal(h.requests[0].headers.get('X-Test'), 'override');
  assert.equal(h.requests[0].credentials, 'include');
  const body = await h.requests[0].json();
  assert.equal(body.commentText, 'new body');
  assert.equal(body.tenorId, id);
  controller.abort();
  assert.equal(h.requests[0].signal.aborted, true);
});

test('gzip requests are decoded and rewritten as uncompressed JSON', async () => {
  const h = hook();
  h.arm();
  const body = await new Response(new Blob([JSON.stringify({ commentText: `hello ${marker}` })]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  await h.window.fetch(create, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body });
  assert.equal(h.requests[0].headers.has('Content-Encoding'), false);
  assert.equal((await h.requests[0].json()).tenorId, id);
  assert.equal(h.result().ok, true);
});

test('ordinary comments pass through without modification', async () => {
  const h = hook();
  await h.send('ordinary comment');
  assert.equal((await h.requests[0].json()).commentText, 'ordinary comment');
  assert.equal(h.messages.length, 0);
});

test('unarmed, reused and unsupported markers never reach YouTube', async () => {
  const unarmed = hook();
  await assert.rejects(unarmed.send(), /marker blocked/);
  assert.equal(unarmed.requests.length, 0);

  const reused = hook();
  reused.arm();
  await reused.send();
  await assert.rejects(reused.send(), /marker blocked/);
  assert.equal(reused.requests.length, 1);

  const edit = hook();
  edit.arm();
  await assert.rejects(edit.send(marker, `${origin}/youtubei/v1/comment/update_comment`), /marker blocked/);
  assert.equal(edit.requests.length, 0);
});


// A blocked G-rated GIF is the one case that is tried again; see above.
for (const [label, reply, status] of [
  ['success', success, 200],
  ['an unreadable response', '<html>temporary error</html>', 200],
  ['a missing confirmation', {}, 200],
  ['a server error carrying INVALID_ARGUMENT', invalid, 500],
  ['an account denial', { error: { status: 'PERMISSION_DENIED', message: 'Denied' } }, 403],
]) {
  test(`one user submission sends one request after ${label}, including verified G-rated GIFs`, async () => {
    const h = hook(reply, status, success);
    h.arm(true);
    assert.equal(await h.send(), h.response);
    assert.equal(h.requests.length, 1);
    const body = await h.requests[0].json();
    assert.equal(body.context.client.clientName, 'WEB');
    assert.equal(body.commentText, 'hello');
    assert.equal(body.tenorId, id);
    assert.equal(h.requests[0].headers.has('X-YouTube-Client-Name'), false);
  });
}

test('a copy injected after an update takes over the fetch wrapper the page already has', async () => {
  const h = hook();
  const wrapper = h.window.fetch;
  h.document.readyState = 'complete';
  h.load();
  // YouTube may hold on to the first wrapper, so it stays and is not wrapped again.
  assert.equal(h.window.fetch, wrapper);
  assert.equal(h.listeners.size, 1);
  // The page was live before the update, so the new copy is too.
  h.arm();
  assert.equal(h.messages.at(-1).type, 'armed');
  await h.send();
  assert.equal(h.requests.length, 1);
  assert.equal((await h.requests[0].json()).tenorId, id);
  assert.equal(h.messages.filter((m) => m.type === 'result').length, 1);
  assert.equal(h.result().ok, true);
});

test('a GIF armed with a copy that was replaced is not posted', async () => {
  const h = hook();
  h.arm();
  h.load();
  await assert.rejects(h.send(), /marker blocked/);
  assert.equal(h.requests.length, 0);
});

test('a hook left by 0.1.5 or older stays in charge', () => {
  const h = hook(undefined, 200, undefined, 200, true);
  h.window[Symbol.for('gcfy.hook')] = true;
  const fetch = h.window.fetch;
  h.load();
  assert.equal(h.window.fetch, fetch);
  assert.equal(h.listeners.size, 0);
});
