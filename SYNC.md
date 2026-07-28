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
