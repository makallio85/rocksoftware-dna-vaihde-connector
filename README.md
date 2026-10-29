# DNA Vaihde Connector

Chrome/Edge extension (Manifest V3) that connects the DNA Vaihde softphone
(vaihde.dna.fi) to a backend system of your own through a small HTTP API:

1. **Click-to-call:** the backend queues a call; the extension, running in
   DNA, picks it up, types the number into DNA's dialler and presses Call.
2. **Incoming calls:** a call that rings in DNA is reported to the backend, so
   it can ring there too. The employee answers in DNA, or the backend asks the
   extension to answer.
3. **Live transcription:** while a call is connected, both sides (the
   employee's microphone and the caller's voice) stream to Speechmatics (EU)
   as two streams, and the transcript lines go to the backend live.

**Audio is never stored** by the extension. The extension does nothing without
an API address and an API token issued by the backend.

## Asennus ja päivitys (käyttäjille)

### Asennus

1. Lataa uusin versio: **Releases → Latest** tällä sivulla →
   `rocksoftware-dna-vaihde-connector-<versio>.zip`.
2. Pura zip pysyvään kansioon (esim. jaettuun OneDrive-kansioon). Älä poista
   kansiota asennuksen jälkeen – selain käyttää sitä.
3. Avaa Chromessa `chrome://extensions` (Edgessä `edge://extensions`), laita
   **Developer mode / Kehittäjätila** päälle ja valitse **Load unpacked /
   Lataa pakkaamaton** → valitse purettu kansio (se, jossa on `manifest.json`).
4. Yhdistä laajennus taustajärjestelmään: paina taustajärjestelmässä
   **Yhdistä DNA Vaihde Connector**, tarkista avautuvalla sivulla osoite,
   paina **Yhdistä** ja valitse selaimen kysymykseen **Salli**.
   (Jos taustajärjestelmässä ei ole Yhdistä-painiketta: laajennuksen
   **Details → Extension options** → API-osoite ja API-token ylläpitäjältä →
   **Tallenna** → **Salli**.) Asetusten **Tarkista** kertoo, onko kaikki
   kunnossa.
5. Salli ponnahdusikkunat osoitteelle `https://vaihde.dna.fi`
   (`chrome://settings/content/popups` → Salli). DNA avaa jokaisen puhelun
   omaan ikkunaansa.
6. Pidä DNA Vaihde auki yhdessä välilehdessä, Yhteystiedot-näkymässä.

### Päivitys

1. Lataa uusin zip kohdasta **Releases → Latest** ja pura se samaan kansioon
   vanhan päälle.
2. `chrome://extensions` → laajennuksen **päivitä-kuvake** (↻).
3. Lataa DNA:n välilehti uudelleen, kun puhelua ei ole käynnissä.

## Releases

**Every version that reaches users must be a GitHub Release with its zip.**

1. Raise `version` in `manifest.json` (and `package.json`).
2. Commit, then tag and push: `git tag v0.9.0 && git push origin v0.9.0`.
3. The *Release* workflow (`.github/workflows/release.yml`) runs the tests,
   checks the tag matches `manifest.json`, builds
   `rocksoftware-dna-vaihde-connector-<version>.zip` (only `manifest.json`,
   `options.*` and `src/`) and publishes the Release with generated notes.

Never commit zips to the repository.

## Connecting a backend

The extension needs the API's **full base address** (e.g.
`https://example.fi/api/calls`) and a token for the user. No backend address
is built in; the browser asks the user to allow the address
(`optional_host_permissions`).

**One click (recommended).** The extension's ID is fixed by the `key` in
`manifest.json`: **`fikiichepjhbdeclghchkglkfmpibgac`**, whatever folder it
is loaded from. A backend issues a token for the logged-in user and opens

```
chrome-extension://fikiichepjhbdeclghchkglkfmpibgac/connect.html#api=<URL-encoded API base>&token=<URL-encoded token>
```

The part after `#` never reaches a server, and the page clears it at once.
The page shows the address; the user presses **Yhdistä** and allows the
address. Whether the extension is installed can be checked first with
`fetch('chrome-extension://fikiichepjhbdeclghchkglkfmpibgac/connect.html')`
(it fails if not).

- A new install is connected; the same address gets its token renewed.
- **A link never replaces a connection to another backend.** That is changed
  on the options page only, so a web page cannot move the extension to a
  server of its own.

**By hand.** The options page takes the address and token.

**Call audio** leaves the browser only for Speechmatics (`*.rt.speechmatics.com`)
and OpenAI (`api.openai.com`), whatever streaming address a backend hands
out. Live listening (below) sends the call's audio to a listener the backend
names over WebRTC: connect only backends you trust.

**Never change the `key` in `manifest.json`**: the extension's ID, and every
backend's connect link, depend on it.

## Backend API

Every request goes to `<base>/<path>` with `Authorization: Bearer <token>` and
JSON bodies. Answers are JSON; an error answer may carry `{error: "<Finnish
message>"}`, which the extension shows. 401 = token refused, 403 = token
lacks the rights.

| Request | When | Body → answer |
|---|---|---|
| `GET calls/index` | every 2 s while DNA is open | → `{calls: [call]}`: calls queued for this token's user to dial |
| `POST calls/edit/{id}` | call state changes | `{status: dialing\|connected\|ended\|failed\|missed}` → `{call, transcription?, agent?}`; `connected` answers the transcription session (temporary Speechmatics key, channels) or an AI agent session |
| `POST calls/add` | a call rings in DNA | `{phone_number, direction: "incoming"}` → `{call}` |
| `GET calls/view/{id}` | while ringing / during a call | → `{call}`; `status`, `is_mine` and `user_name` tell whether to answer in DNA or who answered |
| `POST call-softphones/add` | every 5 s (30 s while DNA is closed) | DNA open/signed in, microphone, pop-ups, extension version → `{softphone: {allowed, reasons, warnings}}`, shown in the DNA tab |
| `POST call-transcript-segments/add` | about once a second during a call | `{call_id, segments}` |
| `POST call-usages/add` | every 15 s and at the end | `{call_id, usages}`: Speechmatics seconds, OpenAI tokens |
| `GET call-listen-sessions/index?call_id=` · `POST call-listen-sessions/edit/{id}` | during a call | live listening (WebRTC offer/answer) |
| `POST messages/add` | AI agent calls | `{call_id, text}`: a note the agent saved |

`src/background.js` is the reference for the exact fields.

## How it works

The status box in the DNA tab shows the backend's answer to the softphone
report: *valmis*, warnings in amber, or what blocks calls in red.

Disable other extensions that wrap DNA's microphone while using this one.

**Developers: reload the extension after every file change, then reload DNA
while idle.**

| File | World | Does |
|---|---|---|
| `src/background.js` | service worker | Holds the API token. Talks to the backend API and keeps one Speechmatics WebSocket per side during a call; batches final lines to the backend once a second. |
| `src/directory.js` | DNA directory, isolated | Polls for queued calls (through the worker), claims one and dials it. Reads DNA's incoming-call pop-up and answers it when the backend asks. |
| `src/call-window.js` | DNA call window, isolated | Reads the call's state from the window (see below), starts/stops capture, relays audio to the worker, shows a status box. |
| `src/capture.js` | DNA call window, MAIN | Listens to DNA's microphone stream (getUserMedia) and the remote WebRTC audio track, converts both to 16 kHz PCM. DNA's own streams are not changed. |
| `src/observe*.js` | DNA pages | Observe mode (off by default): records what DNA shows, for troubleshooting when DNA changes its pages. |
| `src/shared/*.js` | — | Pure helpers: call-state and ringing-screen reading, transcript batching, PCM conversion, which tab dials, poll backoff, the softphone report, the *Tarkista* checklist, the API host permission. Unit-tested. |

Long-lived Speechmatics keys stay in the backend. When a call connects, the
backend answers with a short-lived key per stream; the WebSockets run in the
service worker so DNA's page security policy cannot block them.

### Reading the call's state

DNA exposes no call-state API, so the call window's text is read, as observed
on real calls:

- *ringing*: `<name> ringing`. Not answered: the audio path is up while it
  rings, so microphone or WebRTC readiness never counts as answered.
- *connected*: `Call with <name>` **and** the `mm:ss` timer seen to advance.
- *ended*: window title `Call ended | DNA Ohjelmistopuhelin`, or the window
  closes; *failed* if it never connected (`<name> is not available`).

If DNA changes these texts, `src/shared/call-state.js` is the one place to fix.

### Incoming calls

The dialling DNA tab reads DNA's ringing pop-up every 0.3 seconds, as seen on
test calls: a dialog with a pulsing avatar (`.call-animation`), *Incoming
call*, the caller's number and two round buttons (red decline, green answer),
while the tab title reads `00358… is calling...`.

- The pop-up opens → the number goes to the backend (`calls/add`).
- The backend says this user answered → the tab presses DNA's **green**
  button (never any other). DNA opens its call window, which is transcribed
  like a dialled call.
- The pop-up closes → reported as stopped ringing 0.3 seconds later (missed,
  unless someone else answered). If the green button was pressed in this tab,
  DNA's call window takes over instead; stopped is reported only if no call
  window appeared within 15 seconds.
- A hidden number is not reported; the status box says to answer in DNA.

If DNA changes the pop-up, `src/shared/ring-screen.js` and `ringPopup()` in
`src/directory.js` are the places to fix.

## Tests

```
npm test        # node --test, no dependencies
```

Without Node installed: `docker run --rm -v "$PWD:/app:ro" -w /app node:22-alpine node --test`

## Known limits

- Only calls queued by the backend, or ringing in DNA, are handled; a call
  dialled by hand in DNA is not transcribed.
- The page capture runs in DNA's own JavaScript world and shares it with DNA's
  scripts. It is not a supported DNA integration and may break when DNA
  changes.
- The worker keeps its state in memory. If the browser stops the worker
  mid-call the transcript stops; the call itself is unaffected.
