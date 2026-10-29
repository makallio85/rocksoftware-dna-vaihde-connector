// Unit tests for the extension's pure helpers. Run with: node --test
// The helpers are classic scripts (they run as content scripts and through
// importScripts), so each is loaded into a fresh context here.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file) {
    const context = { atob, btoa, Int16Array, Uint8Array, String, Math, Number, URL, URLSearchParams };
    context.globalThis = context;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', file), 'utf8'), context);
    return context;
}

const { DVCCallState } = load('call-state.js');
const { DVCTranscript } = load('transcript.js');
const { DVCPcm } = load('pcm.js');
const { DVCListen } = load('listen.js');
const { DVCIncoming } = load('incoming.js');
const { DVCRingScreen } = load('ring-screen.js');
const { DVCConnect } = load('connect.js');

// Objects made inside the loaded context have that context's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('ringing is not an answered call', () => {
    const tracker = new DVCCallState.Tracker();
    assert.equal(tracker.update({ title: 'Phone call', text: 'Matti Meikäläinen ringing' }), null);
    assert.equal(DVCCallState.read({ title: 'Phone call', text: 'Matti Meikäläinen ringing' }).state, 'ringing');
});

test('a call counts as connected only once its timer advances', () => {
    const tracker = new DVCCallState.Tracker();
    assert.equal(tracker.update({ title: 'Phone call', text: 'Call with Matti 00:01 Take a note' }), null);
    assert.equal(tracker.update({ title: 'Phone call', text: 'Call with Matti 00:01 Take a note' }), null);
    assert.equal(tracker.update({ title: 'Phone call', text: 'Call with Matti 00:02 Take a note' }), 'connected');
    assert.equal(tracker.update({ title: 'Phone call', text: 'Call with Matti 00:07 Take a note' }), null, 'reported once');
});

test('a call that never connected ends as failed', () => {
    const tracker = new DVCCallState.Tracker();
    tracker.update({ title: 'Phone call', text: 'Maija Virtanen ringing' });
    assert.equal(tracker.update({ title: 'Phone call', text: 'Maija Virtanen is not available' }), 'failed');
    assert.equal(tracker.update({ title: 'Call ended | DNA Ohjelmistopuhelin', text: '' }), null, 'reported once');
});

test('a connected call ends as ended, also when the window just closes', () => {
    const ended = new DVCCallState.Tracker();
    ended.update({ title: 'Phone call', text: 'Call with Matti 00:01' });
    ended.update({ title: 'Phone call', text: 'Call with Matti 00:02' });
    assert.equal(ended.update({ title: 'Call ended | DNA Ohjelmistopuhelin', text: '' }), 'ended');

    const closed = new DVCCallState.Tracker();
    closed.update({ title: 'Phone call', text: 'Call with Matti 00:01' });
    closed.update({ title: 'Phone call', text: 'Call with Matti 00:03' });
    assert.equal(closed.closed(), 'ended');
    assert.equal(closed.closed(), null);
});

test('final lines get per-channel sequences on the call timeline', () => {
    const collector = new DVCTranscript.Collector();
    collector.setOffset('customer', 250);
    collector.accept('customer', { message: 'AddTranscript', metadata: { transcript: ' Hei,  täällä Matti. ', start_time: 1.2, end_time: 2.5 } });
    collector.accept('employee', { message: 'AddTranscript', metadata: { transcript: 'Hei Matti!', start_time: 2.6, end_time: 4 } });
    collector.accept('customer', { message: 'AddPartialTranscript', metadata: { transcript: 'ei talteen' } });
    collector.accept('customer', { message: 'AddTranscript', metadata: { transcript: '   ', start_time: 5, end_time: 5 } });

    const batch = collector.take(10);
    assert.equal(batch.length, 2);
    assert.deepEqual(plain(batch[0]), { channel: 'customer', sequence: 0, start_ms: 1450, end_ms: 2750, text: 'Hei, täällä Matti.' });
    assert.equal(batch[1].channel, 'employee');
    assert.equal(batch[1].sequence, 0);
});

test('a batch that failed to post goes back first, with its numbers kept', () => {
    const collector = new DVCTranscript.Collector();
    ['yksi', 'kaksi', 'kolme'].forEach((word) => collector.accept('customer', { message: 'AddTranscript', metadata: { transcript: word } }));
    const first = collector.take(2);
    collector.putBack(first);
    assert.deepEqual(plain(collector.take(10).map((s) => s.sequence)), [0, 1, 2]);
});

test('float samples become clipped 16-bit PCM and survive base64', () => {
    const pcm = DVCPcm.floatTo16([0, 1, -1, 2, -2, 0.5]);
    assert.deepEqual(Array.from(pcm), [0, 32767, -32768, 32767, -32768, 16383]);

    const bytes = new Uint8Array(pcm.buffer);
    assert.deepEqual(Array.from(DVCPcm.fromBase64(DVCPcm.toBase64(bytes))), Array.from(bytes));
});

const { DVCUsage } = load('usage.js');

test('text lines from the AI session go on the same timeline', () => {
    const collector = new DVCTranscript.Collector();
    collector.addText('ai', ' Hei, täällä  yrityksen tekoälyavustaja. ', 1200.4);
    collector.addText('customer', 'Moi.', 3000);
    collector.addText('ai', '   ', 4000);
    assert.deepEqual(plain(collector.take(10)), [
        { channel: 'ai', sequence: 0, start_ms: 1200, end_ms: 1200, text: 'Hei, täällä yrityksen tekoälyavustaja.' },
        { channel: 'customer', sequence: 0, start_ms: 3000, end_ms: 3000, text: 'Moi.' },
    ]);
});

test('usage is counted in the units the backend prices', () => {
    const meter = new DVCUsage.Meter();
    meter.addSpeechmaticsBytes(32000 * 90);   // 90 s at 16 kHz
    meter.addOpenAiAudioBytes(48000 * 30);    // 30 s at 24 kHz
    meter.addRealtimeUsage({
        input_token_details: { text_tokens: 1000, audio_tokens: 400, cached_tokens: 600, cached_tokens_details: { text_tokens: 500, audio_tokens: 100 } },
        output_token_details: { text_tokens: 50, audio_tokens: 700 },
    });
    meter.addRealtimeUsage({ input_token_details: { text_tokens: 10 }, output_token_details: {} });
    meter.addRealtimeUsage(null);

    assert.deepEqual(plain(meter.report()), [
        { type: 'speechmatics_audio_seconds', quantity: 90 },
        { type: 'openai_transcription_seconds', quantity: 30 },
        { type: 'openai_text_input_tokens', quantity: 510 },
        { type: 'openai_cached_input_tokens', quantity: 600 },
        { type: 'openai_audio_input_tokens', quantity: 300 },
        { type: 'openai_text_output_tokens', quantity: 50 },
        { type: 'openai_audio_output_tokens', quantity: 700 },
    ]);
});

test('an empty meter reports nothing', () => {
    assert.deepEqual(plain(new DVCUsage.Meter().report()), []);
});

test('a requested listening session gets one offer', () => {
    const sessions = [{ id: 4, status: 'requested', ice_servers: [{ urls: 'stun:x' }] }];
    assert.deepEqual(plain(DVCListen.plan(sessions, {})), [{ action: 'offer', id: 4, iceServers: [{ urls: 'stun:x' }] }]);
    assert.deepEqual(plain(DVCListen.plan(sessions, { 4: 'offering' })), [], 'not offered twice while the page works on it');
});

test('the listener\'s answer is applied once, after the offer went out', () => {
    const sessions = [{ id: 4, status: 'answered', answer_sdp: 'v=0 answer' }];
    assert.deepEqual(plain(DVCListen.plan(sessions, { 4: 'offered' })), [{ action: 'answer', id: 4, sdp: 'v=0 answer' }]);
    assert.deepEqual(plain(DVCListen.plan(sessions, { 4: 'answered' })), []);
});

test('an ended session is closed only if this window opened it', () => {
    const sessions = [{ id: 4, status: 'ended' }, { id: 5, status: 'ended' }];
    assert.deepEqual(plain(DVCListen.plan(sessions, { 4: 'answered' })), [{ action: 'stop', id: 4 }]);
    assert.deepEqual(plain(DVCListen.plan(sessions, { 4: 'ended' })), []);
});

test('answering in the backend makes DNA answer, once', () => {
    const call = { status: 'connected', is_mine: true };
    assert.equal(DVCIncoming.decide({}, call), 'answer-in-dna');
    assert.equal(DVCIncoming.decide({ askedToAnswer: true }, call), 'wait');
    assert.equal(DVCIncoming.decide({ windowBound: true }, call), 'wait', 'answered in DNA itself');
});

test('a call a colleague took stops ringing here', () => {
    assert.equal(DVCIncoming.decide({}, { status: 'connected', is_mine: false, user_name: 'Maija' }), 'answered-elsewhere');
    assert.equal(DVCIncoming.decide({}, { status: 'ended', is_mine: false, user_name: 'Maija' }), 'answered-elsewhere');
});

test('a ringing call waits; a missed one is gone', () => {
    assert.equal(DVCIncoming.decide({}, { status: 'ringing', is_mine: false }), 'wait');
    assert.equal(DVCIncoming.decide({}, { status: 'missed', is_mine: false, user_name: null }), 'gone');
    assert.equal(DVCIncoming.decide({}, null), 'gone');
});

const { DVCSoftphone } = load('softphone.js');

test('the oldest open DNA tab dials, and a tab that stopped polling is forgotten', () => {
    const tabs = { 7: { firstSeen: 100, lastSeen: 20000 }, 3: { firstSeen: 200, lastSeen: 20000 }, 5: { firstSeen: 50, lastSeen: 1000 } };
    assert.equal(DVCSoftphone.primaryTab(tabs, 20500), 7);
    assert.deepEqual(Object.keys(tabs).sort(), ['3', '7'], 'tab 5 went quiet');
    assert.equal(DVCSoftphone.primaryTab({}, 0), null);
});

test('polling backs off while the backend does not answer, and comes back to two seconds', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(DVCSoftphone.backoff), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('the report says whether DNA is open, signed in and allowed the microphone', () => {
    const tabs = { 1: {}, 2: {} };
    assert.deepEqual(plain(DVCSoftphone.report({ version: '0.4.0', tabs, dialerReady: true, microphone: 'granted', popupsBlocked: false })), {
        extension_version: '0.4.0', directory_open: true, directory_tabs: 2, dialer_ready: true, microphone_allowed: true, popups_blocked: false,
    });
    const closed = DVCSoftphone.report({ version: '0.4.0', tabs: {}, dialerReady: true, microphone: 'prompt', popupsBlocked: true });
    assert.equal(closed.directory_open, false);
    assert.equal(closed.dialer_ready, false, 'no tab, nothing signed in');
    assert.equal(closed.microphone_allowed, null);
    assert.equal(closed.popups_blocked, true);
});

test('Tarkista names each problem and what to do', () => {
    const lines = plain(DVCSoftphone.diagnose({
        settings: true, backend: 'Taustajärjestelmä hylkäsi API-tokenin.', tabs: 2, dialerReady: false, microphone: 'denied', popupsBlocked: true,
        softphone: { warnings: [{ code: 'token_expiring', message: 'Token vanhenee 01.11.2026.' }, { code: 'dna_tabs', message: 'x' }] },
    }));
    const tones = Object.fromEntries(lines.map((l) => [l.label, l.tone]));
    assert.deepEqual(tones, {
        'Taustajärjestelmä': 'error', 'DNA-vaihde': 'warning', 'DNA-kirjautuminen': 'error', Mikrofoni: 'error', Ponnahdusikkunat: 'error', 'API-token': 'warning',
    });
    const fine = plain(DVCSoftphone.diagnose({ settings: true, backend: null, tabs: 1, dialerReady: true, microphone: 'granted', popupsBlocked: false, softphone: null }));
    assert.ok(fine.every((l) => l.tone === 'ok'));
    assert.equal(plain(DVCSoftphone.diagnose({ settings: false, tabs: 0 }))[1].detail, 'Avaa vaihde.dna.fi ja sen Yhteystiedot-näkymä.');
});

test('the DNA tab shows what the backend says about the softphone', () => {
    assert.deepEqual(plain(DVCSoftphone.status(null)), { text: 'yhteys taustajärjestelmään kunnossa, odotetaan puheluita.', tone: 'ok' },
        'before the first report is answered');
    assert.deepEqual(plain(DVCSoftphone.status({ allowed: true, reasons: [], warnings: [] })), { text: 'valmis, odotetaan puheluita.', tone: 'ok' });
    assert.deepEqual(plain(DVCSoftphone.status({
        allowed: true, reasons: [], warnings: [{ code: 'dna_tabs', message: 'DNA-vaihde on auki 2 välilehdellä.' }, { code: 'token_expiring', message: 'Token vanhenee 01.11.2026.' }],
    })), { text: 'valmis. DNA-vaihde on auki 2 välilehdellä. Token vanhenee 01.11.2026.', tone: 'warning' });
    assert.deepEqual(plain(DVCSoftphone.status({
        allowed: false,
        reasons: [{ code: 'dna_signed_out', message: 'Kirjaudu DNA-vaihteeseen.' }, { code: 'microphone_blocked', message: 'Salli mikrofoni.' }],
        warnings: [{ code: 'dna_tabs', message: 'x' }],
    })), { text: 'ei valmis. Kirjaudu DNA-vaihteeseen. Salli mikrofoni.', tone: 'problem' }, 'problems first; warnings wait');
});

test('DNA\'s ringing pop-up and title give the caller\'s number', () => {
    // As seen on a test call, 2026-10-29.
    assert.deepEqual(plain(DVCRingScreen.read({
        title: '0035840555012300 is calling...',
        popup: { heading: '040555012300' },
    })), { ringing: true, number: '0035840555012300' });
});

test('the pop-up alone rings; its heading is the number when the title is not readable', () => {
    assert.deepEqual(plain(DVCRingScreen.read({ title: 'Contact Directory | DNA Ohjelmistopuhelin', popup: { heading: ' 040 555 0123 ' } })),
        { ringing: true, number: '0405550123' });
    assert.deepEqual(plain(DVCRingScreen.read({ title: '+358 40 123 4567 soittaa…', popup: null })),
        { ringing: true, number: '+358401234567' });
});

test('a hidden number or a name rings without a number', () => {
    assert.deepEqual(plain(DVCRingScreen.read({ title: 'Contact Directory', popup: { heading: 'Matti Meikäläinen' } })),
        { ringing: true, number: null });
    assert.deepEqual(plain(DVCRingScreen.read({ title: 'Unknown is calling...', popup: { heading: 'Unknown' } })),
        { ringing: true, number: null });
});

test('the resting directory does not ring', () => {
    assert.deepEqual(plain(DVCRingScreen.read({ title: 'Contact Directory | DNA Ohjelmistopuhelin', popup: null })),
        { ringing: false, number: null });
});

test('only DNA\'s green button counts as answer', () => {
    assert.equal(DVCRingScreen.isAnswerColour('rgb(18, 199, 0)'), true);
    assert.equal(DVCRingScreen.isAnswerColour('rgb(225, 29, 42)'), false, 'decline');
    assert.equal(DVCRingScreen.isAnswerColour('rgba(0, 0, 0, 0)'), false);
    assert.equal(DVCRingScreen.isAnswerColour('rgb(255, 255, 255)'), false);
    assert.equal(DVCRingScreen.isAnswerColour(''), false);
});

test('a ringing call is reported once, and stopped only after the grace', () => {
    const w = new DVCRingScreen.Watcher();
    const ring = { ringing: true, number: '0401234567' };
    const quiet = { ringing: false, number: null };
    const grace = DVCRingScreen.STOP_GRACE_MS;
    assert.equal(w.update(quiet, 0), null);
    assert.deepEqual(plain(w.update(ring, 100)), { event: 'ringing', number: '0401234567' });
    assert.equal(w.update(ring, 400), null, 'reported once');
    assert.equal(w.update(quiet, 1000), null);
    assert.equal(w.update(quiet, 1000 + grace - 1), null, 'still within the grace');
    assert.deepEqual(plain(w.update(quiet, 1000 + grace)), { event: 'stopped', number: '0401234567' });
    assert.equal(w.update(quiet, 1000 + grace + 300), null, 'stopped once');
});

test('the title flickering back during a ring is the same call', () => {
    const w = new DVCRingScreen.Watcher();
    const ring = { ringing: true, number: '0401234567' };
    w.update(ring, 0);
    assert.equal(w.update({ ringing: false, number: null }, 300), null);
    assert.equal(w.update(ring, 600), null, 'not a second call');
});

test('another caller within the grace stops the first and then rings', () => {
    const w = new DVCRingScreen.Watcher();
    w.update({ ringing: true, number: '0401111111' }, 0);
    w.update({ ringing: false, number: null }, 1000);
    const next = { ringing: true, number: '0402222222' };
    assert.deepEqual(plain(w.update(next, 2000)), { event: 'stopped', number: '0401111111' });
    assert.deepEqual(plain(w.update(next, 2300)), { event: 'ringing', number: '0402222222' });
});

test('a call answered here waits for DNA\'s call window, not the short grace', () => {
    const w = new DVCRingScreen.Watcher();
    w.update({ ringing: true, number: '0401234567' }, 0);
    w.markAnswered();
    const quiet = { ringing: false, number: null };
    assert.equal(w.update(quiet, 500), null);
    assert.equal(w.update(quiet, 500 + DVCRingScreen.STOP_GRACE_MS), null, 'not stopped after the short grace');
    assert.deepEqual(plain(w.update(quiet, 500 + DVCRingScreen.ANSWERED_GRACE_MS)), { event: 'stopped', number: '0401234567' });
    w.update({ ringing: true, number: '0407654321' }, 30000);
    w.update(quiet, 31000);
    assert.deepEqual(plain(w.update(quiet, 31000 + DVCRingScreen.STOP_GRACE_MS)), { event: 'stopped', number: '0407654321' },
        'the next call starts unanswered');
});

test('a missed call is reported within half a second of DNA closing its pop-up', () => {
    assert.ok(DVCRingScreen.STOP_GRACE_MS <= 500);
});

test('the backend address becomes the host permission the browser is asked for', () => {
    assert.equal(DVCSoftphone.originPattern('https://api.example.fi'), 'https://api.example.fi/*');
    assert.equal(DVCSoftphone.originPattern('https://api.example.fi:8443/path/'), 'https://api.example.fi/*', 'no port in patterns');
    assert.equal(DVCSoftphone.originPattern('http://localhost:8765'), 'http://localhost/*');
    assert.equal(DVCSoftphone.originPattern('http://api.example.fi'), null, 'plain http only for localhost');
    assert.equal(DVCSoftphone.originPattern('api.example.fi'), null);
    assert.equal(DVCSoftphone.originPattern(''), null);
});

test('a connect link gives the API address and token', () => {
    const link = DVCConnect.parseLink('#api=' + encodeURIComponent('https://api.example.fi/calls/') + '&token=abc123');
    assert.deepEqual(plain(link), { apiUrl: 'https://api.example.fi/calls', token: 'abc123' });
    assert.deepEqual(plain(DVCConnect.parseLink('#api=http%3A%2F%2Flocalhost%3A8765%2Fapi&token=t')),
        { apiUrl: 'http://localhost:8765/api', token: 't' });
});

test('a connect link without https, address or token is refused', () => {
    assert.ok(DVCConnect.parseLink('#api=' + encodeURIComponent('http://api.example.fi') + '&token=t').error);
    assert.ok(DVCConnect.parseLink('#token=t').error);
    assert.ok(DVCConnect.parseLink('#api=' + encodeURIComponent('https://api.example.fi')).error);
    assert.ok(DVCConnect.parseLink('').error);
    assert.ok(DVCConnect.parseLink('#api=' + encodeURIComponent('https://user:pw@api.example.fi') + '&token=t').error);
    assert.ok(DVCConnect.parseLink('#api=' + encodeURIComponent('https://api.example.fi') + '&token=a%20b').error);
    assert.ok(DVCConnect.parseLink('#api=' + encodeURIComponent('https://api.example.fi') + '&token=' + 'x'.repeat(513)).error);
});

test('a link connects a new install and renews the same backend, never moves to another', () => {
    assert.equal(DVCConnect.decide(undefined, 'https://api.example.fi/calls'), 'connect');
    assert.equal(DVCConnect.decide('', 'https://api.example.fi/calls'), 'connect');
    assert.equal(DVCConnect.decide('https://api.example.fi/calls/', 'https://api.example.fi/calls'), 'renew');
    assert.equal(DVCConnect.decide('https://api.example.fi/calls', 'https://other.example.com/calls'), 'refuse');
    assert.equal(DVCConnect.decide('https://api.example.fi/calls', 'https://api.example.fi/other'), 'refuse');
});

test('call audio goes only to the transcription and AI services', () => {
    assert.equal(DVCConnect.isProviderStream('wss://eu.rt.speechmatics.com/v2?jwt=x'), true);
    assert.equal(DVCConnect.isProviderStream('wss://eu2.rt.speechmatics.com/v2'), true);
    assert.equal(DVCConnect.isProviderStream('wss://api.openai.com/v1/realtime?model=x'), true);
    assert.equal(DVCConnect.isProviderStream('wss://evil.example.com/v2'), false);
    assert.equal(DVCConnect.isProviderStream('wss://rt.speechmatics.com.evil.example.com/'), false);
    assert.equal(DVCConnect.isProviderStream('wss://evilrt.speechmatics.com/'), false);
    assert.equal(DVCConnect.isProviderStream('ws://eu.rt.speechmatics.com/'), false, 'encrypted only');
    assert.equal(DVCConnect.isProviderStream('https://api.openai.com/'), false);
    assert.equal(DVCConnect.isProviderStream(''), false);
});
