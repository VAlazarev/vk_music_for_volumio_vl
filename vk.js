'use strict';

var libQ = require('kew');
var axios = require('axios');
var querystring = require('querystring');

// VK's public audio API was closed to third parties in 2016, so we talk to the
// same private endpoints the web player uses. The app id below is the one the
// web player itself presents; api.vk.com still answers, but vk.ru is what the
// current client targets.
const API_BASE = 'https://api.vk.ru/method/';
const AUTH_URL = 'https://login.vk.ru/?act=web_token';
const APP_ID = '6287487';
const API_VERSION = '5.282';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0';

// Refresh the access token this many seconds before it actually expires.
const REFRESH_THRESHOLD = 600;

function now() {
    return Math.floor(Date.now() / 1000);
}

// VK hands out an HLS playlist for every track, but the segments are just
// MPEG-TS wrappers around the same mp3 that sits next to the playlist. Dropping
// the segment directory gives a plain mp3 url that MPD can play directly.
// Whether VK still serves those files is the open question - see README.
//
// The two reference implementations rewrite the path identically but disagree
// about the query string: vodka2's drops it, vk_api's keeps it. Today's urls
// carry siren and signature parameters, so keepQuery defaults to true.
function m3u8ToMp3(url, keepQuery) {
    if (!url || url.indexOf('index.m3u8') < 0) {
        return url;
    }

    var query = '';
    var base = url;
    var mark = url.indexOf('?');
    if (mark >= 0) {
        query = url.substring(mark);
        base = url.substring(0, mark);
    }

    var rewritten;
    if (base.indexOf('/audios/') >= 0) {
        rewritten = base.replace(/^(.+?)\/[^\/]+?\/audios\/([^\/]+)\/.+$/, '$1/audios/$2.mp3');
    } else {
        rewritten = base.replace(/^(.+?)\/(p[0-9]+)\/[^\/]+?\/([^\/]+)\/.+$/, '$1/$2/$3.mp3');
    }

    // An url shape we do not recognise is left alone rather than mangled.
    if (rewritten === base) {
        return url;
    }

    return (keepQuery === false) ? rewritten : rewritten + query;
}

// The mp3 urls worth trying for a track, in the order they should be tried,
// most likely first. Empty if the playlist url is of an unknown shape.
function mp3Candidates(url) {
    var withQuery = m3u8ToMp3(url, true);
    var withoutQuery = m3u8ToMp3(url, false);
    var candidates = [];

    if (withQuery !== url) {
        candidates.push(withQuery);
    }
    if (withoutQuery !== url && withoutQuery !== withQuery) {
        candidates.push(withoutQuery);
    }

    return candidates;
}

// Header values must be latin1; a value pasted wrong (cyrillic placeholder
// text, a stray newline) otherwise blows up deep inside http with a message
// that says nothing about which cookie is at fault.
function checkCookie(name, value) {
    if (!value) {
        return '';
    }
    for (var i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) > 255) {
            throw new Error('cookie "' + name + '" содержит недопустимый символ в позиции ' + i +
                            ' - похоже, вставлено не то значение');
        }
    }
    return value.trim();
}

function VKClient(cookieP, remixsid, logger) {
    var self = this;

    self.cookieP = checkCookie('p', cookieP);
    self.remixsid = checkCookie('remixsid', remixsid);
    self.logger = logger;
    self.token = '';
    self.expires = 0;
}

// Trades the browser cookies for a short-lived access token. The cookies
// themselves last 50+ days, so this is the only step the user has to repeat
// by hand, and only twice a year.
VKClient.prototype.refresh = function () {
    var self = this;
    var defer = libQ.defer();

    // p lives on login.vk.ru, remixsid on vk.ru. Send whichever we have -
    // whether p is genuinely required is worth finding out rather than
    // assuming.
    var cookies = [];
    if (self.cookieP) {
        cookies.push('p=' + self.cookieP);
    }
    if (self.remixsid) {
        cookies.push('remixsid=' + self.remixsid);
    }

    axios({
        method: 'post',
        url: AUTH_URL,
        headers: {
            'user-agent': USER_AGENT,
            'content-type': 'application/x-www-form-urlencoded',
            'origin': 'https://vk.ru',
            'referer': 'https://vk.ru/',
            'cookie': cookies.join('; ')
        },
        data: querystring.stringify({ version: '1', app_id: APP_ID })
    }).then(function (resp) {
        var data = resp.data;
        if (!data || data.type === 'error' || !data.data) {
            defer.reject(new Error('VK token refresh failed: ' + ((data && data.error_info) || 'unknown error')));
            return;
        }
        self.token = data.data.access_token;
        self.expires = data.data.expires;
        defer.resolve({ token: self.token, expires: self.expires });
    }).catch(function (err) {
        defer.reject(new Error(err));
    });

    return defer.promise;
};

VKClient.prototype.ensureToken = function () {
    var self = this;

    if (self.token && self.expires - now() > REFRESH_THRESHOLD) {
        return libQ.resolve({ token: self.token, expires: self.expires });
    }
    return self.refresh();
};

VKClient.prototype.request = function (method, params) {
    var self = this;
    var defer = libQ.defer();

    // kew does not chain foreign thenables, so the axios call is nested
    // rather than returned from the handler.
    self.ensureToken().then(function () {
        var query = querystring.stringify({
            v: API_VERSION,
            access_token: self.token,
            lang: 'ru',
            client_id: APP_ID
        });
        axios({
            method: 'post',
            url: API_BASE + method + '?' + query,
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'user-agent': USER_AGENT
            },
            data: querystring.stringify(params || {})
        }).then(function (resp) {
            var data = resp.data;
            if (!data || data.error) {
                defer.reject(new Error('VK API ' + method + ': ' + ((data && data.error && data.error.error_msg) || 'unknown error')));
                return;
            }
            defer.resolve(data.response);
        }).catch(function (err) {
            defer.reject(new Error(err));
        });
    }).fail(function (err) {
        defer.reject(new Error(err));
    });

    return defer.promise;
};

// The catalogue root: the list of sections plus, with needBlocks, the VK Mix
// entries, the user's playlists and the recently played tracks.
VKClient.prototype.getSections = function (ownerId, needBlocks) {
    return this.request('catalog.getAudio', {
        owner_id: ownerId,
        need_blocks: needBlocks ? '1' : undefined
    });
};

VKClient.prototype.getSection = function (sectionId, startFrom) {
    return this.request('catalog.getSection', {
        section_id: sectionId,
        start_from: startFrom
    });
};

// Playlist urls are signed and short lived, so a track queued earlier has to
// be looked up again at the moment it plays rather than reusing a stored url.
// ids is one "ownerId_audioId" or an array of them.
VKClient.prototype.getById = function (ids) {
    return this.request('audio.getById', {
        audios: Array.isArray(ids) ? ids.join(',') : String(ids)
    });
};

VKClient.prototype.search = function (query, offset) {
    return this.request('audio.search', {
        q: query,
        offset: (offset === undefined) ? undefined : String(offset)
    });
};

// VK has no separate "like" - a liked track is simply one added to My music,
// which is what the heart in the web player toggles.
VKClient.prototype.add = function (ownerId, audioId) {
    return this.request('audio.add', {
        owner_id: String(ownerId),
        audio_id: String(audioId)
    });
};

VKClient.prototype.remove = function (ownerId, audioId) {
    return this.request('audio.delete', {
        owner_id: String(ownerId),
        audio_id: String(audioId)
    });
};

module.exports = {
    VKClient: VKClient,
    m3u8ToMp3: m3u8ToMp3,
    mp3Candidates: mp3Candidates
};
