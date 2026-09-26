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
    // Metadata of every track we have listed. Volumio explodes a queue one
    // track at a time, so adding a whole section means one explodeUri per
    // track; going to the API for each of those trips VK's rate limit, and
    // the listing we came from already holds everything explodeUri needs.
    self.trackCache = new NodeCache({ stdTTL: 7200, checkperiod: 300 });
    // A section's tracks in order, so "play this whole section" does not have
    // to fetch it again.
    self.sectionTracks = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

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

function playlistUri(playlist) {
    return 'vk_music/playlist/' + playlist.owner_id + '_' + playlist.id +
           (playlist.access_key ? '_' + playlist.access_key : '');
}

function playlistArt(playlist) {
    var photo = playlist.photo || (playlist.thumbs && playlist.thumbs[0]);
    if (!photo) {
        return '/albumart?sourceicon=music_service/vk_music/icons/playlist.png';
    }
    return photo.photo_300 || photo.photo_270 || photo.photo_600 || '/albumart';
}

function playlistItem(playlist) {
    return {
        service: 'vk_music',
        type: 'folder',
        title: playlist.title,
        artist: playlist.subtitle || '',
        albumart: playlistArt(playlist),
        uri: playlistUri(playlist)
    };
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

vkMusic.prototype.rememberTracks = function (audios) {
    var self = this;

    audios.forEach(function (audio) {
        self.trackCache.set(audio.owner_id + '_' + audio.id, audio);
    });
};

vkMusic.prototype.handleBrowseUri = function (curUri) {
    var self = this;

    if (curUri === 'vk_music') {
        return self.browseRoot();
    }
    if (curUri.indexOf('vk_music/section/') === 0) {
        return self.browseSection(curUri.substring('vk_music/section/'.length), curUri);
    }
    if (curUri.indexOf('vk_music/playlist/') === 0) {
        return self.browsePlaylist(curUri);
    }

    return libQ.reject(new Error('VK Music: неизвестный адрес "' + curUri + '"'));
};

// owner and playlist ids are numbers and the key has no underscores, so the
// uri splits cleanly - the owner id may be negative for community playlists.
function parsePlaylistUri(curUri) {
    var parts = curUri.substring('vk_music/playlist/'.length).split('_');
    return { ownerId: parts[0], playlistId: parts[1], accessKey: parts[2] || '' };
}

vkMusic.prototype.loadPlaylist = function (curUri) {
    var self = this;
    var defer = libQ.defer();

    var cached = self.sectionTracks.get(curUri);
    if (cached) {
        defer.resolve(cached);
        return defer.promise;
    }

    if (!self.client && !self.initClient()) {
        defer.reject(new Error(self.getI18n('LOGIN_FAILED_NO_COOKIES')));
        return defer.promise;
    }

    var ref = parsePlaylistUri(curUri);
    self.client.getPlaylist(ref.ownerId, ref.playlistId, ref.accessKey).then(function (response) {
        var audios = response.items || [];
        self.rememberTracks(audios);
        self.sectionTracks.set(curUri, audios);
        self.storeToken();
        defer.resolve(audios);
    }).fail(function (err) {
        self.logger.error('VK Music: плейлист ' + curUri + ' не загрузился: ' + err);
        defer.reject(err);
    });

    return defer.promise;
};

vkMusic.prototype.browsePlaylist = function (curUri) {
    var self = this;
    var defer = libQ.defer();

    self.loadPlaylist(curUri).then(function (audios) {
        defer.resolve({
            navigation: {
                lists: [{
                    availableListViews: ['list'],
                    items: audios.map(trackItem)
                }],
                prev: { uri: 'vk_music' }
            }
        });
    }).fail(function (err) {
        defer.reject(err);
    });

    return defer.promise;
};

vkMusic.prototype.browseSection = function (sectionId, curUri) {
    var self = this;
    var defer = libQ.defer();

    if (!self.client && !self.initClient()) {
        defer.reject(new Error(self.getI18n('LOGIN_FAILED_NO_COOKIES')));
        return defer.promise;
    }

    self.loadSection(sectionId, curUri).then(function (loaded) {
        if (!loaded.page) {
            defer.reject(new Error('VK Music: раздел не загрузился'));
            return;
        }
        self.storeToken();
        defer.resolve(loaded.page);
    }).fail(function (err) {
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

        // Not every section holds tracks: Radio is a hundred internet radio
        // stations and Updates comes back as placeholders. Both render as an
        // empty screen, so the root only lists sections that actually have
        // something to play. Loading them here also warms the cache, so
        // opening one afterwards costs no request.
        return libQ.all(sections.map(function (section) {
            return self.loadSection(section.id, 'vk_music/section/' + section.id);
        })).then(function (loaded) {
            var items = [];
            sections.forEach(function (section, i) {
                if (loaded[i].trackCount > 0) {
                    items.push({
                        service: 'vk_music',
                        type: 'folder',
                        title: section.title,
                        uri: 'vk_music/section/' + section.id,
                        albumart: '/albumart?sourceicon=music_service/vk_music/icons/playlist.png'
                    });
                }
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
        });
    }).fail(function (err) {
        self.logger.error('VK Music: browseRoot failed: ' + err);
        defer.reject(err);
    });

    return defer.promise;
};

// A section is a sequence of blocks: a heading block carrying only a title,
// then a block of track ids or playlist ids referring to the flat audios and
// playlists arrays alongside. Rendering them in order preserves VK's own
// grouping - "Выбор редакции", "Новинки по жанрам" and the rest - instead of
// flattening everything into one anonymous list.
vkMusic.prototype.sectionLists = function (response) {
    var self = this;

    var audios = {};
    (response.audios || []).forEach(function (audio) {
        audios[audio.owner_id + '_' + audio.id] = audio;
    });
    var playlists = {};
    (response.playlists || []).forEach(function (playlist) {
        playlists[playlist.owner_id + '_' + playlist.id] = playlist;
    });

    var blocks = (response.section && response.section.blocks) || [];
    var lists = [];
    var heading = '';

    blocks.forEach(function (block) {
        var title = block.layout && block.layout.title;

        if (block.data_type === 'music_audios') {
            var tracks = (block.audios_ids || []).map(function (id) { return audios[id]; }).filter(Boolean);
            if (tracks.length) {
                lists.push({
                    title: heading || title || '',
                    availableListViews: ['list'],
                    items: tracks.map(trackItem)
                });
                heading = '';
            }
        } else if (block.data_type === 'music_playlists') {
            var found = (block.playlists_ids || []).map(function (id) { return playlists[id]; }).filter(Boolean);
            if (found.length) {
                lists.push({
                    title: heading || title || '',
                    availableListViews: ['list', 'grid'],
                    items: found.map(playlistItem)
                });
                heading = '';
            }
        } else if (title) {
            // A heading block, which labels whatever block comes next.
            heading = title;
        }
    });

    // A section whose blocks we do not understand still shows its tracks.
    if (!lists.length && (response.audios || []).length) {
        lists.push({
            title: (response.section && response.section.title) || '',
            availableListViews: ['list'],
            items: response.audios.map(trackItem)
        });
    }

    return lists;
};

// Fetches a section once and caches both its rendered page and its tracks.
// A section that cannot be loaded is reported as empty rather than failing
// the whole root listing.
vkMusic.prototype.loadSection = function (sectionId, curUri) {
    var self = this;
    var defer = libQ.defer();

    var cached = self.browseCache.get(curUri);
    if (cached) {
        defer.resolve({ page: cached, trackCount: cached.navigation.lists[0].items.length });
        return defer.promise;
    }

    self.client.getSection(sectionId).then(function (response) {
        var audios = response.audios || [];
        self.rememberTracks(audios);

        var lists = self.sectionLists(response);
        var page = {
            navigation: {
                lists: lists,
                prev: { uri: 'vk_music' }
            }
        };

        // Counts playlists too: a section made only of playlists still has
        // plenty to play and must not be hidden as empty.
        var total = lists.reduce(function (sum, list) { return sum + list.items.length; }, 0);

        self.browseCache.set(curUri, page);
        self.sectionTracks.set(curUri, audios);
        defer.resolve({ page: page, trackCount: total });
    }).fail(function (err) {
        self.logger.error('VK Music: раздел ' + sectionId + ' не загрузился: ' + err);
        defer.resolve({ page: false, trackCount: 0 });
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
        self.rememberTracks(audios);
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

function queueEntry(audio) {
    return {
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
    };
}

vkMusic.prototype.explodeUri = function (curUri) {
    var self = this;
    var defer = libQ.defer();

    if (curUri.indexOf('vk_music/playlist/') === 0) {
        self.loadPlaylist(curUri).then(function (audios) {
            defer.resolve(audios.map(queueEntry));
        }).fail(function (err) {
            defer.reject(err);
        });
        return defer.promise;
    }

    // Hitting play on a section queues the whole thing.
    if (curUri.indexOf('vk_music/section/') === 0) {
        var sectionId = curUri.substring('vk_music/section/'.length);
        self.loadSection(sectionId, curUri).then(function (loaded) {
            var audios = self.sectionTracks.get(curUri) || [];
            defer.resolve(audios.map(queueEntry));
        }).fail(function (err) {
            self.logger.error('VK Music: explodeUri section failed: ' + err);
            defer.reject(err);
        });
        return defer.promise;
    }

    if (curUri.indexOf('vk_music/track/') !== 0) {
        defer.reject(new Error('VK Music: нечего проигрывать по адресу "' + curUri + '"'));
        return defer.promise;
    }

    var id = curUri.substring('vk_music/track/'.length);

    // The playlist url is not needed here - clearAddPlayTrack fetches a fresh
    // one when the track actually plays - so a listed track costs no request.
    var known = self.trackCache.get(id);
    if (known) {
        defer.resolve([queueEntry(known)]);
        return defer.promise;
    }

    self.resolveTrack(id).then(function (audio) {
        self.trackCache.set(id, audio);
        defer.resolve([queueEntry(audio)]);
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
