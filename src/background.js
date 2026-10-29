/*
 * Service worker: the only part of the extension that talks to the backend, to
 * Speechmatics and to OpenAI.
 *
 * It holds the employee's API token for the backend (chrome.storage.local, set on the
 * options page) and relays the directory's polling and claims to the backend's
 * public API. During a call it keeps the call's live connections:
 *
 *  - an ordinary call: one Speechmatics WebSocket per side, for the transcript;
 *  - an AI call: one OpenAI Realtime WebSocket. The customer's audio goes in;
 *    the agent's voice, its transcript, the customer's transcript and the
 *    agent's tool calls (save_note, end_call) come out.
 *
 * Audio arrives from the call window as base64 chunks and is never written
 * anywhere. Transcript lines go to the backend about once a second, usage (for the
 * cost of each call) every 15 seconds and when the call ends.
 *
 * The sockets live here rather than in the DNA page so the page's own security
 * policy cannot block them. No long-lived provider key ever exists here: the
 * backend hands out short-lived keys bound to each session.
 */
importScripts('shared/transcript.js', 'shared/pcm.js', 'shared/usage.js', 'shared/listen.js', 'shared/incoming.js', 'shared/softphone.js', 'shared/connect.js');

var FLUSH_MS = 1000;
var WATCH_MS = 2000;
var USAGE_MS = 15000;
var END_WAIT_MS = 8000;
var CLAIM_WINDOW_MS = 60000;
var MAX_REOPENS = 3;

/** The call the directory dialled last, waiting for its call window. */
var claimed = null;
/** The call in progress, at most one. */
var session = null;

// --- Backend -----------------------------------------------------------------

async function settings() {
    var stored = await chrome.storage.local.get(['apiUrl', 'token']);
    return {
        apiUrl: String(stored.apiUrl || '').replace(/\/+$/, ''),
        token: String(stored.token || ''),
    };
}

/**
 * Calls the backend's public API. Throws an Error whose message is Finnish copy
 * for the status box, with `status` set when the backend answered.
 */
async function api(method, path, body) {
    var s = await settings();
    if (!s.apiUrl || !s.token) {
        throw new Error('Aseta taustajärjestelmän API-osoite ja API-token laajennuksen asetuksista.');
    }
    var pattern = DVCSoftphone.originPattern(s.apiUrl);
    if (!pattern || !(await chrome.permissions.contains({ origins: [pattern] }))) {
        throw new Error('Laajennukselta puuttuu lupa taustajärjestelmän osoitteeseen. Avaa laajennuksen asetukset, paina Tallenna ja valitse Salli.');
    }
    var response;
    try {
        // apiUrl is the API's full base address, e.g. https://example.fi/api/calls
        response = await fetch(s.apiUrl + '/' + path, {
            method: method,
            headers: {
                Authorization: 'Bearer ' + s.token,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch (e) {
        throw new Error('Taustajärjestelmä ei vastaa.');
    }
    var data = {};
    try { data = await response.json(); } catch (e) { /* An HTML error page carries nothing to show. */ }
    if (!response.ok) {
        var message = response.status === 401 ? 'Taustajärjestelmä hylkäsi API-tokenin.'
            : response.status === 403 ? 'API-tokenilta puuttuu puheluiden oikeus.'
            : (data.error || 'Taustajärjestelmä vastasi virheellä (' + response.status + ').');
        var error = new Error(message);
        error.status = response.status;
        throw error;
    }
    return data;
}

// --- Softphone state -------------------------------------------------------------
//
// The backend is told what this browser can do about every 5 seconds while a DNA
// directory tab polls, and every 30 seconds otherwise (an alarm, which also
// wakes this worker). The backend shows it and refuses to queue calls while DNA is
// not ready; a call whose softphone falls silent is settled by the backend.

var REPORT_MS = 5000;
var HEARTBEAT_ALARM = 'dvc-softphone-heartbeat';

/** DNA directory tabs that poll, by tab id: {firstSeen, lastSeen}. */
var directoryTabs = {};
/** What the dialling tab last said: DNA's dial input on screen, the microphone permission. */
var dialerReady = null;
var microphone = null;
/** DNA's call window did not open after the last dial. */
var popupsBlocked = false;
var lastReportAt = 0;
/** The backend's answer to the last report: {allowed, reasons, warnings}. */
var lastSoftphone = null;
/** A claim is on its way to the backend; no second one starts meanwhile. */
var claiming = false;

chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === HEARTBEAT_ALARM) {
        void heartbeat(true);
    }
});
chrome.tabs.onRemoved.addListener(function (tabId) {
    if (directoryTabs[tabId]) {
        delete directoryTabs[tabId];
        void heartbeat(true);
    }
});

/**
 * Reports the softphone's state, at most every 5 seconds unless forced.
 * A failure is left for the next report.
 */
async function heartbeat(force) {
    if (!force && Date.now() - lastReportAt < REPORT_MS) {
        return;
    }
    lastReportAt = Date.now();
    DVCSoftphone.primaryTab(directoryTabs, Date.now());
    var body = DVCSoftphone.report({
        version: chrome.runtime.getManifest().version,
        tabs: directoryTabs,
        dialerReady: dialerReady,
        microphone: microphone,
        popupsBlocked: popupsBlocked,
    });
    try {
        lastSoftphone = (await api('POST', 'call-softphones/add', body)).softphone || null;
    } catch (e) {
        lastSoftphone = null;
    }
}

/**
 * Notes a directory tab's poll. Answers whether that tab is the one that
 * dials: with two DNA tabs open both would otherwise take the same call.
 */
function seeDirectoryTab(sender, message) {
    var tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId === null) {
        return true; // the options page testing the connection
    }
    var now = Date.now();
    directoryTabs[tabId] = { firstSeen: directoryTabs[tabId] ? directoryTabs[tabId].firstSeen : now, lastSeen: now };
    var primary = DVCSoftphone.primaryTab(directoryTabs, now);
    if (primary === tabId && message.type === 'poll') {
        var changed = dialerReady !== !!message.dialerReady || microphone !== (message.microphone || null);
        dialerReady = !!message.dialerReady;
        microphone = message.microphone || null;
        if (changed) {
            // Signing in or allowing the microphone shows in the DNA tab and
            // the backend at once, not at the next 15-second report.
            void heartbeat(true);
        }
    }
    return primary === tabId;
}

/** The *Tarkista* checklist on the options page, from a fresh look at everything. */
async function diagnose() {
    var s = await settings();
    var apiError = null;
    if (s.apiUrl && s.token) {
        try {
            await api('GET', 'calls/index');
        } catch (e) {
            apiError = e.message;
        }
        await heartbeat(true);
    }
    DVCSoftphone.primaryTab(directoryTabs, Date.now());
    var tabs = Object.keys(directoryTabs).length;
    return {
        lines: DVCSoftphone.diagnose({
            settings: !!(s.apiUrl && s.token),
            backend: apiError,
            tabs: tabs,
            dialerReady: dialerReady,
            microphone: microphone,
            popupsBlocked: popupsBlocked,
            softphone: lastSoftphone,
        }),
        version: chrome.runtime.getManifest().version,
    };
}

// --- Directory messages ---------------------------------------------------------

chrome.runtime.onMessage.addListener(function (message, sender, reply) {
    handle(message, sender).then(reply, function (e) { reply({ error: e.message }); });
    return true;
});

// --- Incoming calls -------------------------------------------------------------
//
// The dialling DNA tab reads DNA's ringing pop-up (directory.js with
// shared/ring-screen.js) and reports the moments of an incoming call:
//
//   → {type: 'incoming-ringing', number}   it started ringing here; answers {call_id}
//   → {type: 'incoming-stopped', callId}   it stopped ringing here, unanswered
//   ← {type: 'answer-incoming', callId}    sent to that tab: answer in DNA now
//                                          (the employee answered in the backend)
//   ← {type: 'answered-elsewhere', callId, name}  a colleague took it
//
// Answering in DNA needs no message: DNA opens its call window, which binds to
// the reported call exactly as to a dialled one, and its "connected" is the
// answer the backend records (the first softphone to answer gets the call).

var RING_WATCH_MS = 2000;
/** Calls ringing on this softphone, by id. */
var ringing = {};
var ringTimer = null;

async function reportRinging(number, tabId) {
    var result = await api('POST', 'calls/add', { phone_number: number, direction: 'incoming' });
    var call = result.call;
    ringing[call.id] = { call: call, tabId: tabId, askedToAnswer: false, windowBound: false };
    if (!session && !claimed) {
        // The call window DNA opens on answering binds to this call.
        claimed = { call: call, at: Date.now(), window: false, incoming: true };
    }
    if (!ringTimer) {
        ringTimer = setInterval(function () { void watchRinging(); }, RING_WATCH_MS);
    }
    return { call_id: call.id };
}

async function reportStopped(callId) {
    var entry = ringing[callId];
    if (!entry || entry.windowBound) {
        return { ok: true };
    }
    forgetRinging(callId);
    try { await api('POST', 'calls/edit/' + callId, { status: 'missed' }); } catch (e) { /* answered elsewhere meanwhile */ }
    return { ok: true };
}

function forgetRinging(callId) {
    delete ringing[callId];
    if (claimed && claimed.incoming && claimed.call.id === Number(callId) && !claimed.window) {
        claimed = null;
    }
    if (!Object.keys(ringing).length && ringTimer) {
        clearInterval(ringTimer);
        ringTimer = null;
    }
}

async function watchRinging() {
    var ids = Object.keys(ringing);
    for (var i = 0; i < ids.length; i++) {
        var entry = ringing[ids[i]];
        if (!entry) {
            continue;
        }
        var call = null;
        try {
            call = (await api('GET', 'calls/view/' + ids[i])).call;
        } catch (e) {
            if (e.status !== 404) {
                continue; // a missed check is retried on the next tick
            }
        }
        var next = DVCIncoming.decide(entry, call);
        if (next === 'answer-in-dna') {
            entry.askedToAnswer = true;
            chrome.tabs.sendMessage(entry.tabId, { type: 'answer-incoming', callId: Number(ids[i]) }).catch(function () {});
        } else if (next === 'answered-elsewhere') {
            chrome.tabs.sendMessage(entry.tabId, { type: 'answered-elsewhere', callId: Number(ids[i]), name: call.user_name }).catch(function () {});
            forgetRinging(ids[i]);
            api('POST', 'calls/edit/' + ids[i], { status: 'missed' }).catch(function () {});
        } else if (next === 'gone') {
            forgetRinging(ids[i]);
        }
    }
}

// --- Observe-only mode -------------------------------------------------------

/** The most entries kept; the oldest go first. */
var OBSERVE_MAX = 5000;
var observeBuffer = [];
var observeTimer = null;

/**
 * Queues an observed entry and writes the queue to storage at most twice a
 * second, so a burst of changes is one storage write.
 */
function observe(entry) {
    observeBuffer.push(entry);
    if (observeTimer) {
        return;
    }
    observeTimer = setTimeout(async function () {
        observeTimer = null;
        var pending = observeBuffer;
        observeBuffer = [];
        var stored = await chrome.storage.local.get(['observeLog']);
        var log = (stored.observeLog || []).concat(pending);
        await chrome.storage.local.set({ observeLog: log.slice(-OBSERVE_MAX) });
    }, 500);
}

async function handle(message, sender) {
    if (message.type === 'incoming-ringing') {
        if (!seeDirectoryTab(sender, message)) {
            throw new Error('Toinen DNA-välilehti hoitaa puhelut.');
        }
        return reportRinging(String(message.number || ''), sender && sender.tab ? sender.tab.id : null);
    }
    if (message.type === 'incoming-stopped') {
        return reportStopped(message.callId);
    }
    if (message.type === 'observe-log') {
        observe(message.entry);
        return { ok: true };
    }
    if (message.type === 'diagnose') {
        return diagnose();
    }
    if (message.type === 'window-missing') {
        popupsBlocked = true;
        void heartbeat(true);
        return { ok: true };
    }
    if (message.type === 'poll') {
        var dials = seeDirectoryTab(sender, message);
        void heartbeat(false);
        if (!dials) {
            return { calls: [], duplicate: true };
        }
        if (claimed && !claimed.window && Date.now() - claimed.at >= CLAIM_WINDOW_MS) {
            // DNA never opened a call window for it: release the employee.
            var abandoned = claimed;
            claimed = null;
            // An incoming call nobody answered here is settled by its ring
            // reports (incoming-stopped), not as a failed dial.
            if (!abandoned.incoming) {
                try { await api('POST', 'calls/edit/' + abandoned.call.id, { status: 'failed' }); } catch (e) { /* already moved on */ }
            }
        }
        if (session || (claimed && !claimed.window)) {
            return { calls: [], softphone: lastSoftphone };
        }
        return { calls: (await api('GET', 'calls/index')).calls || [], softphone: lastSoftphone };
    }
    if (message.type === 'claim') {
        // One call at a time, from the dialling tab only. The flag is set before
        // the backend is asked, so a second claim arriving meanwhile is refused here;
        // the backend refuses a second claim of the same call from another browser.
        if (claiming || session || (claimed && !claimed.window)) {
            throw new Error('Toinen puhelu on jo valinnassa.');
        }
        if (!seeDirectoryTab(sender, message)) {
            throw new Error('Toinen DNA-välilehti hoitaa puhelut.');
        }
        claiming = true;
        try {
            var result = await api('POST', 'calls/edit/' + message.call.id, { status: 'dialing' });
            claimed = { call: result.call, at: Date.now(), window: false };
        } finally {
            claiming = false;
        }
        return { ok: true };
    }
    if (message.type === 'call-window-opened') {
        return { opened: !!(claimed && claimed.call.id === message.callId && claimed.window) || !!(session && session.call.id === message.callId) };
    }
    return { error: 'Tuntematon viesti.' };
}

// --- Call window --------------------------------------------------------------

chrome.runtime.onConnect.addListener(function (port) {
    if (port.name !== 'call-window') {
        return;
    }
    var mine = null;

    port.onMessage.addListener(function (message) {
        if (message.type === 'hello') {
            if (claimed && !claimed.window && Date.now() - claimed.at < CLAIM_WINDOW_MS && !session) {
                claimed.window = true;
                popupsBlocked = false;
                mine = {
                    call: claimed.call,
                    port: port,
                    connected: false,
                    finished: false,
                    listen: {},
                    meter: new DVCUsage.Meter(),
                    collector: new DVCTranscript.Collector(),
                };
                session = mine;
                if (ringing[mine.call.id]) {
                    ringing[mine.call.id].windowBound = true;
                    forgetRinging(mine.call.id);
                }
                port.postMessage({ type: 'call', call: mine.call });
            }
            return;
        }
        if (message.type === 'close-window' && mine && mine.finished && port.sender && port.sender.tab) {
            // Only a window this worker bound to a backend call, and only once the
            // call has finished. The transcript flush goes on without the tab.
            chrome.tabs.remove(port.sender.tab.id).catch(function () { /* closed already */ });
            return;
        }
        if (message.type === 'force-close' && mine && port.sender && port.sender.tab) {
            // DNA's end-call control was not found or did not end the call:
            // closing the call window ends it.
            if (!mine.finished) {
                void finish(mine, mine.connected ? 'ended' : 'failed');
            }
            chrome.tabs.remove(port.sender.tab.id).catch(function () { /* closed already */ });
            return;
        }
        if (!mine || mine.finished) {
            return;
        }
        if (message.type === 'status' && message.status === 'connected') {
            void connect(mine);
        } else if (message.type === 'status') {
            void finish(mine, message.status);
        } else if (message.type === 'audio') {
            sendAudio(mine, message.channel, message.data);
        } else if (message.type === 'take-over') {
            void stopAgent(mine, true);
        } else if (message.type === 'listen-offer') {
            void sendListenOffer(mine, message.id, message.sdp);
        } else if (message.type === 'listen-failed') {
            mine.listen[message.id] = 'ended';
            api('POST', 'call-listen-sessions/edit/' + message.id, { status: 'ended' }).catch(function () {});
        }
    });

    port.onDisconnect.addListener(function () {
        if (mine && !mine.finished) {
            void finish(mine, mine.connected ? 'ended' : 'failed');
        }
    });
});

async function connect(s) {
    s.connected = true;
    s.connectedAt = Date.now();
    s.flushTimer = setInterval(function () { void flush(s); }, FLUSH_MS);
    s.watchTimer = setInterval(function () { void watchCall(s); }, WATCH_MS);
    s.usageTimer = setInterval(function () { void reportUsage(s); }, USAGE_MS);
    try {
        var result = await api('POST', 'calls/edit/' + s.call.id, { status: 'connected' });
        if (result.agent) {
            if (!DVCConnect.isProviderStream(result.agent.url)) {
                s.port.postMessage({ type: 'not-transcribing', reason: 'taustajärjestelmän antama tekoälyosoite ei ole sallittu.' });
                return;
            }
            openAgent(s, result.agent);
            s.port.postMessage({ type: 'agent-started', sample_rate: result.agent.sample_rate });
            return;
        }
        if (!result.transcription) {
            s.port.postMessage({ type: 'not-transcribing', reason: result.transcription_error || 'puhelua ei litteroida.' });
            return;
        }
        if (!DVCConnect.isProviderStream(result.transcription.url)) {
            s.port.postMessage({ type: 'not-transcribing', reason: 'taustajärjestelmän antama litterointiosoite ei ole sallittu.' });
            return;
        }
        s.sockets = {};
        s.reopens = 0;
        result.transcription.channels.forEach(function (channel) {
            open(s, channel, result.transcription);
        });
        s.port.postMessage({ type: 'transcribing' });
    } catch (e) {
        s.port.postMessage({ type: 'error', error: e.message });
    }
}

// --- OpenAI Realtime agent ------------------------------------------------------

function openAgent(s, agent) {
    if (!DVCConnect.isProviderStream(agent.url)) {
        return;
    }
    var socket = new WebSocket(agent.url, ['realtime', 'openai-insecure-api-key.' + agent.client_secret]);
    s.agent = { socket: socket, rate: agent.sample_rate || 24000, open: false, ending: false };

    socket.onopen = function () {
        s.agent.open = true;
        // The session's instructions tell the agent to open with the AI
        // disclosure; this asks it to start talking.
        socket.send(JSON.stringify({ type: 'response.create' }));
    };
    socket.onmessage = function (event) {
        var message;
        try { message = JSON.parse(event.data); } catch (e) { return; }
        onAgentEvent(s, message);
    };
    socket.onclose = function (event) {
        if (s.agent) {
            s.agent.open = false;
        }
        if (!s.finished && !s.agentStopped && event.code !== 1000) {
            s.port.postMessage({ type: 'error', error: 'Tekoälyn yhteys katkesi (' + event.code + (event.reason ? ': ' + event.reason : '') + '). Ota puhelu.' });
        }
    };
}

function onAgentEvent(s, message) {
    var at = Date.now() - s.connectedAt;
    switch (message.type) {
        case 'response.output_audio.delta':
            if (!s.agentStopped) {
                s.port.postMessage({ type: 'ai-audio', data: message.delta, rate: s.agent.rate });
            }
            break;
        case 'input_audio_buffer.speech_started':
            // The customer started talking: the agent's voice stops at once.
            s.port.postMessage({ type: 'ai-flush' });
            break;
        case 'conversation.item.input_audio_transcription.completed':
            s.collector.addText('customer', message.transcript, at);
            break;
        case 'response.output_audio_transcript.done':
            s.collector.addText('ai', message.transcript, at);
            break;
        case 'response.function_call_arguments.done':
            void onToolCall(s, message);
            break;
        case 'response.done':
            if (message.response) {
                s.meter.addRealtimeUsage(message.response.usage);
            }
            break;
        case 'error':
            s.port.postMessage({ type: 'error', error: 'OpenAI: ' + ((message.error && message.error.message) || 'virhe') });
            break;
    }
}

async function onToolCall(s, message) {
    var args = {};
    try { args = JSON.parse(message.arguments || '{}'); } catch (e) { /* answered as a failure below */ }
    var output = { ok: true };

    if (message.name === 'save_note') {
        try {
            await api('POST', 'messages/add', { call_id: s.call.id, text: String(args.text || '') });
        } catch (e) {
            output = { ok: false, error: e.message };
        }
    } else if (message.name === 'end_call') {
        s.agent.ending = true;
    } else {
        output = { ok: false, error: 'Tuntematon työkalu.' };
    }

    sendAgent(s, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: message.call_id, output: JSON.stringify(output) } });
    if (message.name === 'end_call') {
        // The agent said goodbye before calling it: once its voice has played
        // out, the call window hangs up.
        s.port.postMessage({ type: 'end-call' });
    } else {
        sendAgent(s, { type: 'response.create' });
    }
}

function sendAgent(s, event) {
    if (s.agent && s.agent.socket.readyState === WebSocket.OPEN) {
        s.agent.socket.send(JSON.stringify(event));
    }
}

/**
 * The employee took the call over: the agent goes quiet for good. `report`
 * tells the backend when the take-over came from the call window.
 */
async function stopAgent(s, report) {
    if (s.agentStopped || !s.agent) {
        return;
    }
    s.agentStopped = true;
    sendAgent(s, { type: 'response.cancel' });
    try { s.agent.socket.close(1000); } catch (e) { /* already closed */ }
    if (report) {
        try { await api('POST', 'calls/edit/' + s.call.id, { agent_stopped: true }); } catch (e) { /* the panel shows the old state until the next check */ }
    }
}

// --- Speechmatics streams ----------------------------------------------------------

function open(s, channel, transcription) {
    if (!DVCConnect.isProviderStream(transcription.url)) {
        // Also on a reopen: call audio goes to the transcription service only.
        return;
    }
    var socket = new WebSocket(transcription.url);
    var stream = { socket: socket, started: false, sent: 0, closing: false, done: null };
    stream.finished = new Promise(function (resolve) { stream.done = resolve; });
    s.sockets[channel] = stream;

    socket.binaryType = 'arraybuffer';
    socket.onopen = function () {
        socket.send(JSON.stringify(transcription.start_recognition));
    };
    socket.onmessage = function (event) {
        if (typeof event.data !== 'string') {
            return;
        }
        var message;
        try { message = JSON.parse(event.data); } catch (e) { return; }
        if (message.message === 'RecognitionStarted') {
            stream.started = true;
            s.collector.setOffset(channel, Date.now() - s.connectedAt);
        } else if (message.message === 'AddTranscript') {
            s.collector.accept(channel, message);
        } else if (message.message === 'EndOfTranscript') {
            stream.done();
        } else if (message.message === 'Error') {
            // A refusal (bad settings, quota, key) closes the stream and would
            // be refused again on a new one, so it is shown, not retried.
            stream.refused = true;
            s.port.postMessage({ type: 'error', error: 'Speechmatics: ' + (message.reason || message.type) });
        }
    };
    socket.onclose = function () {
        stream.done();
        if (!stream.closing && !stream.refused && !s.finished && !s.stopped) {
            void reopen(s, channel);
        }
    };
}

/** A stream dropped mid-call: ask the backend for a fresh key and open it again. */
async function reopen(s, channel) {
    if (s.reopens >= MAX_REOPENS) {
        s.port.postMessage({ type: 'error', error: 'Litterointiyhteys katkesi.' });
        return;
    }
    s.reopens++;
    try {
        var result = await api('POST', 'calls/edit/' + s.call.id, { status: 'connected' });
        if (result.transcription && !s.finished && !s.stopped) {
            open(s, channel, result.transcription);
        }
    } catch (e) {
        s.port.postMessage({ type: 'error', error: e.message });
    }
}

function sendAudio(s, channel, base64) {
    if (s.agent) {
        if (channel !== 'customer' || s.agentStopped || !s.agent.open) {
            return;
        }
        sendAgent(s, { type: 'input_audio_buffer.append', audio: base64 });
        s.meter.addOpenAiAudioBytes(Math.floor(base64.length * 3 / 4));
        return;
    }
    var stream = s.sockets && s.sockets[channel];
    if (!stream || !stream.started || stream.closing || stream.socket.readyState !== WebSocket.OPEN) {
        return;
    }
    var bytes = DVCPcm.fromBase64(base64);
    stream.socket.send(bytes);
    stream.sent++;
    s.meter.addSpeechmaticsBytes(bytes.length);
}

async function flush(s) {
    if (s.flushing || s.collector.pending() === 0) {
        return;
    }
    s.flushing = true;
    var batch = s.collector.take(100);
    try {
        await api('POST', 'call-transcript-segments/add', { call_id: s.call.id, segments: batch });
    } catch (e) {
        if (e.status === 422) {
            stopTranscription(s, 'litterointi lopetettu taustajärjestelmässä.');
        } else {
            s.collector.putBack(batch);
        }
    } finally {
        s.flushing = false;
    }
}

async function reportUsage(s) {
    var usages = s.meter.report();
    if (usages.length === 0) {
        return;
    }
    try {
        await api('POST', 'call-usages/add', { call_id: s.call.id, usages: usages });
    } catch (e) {
        // Totals are cumulative: the next report carries what this one missed.
    }
}

/**
 * Notices, every couple of seconds, what was pressed in the backend: *Lopeta
 * puhelu*, *Ota puhelu*, *Lopeta litterointi*.
 */
async function watchCall(s) {
    try {
        var result = await api('GET', 'calls/view/' + s.call.id);
        var call = result.call;
        if (!call || s.finished) {
            return;
        }
        if (call.hangup_requested && !s.hangupSent) {
            s.hangupSent = true;
            s.port.postMessage({ type: 'hangup' });
        }
        if (s.agent && !s.agentStopped && call.ai_agent && !call.agent_active) {
            s.port.postMessage({ type: 'take-over' });
            void stopAgent(s, false);
        }
        if (!s.agent && !call.transcription_enabled) {
            stopTranscription(s, 'litterointi lopetettu taustajärjestelmässä.');
        }
        await watchListeners(s);
    } catch (e) {
        // A missed check is retried on the next tick.
    }
}

/**
 * Colleagues listening in through the backend. For each new request
 * the call window makes a WebRTC offer; the listener's answer is handed back
 * to it; an ended session is closed. The audio goes from the call window
 * straight to the listener, never through here.
 */
async function watchListeners(s) {
    var result = await api('GET', 'call-listen-sessions/index?call_id=' + s.call.id);
    DVCListen.plan(result.sessions || [], s.listen).forEach(function (step) {
        s.listen[step.id] = DVCListen.AFTER[step.action];
        if (step.action === 'offer') {
            s.port.postMessage({ type: 'listen-offer', id: step.id, ice_servers: step.iceServers });
        } else if (step.action === 'answer') {
            s.port.postMessage({ type: 'listen-answer', id: step.id, sdp: step.sdp });
        } else {
            s.port.postMessage({ type: 'listen-stop', id: step.id });
        }
    });
}

async function sendListenOffer(s, id, sdp) {
    try {
        await api('POST', 'call-listen-sessions/edit/' + id, { offer_sdp: sdp });
        s.listen[id] = 'offered';
    } catch (e) {
        s.listen[id] = 'ended';
        s.port.postMessage({ type: 'listen-stop', id: id });
    }
}

function closeStreams(s) {
    Object.keys(s.sockets || {}).forEach(function (channel) {
        var stream = s.sockets[channel];
        stream.closing = true;
        if (stream.socket.readyState === WebSocket.OPEN) {
            stream.socket.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: stream.sent }));
        }
    });
}

function stopTranscription(s, reason) {
    if (s.stopped) {
        return;
    }
    s.stopped = true;
    closeStreams(s);
    s.port.postMessage({ type: 'stop-capture', reason: reason });
}

async function finish(s, status) {
    s.finished = true;
    clearInterval(s.watchTimer);
    clearInterval(s.usageTimer);
    if (s.agent) {
        s.agentStopped = true;
        try { s.agent.socket.close(1000); } catch (e) { /* already closed */ }
    }
    if (s.sockets) {
        closeStreams(s);
        var finals = Object.keys(s.sockets).map(function (channel) { return s.sockets[channel].finished; });
        await Promise.race([Promise.all(finals), new Promise(function (r) { setTimeout(r, END_WAIT_MS); })]);
        Object.keys(s.sockets).forEach(function (channel) {
            try { s.sockets[channel].socket.close(); } catch (e) { /* already closed */ }
        });
    }
    clearInterval(s.flushTimer);
    while (s.collector.pending() > 0 && !s.stopped) {
        var before = s.collector.pending();
        await flush(s);
        if (s.collector.pending() >= before) {
            break;
        }
    }
    await reportUsage(s);
    try {
        await api('POST', 'calls/edit/' + s.call.id, { status: status });
    } catch (e) {
        // The backend refuses a move the call has already made; nothing to undo here.
    }
    if (session === s) {
        session = null;
    }
    if (claimed && claimed.call.id === s.call.id) {
        claimed = null;
    }
}
