'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var NodeCache = require('node-cache');
var querystring = require('querystring');
var vk = require('./vk.js');
var Proxy = require('./proxy.js');

// MPD fetches every track through our own proxy, which assembles and decrypts
// the HLS stream and remuxes it to MP3. 6601 is taken by the Yandex plugin on
// the same device.
const PROXY_PORT = 6602;

module.exports = vkMusic;

function vkMusic(context) {
    var self = this;

    self.context = context;
    self.commandRouter = self.context.coreCommand;
    self.logger = self.context.logger;
    self.configManager = self.context.configManager;

    self.browseCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

    self.client = false;
    self.current_track = false;
    self.proxy = new Proxy(self.logger);
}

vkMusic.prototype.onVolumioStart = function () {
    var self = this;

    var configFile = self.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    self.config = new (require('v-conf'))();
    self.config.loadFile(configFile);
    self.loadI18n();

    return libQ.resolve();
};

vkMusic.prototype.onStart = function () {
    var self = this;

    self.addToBrowseSources();
    self.mpdPlugin = self.commandRouter.pluginManager.getPlugin('music_service', 'mpd');
    self.initClient();
    self.proxy.start(PROXY_PORT);

    return libQ.resolve();
};

vkMusic.prototype.onStop = function () {
    var self = this;

    self.commandRouter.volumioRemoveToBrowseSources(self.getI18n('VKM'));
    self.browseCache.flushAll();
    self.proxy.stop();
    self.client = false;

    return libQ.resolve();
};

vkMusic.prototype.onRestart = function () {
    return libQ.resolve();
};

vkMusic.prototype.getConfigurationFiles = function () {
    return ['config.json'];
};

vkMusic.prototype.initClient = function () {
    var self = this;

    var cookieP = self.config.get('cookie_p');
    var remixsid = self.config.get('remixsid');

    if (!cookieP || !remixsid) {
        self.logger.info('VK Music: cookies are not configured yet');
        self.client = false;
        return false;
    }

    self.client = new vk.VKClient(cookieP, remixsid, self.logger);

    // A token cached from a previous run saves one round trip on startup.
    var token = self.config.get('access_token');
    var expires = self.config.get('token_expires');
    if (token && expires) {
        self.client.token = token;
        self.client.expires = expires;
    }

    return true;
};

// Keeps the refreshed token across restarts so we do not hit the auth
// endpoint more often than necessary.
vkMusic.prototype.storeToken = function () {
    var self = this;

    if (!self.client || !self.client.token) {
        return;
    }
    self.config.set('access_token', self.client.token);
    self.config.set('token_expires', self.client.expires);
};

// ---------------------------------------------------------------- settings

vkMusic.prototype.getUIConfig = function () {
    var self = this;
    var defer = libQ.defer();
    var lang_code = self.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(
        __dirname + '/i18n/strings_' + lang_code + '.json',
        __dirname + '/i18n/strings_en.json',
        __dirname + '/UIConfig.json'
    ).then(function (uiconf) {
        // Never echo the stored cookies back into the form.
        uiconf.sections[0].content[0].value = self.config.get('cookie_p') ? '******' : '';
        uiconf.sections[0].content[1].value = self.config.get('remixsid') ? '******' : '';
        defer.resolve(uiconf);
    }).fail(function () {
        defer.reject(new Error());
    });

    return defer.promise;
};

vkMusic.prototype.setUIConfig = function (data) {
    return libQ.resolve();
};

vkMusic.prototype.getConf = function (varName) {
    return this.config.get(varName);
};

vkMusic.prototype.setConf = function (varName, varValue) {
    this.config.set(varName, varValue);
};

vkMusic.prototype.accountLogin = function (data) {
    var self = this;
    var defer = libQ.defer();

    var cookieP = data['cookie_p'];
    var remixsid = data['remixsid'];

    if (!cookieP || !remixsid || cookieP === '******' || remixsid === '******') {
        self.commandRouter.pushToastMessage('error', self.getI18n('LOGIN_FAILED'), self.getI18n('LOGIN_FAILED_NO_COOKIES'));
        defer.reject(new Error('missing cookies'));
        return defer.promise;
    }

    // Validate before storing: a bad cookie pair fails at the token step.
    var client = new vk.VKClient(cookieP, remixsid, self.logger);
    client.refresh().then(function () {
        self.config.set('cookie_p', cookieP);
        self.config.set('remixsid', remixsid);
        self.client = client;
        self.storeToken();
        self.browseCache.flushAll();
        self.commandRouter.pushToastMessage('success', self.getI18n('VKM'), self.getI18n('LOGIN_SUCCESSFUL'));
        defer.resolve({});
    }).fail(function (err) {
        self.logger.error('VK Music: login failed: ' + err);
        self.commandRouter.pushToastMessage('error', self.getI18n('LOGIN_FAILED'), String(err));
        defer.reject(err);
    });

    return defer.promise;
};

// ------------------------------------------------------------------ browse

vkMusic.prototype.addToBrowseSources = function () {
    var self = this;

    self.commandRouter.volumioAddToBrowseSources({
        name: self.getI18n('VKM'),
        uri: 'vk_music',
        plugin_type: 'music_service',
        plugin_name: 'vk_music',
        albumart: '/albumart?sourceicon=music_service/vk_music/vk_music.png'
    });
};

// VK addresses a track by owner and id together; both are needed to play it
// or to add it to My music.
function trackUri(audio) {
    return 'vk_music/track/' + audio.owner_id + '_' + audio.id;
}

function thumbOf(audio) {
    var thumb = audio.thumb || (audio.album && audio.album.thumb);
    if (!thumb) {
        return '/albumart';
    }
    return thumb.photo_300 || thumb.photo_270 || thumb.photo_600 || thumb.photo_135 || '/albumart';
}

function trackItem(audio) {
    return {
        service: 'vk_music',
        type: 'song',
        title: audio.title,
        artist: audio.artist,
        album: audio.album ? audio.album.title : '',
        duration: audio.duration,
        albumart: thumbOf(audio),
        uri: trackUri(audio)
    };
}

vkMusic.prototype.handleBrowseUri = function (curUri) {
    var self = this;

    if (curUri === 'vk_music') {
        return self.browseRoot();
    }
    if (curUri.indexOf('vk_music/section/') === 0) {
        return self.browseSection(curUri.substring('vk_music/section/'.length), curUri);
    }

    return libQ.reject(new Error('VK Music: неизвестный адрес "' + curUri + '"'));
};

vkMusic.prototype.browseSection = function (sectionId, curUri) {
    var self = this;
    var defer = libQ.defer();

    if (!self.client && !self.initClient()) {
        defer.reject(new Error(self.getI18n('LOGIN_FAILED_NO_COOKIES')));
        return defer.promise;
    }

    var cached = self.browseCache.get(curUri);
    if (cached) {
        defer.resolve(cached);
        return defer.promise;
    }

    self.client.getSection(sectionId).then(function (response) {
        var audios = response.audios || [];
        var page = {
            navigation: {
                lists: [{
                    title: response.section ? response.section.title : '',
                    availableListViews: ['list'],
                    items: audios.map(trackItem)
                }],
                prev: { uri: 'vk_music' }
            }
        };

        self.storeToken();
        self.browseCache.set(curUri, page);
        defer.resolve(page);
    }).fail(function (err) {
        self.logger.error('VK Music: browseSection failed: ' + err);
        defer.reject(err);
    });

    return defer.promise;
};

// The catalogue root. VK returns the same section list the web player shows
// down the left-hand side, so we mirror it one to one.
vkMusic.prototype.browseRoot = function () {
    var self = this;
    var defer = libQ.defer();

    if (!self.client && !self.initClient()) {
        defer.reject(new Error(self.getI18n('LOGIN_FAILED_NO_COOKIES')));
        return defer.promise;
    }

    var cached = self.browseCache.get('root');
    if (cached) {
        defer.resolve(cached);
        return defer.promise;
    }

    self.client.getSections(undefined, true).then(function (response) {
        var sections = (response.catalog && response.catalog.sections) || [];
        var items = sections.map(function (section) {
            return {
                service: 'vk_music',
                type: 'folder',
                title: section.title,
                uri: 'vk_music/section/' + section.id,
                albumart: '/albumart?sourceicon=music_service/vk_music/icons/playlist.png'
            };
        });

        var page = {
            navigation: {
                lists: [{
                    availableListViews: ['list', 'grid'],
                    items: items
                }],
                prev: { uri: '/' }
            }
        };

        self.storeToken();
        self.browseCache.set('root', page);
        defer.resolve(page);
    }).fail(function (err) {
        self.logger.error('VK Music: browseRoot failed: ' + err);
        defer.reject(err);
    });

    return defer.promise;
};

vkMusic.prototype.search = function (query) {
    var self = this;
    var defer = libQ.defer();

    if (!self.client && !self.initClient()) {
        defer.resolve([]);
        return defer.promise;
    }

    self.client.search(query.value, 0).then(function (found) {
        var audios = found.items || [];
        if (!audios.length) {
            defer.resolve([]);
            return;
        }
        defer.resolve([{
            type: 'title',
            title: self.getI18n('SEARCH_RESULTS') + ' - ' + self.getI18n('SEARCH_SONGS_SECTION'),
            availableListViews: ['list'],
            items: audios.map(trackItem)
        }]);
    }).fail(function (err) {
        self.logger.error('VK Music: search failed: ' + err);
        defer.resolve([]);
    });

    return defer.promise;
};

// ---------------------------------------------------------------- playback

// Turns a track id into something MPD can fetch. The signed playlist url is
// resolved fresh every time, because it expires.
vkMusic.prototype.resolveTrack = function (id) {
    var self = this;
    var defer = libQ.defer();

    if (!self.client && !self.initClient()) {
        defer.reject(new Error(self.getI18n('LOGIN_FAILED_NO_COOKIES')));
        return defer.promise;
    }

    self.client.getById(id).then(function (response) {
        var audio = Array.isArray(response) ? response[0] : (response && response.items ? response.items[0] : response);
        if (!audio) {
            defer.reject(new Error('VK Music: трек ' + id + ' не найден'));
            return;
        }
        if (!audio.url) {
            defer.reject(new Error('VK Music: у трека ' + id + ' нет ссылки - возможно, он недоступен'));
            return;
        }
        self.storeToken();
        defer.resolve(audio);
    }).fail(function (err) {
        defer.reject(err);
    });

    return defer.promise;
};

// The .mp3 in the path is cosmetic - it lets MPD and the UI recognise the
// format from the url; the proxy serves whatever the query asks for.
function proxyUrl(playlistUrl) {
    return 'http://127.0.0.1:' + PROXY_PORT + '/track.mp3?' + querystring.stringify({ url: playlistUrl });
}

vkMusic.prototype.explodeUri = function (curUri) {
    var self = this;
    var defer = libQ.defer();

    if (curUri.indexOf('vk_music/track/') !== 0) {
        defer.reject(new Error('VK Music: нечего проигрывать по адресу "' + curUri + '"'));
        return defer.promise;
    }

    self.resolveTrack(curUri.substring('vk_music/track/'.length)).then(function (audio) {
        defer.resolve([{
            uri: trackUri(audio),
            service: 'vk_music',
            name: audio.title,
            title: audio.title,
            artist: audio.artist,
            album: audio.album ? audio.album.title : '',
            type: 'track',
            duration: audio.duration,
            albumart: thumbOf(audio),
            trackType: 'mp3'
        }]);
    }).fail(function (err) {
        self.logger.error('VK Music: explodeUri failed: ' + err);
        defer.reject(err);
    });

    return defer.promise;
};

vkMusic.prototype.clearAddPlayTrack = function (track) {
    var self = this;

    return self.mpdPlugin.sendMpdCommand('stop', [])
        .then(function () {
            return self.mpdPlugin.sendMpdCommand('clear', []);
        })
        .then(function () {
            return self.resolveTrack(track.uri.substring('vk_music/track/'.length));
        })
        .then(function (audio) {
            return self.mpdPlugin.sendMpdCommand('addid "' + proxyUrl(audio.url) + '"', []);
        })
        .then(function (resp) {
            if (resp && resp.Id !== undefined) {
                return self.mpdPlugin.sendMpdCommandArray([
                    { command: 'addtagid', parameters: [resp.Id, 'title', track.title] },
                    { command: 'addtagid', parameters: [resp.Id, 'album', track.album] },
                    { command: 'addtagid', parameters: [resp.Id, 'artist', track.artist] }
                ]);
            }
            return libQ.resolve();
        })
        .then(function () {
            // ignoremeta keeps Volumio reporting this service and uri from the
            // queue rather than from MPD, which is what lets next/previous and
            // the heart button reach this plugin at all. Same trade-off as in
            // the Yandex plugin: live samplerate and bitdepth stop showing.
            self.commandRouter.stateMachine.setConsumeUpdateService('mpd', true);
            return self.mpdPlugin.sendMpdCommand('play', []);
        });
};

vkMusic.prototype.stop = function () {
    var self = this;

    self.commandRouter.stateMachine.setConsumeUpdateService('mpd', true);
    return self.mpdPlugin.stop();
};

vkMusic.prototype.pause = function () {
    var self = this;

    self.commandRouter.stateMachine.setConsumeUpdateService('mpd', true);
    return self.mpdPlugin.pause();
};

vkMusic.prototype.resume = function () {
    var self = this;

    self.commandRouter.stateMachine.setConsumeUpdateService('mpd', true);
    return self.mpdPlugin.resume();
};

vkMusic.prototype.next = function () {
    var self = this;

    self.commandRouter.stateMachine.setConsumeUpdateService('mpd', true);
    return self.mpdPlugin.next();
};

vkMusic.prototype.previous = function () {
    var self = this;

    self.commandRouter.stateMachine.setConsumeUpdateService('mpd', true);
    return self.mpdPlugin.previous();
};

// The stream has no Content-Length and cannot be seeked; see README.
vkMusic.prototype.seek = function (position) {
    var self = this;

    return self.mpdPlugin.seek(position);
};

// -------------------------------------------------------------------- i18n

vkMusic.prototype.loadI18n = function () {
    var self = this;

    try {
        var language_code = self.commandRouter.sharedVars.get('language_code');
        self.i18n = fs.readJsonSync(__dirname + '/i18n/strings_' + language_code + '.json');
    } catch (e) {
        self.i18n = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
    }
    self.i18nDefaults = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
};

vkMusic.prototype.getI18n = function (key) {
    var self = this;

    if (self.i18n && self.i18n[key] !== undefined) {
        return self.i18n[key];
    }
    if (self.i18nDefaults && self.i18nDefaults[key] !== undefined) {
        return self.i18nDefaults[key];
    }
    return key;
};
