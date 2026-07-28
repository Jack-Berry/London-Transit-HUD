# SYNC.md — London Transit HUD

Coordination file for the two-agent workflow.

- **Plan** is owned by the planning lead. Task breakdown with acceptance criteria.
- **Execution notes** is owned by Sol. What was done, decisions taken, problems hit.
- **Review** is owned by the planning lead. Findings, corrections, sign-off.

Neither agent edits the other's section. Entries are dated, newest at the bottom of each section.

Git is owned by the planning lead: Sol never commits or pushes. The lead commits and pushes to origin after each review round.

---

## Plan

### 2026-07-28 — Milestone 1: scaffold plus live Tube status board

**Goal:** a working Even Hub G2 glasses app that shows live TfL line status for the Tube, Elizabeth line, DLR and Overground, refreshing automatically, with proper input handling and a clean exit.

**Context Sol needs before touching anything:** this app runs on Even Realities G2 smart glasses via the Even Hub platform. The app itself is a web app (Vite plus TypeScript) that runs inside a Flutter WebView on the phone, and drives the glasses display through the `@evenrealities/even_hub_sdk` bridge. You never draw pixels directly. You declare "containers" (text, list, image) and the firmware renders them. The display is 576x288 px, 4-bit greyscale (16 shades of green), no fonts, no alignment control, no animations.

**Sol, read this and take it seriously:** only the planning lead has access to the Even Realities documentation and skills. You do not, and you cannot look any of it up. Every SDK fact you need is quoted verbatim in the task descriptions below, and those constraints are hardware-verified. **Never assume SDK behaviour.** Do not infer method names, parameters, event shapes or lifecycle semantics from other SDKs or from what seems plausible; on this platform the plausible guess is usually wrong (single taps arrive as `undefined`, browser localStorage silently loses data, concurrent bridge calls crash the BLE link). If you need an SDK fact that is not written in a task, **stop work on that part and write the question in your Execution notes** for the lead to answer next round. A blocked task with a good question beats invented SDK code every time. The one file you may treat as a known-good reference is `src/main.ts` as scaffolded, since the lead wrote it against the real docs.

**Scope decisions taken (Jack can override, see Open questions):**

- Modes for milestone 1: `tube,elizabeth-line,dlr,overground`. No bus arrivals yet.
- TfL Unified API called keyless (anonymous access is allowed with a modest rate limit, and one request per minute is well inside it). No API key means nothing secret in the client, which keeps us honest on the credentials-stay-server-side rule. If we later need an `app_key`, it goes behind a proxy, never in the client bundle.
- Vanilla TypeScript, no framework.

---

#### T1 — Scaffold the project ✅ DONE (by the planning lead, 2026-07-28)

Done by the lead rather than Sol because it leans entirely on EvenHub docs Sol cannot see. What now exists at repo root:

- Vite plus vanilla TypeScript project: `package.json`, `tsconfig.json`, `vite.config.ts` (build target `es2022`, needed for top-level await), `index.html`, `src/main.ts`.
- `@evenrealities/even_hub_sdk` in dependencies; `@evenrealities/evenhub-cli`, `@evenrealities/evenhub-simulator`, `vite`, `typescript` in devDependencies. TypeScript is pinned to `^5.9.3` because the EvenHub CLI has a `typescript@^5` peer dependency; **do not bump it to 6 or 7**.
- `app.json` manifest with the `network` permission. `package_id` is `com.jackberry.londontransithud`; note it must stay lowercase with **no hyphens** in any segment, and `min_sdk_version` stays `"0.0.10"`.
- `src/main.ts` contains a known-good starter written against the real docs: it awaits the bridge, creates one full-screen text container (`containerID: 1`, `containerName: 'status'`, `isEventCapture: 1`) via `createStartUpPageContainer`, and logs the result. Sol builds T2 on top of this file.
- Verified: `npm run build` passes clean (tsc plus vite). Engine warnings about `mute-stream` wanting a newer Node are harmless noise on Node 20.13.

---

#### T2 — Glasses UI skeleton with input and lifecycle handling

Build the static display layout and wire up input, starting from the scaffolded `src/main.ts` (split into modules if you like, e.g. `src/ui.ts`, `src/events.ts`). The starter currently creates one full-screen `'status'` container; T2 changes the startup call to create the two containers below instead.

Layout (576x288 canvas, origin top-left):

- Container 1, `containerName: 'status'`: full-width text container, `x:0 y:0 w:576 h:252`, `isEventCapture: 1`, `borderWidth: 0`, `paddingLength: 4`. Shows the status board (placeholder text for now: `Loading line status...`).
- Container 2, `containerName: 'footer'`: `x:0 y:252 w:576 h:36`, `isEventCapture: 0`, shows a static hint line: `Swipe: scroll   2x tap: exit`.

Startup:

```typescript
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
} from "@evenrealities/even_hub_sdk";
const bridge = await waitForEvenAppBridge();
const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [statusContainer, footerContainer],
  }),
);
// result: 0 = success, 1 = invalid params, 2 = oversize, 3 = out of memory
```

Hard constraints (hardware-verified, do not improvise):

- **Exactly one container on the page may have `isEventCapture: 1`.** Two or more and the SDK rejects the page.
- `containerID` unique per page (number). `containerName` unique per page, **max 16 characters**.
- Max 12 containers per page, max 8 of them text/list.
- `createStartUpPageContainer` is called **exactly once** for the app's lifetime. Later changes use `textContainerUpgrade` (in-place text swap, no flicker) or `rebuildPageContainer` (layout changes, causes a visible flicker).
- **Protobuf zero-value elision:** the bridge uses proto3 under the hood, so any field whose value is the type's zero value (0, false, empty string) arrives as `undefined`. A single tap has `eventType` 0, so it arrives as `sysEvent` with `eventType === undefined`. **Always read event fields with `?? 0`**, e.g. `const type = event.sysEvent.eventType ?? 0`.
- **Event routing on a text container:** swipes arrive as `event.textEvent` (`eventType` 1 = swipe up, 2 = swipe down). Single and double taps arrive as `event.sysEvent` (0 = single, 3 = double), **not** as textEvent. This is the classic bug source.
- **Exit pattern:** on double tap (`sysEvent.eventType === 3`) call `bridge.shutDownPageContainer(1)` to show the system exit dialog. Do **not** clean up listeners or state before that call; the user can cancel the dialog. Clean up in the handlers for `SYSTEM_EXIT_EVENT` (eventType 7) and `ABNORMAL_EXIT_EVENT` (eventType 6): unsubscribe the event listener there.
- Lifecycle: `FOREGROUND_ENTER_EVENT` (4) re-render current state; `FOREGROUND_EXIT_EVENT` (5) pause the refresh timer.
- **Persistence, if any state needs saving later: `bridge.setLocalStorage(key, value)` / `bridge.getLocalStorage(key)` only.** Browser `localStorage` and IndexedDB do not survive app restarts in the Even WebView. Nothing in milestone 1 needs persistence, so simply do not touch any storage API yet.

For milestone 1 the input behaviour is: swipe up/down logs the event (scroll paging comes in milestone 2), double tap opens the exit dialog, foreground enter re-renders, foreground exit pauses the timer.

Acceptance criteria:

- `npm run build` passes.
- Running `npm run dev` then `npx evenhub-simulator http://localhost:5173` shows the two containers: placeholder status text top, hint line bottom.
- Console log confirms `createStartUpPageContainer` returned 0.
- Double tap in the simulator triggers the exit dialog (console shows `shutDownPageContainer(1)` was called).
- Grep check: no occurrence of `window.localStorage`, `localStorage.` or `indexedDB` in `src/`.
- Grep check: every read of `eventType` or `currentSelectItemIndex` uses `?? 0` (or an equivalent explicit undefined check).

---

#### T3 — Live TfL line status with auto refresh

Fetch and render real data.

Data source: `GET https://api.tfl.gov.uk/Line/Mode/tube,elizabeth-line,dlr,overground/Status` (no key, no auth headers). Response is a JSON array; for each line use `line.name` and `line.lineStatuses[0].statusSeverityDescription` (e.g. `Good Service`, `Minor Delays`, `Part Closure`).

Rendering: build one text string for the whole board, one line per TfL line, name padded then status, e.g.

```
Victoria      Good Service
Central       Minor Delays
Elizabeth     Good Service
```

Then push it with:

```typescript
await bridge.textContainerUpgrade({
  containerID: 1,
  containerName: "status",
  content: boardText,
  contentOffset: 0,
  contentLength: 0,
});
```

Refresh on a 60 second interval. Pause the interval on `FOREGROUND_EXIT_EVENT`, resume and refresh immediately on `FOREGROUND_ENTER_EVENT`.

Hard constraints (hardware-verified):

- `textContainerUpgrade` requires `containerID` **and** `containerName` to exactly match the container created at startup; a mismatch fails silently. `contentOffset: 0, contentLength: 0` means full content replacement.
- Content limit for `textContainerUpgrade` is 2000 characters, but only roughly 400 to 500 characters fit on screen. There are 15 or so lines to show and the container auto-wraps at container width with no alignment control, so keep names to a fixed-width prefix (truncate to about 13 chars, pad with spaces) and statuses short. If the full board does not fit, show as many lines as fit and log the truncation; paging comes in milestone 2.
- **One in-flight bridge update at a time.** Serialise every bridge call: `await` each `textContainerUpgrade` before starting another, and guard the refresh tick so a slow update cannot overlap the next tick (a simple `isUpdating` flag or a promise queue). Concurrent bridge calls can crash the BLE connection.
- **Wrap bridge calls in a timeout.** A flaky BLE hop can hang a call for about 30 seconds. Use `Promise.race` with a 5 second cap; on timeout, skip that tick and try again on the next one.
- Network failure handling: on fetch error or non-200, keep the last good board on screen and append a short stale marker line, e.g. `(!) data 3 min old`. Never clear the display on error.

Acceptance criteria:

- `npm run build` passes.
- In the simulator, real TfL statuses render within a few seconds of launch (verify against https://tfl.gov.uk/tube-dlr-overground/status in a browser).
- Board updates in place with no page flicker (no `rebuildPageContainer` call anywhere in the refresh path).
- Killing the network (toggle wifi off) leaves the last board on screen with the stale marker, and recovery resumes cleanly when the network returns.
- Grep check: exactly one `createStartUpPageContainer` call in `src/`; refresh path uses only `textContainerUpgrade`.
- The refresh tick is visibly guarded against overlap (flag or queue present in code).

---

**Out of scope for milestone 1** (do not build yet): everything in the app flow entry below. Milestone 1 is the walking skeleton; the status board it produces becomes the app's idle screen.

### 2026-07-28 — App flow (product vision, agreed with Jack)

This is the app we are actually building. Milestones 2 onward serve this flow. Updated as the vision evolves.

**Planning (on the phone screen):** the EvenHub app's web UI renders on the phone as well as driving the glasses, so journey setup happens there where real text input exists. The user picks a start point (or "current location", see caveat below) and an end point via searchable station selection, then one of: set off now, set off later, or arrive by, with a time where relevant.

**Options screen:** present exactly two options, the fastest and the cheapest, each with route basics (modes and change points), total time, and cost. Data source is the TfL Journey Planner API, verified live on 2026-07-28:

- `GET https://api.tfl.gov.uk/Journey/JourneyResults/{fromId}/to/{toId}` returns journeys with `duration` (minutes), `fare.totalCost` (pence), and `legs[]` each carrying `mode.name`, `departurePoint`/`arrivalPoint.commonName`, timestamps, and `path.stopPoints[]` with every intermediate stop named.
- "Arrive by" is `?timeIs=Arriving&time=HHmm&date=YYYYMMDD`. "Later" is the same with `timeIs=Departing`. Omit both for "now".
- Cheapest is not a native preference: fetch the default (fastest-leaning) results, plus a `mode=bus` variant, and pick the lowest `fare.totalCost` across all returned journeys. Fares are sometimes absent (some national rail journeys); show "fare unavailable" rather than a made-up number.

**Journey mode (on the glasses, after the user hits Go):** one swipeable page per stage.

1. First page: "Walk to X station" as plain text. No walking directions in this version.
2. One page per transport leg: a horizontal route bar with a notch per stop. Start and end station names are essential; the current stop gets named too when it fits. Position along the bar is inferred by interpolating between the leg's departure and arrival times across its stops (the API does not give per-stop times), corrected by occasional GPS checks if GPS proves available.
3. If the journey has multiple legs, one bar page per leg.
4. Final page: "Walk to your destination".

**Route bar rendering decision:** v1 draws the bar with Unicode glyphs inside a text container, e.g. `KGX ●──●──◉──○──○ BXH` with the current stop named on the line below, updated flicker-free via `textContainerUpgrade`. Reason: image containers are hardware-capped at **288 px wide** (half the canvas), so a full-width graphical bar needs two tiled image containers, and image frames cost 0.5 to 2 seconds each over BLE with no concurrent sends. Text updates are effectively instant. Known trade-off: no alignment control and a proportional font, so notch spacing is approximate; the lead has a font-measurement tool for pixel-accurate layout when we polish, and tiled images remain the upgrade path if the text bar looks too rough on hardware.

**Location caveat:** GPS is not part of the verified SDK surface. The manifest schema has a `location` permission which suggests browser geolocation may work inside the Even WebView, but this is unverified. It gets a dedicated on-device verification task before anything depends on it; manual start selection is the fallback throughout.

**Rough milestone shape from here** (tasked properly when each becomes current):

- **M2:** phone-side planning UI (station search, from/to, now/later/arrive-by), journey fetch and fastest/cheapest computation, options screen on the glasses.
- **M3:** journey mode: stage pages, text-glyph route bar, position interpolation, walk pages.
- **M4:** GPS verification spike, en-route corrections, live disruption awareness, visual polish (possibly the image-based bar).

### 2026-07-28 — Decisions absorbed from Jack's answers (see Open questions)

- **Proxy confirmed.** Jack is registering a TfL `app_key`. All TfL traffic will route through a small server-side proxy (also solves the WebView CORS risk). The key lives in `.env` at repo root as `TFL_APP_KEY` (gitignored; `.env.example` is the committed reference). **Sol: never read `TFL_APP_KEY` in client code, and never create any env var with a `VITE_` prefix. Vite inlines `VITE_*` vars into the shipped client bundle, which would leak the key.** The proxy gets tasked in milestone 2.
- **Milestone 1 unaffected:** T3 still fetches TfL directly and keyless, but put the API base URL in a single exported constant (e.g. `const API_BASE = 'https://api.tfl.gov.uk'`) so the proxy swap later is a one-line change.
- **Modes:** trains and buses. Each mode of transport needs a distinctive identifier on the HUD (greyscale text glyphs, since there is no colour), e.g. a short bracketed tag or symbol per mode: tube, Elizabeth line, DLR, Overground, national rail, bus. Exact glyph set to be specified when the options screen is tasked.
- **Line ordering:** Jack has no preference; milestone 1 keeps whatever order the API returns (it is stable and roughly alphabetical). Sol need not do anything.
- **Phone-first flow confirmed:** all setup on the phone, including the fastest/cheapest options screen. The glasses only come alive when the user hits Go, so the phone can go in the pocket. Voice input on glasses is a maybe-later, not planned.

### 2026-07-28 — Round 2: unblock T2 and T3 (answers to Sol's questions, verified against the installed SDK)

Both of Sol's round 1 blockers were real gaps in the round 1 spec, and both are now resolved below. The contracts here were read directly from the installed `@evenrealities/even_hub_sdk@0.0.12` type definitions by the lead, so they match what the compiler will accept.

---

#### T3b — Fix the `textContainerUpgrade` build error

The round 1 spec showed a plain object literal; that was wrong. `TextContainerUpgrade` is a **class** and the bridge method takes an instance of it:

```typescript
// verbatim from the installed SDK:
// class TextContainerUpgrade {
//   containerID?: number
//   containerName?: string
//   contentOffset?: number
//   contentLength?: number
//   content?: string
//   constructor(data?: Partial<TextContainerUpgrade>)
// }
// bridge method: textContainerUpgrade(container: TextContainerUpgrade): Promise<boolean>
```

Fix at `src/main.ts:130`: import `TextContainerUpgrade` from `@evenrealities/even_hub_sdk` and wrap the existing object in `new TextContainerUpgrade({ ... })`. No other changes to the call. This mirrors how `TextContainerProperty` and `CreateStartUpPageContainer` are already constructed in the same file.

Acceptance criteria:
- `npm run build` passes clean (tsc plus vite).
- The refresh path still uses only `textContainerUpgrade` with `containerID: 1`, `containerName: 'status'`, `contentOffset: 0`, `contentLength: 0`.

---

#### T2b — Wire input and lifecycle events (full contract now provided)

Subscription, verbatim from the installed SDK:

```typescript
// bridge method: onEvenHubEvent(callback: (event: EvenHubEvent) => void): () => void
// the return value is the unsubscribe function
const unsubscribe = bridge.onEvenHubEvent(event => { ... })

// type EvenHubEvent = {
//   listEvent?:  List_ItemEvent
//   textEvent?:  Text_ItemEvent    // { containerID?: number; containerName?: string; eventType?: number }
//   sysEvent?:   Sys_ItemEvent     // { eventType?: number; eventSource?: number; imuData?: ...; systemExitReasonCode?: number }
//   audioEvent?: AudioEventPayload
// }
```

Discriminate by checking which property is present, in this order: `if (event.textEvent) { ... } else if (event.sysEvent) { ... }`. Ignore `listEvent` and `audioEvent` for now (we have no list or audio).

Event meanings (hardware-verified):

- `textEvent.eventType`: `1` = swipe up, `2` = swipe down. Swipes are the ONLY thing that arrives as `textEvent`.
- `sysEvent.eventType`: `0` = single tap, `3` = double tap, `4` = foreground enter, `5` = foreground exit, `6` = abnormal exit, `7` = system exit (user confirmed the exit dialog).
- **Zero-value elision applies:** a single tap arrives with `eventType` equal to `undefined`, not `0`. Read every event field as `event.sysEvent.eventType ?? 0` and `event.textEvent.eventType ?? 0`.

Required behaviour (same as round 1):

- Swipe up/down: `console.log` the direction.
- Single tap: `console.log` it.
- Double tap: call `bridge.shutDownPageContainer(1)` (verified signature: `shutDownPageContainer(exitMode?: number): Promise<boolean>`; mode `1` shows the system exit dialog). Do NOT unsubscribe or clean anything up at this point; the user can cancel the dialog.
- Foreground enter (4): re-render current state (re-send the last board, or trigger an immediate refresh) and resume the 60 second interval.
- Foreground exit (5): pause the interval (clear it; recreate on enter).
- System exit (7) and abnormal exit (6): this is where cleanup lives. Call `unsubscribe()` here.

Acceptance criteria:
- `npm run build` passes.
- In the simulator: swipes and taps log correctly, double tap triggers the exit dialog.
- Grep check: every read of `eventType` uses `?? 0` or an equivalent explicit undefined check.
- Interval is provably paused after foreground exit and resumed after foreground enter (log lines are fine as evidence).

---

#### T3c — Close the in-flight gap on bridge timeouts (correction from review)

`withBridgeTimeout` (src/main.ts:54-69) races the bridge call against a timer, but losing the race does not cancel the underlying BLE call; it is still in flight. Meanwhile `refreshStatuses` clears `isUpdating` in its `finally`, so the next tick can send a second `textContainerUpgrade` while the first is still pending. Concurrent bridge calls can crash the BLE link, so this needs closing.

Fix, concretely: add a module-level `bridgeCallPending: Promise<unknown> | null`. In `updateStatusContainer`, before sending, if `bridgeCallPending` is non-null, skip this update (log and return). Set `bridgeCallPending` to the RAW bridge promise (not the raced one) with a `.finally(() => { bridgeCallPending = null })` attached, then await the raced version as now. That way a timed-out call keeps blocking new sends until it genuinely settles, while the tick logic stays unchanged.

Acceptance criteria:
- `npm run build` passes.
- Code shows the raw bridge promise (not the `Promise.race` result) is what gates the next send.
- A skipped update logs a distinct message so we can spot it in the simulator console.

---

**Vision refinement from Jack (2026-07-28, after round 2):** the app is purely a route planner that does the work for you. No dedicated disruption or status screens: if a line the user needs is disrupted, the app mentions it in the context of their route (at planning time and en route). The milestone 1 status board is a walking-skeleton artefact only and will be replaced, not extended. Milestone 2 planning should reflect this.

**Also for the record, a discovery while verifying the above:** the installed SDK exposes a location API (`getAppLocation(options?): Promise<AppLocation | null>`, `startAppLocationUpdates` / `stopAppLocationUpdates`, `onAppLocationChanged(cb): unsubscribe`, with `AppLocation` carrying `latitude`, `longitude`, `accuracy?`, `speed?`, `heading?`, `timestamp?` and an `AppLocationAccuracy` enum of Low/Medium/High). This substantially de-risks the "current location" and en-route GPS features in the vision: there is a real API, not just a manifest permission. It still needs on-device verification before anything depends on it, and using it will need the `location` permission added to `app.json`. Not tasked yet; M3/M4 material. Sol: do not touch this API in milestone 1.

### 2026-07-28 — Milestone 2 round A: the TfL proxy (T4 for Sol, T5 for the lead)

**Hosting decided:** Jack's existing droplet (`berrydev-apps`). The lead inspected it over SSH. Established pattern on that box, which we follow exactly: one shared Caddy instance (part of the `connect-remote` compose stack) owns ports 80/443 and terminates TLS for every app; each additional app is its own compose project whose container publishes no ports, joins the external docker network `connect-remote_default`, and gets a `reverse_proxy <container>:<port>` site block in the shared Caddyfile. The MatchHUD API already works this way. Deployment to the droplet is the lead's job (T5); Sol only writes the service (T4).

---

#### T4 — TfL proxy service

A tiny standalone HTTP service in a new `proxy/` directory at repo root. This is plain Node, no EvenHub constraints apply. Keep it boring and auditable.

Spec:

- Node 22, TypeScript, **zero runtime dependencies** (use `node:http` and the built-in `fetch`). Own `package.json` in `proxy/` (scripts: `build` via tsc, `start` runs `dist/server.js`), own `tsconfig.json`. Do not touch the root app's package.json.
- `GET /healthz` → `200 {"ok":true}`.
- `GET /tfl/<path>?<query>` → forwards to `https://api.tfl.gov.uk/<path>?<query>` with `app_key=<TFL_APP_KEY>` appended server-side. Return the upstream status code and JSON body. Only `content-type` passes through from upstream headers.
- **Path allowlist** (reject anything else with 404, before any upstream call): paths starting with `Journey/JourneyResults/`, `Line/Mode/`, `StopPoint/Search/`. This stops the service being an open proxy.
- GET and OPTIONS only; other methods get 405.
- **CORS:** every response carries `Access-Control-Allow-Origin: *`; OPTIONS preflight answers 204 with `Access-Control-Allow-Methods: GET` and `Access-Control-Allow-Headers: *`.
- Upstream timeout 15 seconds → respond 504. Upstream network failure → 502.
- **The key must never leak:** not in response bodies, not in response headers, not in error messages, not in logs. Log lines may include the path but must strip the query entirely (simplest rule that cannot go wrong).
- Env: `TFL_APP_KEY` (required; exit nonzero with a clear message at startup if unset), `PORT` (default 8100).
- `proxy/Dockerfile`: `node:22-alpine`, install, build, run `dist/server.js`.
- `proxy/docker-compose.yml`: one service named `transit-proxy`, `restart: unless-stopped`, **no `ports:` published**, `env_file: .env`, and joined to the external network `connect-remote_default` (declare it `external: true`). This mirrors how MatchHUD sits behind the shared Caddy.
- For local testing, load the real key into your shell from the repo root `.env` (`set -a; source ../.env` from `proxy/`). Do not copy the key into any file.

Acceptance criteria:

- `npm run build` in `proxy/` passes.
- With the key exported: `curl localhost:8100/healthz` returns `{"ok":true}`; `curl 'localhost:8100/tfl/Line/Mode/tube/Status'` returns the same JSON array shape the client already consumes; `curl 'localhost:8100/tfl/Journey/JourneyResults/HUBKGX/to/940GZZLUBXN'` returns journeys.
- `curl 'localhost:8100/tfl/Line/1'` (not allowlisted) returns 404 without hitting TfL; `curl -X POST` anything returns 405.
- Responses carry `Access-Control-Allow-Origin: *`.
- Grep proof: `TFL_APP_KEY` appears only in env reading and the outbound URL construction; no log statement includes a query string.
- `docker build proxy/` succeeds.
- No changes outside `proxy/` (the client's `API_BASE` swap is a later task, after the lead deploys).

---

#### T5 — Deploy the proxy (lead's job, after T4 review)

DNS record for the chosen subdomain, site block in the shared Caddyfile, `.env` with the key on the droplet, compose up, end-to-end verify over HTTPS, then task the client `API_BASE` swap. Blocked on the subdomain decision (see Open questions).

---

**Round B preview:** superseded by the full round B plan below. One correction to an earlier claim: hub ids do NOT work as journey endpoints (verified: TfL treats them as free text and answers HTTP 300); use `icsId` from search matches instead.

### 2026-07-28 — Milestone 2 round B: client through the proxy, then the phone planning UI

The proxy is live at `https://transit.berrydev.co.uk` (T5 done, see Review). This round is one mechanical task and one design-heavy task.

---

#### T6 — Point the client at the proxy, fix the Dockerfile CMD

1. `src/main.ts:8`: change `API_BASE` from `'https://api.tfl.gov.uk'` to `'https://transit.berrydev.co.uk/tfl'`. Nothing else changes; the proxy mirrors TfL paths under `/tfl/`.
2. `proxy/Dockerfile` last line: `CMD ["npm", "start"]` becomes `CMD ["node", "dist/server.js"]` (npm does not reliably forward SIGTERM; this is the carry-forward correction from the T4 review).

Acceptance criteria: root `npm run build` and `proxy/` `npm run build` both pass; grep shows no `api.tfl.gov.uk` anywhere in `src/`; the status board still renders in the simulator (lead will verify if you cannot run it).

---

#### T7 — Phone-side planning UI

**Read this context first, it changes how you think about the file:** the same `index.html` page does two jobs. It renders as an ordinary web page in the Even app's phone webview, AND it drives the glasses through the bridge. The phone side is normal DOM: full HTML/CSS/JS, colour, any layout you like. The 576x288 greyscale container constraints apply ONLY to the glasses bridge calls, never to the phone DOM. The body of `index.html` is currently empty; the phone UI lives there.

**Structural requirement (this will bite if skipped):** `src/main.ts` currently top-level-awaits `waitForEvenAppBridge()`. In a plain desktop browser there is no bridge, that promise never resolves, and everything after it is dead: the phone UI would never boot during development. Restructure so the phone UI initialises unconditionally first, and the existing glasses logic (bridge await, startup container, events, refresh loop) is wrapped in an async function fired with `void` and its own try/catch, so a missing bridge cannot break the phone UI. The glasses status board must keep working unchanged in the simulator.

**What to build (mobile-first single column, dark theme, hand-rolled CSS, no frameworks):**

- **From and To fields** with station search: on input (debounce ~300ms), `GET {API_BASE}/StopPoint/Search/{urlencoded query}?modes=tube,elizabeth-line,dlr,overground,bus`. Response shape (verified): `{ matches: [{ id, icsId, name, lat, lon, modes[], zone }] }`. Show a suggestions list of `name` plus small mode chips; selecting a suggestion fills the field and stores the whole match. **Journey endpoints use `icsId`, never `id`** (verified: hub ids return HTTP 300 free-text disambiguation; `icsId` values return journeys). If a journey response ever comes back 300 anyway, show "Couldn't identify that stop, pick it from the suggestions" rather than attempting disambiguation.
- **Timing control:** segmented three-way: Now / Leave at / Arrive by. For Now, no timing params. Otherwise append `date=YYYYMMDD&time=HHmm&timeIs=Departing` (leave at) or `timeIs=Arriving` (arrive by), from a `datetime-local` input (verified param format).
- **Plan action:** two parallel fetches: `GET {API_BASE}/Journey/JourneyResults/{fromIcsId}/to/{toIcsId}?{timing}` and the same with `&mode=bus` added. Combined journeys shape (verified): `{ journeys: [{ duration, startDateTime, arrivalDateTime, fare?: { totalCost }, legs: [{ mode: { name }, departurePoint: { commonName }, arrivalPoint: { commonName } }] }] }`. `duration` is minutes; `totalCost` is pence (display as £X.XX; absent fare shows "fare unavailable"). Fastest = lowest `duration` across the default query's journeys. Cheapest = lowest `totalCost` across ALL journeys from both queries that have a fare. If they are the same journey, show one card labelled "Fastest & cheapest".
- **Option cards** (one for fastest, one for cheapest): duration large, fare, depart and arrive times, and a leg strip of mode chips with change points, e.g. `WALK → TUBE (Green Park) → BUS (59)`. **Each mode gets a visually distinctive chip** (Jack's requirement): distinct colour per mode on the phone: tube, elizabeth-line, dlr, overground, bus, national-rail, walking. Chip label is `mode.name` for now; per-leg line names (Victoria, 59) are not yet verified fields, so leave them out rather than guessing; the lead will verify them for M3.
- **Go button** on each card: stores the selected journey object in a module-level variable and logs `Journey selected`. Glasses handoff is M3. **No persistence of any kind this round**: no bridge storage, and the browser localStorage ban applies to the phone side too (same webview).
- **Error states:** inline messages for search failure, journey fetch failure, and an empty `journeys` array ("No routes found").

Acceptance criteria:

- `npm run build` passes.
- In a plain desktop browser (`npm run dev`, no simulator): typing "kings" under From lists King's Cross suggestions with mode chips; selecting, then setting To to Brixton and hitting Plan renders fastest and cheapest cards with plausible durations and £ fares within a few seconds. Arrive-by with a future time changes the results' arrival times accordingly.
- The phone UI boots in the plain browser with no bridge present and no console errors from the glasses path (a single info log that the bridge is unavailable is fine).
- In the simulator, the glasses status board still renders as before (lead verifies alongside you if needed).
- Grep checks: no `api.tfl.gov.uk` in `src/`, no `localStorage`/`indexedDB`, no `VITE_`, no TfL key anywhere.

Effort recommendation for Jack: **run this round on high.** T6 is trivial but T7 is genuine design judgement (layout, states, interaction detail are Sol's to shape within the spec).

### 2026-07-28 — Milestone 2 round C: places, not just stops (T8, T9)

Users must be able to type a bar, venue or shop name as either journey end. Geocoder decision and verification are in the Review section: Photon, through our proxy, place coordinates passed to the journey planner as `lat,long` (verified working: TfL picks the boarding stop and returns the walking legs itself).

---

#### T8 — Proxy: add a `/geocode` endpoint

Extend `proxy/src/server.ts` (same zero-dependency style):

- `GET /geocode?q=<text>` → forwards to `https://photon.komoot.io/api/?q=<urlencoded text>&limit=6&lat=51.5074&lon=-0.1278` (the fixed lat/lon biases results towards central London; do not pass client-supplied lat/lon this round). Return upstream status and JSON body; only `content-type` passes through; same CORS treatment as `/tfl/`.
- Missing or blank `q` → 400 before any upstream call.
- Reuse the existing timeout/error scaffolding (15s → 504, network failure → 502).
- Response shape for reference (verified): GeoJSON `{features: [{geometry: {coordinates: [lon, lat]}, properties: {name, osm_value, street, postcode, city, ...}}]}`. **Note the coordinate order: `[lon, lat]`.** Pass the body through untouched; the client does the shaping.
- No key exists for Photon; the `TFL_APP_KEY` handling is untouched. Log rule stays: path only, never the query (a place query is user location intent, keep it out of logs).

Acceptance criteria: proxy build passes; `curl 'localhost:8100/geocode?q=ministry%20of%20sound'` returns GeoJSON with the nightclub as a feature; blank `q` returns 400 without an upstream call; CORS header present; existing `/tfl/` and `/healthz` behaviour unchanged (re-run the T4 curls); no query strings in logs.

---

#### T9 — Phone UI: merged stop and place search

Extend the From and To fields so each search fires two parallel requests: the existing TfL stop search AND `GET {proxy}/geocode?q=...`. Render grouped suggestions: **"Stations & stops"** (existing rendering, mode chips) then **"Places"** (name, plus a small type label from `osm_value` e.g. pub, nightclub, and street/postcode as secondary text). Cap places shown at 5.

- Selecting a place stores `{name, lat, lon}` and the journey endpoint for that end becomes the string `` `${lat},${lon}` `` (note Photon gives `[lon, lat]`, flip it). Stops keep using `icsId` exactly as now.
- Both ends accept either kind. All existing behaviour (debounce, abort, stale-guard, error states) applies to the place fetch too; if one of the two searches fails, show the other's results rather than an error.
- The journey request, cards, fastest/cheapest logic are unchanged: they neither know nor care whether an end was a stop or a place (the lead verified TfL returns the same journey shape with walking legs for coordinate ends).

Acceptance criteria: `npm run build` passes; in a plain browser, typing "french house" under To shows The French House (pub) under Places, selecting it and planning from King's Cross renders cards whose first leg is a walk or whose last leg walks to the destination; typing "kings" still shows stations first; a place at BOTH ends also plans successfully; all round B grep checks still pass.

---

Effort recommendation for Jack: **medium.** The pattern is established from round B; T8 is mechanical and T9 extends existing components.

### 2026-07-28 — Milestone 3 round D: the glasses handoff (T10)

Journey mode on the glasses: Go on the phone switches the glasses from the status board to swipeable stage pages. Live position comes in round E; this round the pages are static.

**Verified API facts for this round (lead-checked through the live proxy):**

- Transport legs carry `routeOptions[0].name` (e.g. `Victoria`), `instruction.summary` (e.g. `Victoria line to Brixton`), ISO `departureTime` / `arrivalTime`, `duration` (minutes), `isDisrupted` and `disruptions[]`.
- `leg.path.stopPoints[]` is `{id, name}` per stop, in order, **starting from the first stop after boarding** (the departure station is not included) and ending at the leg's arrival stop.
- Walking legs have `instruction.summary`, `duration`, and `arrivalPoint.commonName`.
- The journey object held by the phone's Go selection is plain JSON, safe to snapshot.

**Platform facts for this round (hardware-verified from project docs; the usual rule applies, do not improvise):**

1. **Backgrounding reloads the app.** When the phone goes to background, the Even host snapshots JS state, loads the SAME plugin URL in a fresh headless WebView, replays the snapshot, and keeps driving the glasses from there; on foregrounding it migrates back. If we register no state hooks, the snapshot is `{}` and the app RESETS mid-journey. The API, verbatim from `@evenrealities/even_hub_sdk`:

```typescript
import { setBackgroundState, onBackgroundRestore } from '@evenrealities/even_hub_sdk'
setBackgroundState('journeyMode', () => ({ ...journeyState }))   // exporter: MUST return a snapshot copy of plain JSON (spread it), never the live reference
onBackgroundRestore('journeyMode', saved => {
  const s = saved as typeof journeyState
  journeyState = { ...journeyState, ...s }                        // restorer: MUST reassign the live variable, with ?? fallbacks per field
})
```

Rules: same key string in both calls; both registered at module init time (top level, before `onEvenHubEvent`), never inside a handler or conditional; no Dates, Maps, Sets or class instances in the snapshot. Because init re-runs in the headless WebView, the restore callback may fire before OR after our async glasses init reaches its first render: handle both orders (see T10 spec).

2. **Text measurement.** Install `@evenrealities/pretext` (client dependency; it is a plain measurement library mirroring the glasses firmware renderer). API: `getTextWidth(text): number` (single-line px), `measureTextWrap(text, maxWidth): {lineCount, height, lineWidths}`, `pxTruncate(text, maxPx): string` (appends `...`). Line height is fixed **27px**. Padding maths: text area inside a container is `width - 2*(paddingLength + borderWidth)` (same for height). Never guess pixel sizes; measure.
3. **Glyphs for the route bar, measured by the lead against firmware metrics:** `●` `○` `─` `▼` `▲` `■` `□` `◆` `◇` are all exactly **20px** wide; `→` is 17px; space is 5px. **Do NOT use `◉`, `▸` or `▾`**: they measure 4px, which means the firmware lacks the glyph and will render tofu.
4. Page changes use `rebuildPageContainer` (full redraw, brief flicker, fine for page turns). The in-place `textContainerUpgrade` path stays for round E's live updates. All previous container rules hold: max 12 containers, exactly one `isEventCapture: 1`, `containerName` max 16 chars, IDs unique per page.

---

#### T10 — Journey mode: handoff, stage pages, swipe navigation, background persistence

**State model.** A module-level journey state, e.g. `{ active: boolean, journey: Journey | null, stageIndex: number }`. Go on the phone sets it and triggers the glasses switch (same JS context, plain function call between modules). Register the background hooks for it at module init exactly as quoted above. Restore-order rule: if the restore callback fires after the glasses already rendered the status board, and the restored state says a journey is active, rebuild into the current stage; if it fires first, the glasses init must check the state and render the journey stage instead of the status board.

**Stages.** Derive one stage per leg of the selected journey, in order. Walking leg stage: type walk. Transport leg stage: type ride. If the LAST leg is not a walking leg, append a final synthetic stage: type arrive, text `Walk to your destination`. Do not prepend anything before the first leg.

**Page layouts (576x288, reuse the existing footer container pattern):**

- Ride stage, three text containers: header at `y:0 h:54` (two lines: `instruction.summary` pxTruncated to fit, then `Stage N of M · <duration> min`); body at `y:54 h:198` for the route bar block; footer at `y:252 h:36` with `Swipe: stages   2x tap: exit`. Body content, three lines, all left-aligned (there is no alignment control):
  1. `<departure name> → <arrival name>`: pxTruncate each name to roughly 240px so the line fits 568px inner width.
  2. The bar: `●` then `─○` per intermediate stop then `─●`. Every bar glyph is 20px, so width = `(2*stops + 1) * 20` for `stops` intermediate stops plus the two ends. If that exceeds the inner width, thin it: drop every second `○` (keeping the `─` runs) until it fits. The bar must never wrap: verify with `getTextWidth` before rendering.
  3. `<stopPoints.length> stops · arrive <HH:MM from leg.arrivalTime>`.
- Walk stage: header `Walk`; body: `instruction.summary` if present else `Walk to <arrivalPoint.commonName>`, plus `about <duration> min`; same footer.
- Arrive stage: body `Walk to your destination`; same footer.

**Input in journey mode:** swipe up = next stage, swipe down = previous, clamped at both ends (a swipe past the end does nothing). Each stage change is one `rebuildPageContainer` call, serialised through the existing raw-promise gate (extend the gate to cover rebuilds: one bridge call in flight, ever). Double tap keeps the existing exit-dialog behaviour unchanged. Foreground enter re-renders the CURRENT stage when a journey is active (not the status board). The status board refresh interval is paused for the whole time a journey is active.

**Dev hook for verification (this round only, keep it small):** support a `?dev-journey=<from>/<to>` URL query (values are icsIds or `lat,long`), active only when `import.meta.env.DEV` is true, which on load auto-plans that journey and enters journey mode with the first result. This exists so the lead can drive the glasses side in the simulator, where the phone UI cannot be clicked by automation. It must be dead code in production builds.

Acceptance criteria:

- Root and proxy builds pass; all standing grep checks stay clean; `setBackgroundState`/`onBackgroundRestore` registered top-level with matching keys, spread snapshot, `??` restores.
- Plain browser: planning and pressing Go logs the handoff and does not error (bridge-dead path stays silent beyond the info log).
- Simulator with `?dev-journey=1000129/1000031`: glasses show the first stage page; swiping up walks through every stage to the arrive page and clamps; swiping down returns and clamps; each ride page shows header, names line, bar, and stops/arrival line with no scrollbar on the body container (bar measured, not guessed); double tap still raises the exit dialog.
- Console evidence that the status refresh is paused while the journey is active and that stage changes go through the serialised bridge gate.

Effort recommendation for Jack: **high.** State machine, restore-order handling and firmware-constrained layout in one round.

### 2026-07-28 — Round D.2: unblock T10 (verified answers to Sol's two questions)

Both round D blockers were spec gaps on the lead's side. Both contracts below are verified against the installed SDK (or, for the second, against the reality that no published SDK has it).

---

#### T10b — `rebuildPageContainer`, the verified contract

Verbatim from installed `@evenrealities/even_hub_sdk@0.0.12`:

```typescript
import { RebuildPageContainer } from '@evenrealities/even_hub_sdk'
// class RebuildPageContainer {
//   containerTotalNum?: number                 // 1 to 12
//   listObject?: ListContainerProperty[]
//   textObject?: TextContainerProperty[]       // max 8
//   imageObject?: ImageContainerProperty[]     // max 4
//   constructor(data?: Partial<RebuildPageContainer>)
// }
// bridge method: rebuildPageContainer(container: RebuildPageContainer): Promise<boolean>  // true = success

await bridge.rebuildPageContainer(new RebuildPageContainer({
  containerTotalNum: 3,
  textObject: [headerContainer, bodyContainer, footerContainer],
}))
```

Identical construction pattern to `CreateStartUpPageContainer`. It is a full redraw (brief hardware flicker, expected on page turns). Text content limit on rebuild is 1000 characters per container. Route every call through the existing serialised bridge gate, same as everything else.

---

#### T10c — background persistence without the SDK helpers

Lead-verified: **no published SDK version has `setBackgroundState`/`onBackgroundRestore`** (checked every version on npm, 0.0.6 through 0.0.12; the docs describe an API newer than the release). Sol was right to refuse the import. Implement the documented host contract directly instead. The host behaviour (from project docs): before backgrounding it calls `window.__getStateSnapshot()`, which must return a JSON **string**; after loading the app afresh in the headless WebView it calls `window.__restoreState(snapshot)` with that value. Hand-roll both ends:

```typescript
declare global {
  interface Window {
    __getStateSnapshot?: () => string
    __restoreState?: (snapshot: unknown) => void
  }
}

window.__getStateSnapshot = () => JSON.stringify({ journeyMode: { ...journeyState } })  // snapshot copy, plain JSON only

window.__restoreState = snapshot => {
  try {
    const parsed = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot
    const saved = (parsed as Record<string, unknown> | null)?.['journeyMode']
    if (saved !== undefined) {
      applyRestoredJourneyState(saved)   // the prepared restore path: reassign with ?? fallbacks, then re-render if needed
    }
  } catch {
    // malformed snapshot: keep current state
  }
}
```

Register both at module init (top level), same placement rules as the original spec. Be defensive about `snapshot` arriving as a string or an already-parsed object, as shown. The snapshot format inside the string is entirely ours, so the only host-contract surface is the two function names and the round-trip, both documented. Known limitation, recorded: the migration cannot be exercised in the simulator, so this path gets verified on hardware later; and when a future SDK release ships the proper helpers we swap to them (tracked as a standing note).

---

Everything else in T10 stands as specced, including all original acceptance criteria (the simulator run now becomes possible). Effort recommendation for Jack: **medium**, the design work survived round D; this is wiring the two supplied contracts into prepared slots.

### 2026-07-28 — Round D.3: HUD-style layout revision plus tap-to-hide (T11)

Jack's direction: the journey pages must not dominate the wearer's view. Content lives in a top band and a bottom band with the middle of the display clear (the middle of the lens is the real world). The route bar moves to the bottom; everything else goes up top. Single tap hides the HUD entirely, with a 5-second `HUD hidden · tap to show` notice; tap again restores it.

---

#### T11 — Journey pages become top/bottom bands, single tap toggles the HUD

**Ride page layout (replaces the round D 54/198/36 stack):**

- Top container `header`: `x:0 y:0 w:576`, `paddingLength: 0`, `isEventCapture: 1`. Lines (27px each, height = lineCount * 27):
  1. `instruction.summary` (pxTruncated to 568px as now).
  2. `Stage N of M · <duration> min · arrive <HH:MM>` (the detail line moves up here; drop the separate stops-line).
  3. Only while `stageIndex === 0`: `Swipe: stages   Tap: hide   2x: exit` (the standing footer hint is retired; after the first stage the top band is two lines).
- Bottom container `bar`: `x:0 w:576 h:54`, `paddingLength: 0`, `isEventCapture: 0`, positioned flush to the bottom: `y: 234`. Two lines:
  1. The names line (`<departure> → <arrival>`, truncation rules unchanged).
  2. The measured bar, unchanged from round D, now with `· <stops> stops` appended after the bar if it still measures as one line at 568px; otherwise the stop count joins the top band's line 2 instead (measure, decide, never wrap).
- **The middle band (roughly y 81 to y 234) must contain no content in any ride layout.** This is the point of the revision and it is screenshot-verifiable.

**Walk page:** top band only (summary line, `about <N> min · Stage N of M`, plus the stage-0 hint line when applicable). No bottom container. **Arrive page:** top band only (`Walk to your destination`). The whole lower two-thirds of the display is clear on both.

**Tap to hide (journey mode only; the status board is unaffected):**

- Single tap (`sysEvent` with `eventType ?? 0 === 0`, the elision rule as ever) while a journey page is visible: rebuild to the hidden layout, which is ONE full-screen text container, `x:0 y:0 w:576 h:288`, `isEventCapture: 1`, content `HUD hidden · tap to show`. **A page must always keep exactly one event-capturing container or taps stop arriving, and a text container's content may not be an empty string: use a single space `' '` for the blank state.**
- 5 seconds after entering hidden state, replace the message with `' '` via `textContainerUpgrade` (flicker-free, through the serialised gate, exact `containerID`/`containerName` match as ever). Unlit pixels are transparent on hardware, so the display genuinely appears empty. Cancel this timer if anything pre-empts it (tap to show, exit, background restore).
- Single tap while hidden: rebuild back to the current stage page. Swipes while hidden are ignored. Double tap keeps its exit behaviour in BOTH states.
- Add `hudHidden` to the journey snapshot state (exporter and restorer both), so pocketing the phone while hidden restores hidden. Restore renders whichever of stage page or hidden layout the state says.

Acceptance criteria:

- Builds and all standing greps pass.
- Simulator, dev journey: ride page shows two bands with the middle band (y 81 to 234) containing zero lit pixels (lead verifies from the RGBA screenshot); the bar and names sit flush to the bottom; the hint line appears on stage 0 only.
- Single tap hides the HUD and shows the notice; after ~5 seconds the display is fully blank (zero lit pixels); a tap restores the exact current stage page; swipes while hidden do nothing; double tap still raises the exit dialog from both visible and hidden states.
- All rebuilds and the upgrade go through the serialised gate (console evidence as before).
- `hudHidden` appears in the snapshot exporter and restorer with a `??` fallback.

Effort recommendation for Jack: **medium.** The components survive; this is layout arithmetic and one well-specified state toggle.

### 2026-07-28 — Milestone 3 round E: live position and stop alerts (T12)

Jack's brief: the bar's stops fill in as the train passes them, plus two alerts above the bar on every train or bus leg: `Next stop: <name>` for 10 seconds when the destination stop becomes the next one, and `This is your stop` from 30 seconds before estimated arrival, clearing on stage change or when the 30 seconds elapse. Both alerts show even while the HUD is hidden.

**The timeline model (design decision, Sol implements exactly this):** there is no live vehicle feed in this round; position is interpolated from schedule arithmetic. For a ride leg with `departureTime`, `arrivalTime` and N `stopPoints` (boarding station excluded, arrival included), divide the interval into N equal segments: estimated arrival at `stopPoints[i]` is `departure + (i+1) * legDuration / N`. **Everything (bar fill, both alerts) is computed fresh from the clock on every tick, never from chained timers.** This is what makes the feature survive the background migration for free: the headless WebView keeps ticking with the phone pocketed, and a restore just recomputes from the journey JSON plus the clock. Nothing new goes in the snapshot.

- **Clock indirection:** every time read goes through one `now()` helper. In dev builds only, a `&dev-clock=<seconds>` addition to the dev-journey URL offsets it, so the lead can time-travel through a journey in the simulator. Production bundles must contain no `dev-clock` string (same rule as `dev-journey`).
- **Tick:** a 1-second interval evaluates state; bridge updates are sent ONLY when rendered content actually changes (a bar changes at most once per segment, alerts a few times per leg). The tick must NOT be paused on `FOREGROUND_EXIT_EVENT`: that pause is for the status board's interval only. The tick stops on exit events and while no journey is active.

**Bar fill:** passed stops render `●`, upcoming stay `○` (both 20px, so the bar's measured width is invariant; assert rather than re-measure). On thinned or capped bars, fill the displayed intermediate markers proportionally to elapsed segments. Fill state applies per displayed ride page: a future leg's page shows no fill, a completed leg's page shows full fill. Updates go through `textContainerUpgrade` against the `bar` container's exact identity (`containerID: 6`, `containerName: 'bar'`), through the serialised gate.

**The alert line, zero-flicker design:** every layout (ride, walk/top, arrive, hidden) gains one always-present text container `alert`, centred horizontally, sitting just above the bottom band (`y:166 h:27`, borderless, `paddingLength: 0`, `isEventCapture: 0`, content a single space `' '` when inactive: **empty string content is not allowed, and adding/removing containers needs a rebuild, so the container always exists and only its content changes**, pure flicker-free upgrades). Ride pages therefore have exactly 8 text containers, the platform maximum: do not add any more. The alert renders on whatever page is currently displayed (it is an alert, not page content), hidden layout included.

- **Trigger A:** when `now()` passes the estimated arrival at the penultimate stop (for a single-stop leg: at departure), show `Next stop: <arrival name>` (pxTruncated to 400px) for 10 seconds, then back to `' '`.
- **Trigger B:** when `now() >= arrivalTime - 30s`, show `This is your stop` until the user changes stage or `now() >= arrivalTime`, whichever first. B replaces A if they overlap.
- Alert text position: centred via the measured-width positioning helpers already in journey-mode.ts.

Acceptance criteria:

- Builds and standing greps pass; production bundle contains neither `dev-journey` nor `dev-clock`.
- The `alert` container exists in all four layouts with `' '` when inactive; ride pages have exactly 8 text containers, others within limits, still exactly one event capture each.
- Simulator with dev-clock offsets (lead drives): mid-leg shows partial bar fill; at the penultimate stop's estimated time the `Next stop: Brixton` alert appears and clears after 10 seconds; at T-30 `This is your stop` appears; after estimated arrival it clears; the same alerts render while the HUD is hidden.
- Console evidence: bar upgrades fire on segment transitions only, not every tick; all updates through the serialised gate.
- Swiping to a future leg's page shows an unfilled bar; back to the live leg shows current fill.

Effort recommendation for Jack: **high.** Time-derived state, cross-layout alert plumbing and careful update discipline.

### 2026-07-28 — Round E.2: even circle spacing on the route bar (T12b)

Jack's note from reviewing the live bar: the circles must be **evenly spaced**. The current connector distribution hands the remainder out unevenly (`Math.floor` proportional split), so some gaps get an extra `─`. Fix in `buildMeasuredBar`/`renderBar` (src/journey-mode.ts):

- Make the per-segment connector count uniform: `k = floor((targetGlyphCount - 2 - displayedMarkerCount) / segmentCount)`, minimum 1, and give EVERY segment exactly `k` connectors. No remainder distribution.
- The bar therefore gets slightly narrower than 520px: `width = (2 + displayedMarkerCount + segmentCount * k) * 20`. Centre it with the existing positioning helpers and keep the names anchored to the new bar ends (`bottomDeparture`/`bottomArrival` already derive from `bottomBar.xPosition` and width, so this should follow automatically; verify).
- Width invariance under live fill still holds (`●`/`○` both 20px); keep the existing assertion, updated to the computed width rather than the 520 constant.

Acceptance: builds and greps pass; simulator screenshot shows visibly uniform gaps for the nine-stop fixture; the assertion uses the computed width; live fill, alerts and thinned/capped bars unaffected. Effort: **light**, one function plus its assertion.

**2026-07-28 — Review of T12b plus journey-matrix verification. SIGNED OFF.** The spacing fix is exactly as specced: uniform connectors per segment, computed width, assertion updated; visually confirmed uniform on a 13-stop bar. And at Jack's prompting the lead ran a proper journey matrix in the simulator beyond the usual nine-stop fixture, all passing:

- **1 stop (King's Cross to Euston):** endpoints-only bar with a clean connecting line, singular `1 stop` label.
- **Bus journey (Camberwell to Peckham Rye, bus > walk > bus):** header carries the route number (`345 bus to Peckham Bus Station`), long bus-stop names truncate without collision, the mid-journey walk page renders (`Walk to The Aylesham Centre · about 5 min · Stage 2 of 4`), and the bus leg's first endpoint fills immediately since bus legs depart at once.
- **13-stop District leg (Earl's Court to Upminster):** marker sampling engages (12 displayed for 13 stops), spacing perfectly uniform post-T12b, count stays honest at `13 stops`.
- **National Rail leg (c2c to Upminster):** mode summary and rail station names all render correctly.

Hosted copy redeployed with T12b. The glasses journey experience is now verified across short, long, bus, walk-between and rail stage types.

### 2026-07-28 — Round F: hardware hotfix, keyboard covers the suggestions (T13)

First field bug, found by Jack on real hardware: in the Even app's WebView, the on-screen keyboard covers the suggestion list under the From/To inputs and the page cannot be scrolled to reach it, so a journey cannot be started. Desktop browsers and the simulator never show a keyboard, which is why every prior test missed it. Phone-side fix only; no glasses code.

#### T13 — Keep the suggestion list visible above the keyboard

Four changes in `index.html` / `src/phone.ts` / `src/styles.css`:

1. **Viewport meta:** change to `content="width=device-width, initial-scale=1.0, interactive-widget=resizes-content"`. On Chromium-based WebViews (Android) this makes the keyboard shrink the layout viewport instead of overlaying it, which fixes the "cannot scroll" half of the bug on its own.
2. **Scroll the active field up on focus:** on `focus` of either search input, after a ~300ms delay (keyboard settle), `scrollIntoView({ block: 'start', behavior: 'smooth' })` the field's containing `.station-field`, so input plus suggestions occupy the space above the keyboard. Repeat once when suggestions first render for that focus.
3. **Constrain the dropdown to the visible viewport:** when showing suggestions, set the list's `max-height` from the VisualViewport API: `window.visualViewport.height` minus the list's `getBoundingClientRect().top` minus a 12px margin, floored at 120px, with `overflow-y: auto` so the list scrolls internally. Recompute on `visualViewport` `resize` and `scroll` events while the list is open (remove listeners on hide). Fallback when `window.visualViewport` is undefined: `max-height: 40vh`. iOS WKWebView does not resize the layout viewport for keyboards, so this VisualViewport path is what saves iOS.
4. **No scroll locking:** verify nothing (CSS `overflow: hidden` on body/app-shell, or touch handlers) prevents page scrolling while the keyboard is open; fix if found.

Also bump `version` in `app.json` to `0.1.1` (the store upload is per-version; the fix ships as a new upload).

Acceptance criteria:

- Builds and standing greps pass.
- Playwright with a keyboard-sized viewport (390x350): typing in From shows the suggestion list fully inside the viewport, internally scrollable, and an option at the list's bottom can be clicked. Same for To. No regression at full height (390x844) or desktop width.
- The suggestions list never renders taller than the visual viewport allows (assert via bounding rect in the test).
- Real verification is Jack retesting on hardware after re-upload; the criteria above are the best pre-hardware proxy we have.

Effort recommendation for Jack: **medium.** Small surface, but viewport behaviour differs per platform and the code must degrade gracefully.

**2026-07-28 — Review of round F (T13). SIGNED OFF.** Lead-verified with Playwright at a keyboard-sized 390x350 viewport: on focus the station field scrolls to the top, the suggestion list constrains itself to the visual viewport (256px in the test run, bounding box fully inside the visible area), and the bottom-most option can be scrolled to and clicked, the exact interaction that was impossible on hardware. Full-height and desktop regress clean with no page errors. Code review: spec implemented faithfully with good judgement beyond it (stale-focus guards on the delayed scrolls, per-focus scroll-once tracking, VisualViewport listeners installed only while the list is open and removed on hide, 40vh fallback). Sol's scroll-lock audit found nothing to remove, consistent with the lead's read. Version bumped to 0.1.1. Hosted copy redeployed; a fresh `.ehpk` will be packed when Jack asks for it. Final verdict rests with Jack's hardware retest.

### 2026-07-28 — Queued, not yet tasked: phone UI restyle

Jack likes the phone app's polish but it is not his vibe. A visual revision round is queued, **blocked on Jack providing reference examples** (apps or sites whose look he wants, plus specific dislikes about the current design). The lead will translate the examples into a concrete restyle spec for Sol once they arrive. Functionality, markup structure and accessibility are to be preserved; this is a skin, not a rebuild.

---

---

## Execution notes

(Sol's section. Sol: append dated entries here. What you did per task, decisions you took, anything that surprised you, anything you could not verify.)

**2026-07-28 — T2/T3 implementation**

- **T2:** Replaced the single full-screen startup text container with the specified `status` (576x252, sole event-capturing container) and `footer` (576x36, non-event-capturing) containers. The startup call remains a single lifetime call and logs its numeric result directly.
- **T2 blocker / question for the lead:** Input and lifecycle event wiring is not implemented because the task does not quote the SDK method used to subscribe to events, its callback/event shape, or the unsubscribe return/signature, and the known-good `src/main.ts` contains no event example. Please provide the exact, hardware-verified subscription and unsubscription code/signatures needed for text and system events. In particular, I need the event envelope fields required to distinguish text swipes from system taps/lifecycle events. I did not infer or inspect undocumented SDK behaviour.
- **T3:** Added the keyless TfL status fetch using one exported `API_BASE`, API-order rendering with names truncated/padded to 13 characters, a 475-character display budget with truncation logging, immediate initial refresh, and a guarded 60-second refresh interval. Updates use only `textContainerUpgrade` with the exact startup container identity and full-replacement offsets.
- **T3 reliability:** Serialised the fetch/update refresh path with `isUpdating`, wrapped startup and text bridge calls in a five-second `Promise.race` timeout, retained the last good board on failures, and attempts to append a stale-age marker. Invalid/non-array/no-usable-status responses are treated as failures.
- **T3 blocker / question for the lead:** The task's quoted `bridge.textContainerUpgrade({ ... })` call does not type-check against the installed `@evenrealities/even_hub_sdk@0.0.12`. TypeScript reports `TS2345`: the object is not assignable to `TextContainerUpgrade` because required property `toJson` is missing. Please provide the exact documented import/construction form for `TextContainerUpgrade` (or confirm that a specific type workaround is hardware-verified). I did not guess a constructor or suppress the error.
- **Decision beyond the spec:** Until event subscription details are supplied, the refresh interval cannot pause in background or refresh specifically on foreground entry. It starts once after startup and continues every 60 seconds.
- **Verification:** `npm run build` was run and currently fails at `src/main.ts:130` with the `TS2345` SDK-contract mismatch above; Vite therefore did not run. Grep found exactly one source call to `createStartUpPageContainer`, only `textContainerUpgrade` in the refresh path, an explicit `isUpdating` overlap guard, no `rebuildPageContainer`, no event-field reads, and no occurrence of `window.localStorage`, `localStorage.`, `indexedDB`, `TFL_APP_KEY`, or `VITE_` in `src/`. `git diff --check` passed. The glasses simulator, double-tap exit dialog, foreground/background behaviour, network-off recovery, and comparison against the live TfL status page could not be verified while the build is blocked.
- **Surprises:** None beyond the missing SDK event-subscription contract described above. No storage API or client-side TfL key/environment variable was added.

**2026-07-28 — Round 2: T3b, T2b, T3c**

- **T3b:** Imported `TextContainerUpgrade` and changed the status update to pass `new TextContainerUpgrade({ ... })` with the existing exact container identity and full-replacement offsets. Added the review-requested guard so a nonzero startup result logs an error and does not subscribe or start refresh work. `npm run build` passed immediately after this task.
- **T2b:** Subscribed with `bridge.onEvenHubEvent`, checking `textEvent` before `sysEvent`. Both `eventType` reads use `?? 0`. Swipe up/down and single tap log; double tap calls `shutDownPageContainer(1)` without cleanup; foreground exit clears and logs the paused interval; foreground enter logs, triggers an immediate refresh, and resumes the interval without duplicating it; abnormal/system exit pause the interval and call the returned `unsubscribe`. `npm run build` passed after this task.
- **T3c:** Added module-level `bridgeCallPending`. `updateStatusContainer` assigns the raw `textContainerUpgrade` promise to that gate, attaches cleanup to the raw promise's true settlement, and races that same raw promise only for the caller's five-second wait. While the raw promise remains unsettled, later status sends are skipped with the distinct log `Skipping status update while the previous raw bridge call is still pending`. A skipped send returns `false`, so it is not incorrectly recorded as the latest successfully displayed board.
- **Decisions beyond the spec:** Applied the same raw-promise pending principle to repeated exit-dialog requests so a timed-out `shutDownPageContainer` call cannot be duplicated while its raw call remains unresolved. Exit-dialog failure/timeout is logged.
- **Verification:** Final `npm run build` passed (TypeScript and Vite). Grep confirmed one source call to `createStartUpPageContainer`, no `rebuildPageContainer`, only `textContainerUpgrade` in the refresh path, both `eventType` reads using `?? 0`, the raw-promise bridge gate, and no forbidden browser storage, `TFL_APP_KEY`, or `VITE_` occurrence in `src/`. `git diff --check` passed before the final notes append.
- **Could not verify / question for the lead:** The local Vite server launched successfully after permission was granted, but the plan's simulator command `npx evenhub-simulator http://127.0.0.1:5173` failed with npm `E404` because it tried to download the nonexistent unscoped package `evenhub-simulator`. The installed scoped simulator package exposes only an `evenhub` binary. Please provide the verified simulator CLI invocation/subcommand. Therefore the visual two-container render, live TfL comparison, gesture/exit-dialog behaviour, lifecycle events, and network-off recovery remain unverified in the simulator this round.
- **Surprises:** The supplied simulator command does not resolve to the installed scoped package's binary; no SDK behaviour was inferred to work around it. No location API, proxy, milestone 2 work, client key, or Vite-prefixed environment variable was touched.

**2026-07-28 — T4: TfL proxy service**

- **Implementation:** Added a standalone TypeScript service under `proxy/` with its own package manifest, lockfile, TypeScript configuration, and zero runtime dependencies. It uses `node:http` and built-in `fetch`, requires the TfL key at startup, defaults to port 8100, and exposes `GET /healthz` plus the allowlisted `/tfl/` forwarding routes.
- **HTTP/security behaviour:** GET and OPTIONS are the only accepted methods; every response receives wildcard CORS; preflight returns 204 with the specified allow headers/method; nonallowlisted paths return 404 before fetch; other methods return 405. Upstream calls have a 15-second abort timeout, generic 504/502 failures, preserve only the upstream `content-type`, and return the upstream status/body. A client-supplied `app_key` is discarded before the server-side key is set.
- **Secret handling:** The key is read only from the process environment and is never logged. Request logs contain `requestUrl.pathname` only, never the query. Upstream response text is defensively redacted before being returned in case TfL echoes the requested URL. The real key was sourced from the repo-root `.env` only for the local process and was not copied. A check confirmed it was absent from saved live response bodies and source text.
- **Container files:** Added a `node:22-alpine` Dockerfile that installs from the lockfile, builds, and starts `dist/server.js`; Compose defines only `transit-proxy`, uses `restart: unless-stopped`, reads `.env`, publishes no ports, and joins external `connect-remote_default`. `.dockerignore` excludes dependencies, build output, logs, and `.env`.
- **Verification passed:** `npm run build` passes. Missing-key startup exits 1 with a clear generic message. Live local curls returned `200 {"ok":true}` for health, a TfL line-status JSON array with 11 entries and HTTP 200, 404 for `/tfl/Line/1`, 405 for POST, and 204 for OPTIONS. Checked responses carried `Access-Control-Allow-Origin: *`; preflight also carried the required allow-methods/headers. Logs showed paths without queries. `git diff --check` passed.
- **Upstream surprise:** The specified journey acceptance URL was forwarded, but TfL returned HTTP 300 with `fromLocationDisambiguation` / `toLocationDisambiguation` rather than a `journeys` array. This is an upstream response for those identifiers, not a proxy-generated error; status and JSON were passed through as required.
- **Could not verify:** `docker build proxy/` could not run because Docker is not installed in this environment (`docker: command not found`). The local host is Node 20.13, so local curl tests ran on Node 20; the production Node 22 path is represented by the unexecuted Dockerfile. Timeout and forced upstream-network-failure responses were verified by code inspection rather than induced against the live TfL host. The lead needs to run the Docker acceptance check before T5.
- **Scope:** No application/client files or root package metadata were changed, and no T5 deployment work was started. The only non-`proxy/` edit for T4 is this required Execution notes entry.

**2026-07-28 — T6/T7: live proxy client and phone-side planner**

- **T6:** Swapped the client `API_BASE` to `https://transit.berrydev.co.uk/tfl` and changed the proxy container command to direct `node dist/server.js` execution for correct signal handling. The root and proxy builds both passed immediately after this task; no direct TfL origin remains in `src/`.
- **T7 structure:** Added semantic phone UI markup to `index.html`, mobile-first dark-theme styling in `src/styles.css`, and the phone controller/data rendering in `src/phone.ts`. `initializePhoneUi(API_BASE)` now runs synchronously before `initializeGlasses()` is fired without awaiting it. The previous bridge startup, container layout, event handling, refresh, timeout, and raw-promise gating logic were moved intact inside that async glasses function with a top-level catch that emits only `Glasses bridge unavailable` if the bridge rejects.
- **Station search:** Added independent From/To autocomplete controls with 300 ms debounce, cancellation of stale requests, URL-encoded search paths, the exact train/bus modes filter, inline failure/empty states, selectable results, and distinct mode chips. Selection stores the complete match, and journey construction uses only `icsId`.
- **Timing and planning:** Added Now / Leave at / Arrive by segmented timing with local `YYYYMMDD` / `HHmm` formatting and the verified `timeIs` values. Planning starts the default and bus-only journey fetches together with `Promise.all`; HTTP 300 gets the required stop-identification message, request failures get an inline retry message, and empty default journeys show `No routes found`.
- **Options:** Fastest is selected only from the default response; cheapest is selected from all fare-bearing default and bus journeys. Structurally identical fastest/cheapest routes collapse to one labelled card. Cards show large duration, formatted/absent fare, departure and arrival times, distinct mode chips, named change points, and a Go button. Go assigns the full journey to the module-level `selectedJourney`, logs `Journey selected`, and updates the selected-card state. No persistence or unverified per-line data was added.
- **Design decisions:** Kept the planner a focused single-column flow at all sizes, used a restrained green transit palette with each specified travel mode receiving a separate chip colour, capped station suggestions at eight, and retained a usable fastest card with an explanatory note if TfL returns no fare-bearing option for cheapest.
- **Verification passed:** Final root and proxy builds pass; `git diff --check` passes. Grep confirms no direct TfL origin, browser storage API, `VITE_`, or TfL key in `src/`; exactly one startup-page call remains; both event-type reads retain `?? 0`; Docker now uses the direct Node command. The Vite preview returned HTTP 200 with all core phone controls in its HTML.
- **Live data verification:** Through the deployed proxy, `kings` returned King's Cross & St Pancras International with `icsId: 1000129` and mode data; Brixton returned `icsId: 1000031`. Default and bus-only journeys both returned HTTP 200 with plausible priced routes (17-minute/£3.10 Tube fastest and 62–63-minute/£1.75 bus cheapest in this run). A future `Arriving` request for 09:00 returned journeys arriving at 08:56, 08:58, and 09:00, confirming the timing format.
- **Could not verify:** No controllable in-app or Chrome browser was available, so I could not visually inspect the responsive layout or exercise typing, suggestion clicks, Plan, and Go through an actual DOM session. I also did not run the glasses simulator; the lead must verify the unchanged status board and the plain-browser no-bridge console criterion. These limitations are tooling availability, not claimed passes.
- **Scope:** No glasses SDK facts beyond the already approved code were introduced, no M3 handoff was implemented, and no commit or push was made.

**2026-07-28 — T8/T9: Photon geocoding and merged destination search**

- **T8 proxy:** Added `GET /geocode` backed by Photon and factored the existing upstream request path into a shared `forwardJson` helper, so Photon and TfL use the same 15-second abort, generic 504/502 handling, CORS, status/body passthrough, content-type-only upstream header policy, and defensive key redaction. Photon requests set only the trimmed `q`, `limit=6`, and fixed central-London bias (`lat=51.5074`, `lon=-0.1278`); client coordinates are ignored.
- **T8 validation:** Proxy build passes. Local `ministry of sound` returned HTTP 200 GeoJSON with Ministry of Sound first (`nightclub`, coordinates `[-0.0994957, 51.4977677]`), correct CORS/content type, and blank whitespace-only `q` returned 400. Re-ran T4 regressions: health 200, Tube status 200, blocked path 404, POST 405, OPTIONS 204 with the required CORS headers. Logs contained `/geocode` and route paths only, never queries.
- **T9 search model:** Extended each existing debounced search to start TfL stop and Photon place requests together with `Promise.allSettled`, sharing one abort signal and the existing stale-input guard. If one provider fails, the fulfilled provider's results still render; only two failures show an inline search error. Station matches remain capped at eight and places are capped at five.
- **T9 rendering:** Suggestions are grouped in fixed order under `Stations & stops` and `Places`. Stop rows retain mode chips. Place rows show the Photon name, `osm_value` type badge, and street plus postcode/city secondary text. Updated both input hints to mention stations, bars, and venues and added matching dark-theme styles without changing the planner layout.
- **T9 endpoints:** Introduced a discriminated selection type. Stops preserve the entire TfL match and use its `icsId`; places preserve the shaped Photon match including `{name, lat, lon}` and use `${lat},${lon}`. Photon `[lon, lat]` is explicitly flipped during shaping. From and To both consume the same union, while all timing, dual journey fetch, fastest/cheapest, card, fare, and Go logic remains unchanged.
- **T9 live data validation:** Local Photon search for `french house` returned the Soho French House first as a `pub` at `[-0.1317144, 51.5127395]`. King's Cross (`icsId: 1000129`) to the flipped coordinate returned HTTP 200 with a final walking leg to Dean Street. A place-to-place request from Ministry of Sound coordinates to the French House also returned HTTP 200, with walking legs at both ends and the same journey/fare shape used by the existing cards.
- **Verification passed:** Final root and proxy builds pass and `git diff --check` passes. Round B grep checks remain clean: no direct TfL origin, browser storage, `VITE_`, or TfL key in `src/`; one glasses startup call; event reads still use `?? 0`. No glasses code was changed.
- **Could not verify / deployment dependency:** No controllable browser is available in this environment, so grouped suggestion visuals and the click-through UI flow were not exercised in a real DOM session. The deployed proxy does not have T8 until the lead deploys this round, so the production-base client cannot use `/geocode` before that deployment. The lead should deploy/rebuild the proxy, then verify `kings` ordering, French House selection, stop-to-place planning, and place-to-place planning in Chrome.
- **Scope:** No persistence, new dependency, SDK behavior, M3 glasses handoff, commit, push, or deployment was added.

**2026-07-28 — T10 partial: journey handoff and static stage content**

- **Implemented:** Installed `@evenrealities/pretext@0.1.4`; added the module-level `{ active, journey, stageIndex }` state; passed the selected plain-JSON journey from the phone Go handler into `enterJourneyMode`; paused status refresh while active; routed journey swipes through clamped stage-index changes; preserved double-tap exit; and made foreground entry request the current stage rather than the status board. If journey state exists before glasses startup (including the development loader), the single lifetime startup call creates the current journey page instead of the status board.
- **Stage derivation and layouts:** Added one walk/ride stage per leg and a synthetic arrive stage only when the last leg is not walking. Ride pages use the specified 54/198/36 geometry and three text containers; walk pages use the same header/body/footer pattern; arrive uses body/footer. Exactly one container captures events on every layout. The two-line 54px header uses zero padding so two verified 27px lines fit; body/footer retain 4px padding and the specified 568px inner width where measured.
- **Measured content:** Ride headers, station names, detail lines, walk text, and the route bar use `getTextWidth`, `measureTextWrap`, and `pxTruncate`. The bar uses only `●`, `○`, and `─`, retains every line segment while progressively thinning intermediate circles, and refuses to return a wrapping bar. The footer is exactly `Swipe: stages   2x tap: exit`. A live `1000129/1000031` fixture derived `ride, arrive`; every emitted line measured as one line at 568px, with the nine-stop bar measuring 380px.
- **Development hook:** Added the development-only `?dev-journey=<from>/<to>` loader, which fetches the first journey and enters journey mode before glasses initialisation. A production build contains no `dev-journey` string.
- **Background-state blocker / question for the lead:** The Plan's verbatim imports do not exist in the installed `@evenrealities/even_hub_sdk@0.0.12`. Importing them produces `TS2305: Module '"@evenrealities/even_hub_sdk"' has no exported member 'setBackgroundState'` and the same error for `onBackgroundRestore`. I left the state restore function prepared with a reassignment and `??` fallback per field, but did not register invented hooks. Please provide the exact verified import module/package version, or explicitly direct an SDK upgrade.
- **Page-rebuild blocker / question for the lead:** The Plan names `rebuildPageContainer` but does not quote its method signature, required parameter class/import, argument shape, or return contract. I did not infer these from the method name or inspect SDK documentation. Please provide the exact verified construction and call. Until then, post-startup Go, restore-after-init, foreground re-render, and stage swipes update state and pause refresh but cannot redraw the glasses page; `requestJourneyRender` logs that this path is blocked.
- **Verification:** Root `npm run build` and proxy `npm run build` pass; `git diff --check` passes. The installed versions are SDK `0.0.12` and pretext `0.1.4`. Standing checks remain clean: no direct TfL origin, browser storage, `VITE_`, or TfL key in `src/`; one startup-page call; event reads use `?? 0`. The new dependency emitted only the existing Node-engine warning during install.
- **Could not verify:** The simulator acceptance, stage rebuild serialisation, background snapshot/restore in both ordering cases, and a real post-startup phone Go redraw depend on the two missing verified SDK contracts above. I did not mark those criteria met. No milestone 3 round E work, deployment, commit, or push was performed.

**2026-07-28 — Round D.2: T10b/T10c completion**

- **T10b rebuild wiring:** Imported the supplied `RebuildPageContainer` class and replaced the blocked render stub with `bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum, textObject }))`. Go-after-startup, foreground entry, restored active state, and accepted stage swipes now rebuild the current static stage. Rebuild failure/timeout is logged without releasing the raw-promise gate early.
- **Single bridge gate:** Factored status upgrades, journey rebuilds, and the exit-dialog request through one raw-promise gate. Status sends still skip while busy. Journey renders queue the latest required redraw and flush only when the true raw call settles. Stage swipes are ignored while a bridge call/render is pending, so each accepted index change produces exactly one serialised rebuild; clamped end swipes still do nothing. Exit requests queue behind an existing raw call and take priority over a queued journey redraw, preserving double-tap behaviour without concurrent BLE calls.
- **Refresh isolation:** Journey activation pauses the interval, and status refresh now checks journey state both before fetching and before either the normal or stale-marker bridge update. This closes the race where a status request started just before Go could repaint over a journey page.
- **T10c host persistence:** Registered `window.__getStateSnapshot` and `window.__restoreState` at module initialisation before phone/glasses event setup. The getter returns a JSON string containing the spread plain-JSON journey state under `journeyMode`. The restorer accepts a string or parsed object, ignores malformed input, and reassigns all three state fields with `??` fallbacks. A state-version check covers restore during asynchronous startup: state present before startup is used by the single startup-page call, while state arriving after the startup layout was chosen queues a rebuild.
- **Decision beyond the spec:** A synthetic 50-stop leg showed that removing every circle still cannot fit once the remaining line glyphs alone exceed 568px. Added a final measured compressed-bar fallback that retains both endpoints, up to twelve intermediate markers, and the exact stop count in the detail line. The 50-stop test bar measured 540px on one line with no wrap; the original nine-stop fixture remains unchanged at 380px.
- **Verification passed:** Root and proxy builds pass; `git diff --check` passes. Standing greps remain clean: one startup call, both event reads use `?? 0`, no direct TfL origin, browser storage, `VITE_`, TfL key, or forbidden route glyphs in `src/`; the production bundle contains no `dev-journey` string. Synthetic ride, arrive, and walk pages all measured at one line per emitted content line, including the long-leg fallback.
- **Runtime verification limits:** Rebuilt the previously missing simulator link, launched Vite and the simulator successfully with `?dev-journey=1000129/1000031`, then stopped both cleanly. This environment exposes no verified simulator-control contract, so I did not claim visual page turns, gesture clamping, or exit-dialog rendering. Per D.2, the actual host background migration cannot be exercised in the simulator and remains for hardware verification. No open SDK questions remain.
- **Scope:** No round E work, deployment, commit, or push was performed. The unrelated `.claude/settings.json` modification remains untouched.

**2026-07-28 — Round D.3: T11 HUD bands and tap-to-hide**

- **HUD band layouts:** Replaced the stacked journey layout with a measured top band and optional bottom band. Ride top content is two 27px lines, plus the hint only on stage 0; the sole event-capturing `header` container is therefore 54px or 81px high at `y:0`. The two-line non-capturing `bar` container is fixed at `y:234 h:54`, leaving the middle entirely container-free. Walk pages use only their two/three-line top band, and arrive uses one 27px top line; neither creates a bottom container.
- **Ride content:** Moved arrival time into `Stage N of M · <duration> min · arrive <HH:MM>`. The names line and measured bar remain at the bottom. The stop count is appended to the bar only when the combined line measures within 568px; otherwise it is appended to the top detail. The live nine-stop fixture measures 461px with its count on the bar. The synthetic 50-stop fallback remains 540px and moves `50 stops` to the top detail. Every generated fixture line reports one measured line with no wrap.
- **Tap-to-hide:** Added the one-container hidden page (`hidden`, ID 1, full 576x288, sole event capture) with `HUD hidden · tap to show`. A journey-mode single tap toggles hidden/visible and rebuilds the latest state; status-board single taps remain unchanged. Hidden swipes return before changing stage. Double tap still uses the existing exit path in either state.
- **Notice clear and serialisation:** After a successful hidden rebuild (or hidden startup), a five-second timer queues a full-replacement `textContainerUpgrade` against the exact `hidden` identity with content `' '`. The upgrade, all rebuilds, status updates, and exit requests share the raw-promise gate. Exit remains highest priority, journey redraws next, and a queued notice clear flushes only after the true raw call settles. Tap-to-show, exit, foreground/background transition, and restore cancel the timer/queued clear; a state change during an in-flight clear queues the correct rebuild behind it.
- **Persistence and restore:** Added `hudHidden` to the journey state, explicitly included it in the spread snapshot exporter, and restored it with `s.hudHidden ?? journeyState.hudHidden`. New journeys start visible. A restored hidden journey starts/rebuilds hidden and receives a fresh five-second notice timer; restore cancels any timer from the state it replaces.
- **Defensive correction:** Wrapped stage construction inside the render flush, so the previously noted measurement-invariant exception is logged rather than becoming an unhandled rejection.
- **Verification passed:** Root and proxy builds pass; `git diff --check` passes. Standing greps remain clean: one startup call, both event reads use `?? 0`, and no direct TfL origin, browser storage, `VITE_`, TfL key, or forbidden route glyph appears in `src/`; the production bundle contains no `dev-journey` string. Vite and the simulator both launched with the specified dev journey and were stopped cleanly.
- **Could not verify:** This environment still has no verified simulator-control contract, so I did not claim the RGBA zero-lit-pixel screenshots, injected tap/swipe sequence, five-second visual blanking, or exit-dialog behaviour. The lead needs to run those simulator acceptance checks. Host background migration remains hardware-only as already recorded. No SDK questions arose.
- **Scope:** No round E live-position work, deployment, commit, or push was performed.

**2026-07-28 — Jack-requested train HUD alignment refinement**

- **Top row:** Replaced the ride page's multi-line header with three independently positioned, measured one-line containers: route summary flush left, `Arrive <HH:MM>` globally centred, and `Stage N of M` flush right. Duration is no longer shown on the train HUD. The live Victoria fixture resolves to route `x:0 w:193`, arrival `x:236 w:103` (centre 287.5), and stage `x:472 w:104` (right edge 576). Long route summaries are px-truncated to preserve a measured 10px gap before the centred arrival.
- **Instructions:** Removed `Swipe: stages   Tap: hide   2x: exit` from every ride page. It remains only on a first walking stage (`Walk to station` flow); later ride/arrive pages do not show it.
- **Bottom alignment:** Split the bottom band into separately measured station-name and route-bar containers at `y:234` and `y:261`, each positioned from its actual firmware width so it is horizontally centred. For the live fixture, the names line is `x:40 w:496` and the bar/count line is `x:57 w:461`. The stop count now always stays with the graphic; long bars thin/compress within the remaining measured width so the combined graphic/count line remains centred and never wraps (synthetic 50-stop line: `x:11 w:553`).
- **Container constraints:** Ride pages now use five text containers, within the verified maximum of eight: route (the sole event-capturing container), arrival, stage, names, and bar. All names remain under 16 characters, IDs are unique, padding/borders are zero, and the middle remains completely container-free.
- **Verification:** Root and proxy builds pass and `git diff --check` passes. Live and synthetic fixture measurements confirm no overlaps or wraps, exact left/centre/right top placement, independently centred bottom lines, and walking-only instructions. Standing greps remain clean: one startup call, both event reads use `?? 0`, no forbidden storage/key/env/origin/glyph usage, and no production `dev-journey` hook.
- **Could not verify:** Visual simulator screenshots were not captured in this environment; the lead should confirm the revised alignment on the simulated firmware renderer. No SDK questions arose, and no round E work, deployment, commit, or push was performed.

**2026-07-28 — Jack-requested centred standalone text refinement**

- **Implementation:** Top-only journey pages now render each line in its own measured container and centre it horizontally. This centres the `Walk to station` summary, its detail line, its walk-only instruction line, and the arrive-page text. The train page deliberately retains its requested left/centre/right top-row layout.
- **Measurements:** The live walk fixture places `Walk to Victoria station` at `x:190 w:195`, `about 7 min · Stage 1 of 3` at `x:177 w:221`, and the instruction hint at `x:143 w:290`. `Walk to your destination` resolves to `x:185 w:206`.
- **Container constraints:** The first top line remains the sole event-capturing container; walk pages use at most three containers, with unique IDs, short names, and zero padding/borders.
- **Verification:** Root and proxy builds pass and `git diff --check` passes. Standing greps remain clean. The measured fixture output confirms the horizontal positions; no visual simulator screenshot was captured, so the lead should confirm the centring on the simulated firmware renderer. No SDK questions arose, and no round E work, deployment, commit, or push was performed.

**2026-07-28 — Jack-requested HUD spacing and band refinement**

- **Train header:** Added 12px left/right insets and changed the three measured labels to a space-between layout. The remaining width after measuring route, arrival, and stage labels is divided equally between the two internal gaps; long route summaries are still px-truncated with a guaranteed 10px minimum gap. The live fixture renders `Victoria line to Brixton`, `Arrive 17:58`, and `Stage 1 of 2` with visibly balanced spacing and neither edge touching the canvas.
- **Station names:** Removed the arrow and split departure and arrival into their own full-width measured, centred lines at `y:207` and `y:234`; the centred bar/count remains at `y:261`. Each name can now use the full 568px safe width before truncation. Ride pages use six text containers, below the verified maximum of eight, with the route container remaining the sole event capture.
- **Walk controls:** Removed the stage-zero controls from the top-line stack and placed them in a separate centred bottom container at `y:261`. The walk summary and duration/stage stay centred at the top, leaving the middle clear. Later walk stages and the arrive page still omit the controls.
- **Verification:** Root and proxy builds pass; `git diff --check` and all standing safety greps pass. Simulator startup returned 0 for both fixtures with no page errors. The live train screenshot shows balanced header spacing, two complete centred station-name lines, and a centred bar; the place-to-place screenshot shows two top lines and the controls alone at the bottom. The simulator approximates the hardware font, so final feel remains subject to hardware confirmation.
- **Scope/questions:** No SDK behaviour was added or inferred, no questions arose, and no round E work, deployment, commit, or push was performed.

**2026-07-28 — Jack-requested train-line endpoint labels**

- **Implementation:** Kept departure and arrival in separate measured containers but returned them to one shared row at `y:234`, directly above the route line. Departure is inset-left and arrival inset-right, making them visual anchors for the line endpoints. Each gets up to 270px, with a measured 12px minimum gap between the two halves.
- **Name cleanup:** A case-insensitive trailing `Underground Station` is removed before measuring and truncating; no other part of the TfL name is altered. The live labels therefore render as `King's Cross St. Pancras` and `Brixton`.
- **Verification:** Root and proxy builds pass; `git diff --check` and standing safety greps pass. Simulator startup returned 0 with no page errors, and the screenshot confirms both names fit on one row at opposite ends without overlapping the centred bar below. The simulator font remains an approximation pending hardware confirmation.
- **Scope/questions:** The approved top row, walk layout, input handling, bridge serialisation, and persistence are unchanged. No SDK question arose, and no round E work, deployment, commit, or push was performed.

**2026-07-28 — Jack-requested wide route graphic and centred stop count**

- **Bottom-band layout:** Moved the two endpoint-name containers to `y:207`, the route graphic to `y:234`, and a new standalone stop-count container to `y:261`. The count no longer competes with the graphic and is horizontally centred.
- **Route width:** Expanded the measured glyph bar to 520px, which is 90.3% of the 576px canvas, centred from `x:28` to `x:548`. Extra `─` glyphs are distributed evenly across the route segments rather than accumulated at one end. Existing marker thinning/compression still runs first for unusually long legs, after which the surviving graphic expands safely to the target width without wrapping.
- **Endpoint alignment:** Departure and arrival remain separate, capped at 270px, and are positioned against the exact left/right bounds of the rendered bar. In the live fixture, `King's Cross St. Pancras` begins above the left illuminated circle and `Brixton` ends above the right illuminated circle.
- **Verification:** Root and proxy builds pass; `git diff --check` and standing safety greps pass. Ride pages now use seven text containers, within the verified maximum of eight, with the route header still the sole event capture. Simulator startup returned 0 with no page errors and visually confirmed the three-row bottom band, full-width line, endpoint relationship, and centred `9 stops`.
- **Scope/questions:** The top row, walk layout, input handling, bridge serialisation, persistence, and hide/show flow are unchanged. No SDK question arose, and no round E work, deployment, commit, or push was performed.

**2026-07-28 — Jack-requested final train-header swap**

- **Implementation:** Swapped the measured arrival and route-summary slots. `Arrive <HH:MM>` now occupies the padded left position, the route summary is the centred item, and `Stage N of M` remains right. The existing space-between calculation still divides the remaining width equally between both internal gaps and truncates safely when needed.
- **Verification:** Root and proxy builds pass; `git diff --check` and standing safety greps pass. Simulator startup returned 0 with no page errors and visually confirmed `Arrive 18:08` left, `Victoria line to Brixton` centred, and `Stage 1 of 2` right. The approved three-row bottom band is unchanged.
- **Scope/questions:** No SDK behaviour, journey logic, walk layout, persistence, input handling, round E work, deployment, commit, or push was added. No questions arose.

**2026-07-28 — T12 live position and stop alerts**

- **Clock and lifecycle:** Added one `now()` indirection for every current-time read and a development-only `dev-clock` offset configured before phone/journey initialisation. Journey mode now owns a one-second live tick that recomputes from the journey JSON and clock, starts only for an active journey, continues across foreground exit, and stops on system/abnormal exit or when no journey remains.
- **Live bar:** Reworked the fixed 520px bar so passed stop markers fill from interpolated segment ETAs while future markers remain hollow. Long legs retain a proportional, evenly sampled marker set and invariant glyph width. A ride before departure is completely hollow, including its first endpoint; a completed ride is completely filled. Content-only updates target the exact `bar` identity (`ID 6`, name `bar`) and are queued only when the rendered string changes.
- **Alerts and layouts:** Added the always-present borderless `alert` container (`x:88 y:166 w:400 h:27`, `ID 8`, name `alert`) to ride, walk/top, arrive, and hidden layouts, using the required single space while inactive. Ride pages now use exactly eight text containers and every layout still has exactly one event-capturing container. The penultimate-stop calculation shows `Next stop: <arrival name>` for up to ten seconds; the T-30 window shows `This is your stop` with precedence, clears at arrival, and is dismissed on a stage change.
- **Serialisation:** Alert and bar upgrades use `TextContainerUpgrade` inside the existing raw-promise bridge gate. Exit, rebuild, live upgrade, and hidden-notice work retain explicit priority; rebuild completion refreshes rendered live state before another update is considered, preventing stale or concurrent sends.
- **Decisions beyond the literal spec:** Because alert changes must be content-only, the alert container stays at a fixed centred 400px position and the measured line is centred within it using measured leading-space width. The live TfL journey returned slightly different departure choices between repeated requests during time-offset testing, so simulator launches calculated offsets immediately before launch; no production logic depends on that test technique.
- **Verification:** Root and proxy builds pass and `git diff --check` passes. The production bundle contains neither `dev-journey` nor `dev-clock`; standing storage, key, origin, event-elision, startup-count, and route-glyph checks remain clean. Simulator startup returned 0 without errors. Screenshots verified a partial current-leg bar, `Next stop: Brixton Underground Station`, its ten-second clear, centred `This is your stop`, the alert retained on the hidden HUD, stage-change clearing, a completely hollow future London Bridge-to-Canary Wharf leg, and the partial current leg restored on swipe back. Arrival produced one alert-clear upgrade and one final bar upgrade. Console evidence showed bar/alert upgrades only at content transitions and every rebuild/upgrade entering the serialised bridge gate.
- **Could not verify / questions:** The simulator cannot verify continued ticking during the real phone background migration or final rendering on G2 hardware; those remain for lead/hardware verification. No SDK question arose, and no SDK documentation was consulted. No deployment, commit, or push was performed.

**2026-07-28 — Jack-requested glasses-wide station-name cleanup**

- **Implementation:** Added one glasses-text normalizer that removes every case-insensitive occurrence of `Underground Station`, repairs the surrounding whitespace/punctuation, and retains the required single-space fallback if removal would otherwise produce empty content. Journey text is cleaned before measurement and truncation, covering ride summaries, departure/arrival labels, walk instructions and fallback names, and next-stop alerts. Dynamic status-board names/descriptions use the same normalizer. The phone planner remains unchanged and continues to show TfL's original names.
- **Decision:** Centralised the rule at the glasses text-formatting boundaries rather than changing the stored journey JSON, so snapshots, route comparison data, phone rendering, and API responses retain their source values while every glasses layout benefits from the shorter measured string.
- **Verification:** Root and proxy builds pass and `git diff --check` passes. Five direct fixtures passed for endpoint, walk, alert, mixed-case, punctuation, and empty-result behavior; `Underground Station` now occurs in `src/` only as the normalizer's matching expression. No simulator run was needed for this text-only preprocessing change, so final hardware typography remains for lead/device confirmation.
- **Scope/questions:** No SDK behavior, container geometry, bridge call, input, persistence, key handling, deployment, commit, or push changed. Nothing surprising arose and there are no questions for the lead.

**2026-07-28 — T12b even route-bar spacing**

- **Implementation:** Replaced proportional remainder distribution with one uniform `connectorsPerSegment` value: the available connector glyphs are divided by the displayed segment count, floored with a minimum of one, and that exact run is emitted for every gap. The live-fill assertion now compares against the computed bar width instead of the old fixed 520px target.
- **Layout effects:** The nine-stop fixture produces a 380px bar centred at `x:98`, with all circle centres evenly spaced and both station names still deriving from the new bar endpoints. The capped 50-stop fixture produces a centred 500px bar. Marker sampling, passed/upcoming fill selection, stop count, alerts, and container geometry are unchanged.
- **Verification:** Root and proxy builds pass; production dev-hook and standing safety greps remain clean; `git diff --check` passes. Synthetic nine-stop and capped 50-stop fixtures verified identical connector-run lengths and invariant widths across unfilled, partially filled, and completed states. Simulator startup returned 0 without errors; the RGBA screenshot visibly confirms uniform nine-stop gaps, and the console shows the subsequent live bar change entering the existing serialised bridge gate.
- **Decisions/surprises/limits:** No decision beyond T12b was needed. The direct CommonJS fixture harness could not load the ESM-only measurement package, so the same source was bundled with the already-installed build tool for the synthetic assertions; product code was unaffected. Simulator font rendering remains an approximation pending hardware confirmation. No SDK question arose, no SDK documentation was consulted, and no deployment, commit, or push was performed.

**2026-07-28 — T13 keyboard-safe station suggestions**

- **Implementation:** Added `interactive-widget=resizes-content` to the viewport meta declaration and bumped `app.json` to `0.1.1`. From and To now scroll their containing `.station-field` to the top after a 300ms keyboard-settle delay on focus, then repeat that scroll once when suggestions first render during the same focus. An active suggestion list is constrained to `max(120px, floor(visualViewport.height - listTop - 12px))`; its VisualViewport resize/scroll listeners are installed only while open and removed on hide. WebViews without VisualViewport receive the specified `40vh` fallback.
- **Existing behavior retained:** `.suggestions` already had `overflow-y: auto`, so no CSS rewrite was necessary. Inspection found no `overflow: hidden` on `body` or `.app-shell`, no touch-event handlers, and no page-scroll prevention; the only `preventDefault` is the journey form submission. No scroll lock needed removing.
- **Decisions/surprises:** The delayed callbacks confirm the relevant input is still focused before scrolling, preventing a stale timer from moving the page after the user has left the field. Suggestion-render scrolling is tracked per focus, so subsequent result refreshes during that focus do not repeatedly pull the page. The browser-control surface reported no available browser in this session; this is an environment limitation rather than an app error.
- **Verification:** Root and proxy builds pass and `git diff --check` passes. Standing safety greps remain clean: no direct TfL origin, forbidden browser storage, `VITE_`, or TfL key in `src/`; one startup-page call remains; both event reads use `?? 0`; production contains neither dev hook; and no body/app-shell scroll lock or touch handler was introduced. The exact viewport meta and manifest version are present.
- **Could not verify / lead action:** I could not run the Playwright 390x350 From/To interaction, bottom-option click, bounding-rect assertion, or the 390x844/desktop visual regression because no controllable browser was available. The lead should run those acceptance checks, followed by Jack's hardware retest after re-upload. No SDK question arose, no SDK documentation was consulted, and no deployment, commit, or push was performed. The pre-existing `.claude/settings.json` change was left untouched.

---

## Review

**2026-07-28:** Nothing of Sol's to review yet. Plan for milestone 1 written; T1 (scaffold) done by the lead and verified building clean, so Sol's first run starts at T2. Review will check acceptance criteria first, then the platform gotchas: proto3 zero-value elision (`?? 0` on all event fields), one in-flight bridge update at a time, bridge KV storage only, no browser localStorage, exactly one `isEventCapture: 1` container, cleanup ordering around the exit dialog.

**2026-07-28 — Review of round 1 (T2 partial, T3).** Overall: a genuinely good first run. Both blockers Sol raised were legitimate spec gaps on my side, and stopping to ask instead of inventing SDK code was exactly the right call. Both are now answered with verified contracts in the Plan (T2b, T3b).

What I checked and confirmed:

- **T2 layout (src/main.ts:26-52):** matches the spec field for field. Container IDs, names, geometry, padding, exactly one `isEventCapture: 1`. Pass.
- **T3 structure:** exported `API_BASE` constant, correct endpoint, 13-char name padding, 475-char budget with truncation logging, guarded 60s interval, immediate first refresh, full-replacement offsets, last-good-board retention with stale marker, and the refresh path uses only `textContainerUpgrade`. All match the spec. The timeout wrapper (src/main.ts:54-69) correctly clears its timer to avoid stray timeouts; nice touch.
- **Gotcha sweep:** no browser storage, no `rebuildPageContainer`, no `TFL_APP_KEY` or `VITE_` in client code, single `createStartUpPageContainer` call. All clean. No event-field reads exist yet so elision cannot be judged this round; it is baked into T2b's criteria.
- **Build failure at src/main.ts:130 (TS2345):** reproduced the cause in the SDK typings. Sol's diagnosis was correct: `TextContainerUpgrade` is a class and the method wants an instance. The plan's object-literal example was my error. Fix specced in T3b.

Corrections (specific):

1. **src/main.ts:130** — wrap the argument in `new TextContainerUpgrade({ ... })` and add the import. Full contract in T3b. This unblocks the build, and with it the simulator criteria that could not be verified this round.
2. **src/main.ts:54-69 with 141-178** — in-flight gap: a timed-out bridge call is still pending, but `finally` releases `isUpdating`, so the next tick can send a concurrent bridge call, which risks crashing the BLE link. Fix specced in T3c (gate on the raw promise, not the raced one). This one is on me as much as Sol; round 1 said "timeout and skip the tick" without saying what gates the next send.
3. **Minor, src/main.ts:71-80 and 181-184** — the refresh loop starts even if `createStartUpPageContainer` returned nonzero. If startup failed there is nothing to update; guard it (skip starting the loop and log an error). Fold into T3b, no separate criteria.
4. **Note, no action:** the stale marker can push content to roughly 495 chars, slightly past the 475 budget. Well inside the 2000 hard limit and at worst the last line clips; acceptable.

Not verifiable this round (build was red): simulator render, exit dialog, network-off recovery, live status comparison. These carry forward as T2b/T3b criteria.

**Verdict: corrections issued, no sign-off yet.** Sol's next run is T3b, T2b, then T3c, in that order (build first, then features, then hardening). Not committing round 1 to main; the commit lands when the round goes green.

**2026-07-28 — Review of round 2 (T3b, T2b, T3c). SIGNED OFF.** Milestone 1 is complete. The lead ran the app in the simulator and verified everything Sol could not.

Code review findings:

- **T3b:** `new TextContainerUpgrade({...})` with the import, plus the nonzero-startup guard (src/main.ts:240-276 restructured so events and refresh only start when `result === 0`). Correct.
- **T2b:** event wiring matches the contract exactly: `textEvent` checked before `sysEvent`, both `eventType` reads use `?? 0`, double tap defers cleanup, foreground enter/exit pause and resume without duplicating the interval (the `refreshInterval !== undefined` guard in `startRefreshInterval` is right), cleanup lives in the 6/7 handlers. Correct.
- **T3c:** the raw-promise gate is exactly as specced: `bridgeCallPending` holds the raw bridge promise, cleanup attaches to its true settlement, the race only governs the caller's wait, skipped sends log distinctly and return `false` so a skipped board is not recorded as displayed (src/main.ts:132-154, 176-179). Correct. Extending the same principle to `requestExit` was a sensible unrequested improvement; accepted.

Simulator verification by the lead (Sol's blocker resolved):

- **Root cause of the E404:** the `node_modules/.bin/evenhub-simulator` symlink was never created. The scaffold's first `npm install` aborted mid-flight on the TypeScript peer conflict, leaving the simulator package installed but unlinked. That was the lead's broken install, not a wrong command and not Sol's error. Fixed with `npm rebuild @evenrealities/evenhub-simulator`. The verified invocation, from repo root: `npx evenhub-simulator http://localhost:<port> --automation-port 9898`.
- Verified in the simulator: real TfL board renders (alphabetical, 17 of 19 lines within budget, truncation logged), footer hint renders, `createStartUpPageContainer result: 0`, swipe up logs, single tap logs, double tap logs `Calling shutDownPageContainer(1)`.
- **Elision proof in the wild:** the simulator's single-tap event arrived with NO `eventType` field at all (`{"sysEvent":{"eventSource":1}}`), and the `?? 0` handling classified it correctly. The gotcha is real and the code survives it.
- **Simulator quirks (recorded for future rounds, no code changes needed):** swipe-down events are sometimes swallowed by the simulator's native text scroll; the exit dialog is not rendered visually (the page just blanks); `SYSTEM_EXIT_EVENT` (7) is never delivered, so the cleanup path cannot be observed in the simulator (verified correct by inspection); the simulator fast-forwards timers, so the 60s refresh ticks far more often than on hardware. All four need on-hardware confirmation eventually, none block sign-off.
- Not verified this round: network-off stale marker behaviour (code path reviewed and sound; will surface naturally in hardware testing).

**Milestone 1 is done.** T2, T3, T3b, T2b, T3c all pass. Committing this round to main. Next: milestone 2 planning (phone-side planning UI, proxy, journey fetch). Per Jack's direction, the product is a route planner that does the work for you: disruption information is only mentioned when it affects the user's route, so no dedicated status/disruption screens get planned. The milestone 1 status board stays as a walking-skeleton artefact and will be replaced, not extended.

**2026-07-28 — Review of round A (T4). SIGNED OFF, one carry-forward correction.** The lead re-ran the full acceptance suite locally with the real key and independently verified: build passes, healthz, line status array, 404 on non-allowlisted paths, 405 on POST, 204 preflight with the specified headers, wildcard CORS on every response, and the key absent from response bodies and headers (Sol's leak checks re-confirmed; the lead's first grep produced a false positive from an empty shell variable, not from the proxy).

Security review beyond the criteria, all passed:

- Protocol-relative escape (`/tfl///evil.com` producing `//evil.com` as the upstream path) is blocked because the allowlist check runs before URL construction. Correct ordering, verified in code.
- Dot-segment traversal is normalised away by the URL parser before the `/tfl/` check. Residual worst case is confined to api.tfl.gov.uk. Acceptable.
- Client-supplied `app_key` is stripped before the server key is set; upstream bodies are defensively redacted; logs carry the path only. All verified.

Findings for the record:

- **Sol's HTTP 300 surprise is upstream product behaviour, not a bug.** The lead's acceptance URL used the hub id `HUBKGX`; TfL answers hub ids with a 300 `fromLocationDisambiguation` response. Specific NaPTAN ids (`940GZZLUKSX`) return 200 with journeys (lead-verified through the proxy). The proxy passing 300 through untouched is correct. Round B's UI must either prefer specific stop ids from search results or handle the disambiguation response; this is now a round B design input.
- **Correction, carried to the next Sol round (does not block deploy):** `proxy/Dockerfile` last line uses `CMD ["npm", "start"]`. npm does not reliably forward SIGTERM, so container stops wait out the kill timeout. Change to `CMD ["node", "dist/server.js"]`. One line.
- `docker build` was not runnable in Sol's or the lead's local environment; the lead will run it on the droplet as part of T5, which satisfies that criterion in the environment that actually matters.

T5 (deploy) proceeds now.

**2026-07-28 — T5 deploy record (lead).** The proxy is live at `https://transit.berrydev.co.uk`.

- The repo is private, so the droplet cannot `git clone` it; deployed by rsyncing `proxy/` to `~/london-transit-hud/proxy/` on the droplet. The key went over ssh stdin into `proxy/.env` (mode 600), never in a command line. If we want git-based deploys later, the repo needs a deploy key or to go public: noted for Jack.
- `docker compose up -d --build` succeeded on the droplet, which satisfies T4's outstanding `docker build` criterion. Container `proxy-transit-proxy-1` runs with network alias `transit-proxy` on `connect-remote_default`.
- Added the `transit.berrydev.co.uk` site block to the shared Caddyfile, `caddy validate` passed, reloaded without downtime for the other apps.
- End-to-end verified over HTTPS from outside: `/healthz` 200 with CORS, live tube status through the proxy (11 lines), non-allowlisted path 404. Fresh Let's Encrypt cert issued automatically.
- The Caddyfile change is **committed on the droplet's connect-remote checkout but not pushed** (the droplet has no GitHub credentials). Jack: push it from the droplet next time you have credentials there, or tell me and I will sort a deploy key. Until then a `git pull` on the droplet will merge fine; nothing is at risk.
- **Addendum, later on 2026-07-28:** Jack made the repo public, so the lead replaced the rsynced directory on the droplet with a proper git clone (same path, `.env` preserved, container untouched, verified healthy after). Standard deploy from now on: ssh in, `git pull`, `docker compose up -d --build` in `~/london-transit-hud/proxy`.

**2026-07-28 — Review of round B (T6, T7). SIGNED OFF, no corrections.** The lead verified everything Sol could not, using Playwright driving real Chrome against the dev server, plus the glasses simulator.

- **T6:** `API_BASE` swap and Dockerfile `CMD` fix are exactly as specced. The glasses status board renders in the simulator through the live proxy (`createStartUpPageContainer` result 0, board painted), which also proves CORS through `transit.berrydev.co.uk` works from the webview.
- **T7, full flow verified in a real browser:** typing "kings" lists King's Cross & St Pancras International with mode chips; Brixton selects; Compare routes renders a Fastest card (16 min, £3.60, Tube) and a Cheapest card (61 min, £1.75, Bus with change points); Go marks the card selected and logs `Journey selected` with the journey object; Arrive by reveals the datetime field; zero page errors. Screenshots on file with the lead.
- **Code quality:** phone.ts is well structured. XSS-safe rendering throughout (textContent, or escaping where innerHTML is used), debounce with abort plus a stale-response guard on search, correct 300 handling (fetch does not auto-follow 300, verified reasoning), fastest/cheapest logic per spec including the same-journey collapse and the no-fare note. The visual design is genuinely good: restrained transit palette, distinct chip colour per mode (Jack's identifier requirement met), accessible markup (roles, aria attributes, status regions) unprompted.
- **One observed nuance, no action needed:** in a plain browser the SDK initialises a stub bridge, so `waitForEvenAppBridge` resolves rather than hanging; `createStartUpPageContainer` then returns 1 and the round 2 nonzero-result guard cleanly stops the glasses path. Different route to the same safe outcome the spec imagined; the phone UI is unaffected. (Cosmetic: the browser logs a favicon 404; ignore or add a favicon whenever convenient.)
- **Deployed:** the lead pulled and rebuilt the proxy on the droplet so the running container picks up the direct `node` CMD.

**Milestone 2 is complete.** Next planning: milestone 3, the glasses handoff: Go sends the chosen journey to the glasses, stage pages, the text-glyph route bar, position interpolation. The lead needs to verify per-leg line-name fields and re-check the leg `path.stopPoints` shape through the proxy before writing those tasks.

**2026-07-28 — Review of round C (T8, T9). SIGNED OFF, no corrections.** The lead deployed the updated proxy to the droplet and verified in production plus real Chrome via Playwright.

- **T8:** `/geocode` live at `transit.berrydev.co.uk` (French House pub returned with correct coordinates; blank `q` 400s; T4 regression curls all still pass). The `forwardJson` refactor keeps timeout, CORS, content-type policy and key redaction uniform across both upstreams: approved, tidier than two copies.
- **T9, full flow verified in Chrome:** grouped suggestions render with both headings; "french house" lists the pub with its type badge; King's Cross to French House plans with a Tube leg then a walking leg; Ministry of Sound to French House (place at both ends) plans successfully; zero page errors. Screenshots on file.
- **Quality notes:** the `new URL('/geocode', apiBase)` resolution correctly lands on the proxy root rather than under `/tfl`, the Photon `[lon, lat]` flip is validated field by field before shaping, and single-provider failure degrades gracefully to the surviving provider's results. All exactly as specced, several caught-in-advance traps avoided.

Milestone 2 round C complete. Next: milestone 3 planning (glasses handoff).

**2026-07-28 — Interim review of round D (T10 partial).** Both blockers Sol raised are legitimate and both were the lead's spec gaps: `rebuildPageContainer` was named without its construction contract, and the background-state helpers were quoted from docs that are ahead of every published SDK version (lead-verified on npm: nothing from 0.0.6 to 0.0.12 exports them; Sol's refusal to invent the import was exactly right, again). Verified answers are in Plan round D.2. Red-flag scan of the partial implementation is clean: one startup call site, exactly one event-capturing container per layout, container names within the 16-char limit, builds and standing greps pass, and the measured route bar (nine stops at 380px) confirms the glyph arithmetic. Full review after the D.2 rerun; not committing the partial round.

**2026-07-28 — Review of round D complete (T10, T10b, T10c). SIGNED OFF, no corrections.** The lead drove the full journey flow in the simulator via the dev hook and verified everything Sol could not.

- **Simulator verification (screenshots on file):** the ride page renders exactly as designed: `Victoria line to Brixton`, `Stage 1 of 2 · 17 min`, truncated names line, the `●─○─…─●` bar with eight intermediate notches, `9 stops · arrive 17:26`, footer. No wrapping, no scrollbar. Swipe up reaches the `Walk to your destination` arrive page; a further swipe clamps; swiping back renders a pixel-identical stage 0 (byte-compared); a further swipe clamps. Double tap raises the exit dialog. Console confirms the status refresh paused for journey mode and every bridge call (rebuilds and the exit request) passing through the serialised gate, one at a time.
- **Code review:** the unified `startBridgeCall` gate with queued flush and exit-priority is a genuinely good piece of engineering, better than the split gates it replaced. Restore-order handling via the state version covers both orderings cleanly. The status-repaint race (status fetch resolving just after Go) is closed with re-checks after every await. `journey-mode.ts` measures everything and never guesses; the unrequested long-leg fallback (cap at twelve markers when even a bare line overflows, verified at 540px for a synthetic 50-stop leg) is accepted, measured initiative of exactly the right kind.
- **One nit, no action needed now:** a measurement-invariant throw inside `flushJourneyRender` would surface as an unhandled rejection. It is a should-never-happen path guarded by construction; tidy it opportunistically in a future round.
- **Honestly unverified, carried forward:** the host background migration (simulator cannot exercise it; hardware test when Jack next wears the glasses), exit-dialog visuals, and hardware flicker feel on rebuilds.

**2026-07-28 — Review of round D.3 (T11). SIGNED OFF, no corrections.** Lead-verified in the simulator, numerically and visually:

- **The bands are real:** stage 0 screenshot measures 1744 lit pixels in the top band, 2697 in the bottom band, and exactly **zero** in the middle band (y 81 to 234). The ride page reads: summary, stage/duration/arrival line, first-stage hint up top; names and the bar with `· 9 stops` flush at the bottom; clear lens in between. Exactly Jack's brief.
- **Tap-to-hide verified end to end:** tap shows the `HUD hidden · tap to show` notice (533 lit px); after the 5-second timer the display is zero-lit, genuinely transparent on hardware; a swipe while hidden logs an ignore and changes nothing; tap restores a byte-identical stage page; double tap raises the exit dialog. Every rebuild and the notice-clear upgrade went through the serialised gate in order.
- **Also noted with approval:** Sol folded the previously flagged unhandled-rejection nit into this round (stage construction now caught inside the render flush), handled restore-cancels-timer, and measured the stop-count placement adaptively (on the bar at 461px for the nine-stop fixture, moved to the top line for the 50-stop synthetic). Carried forward unchanged: hardware verification of background migration, dialog visuals and flicker feel.

**2026-07-28 — Review of Jack-directed layout polish. SIGNED OFF and pushed.** Sol reworked the journey pages into positioned containers under Jack's direction: ride pages now spread the top row (arrival left, line summary centred, stage counter right), anchor the departure and arrival names to the ends of a fixed 520px bar that stretches by distributing connector glyphs evenly between stops, centre the stop count beneath, and trim "Underground Station" suffixes from names. Lead verified: builds and standing greps pass; ride pages use 7 text containers with unique IDs, compliant names and exactly one event capture (all four layout types checked); the middle band still measures zero lit pixels; and, the key regression risk, swipes and taps still arrive despite the event-capture container shrinking from a full band to a single positioned label, confirmed live in the simulator along with the full hide/blank/restore cycle (byte-identical restore). Noted as intentional per Jack's direction: the stage-0 hint line now appears only on walk pages, not ride pages.

**2026-07-28 (evening) — Test-readiness deploy (lead).** The app is now hosted and hardware-testable without a dev machine.

- **app.json fix:** the `network` permission was missing its required `whitelist` field (would have failed on hardware and at packing). Added `["https://transit.berrydev.co.uk"]`. All other manifest fields validate against the packaging rules (name 18/20 chars, package_id compliant).
- **Hosting:** the production build (plus `app.json`) is rsynced to `~/london-transit-hud-site` on the droplet and served by the shared Caddy at `https://transit.berrydev.co.uk`, same origin as the API: `handle` blocks route `/tfl/*`, `/geocode` and `/healthz` to the transit-proxy container, everything else is `file_server` with an `index.html` fallback. Caddy container recreated (seconds of blip for the other sites, all verified healthy after: car-proxy 200, ableshow 200, matchhud routing intact). Infra change committed on the droplet's connect-remote checkout (still unpushed there, as before).
- **Production verification:** full Playwright click-through against the live URL: search suggestions, fastest (15 min £3.10) and cheapest (50 min £1.75) cards, Go, journey handoff logged, zero page errors.
- **Sideload:** `npx evenhub qr --url https://transit.berrydev.co.uk` generates the install QR for the Even Hub companion app. Redeploying the client is: `npm run build && cp app.json dist/ && rsync -az --delete dist/ deploy@car-proxy.berrydev.co.uk:~/london-transit-hud-site/` (no Caddy reload needed).
- **Hardware test checklist for Jack's first session:** plan and Go from the phone inside the Even app; band layout legibility and dominance through real lenses; swipe feel and rebuild flicker on page turns; tap-to-hide notice, 5-second fade and restore; double-tap exit dialog visuals; pocket the phone mid-journey and return (background migration hooks, the big unverified one); status board on plain launch.

**2026-07-28 — Review of round E (T12 plus the station-name cleanup). SIGNED OFF; one cosmetic correction specced as T12b.** The lead independently verified the full time-travel matrix in the simulator with dev-clock offsets computed from live journeys:

- **Mid-leg fill (+10 min):** five filled, four hollow, clean boundary; station names shortened by the cleanup (screenshots on file).
- **`Next stop: Brixton`:** appears centred above the bar inside its 10-second window, confirmed by the `Journey alert update` gate log and a 391-lit-pixel alert row. For the record: the lead's first two attempts to catch this window failed due to test-rig faults (a Vite port race sending the simulator to a dead URL), NOT a code defect; Sol's implementation was correct throughout.
- **`This is your stop`:** shows from T-30, bar fully filled except the destination; and the alert renders on the hidden layout alongside the hide notice, exactly per spec.
- **Code quality:** the trigger arithmetic matches the spec precisely; the always-present alert container keeps every update flicker-free; upgrade labels (`Journey alert update`, `Live bar update`) make the gate auditable; the evenly-sampled marker selection for long legs is an accepted improvement over the spec's first-N capping; the space-padded centring inside the fixed 400px alert container is a resourceful answer to the no-alignment constraint. The station-name cleanup at the formatting boundary (source data untouched) is the right architecture.
- **Carried forward:** continued ticking through a real background migration and on-hardware rendering remain hardware-verification items, as recorded since round D.
- **T12b (even circle spacing, Jack's note) is the only correction**, specced above; cosmetic, light effort.
- **Deployed:** the lead rebuilt and redeployed the hosted copy at transit.berrydev.co.uk with round E included.

**Milestone 3 round D is done. The core vision now runs end to end:** plan on the phone (stations, stops, bars or venues), compare fastest and cheapest, hit Go, and the glasses show swipeable stage pages with the notched route bar. Next: round E, live position: interpolate between the leg's timestamps across its stops, move a marker along the bar via flicker-free `textContainerUpgrade`, show time-to-next-stop, and surface per-leg disruptions (the API's `isDisrupted`/`disruptions` fields, per Jack's route-relevant-only rule).

**2026-07-28 addendum after discussion with Jack:** stop-to-stop is not enough; users must be able to type a bar or venue name and get there. TfL's gazetteer cannot do POIs, so a proper geocoder feeds lat,long into the journey call. **Decision: Photon (photon.komoot.io), OSM-backed, free, keyless, built for typeahead, routed through our proxy.** Verified live: "ministry of sound" returns the nightclub with correct coordinates and postcode; "french house soho" returns the pub. Nominatim's public instance is ruled out because its usage policy prohibits autocomplete-style traffic; Mapbox is the paid fallback if Photon's quality or availability disappoints, and the proxy indirection means swapping upstream later without touching the client. Tasked as milestone 2 round C below.

**2026-07-28 — Jack asked whether we need another API for nearest-stop-to-destination. Answer: no for planning (verified live).** TfL Journey Planner accepts raw `lat,long` (and postcodes) as either journey end: given Soho coordinates it resolved the address, picked Tottenham Court Road as the boarding station itself, and returned the walking leg (`walking | 55 FRITH STREET, LONDON -> Tottenham Court Road Underground Station`). So door-to-door planning, "use current location", and the walk pages all come free from the existing `Journey/JourneyResults` endpoint with no new API. Two related notes for later milestones: (1) arbitrary place-name destinations (e.g. "Tate Modern") would use TfL's free-text journey lookup, whose HTTP 300 disambiguation options (with `parameterValue` lat,longs and match quality) can serve as a place picker: same endpoint, already allowlisted; (2) an explicit nearest-stop query for en-route GPS checks in M4 would be `StopPoint?lat=&lon=&radius=`, a path shape not currently allowlisted in the proxy, one line to add when needed.
- Also verified through the live proxy while testing: hub ids (`HUBKGX`) are NOT valid journey locations. TfL treats them as free text and returns HTTP 300 with a list of fuzzy matches (highlight: "Chicken Hub" in Hackney). Search matches carry `icsId` (e.g. `1000129` for King's Cross), and journeys planned with `icsId` values return 200 with journeys and fares. Round B uses `icsId` exclusively.

---

## Open questions for Jack

1. **TfL API key and proxy.** Milestone 1 goes keyless, which is fine at one request per minute. If we add arrivals polling (more frequent) we will likely want a registered `app_key`, and per the ground rules that means a small server-side proxy rather than a key in the client. Happy for me to plan that proxy in milestone 2, or do you want to stay keyless as long as possible?
2. **CORS risk.** The app runs in a Flutter WebView, and TfL's API generally sends permissive CORS headers, but I have not verified behaviour inside the Even WebView specifically. If fetches get blocked on device, the fallback is the same proxy from question 1. Flagging now so it is not a surprise.
3. **Modes.** I picked Tube, Elizabeth line, DLR and Overground for the milestone 1 status board. Journey planning naturally includes buses (they are the usual cheapest option). Want trams or national rail in scope at any point?
4. **Line ordering.** Alphabetical, or severity-first (disrupted lines at the top)? I have left it unspecified for milestone 1; Sol will get an explicit instruction in review if it matters to you.
5. **Phone-side planning UI.** I have assumed journey setup (station search, timing choice) happens on the phone screen and the glasses take over at Go, because glasses text entry is not workable. Shout if you pictured glasses-only.
6. **Options screen location.** Should the fastest/cheapest comparison show on the glasses, the phone, or both? I have assumed both (choose on either), but phone-only would simplify the glasses UI.
7. **Proxy subdomain (blocks T5, not T4).** I suggest `transit.berrydev.co.uk`. If you are happy with it, add a DNS A record pointing it at the droplet's IP (same target as car-proxy.berrydev.co.uk) and tell me when it is in; I will do the rest. If you would rather a different name, just say which. **ANSWERED 2026-07-28: Jack added the record; `transit.berrydev.co.uk` resolves to 178.128.168.63 (verified by the lead). T5 is unblocked once T4 passes review.**

## Jacks answers

1. **TfL API key and proxy.** I will register a key
2. **CORS risk.** Yes we will bounce it all through the proxy
3. **Modes.** Just trains and buses for now, but each mode of transport needs a distictive identifier
4. **Line ordering.** I don't mind
5. **Phone-side planning UI.** Yes for now everything is set up on the phone. In future maybe add voice input on glasses but not yet.
6. **Options screen location.** On the phone I think. I'm thinking nearly all set up is on the phone and then when the route is selected, they can pocket the phone and just use the glasses.
