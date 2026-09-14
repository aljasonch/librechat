# Fork custom changes vs upstream

This fork (`aljasonch/librechat`) carries custom features on top of upstream
(`danny-avila/LibreChat`). This file is fork-only; upstream never touches it, so it is
the safe place to document our delta. Read it **before** resolving any merge conflict.

Full custom delta check: `git diff upstream/main...HEAD --stat`

## Merge conflict workflow (follow in order)

1. Read `AGENTS.md` and `CLAUDE.md`, then run `git status`, `git ls-files -u`, `git diff --cc`.
2. Resolve file by file. **Never** use `git reset --hard`, `git checkout --ours`, or
   `git checkout --theirs` blindly — ours carries the features below, upstream carries
   phase/activity-label handling, reasoning label lifecycle, `MessageRow`, attachment
   filtering, parallel rendering, fade hydration, and new UI primitives.
3. Evidence-based bulk resolution: for any conflicted file NOT in the custom-file list
   below, compare stage-2 (ours) against the previous upstream tip
   (`git rev-parse <old-upstream-tip>:<path>` vs `git rev-parse :2:<path>`). If identical,
   ours holds no custom content — take upstream via `git checkout MERGE_HEAD -- <path>`.
4. After resolution: run Prettier + ESLint on resolved files, build generated packages
   (`npm run build:data-provider`, `npm run build --workspace=packages/client`,
   `npm run build --workspace=packages/data-schemas`) BEFORE trusting typecheck
   (client reads possibly-stale `packages/*/dist`), then `tsc --noEmit` in `client/`
   and `packages/api/`, then the required tests, `git diff --check`, a global scan for
   `<<<<<<<`/`=======`/`>>>>>>>`, stage only conflicted files with `git add`.
   Done = `git ls-files -u` is empty with zero loss of upstream or custom changes.
5. Required tests (run from `client/`): `ContentParts.test.tsx`, `Timeline.test.tsx`,
   `Markdown.mcpui.test.tsx`, `animate.test.tsx`. Also `packages/api` jest for any
   packages files you touched.
6. Environment notes: no Redis locally (all `*.stream_integration` suites fail — not a
   merge regression; verify the spec is bit-identical to upstream and move on). Some
   upstream specs use POSIX single quotes that break on Windows. Jest must run from
   `client/` with its own config, or babel lacks the TypeScript preset and `import type`
   fails to parse.

## Custom features (do not lose these)

### 1. Compact Thinking Timeline (largest feature)

- `client/src/components/Chat/Messages/Content/Timeline.tsx` (fork-only file) — timeline
  renderer. Sequential `think` + `tool_call` blocks merge into one timeline; assistant
  messages only, user messages render normally; final answer text stays outside the
  timeline in regular markdown. Handles web search states Searching/Searched/Found/Read
  with favicon/domain from `searchResults` or attachments, capped chips + "N more";
  generic tools use `getToolDisplayLabel` with expandable input/output detail. Live state
  while `isSubmitting`, "Thought for Ns" after local duration, "Done" when the final
  response appears; never fabricates durations for old history. The activity panel
  (desktop: right sidebar shifting `#root`; mobile: draggable bottom sheet) has **no
  shadow by design** — do not restore `shadow-xl` or
  `shadow-[0_-12px_48px_rgba(0,0,0,0.18)]` on the panel className.
- `client/src/components/Chat/Messages/Content/ContentParts.tsx` — grouping brain.
  Custom `RenderUnit` type (`single` / `tool-group` / `timeline`); custom
  `renderUnits` loop (not upstream's `groupedParts`); keep upstream's
  `groupActivityPhases`, `labelPart?` on the tool-group type, agent-based attachment
  filtering, and `metadata` forwarded to nested `ContentParts`. `showEmptyCursor` must
  include `sequentialParts.length === 0` so the loading bullet appears before any fake
  "Thinking".
- Reasoning split: GPT-style summaries starting with bold `**Title**` become heading
  nodes (one node per summary, body never treated as free markdown); raw thinking from
  non-GPT models renders literal (no markdown), split into ~90-word nodes only at
  sentence boundaries (period + next capital letter), never per space or server chunk.
- `client/src/components/Chat/Messages/Content/Parts/Reasoning.tsx` — prefer backend
  `reasoningLabel` as the title; fallback `Thinking` (live) / `Thoughts` (done);
  collapse/expand, shimmer, strips `<think>` tags, never fabricates hidden reasoning.
- `client/src/components/Chat/Messages/Content/TextShimmer.tsx` (fork-only) +
  `shine` keyframe in `client/tailwind.config.cjs`.

### 2. Word fade on streaming markdown

- `client/src/components/Chat/Messages/Content/streaming.tsx` (fork-only) —
  `rehypeStreamingWords` plugin + `StreamingSpan`; skips code/pre/KaTeX/mermaid/svg.
- `markdownConfig.ts` — cached getters, deliberately NOT upstream's plain exports.
  Current shape: two cache slots keyed by `latexParsing` (true/false) plus a separate
  cache for `animateWords` rehype plugins and one for components. Do not drop the
  caches (react-markdown rebuilds its processor otherwise) and do not collapse the two
  `latexParsing` slots into one. `getRehypePlugins(animateWords?)` and
  `getMarkdownComponents()` include `span: StreamingSpan`.
- `Markdown.tsx` — keep `animateWords` prop (consumed by `Text.tsx`,
  `MessageContent.tsx`, tests), `useMessageContext() ?? {}`, `useSmoothStreaming`,
  `FADE_HYDRATION_THRESHOLD` hydration refs, `aria-live` placeholder, and the
  `isLatestMessage` null-return guard.
- `MarkdownBlocks.tsx` — memo comparator extends upstream's (`mermaidBaseIndex`,
  `animate`) with identity checks on `remarkPlugins`/`rehypePlugins`/`components`.
- CSS: `[data-lc-fade]` blocks + cursor suppression in `client/src/style.css` — keep
  the `@supports`/`@media` bracket structure intact.

### 3. Duration persistence

- `api/server/routes/messages.js` — fork endpoint
  `PUT /:conversationId/:messageId/activity-duration` (validates key
  `[A-Za-z0-9_-]{1,64}`, seconds 1–86400, ownership via `user: req.user.id`, writes
  `metadata.activityDurations.<key>`). Upstream doesn't have it — merge conflicts
  present it as ours-only; keep it. Main PUT keeps upstream's latest middleware.
- `client/src/data-provider/Messages/mutations.ts` —
  `useUpdateMessageActivityDurationMutation` with optimistic React Query cache update.
- Wiring: `durationKey = conversationId:messageId:idx`, `storedDuration`,
  `onDurationFinalized` flow through ContentParts → Timeline.
- `MessageParts.tsx` + `components/Messages/ContentRender.tsx` — forward `message.metadata`
  and include it in memo equality.

### 4. Activity panel styling (client/src/style.css)

Gray shimmer with white highlight; muted text light ~`rgb(93,93,93)`, dark
~`rgb(175,175,175)`; smooth node animations; desktop sidebar slides from right and
shifts `#root`; mobile bottom sheet drags down; close animations right/down; visible
scrollbar; reduced-motion fallback. Keep `@supports`/`@media` nesting balanced.

## Fork-only infra changes (easy to lose in merges — always re-check)

- `.github/workflows/dev-images.yml` — single matrix entry `image_name: aljasonchat`
  (not upstream's `librechat-dev-api` + `librechat-dev`), `platforms: linux/amd64` only
  (arm64 via QEMU dies SIGILL 132 during npm ci), pushes to
  `<DOCKERHUB_USERNAME>/aljasonchat:latest` + commit sha.
- `.github/workflows/main_librechat.yml` — Azure Web App deploy (legacy, unused;
  candidate for disabling, do not spend effort fixing it).
- `api/package.json` — fork script `"backend": "NODE_ENV=production node server/index.js"`
  in the api workspace: compatibility for the HuggingFace Space Dockerfile that runs
  `npm run backend` from `/app/api` (root-only script otherwise).
- tsdown configs (`packages/api`, `packages/client`, `packages/data-provider`) —
  `neverBundle` uses `isFirstPartyImport` helper recognizing Windows drive-letter paths;
  upstream's `.`/`~`-only check breaks Windows builds.

## Fork-only bug fixes (upstream may not have them yet — keep)

- `client/src/utils/convos.ts` — `upsertConvoInAllQueries` skips temporary conversations
  so they never leak into the sidebar history cache.
- `packages/api/src/endpoints/google/initialize.ts` — Google service key loads only when
  `GOOGLE_SERVICE_KEY_FILE` is set or the default file exists (no spurious error logs).
- `packages/api/src/utils/tokenizer.spec.ts` — `createExactTokenCounter` must throw on
  tokenizer failure, not fall back to estimates.
- `api/server/services/Config/loadAsyncEndpoints.spec.js` — `path.join` for Windows-safe
  path assertions.

## Locale keys (ours; keep on conflict)

`client/src/locales/en/translation.json`: `com_ui_activity`, `com_ui_found_n_web_pages`,
`com_ui_subagent_earlier_turn`, `com_ui_subagent_latest_turn`,
`com_ui_thought_for_seconds`, `com_ui_read_n_pages`, `com_ui_view_all`,
`com_ui_weekend_morning`; `com_ui_thinking` is "Thinking" (no ellipsis — Reasoning.tsx
strips trailing ellipsis at runtime). Always merge upstream's new keys in, then validate
JSON parses and has no duplicate keys.
