// The connect page a backend opens (see src/shared/connect.js and README).
(function () {
    'use strict';

    var link = DVCConnect.parseLink(location.hash);
    // The token must not stay in the address bar or the history.
    history.replaceState(null, '', location.pathname);

    var ask = document.getElementById('ask');
    var message = document.getElementById('message');

    function say(text, tone) {
        message.textContent = text;
        message.className = tone || '';
    }

    if (link.error) {
        say(link.error, 'error');
        return;
    }

    chrome.storage.local.get(['apiUrl']).then(function (stored) {
        var decision = DVCConnect.decide(stored.apiUrl, link.apiUrl);
        if (decision === 'refuse') {
            say('Laajennus on jo yhdistetty toiseen järjestelmään (' + DVCConnect.normalise(stored.apiUrl) + '). '
                + 'Jos haluat vaihtaa sen, vaihda osoite laajennuksen asetuksista.', 'error');
            return;
        }
        document.getElementById('address').textContent = link.apiUrl;
        if (decision === 'renew') {
            document.getElementById('question').textContent = 'Uusitaanko yhteys tähän taustajärjestelmään?';
        }
        ask.hidden = false;
    });

    document.getElementById('connect').addEventListener('click', async function () {
        // Asked first, while the click still counts as the user's.
        var allowed = await chrome.permissions.request({ origins: [DVCSoftphone.originPattern(link.apiUrl)] });
        if (!allowed) {
            say('Ilman lupaa laajennus ei saa yhteyttä järjestelmään. Paina Yhdistä uudelleen ja valitse Salli.', 'error');
            return;
        }
        await chrome.storage.local.set({ apiUrl: link.apiUrl, token: link.token });
        ask.hidden = true;
        say('Valmis – laajennus on yhdistetty. Voit sulkea tämän välilehden. '
            + 'Lataa DNA Vaihteen välilehti uudelleen, jos se on auki.', 'ok');
    });

    document.getElementById('cancel').addEventListener('click', function () {
        ask.hidden = true;
        say('Ei yhdistetty. Voit sulkea tämän välilehden.');
    });
})();
