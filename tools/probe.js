'use strict';

// Development probe: answers the one question the plugin is blocked on -
// does VK still serve a plain mp3 next to the HLS playlist?
//
// Cookies come from the environment or from .vk-cookies.json in the repo root
// (gitignored). Neither is ever printed.
//
//   node tools/probe.js [search query]

var fs = require('fs');
var path = require('path');
var axios = require('axios');
var vk = require('../vk.js');

var QUERY = process.argv.slice(2).join(' ') || 'Кино Группа крови';
var RANGE_HEADERS = { 'range': 'bytes=0-1023', 'user-agent': 'Mozilla/5.0' };

function loadCookies() {
    if (process.env.VK_COOKIE_P && process.env.VK_REMIXSID) {
        return { p: process.env.VK_COOKIE_P, remixsid: process.env.VK_REMIXSID };
    }
    var file = path.join(__dirname, '..', '.vk-cookies.json');
    if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return false;
}

// A ranged GET tells us whether the file exists without pulling it down:
// VK answers 200/206 with audio/mpeg for a real file, 404 or html otherwise.
function probeUrl(url) {
    return axios.get(url, {
        headers: RANGE_HEADERS,
        responseType: 'arraybuffer',
        maxRedirects: 5,
        validateStatus: function () { return true; }
    }).then(function (resp) {
        var body = Buffer.from(resp.data || []);
        return {
            status: resp.status,
            type: resp.headers['content-type'] || '-',
            length: resp.headers['content-length'] || '-',
            head: body.slice(0, 4).toString('hex')
        };
    }).catch(function (err) {
        return { status: 'ERR', type: String(err.message || err), length: '-', head: '-' };
    });
}

function report(label, url, result) {
    console.log('  ' + label);
    console.log('    ' + url);
    console.log('    -> ' + result.status + '  ' + result.type + '  ' + result.length + ' bytes  first4=' + result.head);
}

var cookies = loadCookies();
if (!cookies) {
    console.error('Нет cookie. Задайте VK_COOKIE_P и VK_REMIXSID или создайте .vk-cookies.json:');
    console.error('  {"p": "...", "remixsid": "..."}');
    process.exit(1);
}

var client = new vk.VKClient(cookies.p, cookies.remixsid, console);

console.log('1. Обмен cookie на токен...');
client.refresh().then(function (token) {
    var left = Math.round((token.expires - Date.now() / 1000) / 60);
    console.log('   OK, токен получен, живёт ещё ~' + left + ' мин\n');

    console.log('2. Каталог (catalog.getAudio)...');
    return client.getSections(undefined, true);
}).then(function (catalog) {
    var sections = (catalog.catalog && catalog.catalog.sections) || [];
    console.log('   разделов: ' + sections.length + ' -> ' + sections.map(function (s) { return s.title; }).join(', '));
    console.log('   плейлистов: ' + ((catalog.playlists || []).length) +
                ', недавних треков: ' + ((catalog.audios || []).length) +
                ', миксов: ' + ((catalog.audio_stream_mixes || []).length) + '\n');

    console.log('3. Поиск: "' + QUERY + '"...');
    return client.search(QUERY, 0);
}).then(function (found) {
    var items = found.items || [];
    console.log('   найдено: ' + found.count + ', взят первый из ' + items.length);
    if (!items.length) {
        throw new Error('поиск ничего не вернул');
    }

    var track = items[0];
    console.log('   ' + track.artist + ' - ' + track.title +
                '  (' + track.owner_id + '_' + track.id + ', ' + track.duration + ' сек, like=' + track.like + ')');
    console.log('   url: ' + track.url + '\n');

    if (!track.url) {
        throw new Error('у трека нет url - возможно, нет подписки или трек недоступен');
    }

    console.log('4. Проверка ссылок...');
    var candidates = vk.mp3Candidates(track.url);
    if (!candidates.length) {
        console.log('   ВНИМАНИЕ: формат ссылки не распознан, переписать в mp3 нечем');
    }

    var checks = [{ label: 'исходный m3u8', url: track.url }];
    candidates.forEach(function (url, i) {
        checks.push({ label: 'mp3 вариант ' + (i + 1) + (i === 0 ? ' (с query)' : ' (без query)'), url: url });
    });

    // Sequential so the output stays readable. Kept inside its own native
    // chain - kew does not chain foreign thenables.
    checks.reduce(function (chain, check) {
        return chain.then(function () {
            return probeUrl(check.url).then(function (result) {
                report(check.label, check.url, result);
            });
        });
    }, Promise.resolve()).then(function () {
        console.log('\nГотово. Работающий mp3-вариант -> идём простым путём.');
        console.log('Только m3u8 -> нужен прокси с ffmpeg (см. README).');
    }).catch(function (err) {
        console.error('\nОШИБКА при проверке ссылок: ' + (err && err.message ? err.message : err));
        process.exit(1);
    });
}).fail(function (err) {
    console.error('\nОШИБКА: ' + (err && err.message ? err.message : err));
    process.exit(1);
});
