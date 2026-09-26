'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var NodeCache = require('node-cache');
var vk = require('./vk.js');

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

    return libQ.resolve();
};

vkMusic.prototype.onStop = function () {
    var self = this;

    self.commandRouter.volumioRemoveToBrowseSources(self.getI18n('VKM'));
    self.browseCache.flushAll();
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

vkMusic.prototype.handleBrowseUri = function (curUri) {
    var self = this;

    if (curUri === 'vk_music') {
        return self.browseRoot();
    }

    // TODO: sections, playlists, VK Mix and search results.
    return libQ.reject(new Error('VK Music: browsing "' + curUri + '" is not implemented yet'));
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
    // TODO: map audio.search onto Volumio's search result sections.
    return libQ.resolve([]);
};

// ---------------------------------------------------------------- playback

vkMusic.prototype.explodeUri = function (uri) {
    // TODO: resolve a track uri into a Volumio track object. Blocked on the
    // streaming question - see README, "Как проигрывать".
    return libQ.reject(new Error('VK Music: playback is not implemented yet'));
};

vkMusic.prototype.clearAddPlayTracks = function (track) {
    return libQ.reject(new Error('VK Music: playback is not implemented yet'));
};

vkMusic.prototype.stop = function () {
    var self = this;
    return self.mpdPlugin.stop();
};

vkMusic.prototype.pause = function () {
    var self = this;
    return self.mpdPlugin.pause();
};

vkMusic.prototype.resume = function () {
    var self = this;
    return self.mpdPlugin.resume();
};

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
