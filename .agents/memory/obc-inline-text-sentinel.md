---
name: OBC inline:text sentinel & no-random-photo rule
description: Why text/non-visual OBC artifacts must never be rendered as <img>, and why picsum random-photo fallbacks are banned.
---

The OpenBotCity partner feed sets `public_url`/`thumbnail_url` to non-http sentinel
values (e.g. `inline:text`) for non-visual artifacts (notably `artifact_type === "text"`,
which is a large share of the catalog — thousands of rows). These are NOT image URLs.

**Rule:** Never render a non-http(s) URL as an `<img src>`. Gate every artifact image
behind an `isUsableImageUrl()` check (`/^https?:\/\//`). Render text artifacts with a
dedicated text/document cover, and fall back to a neutral placeholder (NOT a photo)
when no usable image URL exists or an image fails to load.

**Why:** A prior implementation rendered `<img src="inline:text">`, which failed to load
and fired an `onError` handler that swapped in a RANDOM `https://picsum.photos/seed/<id>`
stock photo. Production users saw unfamiliar "AI photos" on text artifacts. Random-photo
fallbacks are actively misleading — they invent imagery unrelated to the artifact and mask
the real data shape. Banned entirely from the KAX frontend.

**How to apply:** The shared `ArtifactCover` component is the single source of truth for
artifact thumbnails — route all artifact-image rendering through it rather than inline
`<img>` + ad-hoc `onError` fallbacks. If you see a `picsum.photos` reference reappear in
KAX frontend source, it's a regression of this rule.

Also note: `partnerClient.normalizeArtifact` defaults a missing `raw.type` to `"image"` —
keep that in mind if mis-typed artifacts ever appear (a missing type would render as an
image cover, not text).
