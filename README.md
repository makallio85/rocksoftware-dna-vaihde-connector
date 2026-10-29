# DNA Vaihde Connector

Chrome/Edge extension (Manifest V3) that connects the DNA Vaihde softphone
(vaihde.dna.fi) to an ERP through the ERP's public API:

1. An employee presses **Soita** in the ERP. The extension, running in DNA,
   picks the call up, types the number into DNA's dialler and presses Call.
2. A call that rings in DNA rings in the ERP too. The employee answers in DNA
   or with **Vastaa** in the ERP.
3. While a call is connected, both sides (the employee's microphone and the
   customer's voice) stream to Speechmatics (EU) as two streams, and the
   transcript lines go to the ERP live.

**Audio is never stored**, not by the extension and not by the ERP. The ERP
keeps the transcript text only.

The extension does nothing without an ERP address and an API token issued by
that ERP.

## Asennus ja päivitys (henkilöstölle)

### Asennus

1. Lataa uusin versio: **Releases → Latest** tällä sivulla →
   `rocksoftware-dna-vaihde-connector-<versio>.zip`.
2. Pura zip pysyvään kansioon (esim. jaettuun OneDrive-kansioon). Älä poista
   kansiota asennuksen jälkeen – selain käyttää sitä.
3. Avaa Chromessa `chrome://extensions` (Edgessä `edge://extensions`), laita
   **Developer mode / Kehittäjätila** päälle ja valitse **Load unpacked /
   Lataa pakkaamaton** → valitse purettu kansio (se, jossa on `manifest.json`).
4. Avaa laajennuksen **Details → Extension options**:
   - **ERP:n osoite** ja **oma API-token** (ERP:ssä Hallinta › API-tokenit,
     oikeudet `customer_service.calls.read` ja `customer_service.calls.write`).
   - Paina **Tallenna** ja valitse selaimen kysymykseen **Salli**.
   - **Tarkista** kertoo, onko kaikki kunnossa ja mitä tehdä, jos ei ole.
5. Salli ponnahdusikkunat osoitteelle `https://vaihde.dna.fi`
   (`chrome://settings/content/popups` → Salli). DNA avaa jokaisen puhelun
   omaan ikkunaansa.
6. Pidä DNA Vaihde auki yhdessä välilehdessä, Yhteystiedot-näkymässä.

### Päivitys

1. Lataa uusin zip kohdasta **Releases → Latest** ja pura se samaan kansioon
   vanhan päälle.
2. `chrome://extensions` → laajennuksen **päivitä-kuvake** (↻).
3. Lataa DNA:n välilehti uudelleen, kun puhelua ei ole käynnissä.

ERP näyttää varoituksen, jos laajennuksen versio on vanhentunut.

## Releases

**Every version that reaches users must be a GitHub Release with its zip.**

1. Raise `version` in `manifest.json` (and `package.json`).
2. Commit, then tag and push: `git tag v0.8.0 && git push origin v0.8.0`.
3. The *Release* workflow (`.github/workflows/release.yml`) runs the tests,
   checks the tag matches `manifest.json`, builds
   `rocksoftware-dna-vaihde-connector-<version>.zip` (only `manifest.json`,
   `options.*` and `src/`) and publishes the Release with generated notes.

Never commit zips to the repository.

## How it works

The extension reports to the ERP every 5 seconds (every 30 while DNA is
closed): DNA open and signed in, microphone allowed, pop-ups, its version.
The ERP shows whether DNA is ready and refuses *Soita* while it cannot dial.
The status box in the DNA tab shows the same answer: *valmis*, warnings in
amber, or what blocks calls in red.

No ERP address is built in: when the address is saved on the options page,
the browser asks the user to allow it (`optional_host_permissions`). Without
that permission the status box and *Tarkista* say what to do.

Disable other extensions that wrap DNA's microphone while using this one.

**Developers: reload the extension after every file change, then reload DNA
while idle.**

| File | World | Does |
|---|---|---|
| `src/background.js` | service worker | Holds the ERP token. Talks to the ERP's public API (`/public-api/v1/customer-service/*`) and keeps one Speechmatics WebSocket per side during a call; batches final lines to the ERP once a second. |
| `src/directory.js` | DNA directory, isolated | Polls for queued calls (through the worker), claims one and dials it. Reads DNA's incoming-call pop-up and answers it on *Vastaa* in the ERP. |
| `src/call-window.js` | DNA call window, isolated | Reads the call's state from the window (see below), starts/stops capture, relays audio to the worker, shows a status box. |
| `src/capture.js` | DNA call window, MAIN | Listens to DNA's microphone stream (getUserMedia) and the remote WebRTC audio track, converts both to 16 kHz PCM. DNA's own streams are not changed. |
| `src/observe*.js` | DNA pages | Observe mode (off by default): records what DNA shows, for troubleshooting when DNA changes its pages. |
| `src/shared/*.js` | — | Pure helpers: call-state and ringing-screen reading, transcript batching, PCM conversion, which tab dials, poll backoff, the softphone report, the *Tarkista* checklist, the ERP host permission. Unit-tested. |

The long-lived Speechmatics key stays in the ERP. When a call connects, the ERP
answers with a 60-second temporary key per stream; the WebSockets run in the
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

- The pop-up opens → the number goes to the ERP (`calls/add`, incoming), which
  rings it for the staff.
- *Vastaa* in the ERP → the tab presses DNA's **green** button (never any
  other). DNA opens its call window, which is transcribed like a dialled call.
- The pop-up closes → reported as stopped ringing 0.3 seconds later (missed,
  unless a colleague answered). If the green button was pressed in this tab
  (by hand or by *Vastaa*), DNA's call window takes over instead; stopped is
  reported only if no call window appeared within 15 seconds.
- A hidden number is not reported; the status box says to answer in DNA.

If DNA changes the pop-up, `src/shared/ring-screen.js` and `ringPopup()` in
`src/directory.js` are the places to fix.

## Tests

```
npm test        # node --test, no dependencies
```

Without Node installed: `docker run --rm -v "$PWD:/app:ro" -w /app node:22-alpine node --test`

## Known limits

- Only calls queued from the ERP, or ringing in DNA, are handled; a call
  dialled by hand in DNA is not transcribed.
- The page capture runs in DNA's own JavaScript world and shares it with DNA's
  scripts. It is not a supported DNA integration and may break when DNA
  changes.
- The worker keeps its state in memory. If the browser stops the worker
  mid-call the transcript stops; the call itself is unaffected.
