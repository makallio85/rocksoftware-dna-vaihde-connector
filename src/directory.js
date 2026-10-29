/*
 * The DNA directory (vaihde.dna.fi/cwp/…), isolated world.
 *
 * While the directory is open it asks the backend, through the service worker,
 * every couple of seconds for calls queued for the signed-in employee.
 * A queued call is claimed (reported as dialling) and typed into DNA's own
 * dialler, whose Call button opens DNA's call window — exactly as if the
 * employee had typed it.
 *
 * DNA opens the call in a new window. A browser blocks a window a script
 * opens unless pop-ups are allowed for vaihde.dna.fi; the README says how, and
 * the status box tells the employee to press Call themselves if it happens.
 *
 * Only one directory tab dials: the service worker names the oldest one open,
 * and any other says so and stays idle. Each poll also tells the worker whether
 * DNA's dial input is on screen and whether the microphone is allowed, which it
 * reports to the backend; the backend's answer (ready, or what is wrong) is the status
 * line, the same reasons the backend shows. While the backend does not
 * answer, polls slow down to one every 30 seconds.
 */
(function () {
    'use strict';

    var WINDOW_WAIT_MS = 15000;
    var AI_ARM_KEY = 'dvc-calls-ai-arm';
    var AI_ARM_MS = 60000;
    var DIAL_INPUT = '#makeACall-input';

    /** A problem stays on screen this long even if the next poll is quiet. */
    var ERROR_HOLD_MS = 30000;
    var BORDERS = { error: '#b02a37', problem: '#b02a37', warning: '#997404', ok: '#164d38' };

    var busy = false;
    var failures = 0;
    var microphone = null;
    var panel = null;
    var holdUntil = 0;
    /** What the backend said about this softphone in the last poll. */
    var softphone = null;

    /** The resting status: ready, or what the backend says is wrong. */
    function showStatus() {
        var s = DVCSoftphone.status(softphone);
        show(s.text, s.tone);
    }

    /**
     * `error` is something that just went wrong here and stays a while; a
     * `problem` comes from the backend and clears as soon as the backend stops saying it.
     */
    function show(text, tone) {
        holdUntil = tone === 'error' ? Date.now() + ERROR_HOLD_MS : 0;
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'dvc-calls-status';
            panel.setAttribute('role', 'status');
            Object.assign(panel.style, {
                position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
                background: '#fff', color: '#172534', border: '2px solid #164d38', borderRadius: '8px',
                padding: '8px 12px', font: '13px sans-serif', maxWidth: '320px',
            });
            document.body.appendChild(panel);
        }
        panel.style.display = text ? 'block' : 'none';
        panel.style.borderColor = BORDERS[tone] || BORDERS.ok;
        panel.textContent = text ? 'DNA Connector: ' + text : '';
    }

    function ask(message) {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage(message, function (response) {
                resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : response || {});
            });
        });
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /**
     * Types into a React-controlled input the way a person would: the value is
     * set through the native setter so the framework sees the change.
     */
    function type(input, value) {
        var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        input.focus();
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /** The visible buttons around the dial input, nearest container first. */
    function nearbyButtons(input) {
        var scope = input;
        for (var depth = 0; depth < 4 && scope.parentElement; depth++) {
            scope = scope.parentElement;
        }
        return Array.prototype.filter.call(scope.querySelectorAll('button'), function (b) {
            return b.offsetParent !== null;
        });
    }

    function describe(button) {
        return (button.textContent || '').trim().slice(0, 30)
            + ' [aria-label=' + button.getAttribute('aria-label')
            + ' title=' + button.getAttribute('title')
            + ' id=' + button.id + ']';
    }

    /**
     * The dialler's own Call button. DNA keeps it disabled while the dial input
     * is empty, so it is the button that typing a number enabled. A button
     * named Call or Soita is the fallback.
     */
    function dialButton(disabledBefore, after) {
        var enabled = disabledBefore.filter(function (b) { return !b.disabled && b.isConnected; });
        if (enabled.length) {
            return enabled[0];
        }
        return after.filter(function (b) {
            var label = [b.textContent, b.getAttribute('aria-label'), b.getAttribute('title')].join(' ');
            return !b.disabled && /\b(call|soita)\b/i.test(label);
        })[0] || null;
    }

    async function dial(call) {
        var input = document.querySelector(DIAL_INPUT);
        if (!input) {
            show('DNA:n numeronvalintaa ei löytynyt. Avaa Yhteystiedot-näkymä.', 'error');
            return false;
        }
        var claim = await ask({ type: 'claim', call: call });
        if (claim.error) {
            show(claim.error, 'error');
            return false;
        }

        type(input, '');
        await sleep(300);
        var disabledBefore = nearbyButtons(input).filter(function (b) { return b.disabled; });
        type(input, call.phone_number);
        await sleep(400);
        var after = nearbyButtons(input);
        var button = dialButton(disabledBefore, after);
        if (!button) {
            console.warn('[DNA Connector] Call button not found. Buttons near the dial input:', after.map(describe));
            show('Numero ' + call.phone_number + ' on valmiina – paina Call.', 'error');
            return true;
        }
        // The call window opens in this origin and picks the microphone up as
        // it starts, so an AI call is announced to it here, before it exists.
        try {
            if (call.ai_agent) {
                localStorage.setItem(AI_ARM_KEY, JSON.stringify({ id: call.id, until: Date.now() + AI_ARM_MS }));
            } else {
                localStorage.removeItem(AI_ARM_KEY);
            }
        } catch (e) {
            show('Selaimen tallennustila ei ole käytössä – tekoälypuhelu ei toimi.', 'error');
            return true;
        }
        console.info('[DNA Connector] Pressing', describe(button));
        button.click();
        show((call.ai_agent ? 'tekoäly soittaa ' : 'soitetaan ') + call.phone_number + '…');

        var opened = { opened: false };
        for (var waited = 0; waited < WINDOW_WAIT_MS && !opened.opened; waited += 1000) {
            await sleep(1000);
            opened = await ask({ type: 'call-window-opened', callId: call.id });
        }
        if (!opened.opened) {
            void ask({ type: 'window-missing' });
            console.warn('[DNA Connector] No call window after pressing', describe(button), 'Buttons:', after.map(describe));
            show('DNA ei avannut puheluikkunaa. Salli ponnahdusikkunat vaihde.dna.fi:lle tai paina Call itse.', 'error');
        } else {
            showStatus();
        }
        return true;
    }

    // --- Incoming calls ---------------------------------------------------------
    //
    // DNA's ringing pop-up and tab title are read every RING_TICK_MS (see
    // shared/ring-screen.js). Only the tab that dials reports, so two DNA tabs
    // never report one call twice.

    var RING_TICK_MS = 300;
    var ringWatcher = new DVCRingScreen.Watcher();
    /** The backend's id for the call ringing now, once reported. */
    var ringingCallId = null;
    /** Whether this tab dials and reports; null until the first poll answers. */
    var primary = null;

    /** DNA's incoming-call pop-up: a dialog with the pulsing call avatar. */
    function ringPopup() {
        var dialogs = document.querySelectorAll('[role="dialog"]');
        for (var i = 0; i < dialogs.length; i++) {
            if (dialogs[i].querySelector('.call-animation')) {
                return dialogs[i];
            }
        }
        return null;
    }

    function readScreen() {
        var popup = ringPopup();
        var heading = popup ? popup.querySelector('h1, h2, h3, h4, h5, h6') : null;
        return DVCRingScreen.read({
            title: document.title,
            popup: popup ? { heading: heading ? heading.textContent : '' } : null,
        });
    }

    async function watchRing() {
        var moment = ringWatcher.update(readScreen(), Date.now());
        if (!moment || primary !== true) {
            return;
        }
        if (moment.event === 'ringing') {
            ringingCallId = null;
            if (!moment.number) {
                show('Saapuva puhelu piilotetusta numerosta – se ei näy taustajärjestelmässä. Vastaa DNA:ssa.', 'warning');
                return;
            }
            var result = await ask({ type: 'incoming-ringing', number: moment.number });
            if (result.error) {
                show('Saapuvaa puhelua ' + moment.number + ' ei saatu taustajärjestelmään: ' + result.error, 'error');
                return;
            }
            ringingCallId = result.call_id;
            show('Saapuva puhelu ' + moment.number + ' – vastaa DNA:ssa tai taustajärjestelmässä.');
        } else if (moment.event === 'stopped' && ringingCallId !== null) {
            var callId = ringingCallId;
            ringingCallId = null;
            await ask({ type: 'incoming-stopped', callId: callId });
            showStatus();
        }
    }

    // Answering here (by hand, or the click answerInDna makes) keeps the call
    // from being reported as stopped while DNA's call window opens.
    document.addEventListener('click', function (event) {
        var button = event.target && event.target.closest ? event.target.closest('button') : null;
        var popup = ringPopup();
        if (button && popup && popup.contains(button)
            && DVCRingScreen.isAnswerColour(getComputedStyle(button).backgroundColor)) {
            ringWatcher.markAnswered();
        }
    }, true);

    var ringBusy = false;
    setInterval(function () {
        if (ringBusy) {
            return;
        }
        ringBusy = true;
        watchRing().finally(function () { ringBusy = false; });
    }, RING_TICK_MS);

    /** Answered in the backend: press DNA's green answer button, never the red one. */
    function answerInDna(callId) {
        if (callId !== ringingCallId) {
            return;
        }
        var popup = ringPopup();
        var buttons = popup ? Array.prototype.slice.call(popup.querySelectorAll('button')) : [];
        var answer = buttons.filter(function (b) {
            return !b.disabled && DVCRingScreen.isAnswerColour(getComputedStyle(b).backgroundColor);
        });
        if (answer.length !== 1) {
            console.warn('[DNA Connector] Answer button not found. Buttons in the pop-up:', buttons.map(function (b) {
                return describe(b) + ' bg=' + getComputedStyle(b).backgroundColor;
            }));
            show('DNA:n vastauspainiketta ei löytynyt – vastaa DNA:ssa itse.', 'error');
            return;
        }
        console.info('[DNA Connector] Answering incoming call', callId);
        ringWatcher.markAnswered();
        answer[0].click();
        show('Vastataan puheluun…');
    }

    chrome.runtime.onMessage.addListener(function (message) {
        if (message.type === 'answer-incoming') {
            answerInDna(message.callId);
        } else if (message.type === 'answered-elsewhere' && message.callId === ringingCallId) {
            show('Vastattu: ' + (message.name || 'toinen työntekijä') + '.');
        }
    });

    async function poll() {
        if (!busy) {
            busy = true;
            try {
                var response = await ask({
                    type: 'poll',
                    dialerReady: !!document.querySelector(DIAL_INPUT),
                    microphone: microphone,
                });
                failures = response.error ? failures + 1 : 0;
                if (!response.error) {
                    primary = !response.duplicate;
                }
                if ('softphone' in response) {
                    softphone = response.softphone;
                }
                if (response.error) {
                    show(response.error + (failures > 1 ? ' Yritetään uudelleen ' + Math.round(DVCSoftphone.backoff(failures) / 1000) + ' s kuluttua.' : ''), 'error');
                } else if (response.duplicate) {
                    show('DNA-vaihde on auki toisessakin välilehdessä, ja se soittaa puhelut. Sulje tämä välilehti.', 'error');
                } else if (response.calls && response.calls.length) {
                    await dial(response.calls[0]);
                } else if (Date.now() > holdUntil && !ringWatcher.active) {
                    // Always on screen, so the employee can see the extension is
                    // running and connected before a call is queued in the backend,
                    // with the same reasons the backend shows.
                    showStatus();
                }
            } finally {
                busy = false;
            }
        }
        setTimeout(poll, DVCSoftphone.backoff(failures));
    }

    // The microphone permission of vaihde.dna.fi, reported with each poll so the
    // backend can say when it is blocked.
    if (navigator.permissions) {
        navigator.permissions.query({ name: 'microphone' }).then(function (status) {
            microphone = status.state;
            status.onchange = function () { microphone = status.state; };
        }).catch(function () { /* not answerable here */ });
    }

    poll();
})();
