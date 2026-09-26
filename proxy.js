'use strict';

var http = require('http');
var url = require('url');
var spawn = require('child_process').spawn;
var hls = require('./hls.js');

// MPD cannot play VK's HLS itself, so tracks are handed to it as a plain
// http url pointing here. We assemble and decrypt the transport stream in
// hls.js, then let ffmpeg remux it to MP3 - no re-encoding, just repackaging.
//
// The stream is chunked and carries no Content-Length, so seeking inside a
// track will not work. Buffering the whole track first would restore that at
// the cost of a couple of seconds before playback starts; see README.

var FFMPEG_ARGS = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'mpegts',
    '-i', 'pipe:0',
    '-c:a', 'copy',
    '-f', 'mp3',
    'pipe:1'
];

function Proxy(logger) {
    var self = this;

    self.logger = logger;
    self.server = false;
}

Proxy.prototype.start = function (port) {
    var self = this;

    if (self.server) {
        return;
    }

    self.server = http.createServer(function (req, res) {
        self.handle(req, res);
    });

    self.server.on('error', function (err) {
        self.logger.error('[vk_music] proxy: ' + err);
    });

    self.server.listen(port, '127.0.0.1');
};

Proxy.prototype.handle = function (req, res) {
    var self = this;
    var target = url.parse(req.url, true).query['url'];

    if (!target) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('missing url parameter');
        return;
    }

    // Nothing here is seekable, so a Range request is answered with the whole
    // stream rather than a 206 we could not honour.
    res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'none'
    });

    if (req.method === 'HEAD') {
        res.end();
        return;
    }

    var source = hls.openStream(target, self.logger);
    var ffmpeg = spawn('ffmpeg', FFMPEG_ARGS);
    var finished = false;

    function cleanup(reason, err) {
        if (finished) {
            return;
        }
        finished = true;

        if (err) {
            self.logger.error('[vk_music] proxy ' + reason + ': ' + err);
        }
        source.destroy();
        ffmpeg.kill('SIGKILL');
        res.end();
    }

    source.on('error', function (err) {
        cleanup('поток HLS', err);
    });

    // ffmpeg exiting first leaves the assembler writing into a closed pipe.
    ffmpeg.stdin.on('error', function () {});

    ffmpeg.stderr.on('data', function (chunk) {
        self.logger.error('[vk_music] ffmpeg: ' + String(chunk).trim());
    });

    ffmpeg.on('error', function (err) {
        cleanup('запуск ffmpeg', err);
    });

    ffmpeg.on('close', function (code) {
        if (code !== 0 && !finished) {
            cleanup('ffmpeg завершился с кодом ' + code);
        } else {
            cleanup();
        }
    });

    // MPD closing the connection - a skipped track - must stop the work.
    res.on('close', function () {
        cleanup();
    });

    source.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(res);
};

Proxy.prototype.stop = function () {
    var self = this;

    if (self.server) {
        self.server.close();
        self.server = false;
    }
};

module.exports = Proxy;
