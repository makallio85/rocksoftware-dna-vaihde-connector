/*
 * The DNA call window (vaihde.dna.fi/join/main/…), isolated world.
 *
 * Asks the service worker whether this window belongs to a call queued from the
 * backend. If it does, it watches the window for the call connecting and ending,
 * starts and stops the page capture accordingly, relays audio between the page
 * and the service worker, and carries out hang-up and take-over. A call nobody
 * queued from the backend is left alone.
 */
(function () {
    'use strict';

    var FROM_PAGE = 'dvc-calls-page';
    var TO_PAGE = 'dvc-calls-extension';
    var AI_ARM_KEY = 'dvc-calls-ai-arm';
    var WATCH_MS = 500;
    var CLOSE_DELAY_MS = 3000;
    /** DNA's own end-call control, found by its label or tooltip. */
    var HANGUP_LABEL = /\b(leave call|end call|hang ?up|lopeta puhelu|katkaise|päätä puhelu|poistu puhelusta)\b/i;

    var port = chrome.runtime.connect({ name: 'call-window' });
    var tracker = new DVCCallState.Tracker();
    var call = null;
    var capturing = false;
    var aiActive = false;
    var hangingUp = false;
    var watchTimer = null;
    var panel = null;
    var statusLine = null;
    var actions = null;

    function toPage(type, extra, transfer) {
        var message = Object.assign({ source: TO_PAGE, type: type }, extra || {});
        window.postMessage(message, location.origin, transfer || []);
    }

    function button(label, onClick, danger) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        Object.assign(b.style, {
            margin: '6px 6px 0 0', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
            border: '1px solid ' + (danger ? '#b02a37' : '#164d38'),
            background: danger ? '#fff' : '#164d38', color: danger ? '#b02a37' : '#fff', font: '13px sans-serif',
        });
        b.addEventListener('click', onClick);
        return b;
    }

    function ensurePanel() {
        if (panel) {
            return;
        }
        panel = document.createElement('div');
        panel.id = 'dvc-calls-status';
        Object.assign(panel.style, {
            position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
            background: '#fff', color: '#172534', border: '2px solid #164d38', borderRadius: '8px',
            padding: '8px 12px', font: '13px sans-serif', maxWidth: '340px',
        });
        statusLine = document.createElement('div');
        statusLine.setAttribute('role', 'status');
        actions = document.createElement('div');
        panel.append(statusLine, actions);
        document.body.appendChild(panel);
    }

    function show(text, tone) {
        ensurePanel();
        panel.style.borderColor = tone === 'error' ? '#b02a37' : '#164d38';
        statusLine.textContent = 'DNA Connector: ' + text;
    }

    function setActions(list) {
        ensurePanel();
        actions.replaceChildren.apply(actions, list);
    }

    function snapshot() {
        return { title: document.title, text: document.body ? document.body.innerText : '' };
    }

    function stopCapture() {
        if (capturing) {
            toPage('stop');
            capturing = false;
        }
    }

    function report(status, closing) {
        stopCapture();
        aiActive = false;
        try { localStorage.removeItem(AI_ARM_KEY); } catch (e) { /* storage unavailable */ }
        port.postMessage({ type: 'status', status: status });
        clearInterval(watchTimer);
        setActions([]);
        show((status === 'ended' ? 'puhelu päättyi.' : 'puhelu ei yhdistynyt.') + (closing ? '' : ' Ikkuna suljetaan.'));
        if (!closing) {
            // DNA leaves its ended call window open. It is closed only after
            // DNA itself shows the call over, and after a pause so the employee
            // sees how it ended.
            setTimeout(function () { port.postMessage({ type: 'close-window' }); }, CLOSE_DELAY_MS);
        }
    }

    function watch() {
        var event = tracker.update(snapshot());
        if (event === 'connected') {
            show(call && call.ai_agent ? 'puhelu yhdistetty, tekoäly aloittaa…' : 'puhelu yhdistetty, aloitetaan litterointi…');
            port.postMessage({ type: 'status', status: 'connected' });
            setActions([button('Lopeta puhelu', hangUp, true)]);
        } else if (event === 'ended' || event === 'failed') {
            report(event);
        }
    }

    /**
     * Ends the call the way the employee would: DNA's own end-call control.
     * If it cannot be found, the call window is closed, which ends the call.
     */
    function hangUp() {
        if (hangingUp) {
            return;
        }
        hangingUp = true;
        var candidates = Array.prototype.filter.call(document.querySelectorAll('button, [role="button"]'), function (b) {
            var label = [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-tooltip'), b.textContent].join(' ');
            return HANGUP_LABEL.test(label) && !(panel && panel.contains(b));
        });
        if (candidates.length) {
            console.info('[DNA Connector] Ending the call with', candidates[0]);
            candidates[0].click();
            show('lopetetaan puhelu…');
            // If DNA does not show the call ended, the window goes anyway.
            setTimeout(function () {
                if (!tracker.finished) {
                    port.postMessage({ type: 'force-close' });
                }
            }, 6000);
        } else {
            console.warn('[DNA Connector] No end-call control found; closing the call window.');
            port.postMessage({ type: 'force-close' });
        }
    }

    function takeOver() {
        if (!aiActive) {
            return;
        }
        aiActive = false;
        toPage('take-over');
        port.postMessage({ type: 'take-over' });
        show('otit puhelun – mikrofonisi on päällä.');
        setActions([button('Lopeta puhelu', hangUp, true)]);
    }

    port.onMessage.addListener(function (message) {
        switch (message.type) {
            case 'call':
                call = message.call;
                show((call.ai_agent ? 'tekoälypuhelu ' : (call.direction === 'incoming' ? 'saapuva puhelu ' : 'puhelu '))
                    + call.phone_number + '.');
                watchTimer = setInterval(watch, WATCH_MS);
                break;
            case 'transcribing':
                capturing = true;
                toPage('start', { rate: 16000, channels: ['employee', 'customer'] });
                show('litterointi käynnissä. Ääntä ei tallenneta.');
                break;
            case 'agent-started':
                capturing = true;
                aiActive = true;
                toPage('start', { rate: message.sample_rate || 24000, channels: ['customer'] });
                toPage('resume-audio');
                show('tekoäly hoitaa puhelua – sinä kuuntelet. Puhelu litteroidaan.');
                setActions([button('Ota puhelu', takeOver), button('Lopeta puhelu', hangUp, true)]);
                break;
            case 'ai-audio':
                var bytes = DVCPcm.fromBase64(message.data);
                toPage('ai-audio', { pcm: bytes.buffer, rate: message.rate || 24000 }, [bytes.buffer]);
                break;
            case 'ai-flush':
                toPage('ai-flush');
                break;
            case 'end-call':
                // The AI said goodbye: let its last words play out, then hang up.
                show('tekoäly lopettaa puhelun…');
                toPage('ai-notify-drained');
                break;
            case 'hangup':
                hangUp();
                break;
            case 'take-over':
                takeOver();
                break;
            case 'not-transcribing':
                show(message.reason || 'puhelua ei litteroida.');
                break;
            case 'stop-capture':
                stopCapture();
                show(message.reason || 'litterointi lopetettu.');
                break;
            case 'error':
                show(message.error, 'error');
                break;
            // A colleague listening in from the backend: the page builds the
            // connection, since only it holds the call's audio.
            case 'listen-offer':
                toPage('listen-start', { id: message.id, iceServers: message.ice_servers || [] });
                break;
            case 'listen-answer':
                toPage('listen-answer', { id: message.id, sdp: message.sdp });
                break;
            case 'listen-stop':
                toPage('listen-stop', { id: message.id });
                break;
        }
    });

    port.onDisconnect.addListener(function () {
        stopCapture();
        clearInterval(watchTimer);
    });

    window.addEventListener('message', function (event) {
        var data = event.data;
        if (event.source !== window || !data || data.source !== FROM_PAGE || !call) {
            return;
        }
        if (data.type === 'audio' && capturing) {
            port.postMessage({ type: 'audio', channel: data.channel, data: DVCPcm.toBase64(new Uint8Array(data.pcm)) });
        } else if (data.type === 'ai-drained') {
            setTimeout(hangUp, 400);
        } else if (data.type === 'mixer-state' && data.state === 'suspended' && aiActive) {
            show('selain pysäytti äänen – klikkaa tätä laatikkoa, jotta tekoäly kuuluu.', 'error');
            panel.addEventListener('click', function () { toPage('resume-audio'); }, { once: true });
        } else if (data.type === 'listen-offer') {
            port.postMessage({ type: 'listen-offer', id: data.id, sdp: data.sdp });
        } else if (data.type === 'listen-error') {
            port.postMessage({ type: 'listen-failed', id: data.id });
        } else if (data.type === 'capture-error') {
            show('äänen kaappaus epäonnistui: ' + data.error, 'error');
        } else if (data.type === 'capture-started' && data.wanted.length === 2 && (!data.mic || !data.remote)) {
            show('litteroidaan vain ' + (data.mic ? 'oma ääni' : 'asiakkaan ääni') + ' – toista ääntä ei löytynyt.', 'error');
        }
    });

    window.addEventListener('pagehide', function () {
        var event = tracker.closed();
        if (event) {
            report(event, true);
        }
    });

    port.postMessage({ type: 'hello' });
})();
