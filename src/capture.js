/*
 * Runs in the DNA call window's own JavaScript world (MAIN), from document
 * start, because only there can the call's audio be reached:
 *
 *  - the employee's microphone is the stream DNA gets from getUserMedia;
 *  - the customer's voice is the remote audio track of DNA's WebRTC
 *    connection.
 *
 * An ordinary call is only LISTENED to: DNA receives its streams unchanged.
 *
 * An AI call (the directory marks it in localStorage before dialling) is
 * different: DNA receives a mixed microphone — the employee's own voice, muted
 * while the AI leads, plus the AI agent's voice. The AI's voice is also played
 * on this computer, so the employee hears both sides. Taking over unmutes the
 * microphone and silences the AI.
 *
 * Audio leaves the page as PCM chunks posted to the extension's isolated
 * content script, and to colleagues listening in from the ERP over a direct
 * WebRTC connection the page itself opens. Nothing is stored.
 */
(function () {
    'use strict';

    if (window.top !== window || window.__dvcCallsCapture) {
        return;
    }
    window.__dvcCallsCapture = true;

    var FROM_PAGE = 'dvc-calls-page';
    var TO_PAGE = 'dvc-calls-extension';
    var AI_ARM_KEY = 'dvc-calls-ai-arm';
    // 4096 samples is a chunk every ~170–256 ms: small enough for a live
    // transcript, large enough not to flood the message channel.
    var CHUNK = 4096;

    var micTracks = [];
    var remoteTracks = [];
    var session = null;
    var mixer = null;

    function post(message, transfer) {
        message.source = FROM_PAGE;
        window.postMessage(message, location.origin, transfer || []);
    }

    function live(tracks) {
        return tracks.filter(function (t) { return t.readyState === 'live'; });
    }

    function remember(list, track) {
        if (list.indexOf(track) === -1) {
            list.push(track);
            track.addEventListener('ended', function () {
                var i = list.indexOf(track);
                if (i !== -1) { list.splice(i, 1); }
            });
        }
        post({ type: 'tracks', mic: live(micTracks).length, remote: live(remoteTracks).length });
    }

    /** Whether the directory armed this window for an AI call. */
    function aiArmed() {
        try {
            var arm = JSON.parse(localStorage.getItem(AI_ARM_KEY) || 'null');
            return !!arm && arm.until > Date.now();
        } catch (e) {
            return false;
        }
    }

    // --- The AI mixer --------------------------------------------------------

    /**
     * DNA's microphone for an AI call: mic (muted while the AI leads) + AI.
     */
    function mixedMicrophone(raw) {
        var context = new AudioContext();
        var destination = context.createMediaStreamDestination();
        var micGain = context.createGain();
        micGain.gain.value = 0;
        context.createMediaStreamSource(new MediaStream(raw.getAudioTracks())).connect(micGain).connect(destination);

        var aiGain = context.createGain();
        aiGain.connect(destination);
        aiGain.connect(context.destination); // the employee hears the AI too

        mixer = { context: context, micGain: micGain, aiGain: aiGain, nextAt: 0, sources: [], drainWaiters: [] };
        resumeMixer();

        return new MediaStream(destination.stream.getAudioTracks().concat(raw.getVideoTracks()));
    }

    function resumeMixer() {
        if (!mixer) {
            return;
        }
        void mixer.context.resume().then(function () {
            post({ type: 'mixer-state', state: mixer.context.state });
        });
        post({ type: 'mixer-state', state: mixer.context.state });
    }

    /** Queues one chunk of the AI's voice (PCM16, given rate) after the last. */
    function playAi(buffer, rate) {
        if (!mixer) {
            return;
        }
        var pcm = new Int16Array(buffer);
        var audio = mixer.context.createBuffer(1, pcm.length, rate);
        var channel = audio.getChannelData(0);
        for (var i = 0; i < pcm.length; i++) {
            channel[i] = pcm[i] / 0x8000;
        }
        var source = mixer.context.createBufferSource();
        source.buffer = audio;
        source.connect(mixer.aiGain);
        var at = Math.max(mixer.context.currentTime + 0.02, mixer.nextAt);
        source.start(at);
        mixer.nextAt = at + audio.duration;
        mixer.sources.push(source);
        source.onended = function () {
            var i = mixer.sources.indexOf(source);
            if (i !== -1) { mixer.sources.splice(i, 1); }
            checkDrained();
        };
    }

    /** The customer started talking: the AI stops mid-sentence. */
    function flushAi() {
        if (!mixer) {
            return;
        }
        mixer.sources.slice().forEach(function (s) {
            try { s.stop(); } catch (e) { /* already stopped */ }
        });
        mixer.sources = [];
        mixer.nextAt = 0;
        checkDrained();
    }

    function checkDrained() {
        if (mixer && mixer.sources.length === 0 && mixer.drainWaiters.length) {
            mixer.drainWaiters = [];
            post({ type: 'ai-drained' });
        }
    }

    function takeOver() {
        if (!mixer) {
            return;
        }
        flushAi();
        mixer.aiGain.gain.value = 0;
        mixer.micGain.gain.value = 1;
        post({ type: 'taken-over' });
    }

    // --- Taps ---------------------------------------------------------------

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        var originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async function (constraints) {
            var stream = await originalGetUserMedia(constraints);
            stream.getAudioTracks().forEach(function (track) { remember(micTracks, track); });
            if (stream.getAudioTracks().length && aiArmed()) {
                try {
                    return mixedMicrophone(stream);
                } catch (error) {
                    // Without the mixer the AI cannot speak; DNA keeps the plain microphone.
                    post({ type: 'capture-error', error: 'Tekoälyn äänireititys epäonnistui: ' + error.message });
                }
            }
            return stream;
        };
    }

    var NativePeerConnection = window.RTCPeerConnection;
    if (NativePeerConnection) {
        var Tapped = function (config, constraints) {
            var pc = new NativePeerConnection(config, constraints);
            pc.addEventListener('track', function (event) {
                if (event.track && event.track.kind === 'audio') {
                    remember(remoteTracks, event.track);
                }
            });
            return pc;
        };
        Tapped.prototype = NativePeerConnection.prototype;
        Object.setPrototypeOf(Tapped, NativePeerConnection);
        window.RTCPeerConnection = Tapped;
    }

    // --- Listening in ----------------------------------------------------------

    /** Colleagues listening in from the ERP, by session id. */
    var listeners = {};
    /** Candidates still gathering after this are not waited for. */
    var ICE_WAIT_MS = 3000;

    function gathered(pc) {
        return new Promise(function (resolve) {
            if (pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }
            var timer = setTimeout(resolve, ICE_WAIT_MS);
            pc.addEventListener('icegatheringstatechange', function () {
                if (pc.iceGatheringState === 'complete') {
                    clearTimeout(timer);
                    resolve();
                }
            });
        });
    }

    /**
     * Offers a listener both sides of the call mixed into one track: the
     * employee's microphone, the customer's voice and, on an AI call, the AI's
     * voice. The connection is the browser's own (not the tapped constructor),
     * so it never shows up as one of DNA's tracks.
     */
    async function listenStart(id, iceServers) {
        if (listeners[id] || !NativePeerConnection) {
            return;
        }
        var tracks = live(micTracks).concat(live(remoteTracks));
        if (!tracks.length) {
            post({ type: 'listen-error', id: id });
            return;
        }
        try {
            var context = new AudioContext();
            var destination = context.createMediaStreamDestination();
            tracks.forEach(function (track) {
                context.createMediaStreamSource(new MediaStream([track])).connect(destination);
            });
            if (mixer) {
                mixer.aiGain.connect(destination);
            }
            void context.resume();
            var pc = new NativePeerConnection({ iceServers: iceServers || [] });
            listeners[id] = { pc: pc, context: context };
            destination.stream.getAudioTracks().forEach(function (track) { pc.addTrack(track, destination.stream); });
            await pc.setLocalDescription(await pc.createOffer());
            await gathered(pc);
            post({ type: 'listen-offer', id: id, sdp: pc.localDescription.sdp });
        } catch (error) {
            listenStop(id);
            post({ type: 'listen-error', id: id, error: String(error && error.message || error) });
        }
    }

    function listenAnswer(id, sdp) {
        var listener = listeners[id];
        if (!listener) {
            return;
        }
        listener.pc.setRemoteDescription({ type: 'answer', sdp: sdp }).catch(function () {
            listenStop(id);
            post({ type: 'listen-error', id: id });
        });
    }

    function listenStop(id) {
        var listener = listeners[id];
        if (!listener) {
            return;
        }
        delete listeners[id];
        try { listener.pc.close(); } catch (e) { /* closed already */ }
        void listener.context.close().catch(function () {});
    }

    // --- Capture --------------------------------------------------------------

    function floatTo16(samples) {
        var out = new Int16Array(samples.length);
        for (var i = 0; i < samples.length; i++) {
            var s = Math.max(-1, Math.min(1, samples[i]));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
    }

    function pipe(context, sink, tracks, channel) {
        if (!tracks.length) {
            return null;
        }
        var processor = context.createScriptProcessor(CHUNK, 1, 1);
        var sources = tracks.map(function (track) {
            var source = context.createMediaStreamSource(new MediaStream([track]));
            source.connect(processor);
            return source;
        });
        processor.onaudioprocess = function (event) {
            var pcm = floatTo16(event.inputBuffer.getChannelData(0));
            post({ type: 'audio', channel: channel, pcm: pcm.buffer }, [pcm.buffer]);
        };
        processor.connect(sink);

        return { processor: processor, sources: sources };
    }

    /**
     * @param {number} rate 16000 for Speechmatics, 24000 for the AI agent.
     * @param {string[]} channels Which sides to capture.
     */
    function start(rate, channels) {
        if (session) {
            return;
        }
        var mic = channels.indexOf('employee') !== -1 ? live(micTracks) : [];
        var remote = channels.indexOf('customer') !== -1 ? live(remoteTracks) : [];
        if (!mic.length && !remote.length) {
            post({ type: 'capture-error', error: 'Puhelun ääntä ei löytynyt.' });
            return;
        }
        try {
            // The browser resamples each track to the context's rate.
            var context = new AudioContext({ sampleRate: rate });
            var sink = context.createGain();
            sink.gain.value = 0;
            sink.connect(context.destination);
            session = {
                context: context,
                pipes: [pipe(context, sink, mic, 'employee'), pipe(context, sink, remote, 'customer')].filter(Boolean),
            };
            void context.resume();
            post({
                type: 'capture-started',
                mic: mic.length,
                remote: remote.length,
                wanted: channels,
                sample_rate: context.sampleRate,
            });
        } catch (error) {
            session = null;
            post({ type: 'capture-error', error: String(error && error.message || error) });
        }
    }

    function stop() {
        if (!session) {
            return;
        }
        session.pipes.forEach(function (p) {
            p.processor.onaudioprocess = null;
            p.sources.forEach(function (s) { s.disconnect(); });
            p.processor.disconnect();
        });
        void session.context.close().catch(function () {});
        session = null;
        post({ type: 'capture-stopped' });
    }

    window.addEventListener('message', function (event) {
        var data = event.data;
        if (event.source !== window || !data || data.source !== TO_PAGE) {
            return;
        }
        switch (data.type) {
            case 'start': start(data.rate || 16000, data.channels || ['employee', 'customer']); break;
            case 'stop': stop(); break;
            case 'ai-audio': playAi(data.pcm, data.rate || 24000); break;
            case 'ai-flush': flushAi(); break;
            case 'ai-notify-drained':
                if (mixer) { mixer.drainWaiters.push(true); checkDrained(); } else { post({ type: 'ai-drained' }); }
                break;
            case 'take-over': takeOver(); break;
            case 'resume-audio': resumeMixer(); break;
            case 'listen-start': void listenStart(data.id, data.iceServers); break;
            case 'listen-answer': listenAnswer(data.id, data.sdp); break;
            case 'listen-stop': listenStop(data.id); break;
        }
    });

    window.addEventListener('pagehide', function () {
        stop();
        Object.keys(listeners).forEach(listenStop);
        if (mixer) {
            void mixer.context.close().catch(function () {});
        }
    });
})();
