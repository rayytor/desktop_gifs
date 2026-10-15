# Issue #93: server evidence and submission safeguards

Investigated on 14–15 October 2026. This branch does **not restore GIF posting**.
The latest official base checked was `721f84313801102c3b8596590b6a7ce48952fbbf`
(v0.1.8). No user account was accessed and no real comment was published.

## What the evidence establishes

The maintainer reports that desktop create requests with `tenorId` receive
HTTP 400 `INVALID_ARGUMENT`, while otherwise comparable text requests work.
Reports cover comments/replies, GIF-only drafts and text with GIFs. Later
comments report both VPN failures and apparent successes; none examined here
establishes a new, persistent, animated comment visible to another visitor.
The image attachment experiment reached a composer preview but stalled on
submission; a working upload endpoint was still unknown.

Sources: [issue #93](https://github.com/rayytor/desktop_gifs/issues/93),
[maintainer update](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6174882048),
[image experiment](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6175491242),
[upload still unknown](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6175827944),
[later conflicting VPN claim](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6176164788).

These are public reproduction reports, not an independent authenticated
capture. The precise server rule and order of validation remain unknown.
An `INVALID_ARGUMENT` response alone cannot distinguish client capability,
account eligibility, rollout, attachment validation or another restriction.

## Later public reports (15 October 2026)

- A real mobile-web test: the hook on `m.youtube.com`, client MWEB, sends
  `create_comment` and is refused in the same way, HTTP 400 `INVALID_ARGUMENT`
  ([comment](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6179017241)).
- A request-shape matrix: desktop, mobile web and YouTube Studio all refuse
  `tenorId` with HTTP 400; a community-post label sent from youtube.com is
  accepted but apparently ignored; an uploaded image is accepted and then
  dropped; an edit carrying `tenorId` is accepted and the GIF is dropped
  ([comment](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6197055309)).
- An inspection of the desktop site's own bundle, web client
  `2.20261014.01.00`: it contains no `tenor`/`tenorId` code for creating
  comments, only strings for viewing GIFs; image attachments have their own
  view model and appear to be gated per account
  ([comment](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6190716702)).
- A proposal to pass off the request as mobile web by rewording
  `context.client.clientName` ([comment](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6198318144));
  the real MWEB test above already saw that client refused the same way, and
  client-attestation spoofing has been reported as unworkable for the app
  clients ([comment](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6187019637)).
- Reports of a full GIF shutdown across mobile and desktop
  ([comment](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6182510037)),
  and one unverified sighting of a recent GIF comment
  ([comment](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6201544486)).
  No accepted submission from this extension was independently captured.

None of these reports supplies a verified client-side fix. The `Unsafe attempt
to load URL https://media.tenor.com/...` entries that Chromium lists for the
extension mark inserting preview images, are local to the browser, and are not
part of the comment request; a paste combining them with the `kind: "blocked"`
diagnostics ([comment](https://github.com/rayytor/desktop_gifs/issues/93#issuecomment-6202507487))
matches the original report's combination, not a second failure.

## Request behavior verified in source and fixtures

The page supplies a POST to `youtubei/v1/comment/create_comment` or
`create_comment_reply`. Its body includes comment text, page-generated creation
parameters and client context; page authentication and attestation are retained.
The extension adds a one-time marker to the editor, removes it from
`commentText`, adds a string `tenorId`, and omits `commentText` for GIF-only
submissions. Gzipped JSON is decoded and sent as JSON without content-encoding.
`fetch(Request, init)` body/header/credential/signal overrides are retained.
Text-only native requests use the original fetch arguments.

This describes the actual extension algorithm and synthetic payloads. It is
not a complete current native web/mobile request capture. Mobile success on
the same account/video is reported in [PR #41](https://github.com/rayytor/desktop_gifs/pull/41),
but no comparable official mobile capture was available. Previously accepted
`tenorId` submissions are historical behavior reported by the project.

## Attachment alternatives

The official [comment resource](https://developers.google.com/youtube/v3/docs/comments)
recognizes `snippet.imageUrl` for images/animated GIFs with an expiring signed
URL. The [Discovery schema](https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest),
revision `20261013`, marks it output-only (`readOnly: true`). Neither
[commentThreads.insert](https://developers.google.com/youtube/v3/docs/commentThreads/insert)
nor [comments.insert](https://developers.google.com/youtube/v3/docs/comments/insert)
offers media upload. The [revision history](https://developers.google.com/youtube/v3/revision_history)
announces general availability of that property in November 2026; this does
not promise a desktop upload flow.

[YouTube.js](https://github.com/LuanRT/YouTube.js/blob/main/src/parser/classes/endpoints/CreateCommentEndpoint.ts)
can map an existing image blob ID to `imageAttachment.encryptedBlobId`.
That independent client's representation supplies neither a supported upload
procedure nor proof of eligibility. Upload initiation, valid identifier
acquisition, accepted formats, animation preservation, persistence and ordinary
account access remain unverified. No endpoint/identifier was invented, and no
client identity or integrity attestation was changed.

## Independent defects addressed

- Repeated deterministic rejections: one native request per submission.
- A 400 refusal of a verified G-rated GIF is remembered for a day, or until a
  GIF goes through, and the picker links to this issue; an unrated GIF's
  refusal is not treated as the known desktop failure. No automatic retry.
- Network loss/cancellation after dispatch: publication remains uncertain.
- Contradictory success/error responses: never confirm success.
- Diagnostics: omit server text and arbitrary status strings that could echo
  private input; retain known enum statuses and local metadata only.
- Cancel/update/navigation during rating or arming: retire pending work before
  a marker can be submitted; let already dispatched work finish once.
- Timeout after submission: warn of missing confirmation and remove the marker.
- Gzip casing and malformed marker/response handling: covered by regressions.

These defects do not explain or reverse the service's rejection of `tenorId`.
Search, favorites and the picker remain in the existing implementation.

## Verification and limits

Run `node --test tests/main.test.cjs tests/sw.test.cjs` and
`python tests/picker.browser.py --browser chromium`. All API responses, page
fixtures and browser publication acknowledgements in these suites are
simulated. The server-refusal workflows are covered: the verdict kind, keeping
only a verified G-rated refusal, the picker notice and its dismissal, a stale
stamp after a day, and clearing when a GIF goes through. Chromium MV3 loading
can be checked with a separate disposable profile; it proves script
installation, not YouTube posting.

ReadableStream bodies in `init.body` and unknown request compression/schema
changes remain compatibility risks in the interception algorithm; the observed
native JSON/gzip path is tested. There is no absolute guarantee for future
YouTube endpoints or opaque body formats. This branch does not supply
idempotency across fresh manual submissions or prove persistence after an API
acknowledgement. Do not resubmit an uncertain request until its outcome is checked.

No real acceptance, refresh persistence, anonymous visibility, animation or
live text-comment regression was verified. A restoration PR requires all of
those checks on an explicitly authorized comment. This branch is suitable only
for review as submission hardening and investigation, not as a GIF restoration.
