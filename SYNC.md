# SYNC.md — London Transit HUD

Coordination file for the two-agent workflow.

- **Plan** is owned by the planning lead. Task breakdown with acceptance criteria.
- **Execution notes** is owned by Sol. What was done, decisions taken, problems hit.
- **Review** is owned by the planning lead. Findings, corrections, sign-off.

Neither agent edits the other's section. Entries are dated, newest at the bottom of each section.

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

---

---

## Execution notes

(Sol's section. Sol: append dated entries here. What you did per task, decisions you took, anything that surprised you, anything you could not verify.)

---

## Review

**2026-07-28:** Nothing of Sol's to review yet. Plan for milestone 1 written; T1 (scaffold) done by the lead and verified building clean, so Sol's first run starts at T2. Review will check acceptance criteria first, then the platform gotchas: proto3 zero-value elision (`?? 0` on all event fields), one in-flight bridge update at a time, bridge KV storage only, no browser localStorage, exactly one `isEventCapture: 1` container, cleanup ordering around the exit dialog.

---

## Open questions for Jack

1. **TfL API key and proxy.** Milestone 1 goes keyless, which is fine at one request per minute. If we add arrivals polling (more frequent) we will likely want a registered `app_key`, and per the ground rules that means a small server-side proxy rather than a key in the client. Happy for me to plan that proxy in milestone 2, or do you want to stay keyless as long as possible?
2. **CORS risk.** The app runs in a Flutter WebView, and TfL's API generally sends permissive CORS headers, but I have not verified behaviour inside the Even WebView specifically. If fetches get blocked on device, the fallback is the same proxy from question 1. Flagging now so it is not a surprise.
3. **Modes.** I picked Tube, Elizabeth line, DLR and Overground for the milestone 1 status board. Journey planning naturally includes buses (they are the usual cheapest option). Want trams or national rail in scope at any point?
4. **Line ordering.** Alphabetical, or severity-first (disrupted lines at the top)? I have left it unspecified for milestone 1; Sol will get an explicit instruction in review if it matters to you.
5. **Phone-side planning UI.** I have assumed journey setup (station search, timing choice) happens on the phone screen and the glasses take over at Go, because glasses text entry is not workable. Shout if you pictured glasses-only.
6. **Options screen location.** Should the fastest/cheapest comparison show on the glasses, the phone, or both? I have assumed both (choose on either), but phone-only would simplify the glasses UI.

## Jacks answers

1. **TfL API key and proxy.** I will register a key
2. **CORS risk.** Yes we will bounce it all through the proxy
3. **Modes.** Just trains and buses for now, but each mode of transport needs a distictive identifier
4. **Line ordering.** I don't mind
5. **Phone-side planning UI.** Yes for now everything is set up on the phone. In future maybe add voice input on glasses but not yet.
6. **Options screen location.** On the phone I think. I'm thinking nearly all set up is on the phone and then when the route is selected, they can pocket the phone and just use the glasses.
