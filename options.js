(function () {
    'use strict';

    var apiUrl = document.getElementById('apiUrl');
    var token = document.getElementById('token');
    var status = document.getElementById('status');

    function say(text, tone) {
        status.textContent = text;
        status.className = tone || '';
    }

    chrome.storage.local.get(['apiUrl', 'token']).then(function (stored) {
        apiUrl.value = stored.apiUrl || '';
        token.placeholder = stored.token ? 'Tallennettu (••••' + String(stored.token).slice(-4) + ')' : 'Ei tallennettua tokenia';
    });

    document.getElementById('save').addEventListener('click', async function () {
        var url = apiUrl.value.trim().replace(/\/+$/, '');
        var pattern = url ? DVCSoftphone.originPattern(url) : null;
        if (url && !pattern) {
            say('Osoitteen pitää alkaa https://', 'error');
            return;
        }
        // No backend address is built in: the browser asks the user to allow this
        // one. Asked first, while the click still counts as the user's.
        var allowed = pattern ? await chrome.permissions.request({ origins: [pattern] }) : true;
        var update = { apiUrl: url };
        if (token.value.trim() !== '') {
            update.token = token.value.trim();
        }
        await chrome.storage.local.set(update);
        token.value = '';
        var stored = await chrome.storage.local.get(['token']);
        token.placeholder = stored.token ? 'Tallennettu (••••' + String(stored.token).slice(-4) + ')' : 'Ei tallennettua tokenia';
        if (allowed) {
            say('Tallennettu.', 'ok');
        } else {
            say('Tallennettu, mutta laajennus ei saa yhteyttä taustajärjestelmään ilman lupaa. Paina Tallenna uudelleen ja valitse Salli.', 'error');
        }
    });

    var observe = document.getElementById('observe');
    var observeStatus = document.getElementById('observe-status');

    async function refreshObserve() {
        var s = await chrome.storage.local.get(['observe', 'observeLog']);
        observe.checked = !!s.observe;
        var log = s.observeLog || [];
        observeStatus.textContent = log.length
            ? 'Kirjauksia ' + log.length + ', viimeisin ' + new Date(log[log.length - 1].t).toLocaleString('fi-FI') + '.'
            : 'Ei kirjauksia.';
    }

    observe.addEventListener('change', async function () {
        await chrome.storage.local.set({ observe: observe.checked });
        await refreshObserve();
    });

    document.getElementById('download').addEventListener('click', async function () {
        var s = await chrome.storage.local.get(['observeLog']);
        var blob = new Blob([JSON.stringify(s.observeLog || [], null, 2)], { type: 'application/json' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'dna-tarkkailu-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
        link.click();
        setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
    });

    document.getElementById('clear').addEventListener('click', async function () {
        await chrome.storage.local.set({ observeLog: [] });
        await refreshObserve();
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'local' && (changes.observeLog || changes.observe)) {
            void refreshObserve();
        }
    });
    void refreshObserve();

    document.getElementById('test').addEventListener('click', function () {
        say('Testataan…');
        chrome.runtime.sendMessage({ type: 'poll' }, function (response) {
            if (chrome.runtime.lastError || !response) {
                say('Laajennus ei vastannut.', 'error');
            } else if (response.error) {
                say(response.error, 'error');
            } else {
                say('Yhteys taustajärjestelmään toimii.', 'ok');
            }
        });
    });
})();

// Tarkista: everything a call needs, each with what to do about it.
(function () {
    'use strict';

    var list = document.getElementById('checklist');
    var MARKS = { ok: '✓', warning: '!', error: '✗' };

    document.getElementById('check').addEventListener('click', function () {
        list.textContent = 'Tarkistetaan…';
        chrome.runtime.sendMessage({ type: 'diagnose' }, function (response) {
            list.textContent = '';
            if (chrome.runtime.lastError || !response || response.error) {
                list.textContent = 'Laajennus ei vastannut.';
                return;
            }
            response.lines.forEach(function (line) {
                var item = document.createElement('li');
                item.className = line.tone;
                var label = document.createElement('b');
                label.textContent = MARKS[line.tone] + ' ' + line.label;
                item.appendChild(label);
                item.appendChild(document.createTextNode(line.detail));
                list.appendChild(item);
            });
            var version = document.createElement('li');
            version.className = 'hint';
            version.textContent = 'Laajennuksen versio ' + response.version + '.';
            list.appendChild(version);
        });
    });
})();
