'use strict';

var https = require('https');
var url = require('url');
var crypto = require('crypto');
var stream = require('stream');

// VK serves tracks as HLS with roughly every third segment encrypted with
// AES-128 and the rest carrying METHOD=NONE. ffmpeg's own HLS demuxer fetches
// the key and opens the segment through crypto+https, but still fails with
// "Invalid data found" on the encrypted ones and silently drops them - a
// 284 second track comes out 186 seconds long. The encryption itself is
// entirely standard, so we do the fetching and decrypting here and leave
// ffmpeg to do nothing but remux the assembled TS into MP3.

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0';

function fetch(target) {
    return new Promise(function (resolve, reject) {
        var opts = url.parse(target);
        opts.headers = { 'user-agent': USER_AGENT };

        var req = https.get(opts, function (res) {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                resolve(fetch(url.resolve(target, res.headers.location)));
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error('HTTP ' + res.statusCode + ' для ' + target.split('?')[0]));
                return;
            }
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () { resolve(Buffer.concat(chunks)); });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30000, function () {
            req.destroy(new Error('таймаут запроса'));
        });
    });
}

// Standard HLS: without an explicit IV attribute the initialisation vector is
// the segment's media sequence number, big endian, in the low 8 bytes.
function sequenceIV(seq) {
    var iv = Buffer.alloc(16);
    iv.writeUInt32BE(Math.floor(seq / 0x100000000), 8);
    iv.writeUInt32BE(seq >>> 0, 12);
    return iv;
}

function parseHex(text) {
    return Buffer.from(text.replace(/^0[xX]/, ''), 'hex');
}

// Turns the playlist into a flat list of segments, each already knowing
// whether and how it is encrypted.
function parsePlaylist(body, baseUrl) {
    var lines = body.split('\n');
    var segments = [];
    var sequence = 0;
    var key = null;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) {
            continue;
        }

        if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
            sequence = parseInt(line.split(':')[1], 10) || 0;
        } else if (line.indexOf('#EXT-X-KEY:') === 0) {
            if (line.indexOf('METHOD=NONE') >= 0) {
                key = null;
            } else if (line.indexOf('METHOD=AES-128') >= 0) {
                var uriMatch = line.match(/URI="([^"]+)"/);
                var ivMatch = line.match(/IV=([0-9a-fA-FxX]+)/);
                key = {
                    uri: uriMatch ? url.resolve(baseUrl, uriMatch[1]) : null,
                    iv: ivMatch ? parseHex(ivMatch[1]) : null
                };
            } else {
                throw new Error('неподдерживаемый метод шифрования: ' + line);
            }
        } else if (line[0] !== '#') {
            segments.push({
                url: url.resolve(baseUrl, line),
                key: key,
                sequence: sequence
            });
            sequence++;
        }
    }

    return segments;
}

// The plaintext is a whole number of 188 byte TS packets, so the encrypted
// segment carries PKCS#7 padding to reach the AES block size. Node would
// verify it for us, but a malformed tail should cost us that one segment
// rather than throw, so padding is handled by hand.
function stripPadding(buf) {
    if (!buf.length) {
        return buf;
    }
    var pad = buf[buf.length - 1];
    if (pad < 1 || pad > 16 || pad > buf.length) {
        return buf;
    }
    for (var i = buf.length - pad; i < buf.length; i++) {
        if (buf[i] !== pad) {
            return buf;
        }
    }
    return buf.slice(0, buf.length - pad);
}

function decryptSegment(data, keyBytes, iv) {
    var decipher = crypto.createDecipheriv('aes-128-cbc', keyBytes, iv);
    decipher.setAutoPadding(false);
    return stripPadding(Buffer.concat([decipher.update(data), decipher.final()]));
}

// Fetches the playlist and pipes the assembled MPEG-TS into the returned
// stream, one segment at a time so memory stays flat regardless of track
// length. Keys are fetched once each and reused.
function openStream(playlistUrl, logger) {
    var out = new stream.PassThrough();
    var keyCache = {};
    var cancelled = false;

    out.on('close', function () { cancelled = true; });

    function write(chunk) {
        return new Promise(function (resolve) {
            if (out.write(chunk)) {
                resolve();
            } else {
                out.once('drain', resolve);
            }
        });
    }

    function keyFor(segment) {
        if (!segment.key || !segment.key.uri) {
            return Promise.resolve(null);
        }
        if (keyCache[segment.key.uri]) {
            return Promise.resolve(keyCache[segment.key.uri]);
        }
        return fetch(segment.key.uri).then(function (bytes) {
            if (bytes.length !== 16) {
                throw new Error('ключ длиной ' + bytes.length + ' байт вместо 16');
            }
            keyCache[segment.key.uri] = bytes;
            return bytes;
        });
    }

    (async function () {
        var body = (await fetch(playlistUrl)).toString('utf8');
        var segments = parsePlaylist(body, playlistUrl);

        if (!segments.length) {
            throw new Error('в плейлисте нет сегментов');
        }
        if (logger && logger.info) {
            logger.info('[vk_music] HLS: сегментов ' + segments.length +
                        ', зашифрованных ' + segments.filter(function (s) { return s.key; }).length);
        }

        for (var i = 0; i < segments.length && !cancelled; i++) {
            var segment = segments[i];
            var data = await fetch(segment.url);
            var keyBytes = await keyFor(segment);

            if (keyBytes) {
                var iv = segment.key.iv || sequenceIV(segment.sequence);
                data = decryptSegment(data, keyBytes, iv);
            }

            await write(data);
        }

        out.end();
    })().catch(function (err) {
        out.emit('error', err);
        out.end();
    });

    return out;
}

module.exports = {
    openStream: openStream,
    parsePlaylist: parsePlaylist,
    sequenceIV: sequenceIV,
    stripPadding: stripPadding
};
