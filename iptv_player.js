(function () {
    'use strict';

    /**
     * IPTV для Lampa, версия 2
     *
     * - Несколько плейлистов (M3U/M3U8) с переключением
     * - Программа передач (XMLTV, в том числе .xml.gz): "сейчас идёт" в списках и в названии в плеере
     * - Вид "Список" (стабильный) или "Плитки" с логотипами (экспериментальный)
     * - Продолжить последний канал, предыдущий канал, переключение цифрами в плеере
     * - Скрытие групп и каналов, переименование, сортировка
     * - Избранное
     * - PIN-код на группы
     * - Автообновление плейлиста раз в сутки, кэш на случай недоступности
     * - Автоповтор при обрыве потока (если версия Lampa даёт событие ошибки)
     * - Экспорт и импорт настроек
     * - Кнопка таймера сна (если установлен плагин sleep_timer.js)
     *
     * Настройки находятся в разделе Lampa: Настройки -> IPTV.
     * (Только кнопки и переключатели: поля ввода Lampa в этом разделе не используются,
     *  а значения вводятся через окно ввода.)
     */

    if (window.plugin_iptv_player_ready) return;
    window.plugin_iptv_player_ready = true;

    var ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 2l4 4 4-4"/></svg>';

    var PAGE_SIZE = 60;
    var GRID_CHUNK = 120;
    var CACHE_LIMIT = 2000000;
    var CACHE_TTL = 24 * 3600 * 1000;
    var EPG_TTL = 6 * 3600 * 1000;
    var GZIP_JS_MAX = 250000000;
    var UNLOCK_MS = 30 * 60 * 1000;

    var STATE = {
        channels: [],
        groupMap: {},
        groupOrder: [],
        loaded: false,
        loadedId: null,
        epg: null,
        epgLoading: false,
        unlockedUntil: 0,
        current: null,
        origin: 'menu',
        gridOk: false,
        gridCtx: null
    };

    /* =====================================================
       Утилиты
       ===================================================== */

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function noty(text) {
        try { Lampa.Noty.show(text); } catch (e) {}
    }

    function sget(key, def) {
        var v = Lampa.Storage.get(key, def);
        return v === undefined || v === null ? def : v;
    }

    function sset(key, value) {
        Lampa.Storage.set(key, value);
    }

    function toSet(arr) {
        var o = {};
        (Array.isArray(arr) ? arr : []).forEach(function (x) { o[x] = true; });
        return o;
    }

    function shorten(str, n) {
        str = String(str || '');
        n = n || 50;
        return str.length > n ? str.substring(0, n - 3) + '...' : str;
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function fmtTime(ts) {
        var d = new Date(ts);
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function norm(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9а-яё]+/g, '');
    }

    function truthy(v) {
        return v === true || v === 'true' || v === 1 || v === '1';
    }

    function gridMode() {
        var g = sget('iptv_grid', null);
        if (g === null || g === '') return sget('iptv_view', 'list') === 'grid';
        return truthy(g);
    }

    function sortAz() {
        var g = sget('iptv_sort_az', null);
        if (g === null || g === '') return sget('iptv_sort', 'list') === 'az';
        return truthy(g);
    }

    function ask(title, value, cb) {
        if (!(Lampa.Input && Lampa.Input.edit)) {
            noty('IPTV: ввод недоступен в этой версии Lampa');
            return cb(null);
        }

        Lampa.Input.edit({ value: value || '', free: true, title: title }, function (v) {
            v = (v === undefined || v === null ? '' : String(v)).trim();
            cb(v || null);
        });
    }

    function back() {
        try { Lampa.Controller.toggle(STATE.origin || 'menu'); } catch (e) {}
    }

    /* =====================================================
       Плейлисты (несколько)
       ===================================================== */

    function getLists() {
        var l = sget('iptv_lists', []);
        if (!Array.isArray(l)) l = [];

        // миграция со старой версии, где была одна ссылка
        if (!l.length) {
            var old = String(sget('iptv_url', '') || '').trim();
            if (old) {
                l = [{ id: 'l1', name: 'Основной', url: old }];
                sset('iptv_lists', l);
                sset('iptv_active', 'l1');
            }
        }
        return l;
    }

    function activeList() {
        var l = getLists();
        if (!l.length) return null;
        var id = sget('iptv_active', '');
        for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
        return l[0];
    }

    function addPlaylist(cb) {
        var first = getLists().length === 0;

        function askUrl(name) {
            ask('Ссылка на плейлист (M3U)', '', function (url) {
                if (!url) return cb(false);
                var lists = getLists();
                var id = 'l' + Date.now();
                lists.push({ id: id, name: name, url: url });
                sset('iptv_lists', lists);
                sset('iptv_active', id);
                STATE.loaded = false;
                cb(true);
            });
        }

        if (first) askUrl('Основной');
        else ask('Название плейлиста', '', function (name) {
            if (!name) return cb(false);
            askUrl(name);
        });
    }

    /* =====================================================
       Загрузка и разбор M3U
       ===================================================== */

    function parseM3U(text) {
        var lines = String(text).split(/\r?\n/);
        var channels = [];
        var groups = {};
        var order = [];
        var cur = null;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            if (line.indexOf('#EXTINF') === 0) {
                var name = line.substring(line.lastIndexOf(',') + 1).trim();
                var g = /group-title="([^"]*)"/i.exec(line);
                var logo = /tvg-logo="([^"]*)"/i.exec(line);
                var tid = /tvg-id="([^"]*)"/i.exec(line);
                cur = {
                    name: name || 'Без названия',
                    group: g && g[1] ? g[1] : 'Без группы',
                    logo: logo ? logo[1] : '',
                    id: tid ? tid[1] : ''
                };
            } else if (line.charAt(0) === '#') {
                if (line.indexOf('#EXTGRP:') === 0 && cur) cur.group = line.substring(8).trim() || cur.group;
            } else if (cur) {
                cur.url = line;
                channels.push(cur);
                if (!groups[cur.group]) {
                    groups[cur.group] = true;
                    order.push(cur.group);
                }
                cur = null;
            }
        }

        return { channels: channels, order: order };
    }

    function applyParsed(text) {
        var p = parseM3U(text);
        STATE.channels = p.channels;
        STATE.groupOrder = p.order;
        STATE.loaded = p.channels.length > 0;
        return STATE.loaded;
    }

    function buildUrl(url) {
        var proxy = String(sget('iptv_proxy', '') || '').trim();
        return proxy ? proxy + encodeURIComponent(url) : url;
    }

    function download(url, ok, fail) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', buildUrl(url), true);
        xhr.timeout = 40000;
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) ok(xhr.responseText);
            else fail('HTTP ' + xhr.status);
        };
        xhr.onerror = function () { fail('сеть или CORS'); };
        xhr.ontimeout = function () { fail('таймаут'); };
        xhr.send();
    }

    function loadPlaylist(force, done) {
        var list = activeList();

        if (!list) {
            return addPlaylist(function (ok) {
                if (ok) loadPlaylist(true, done);
            });
        }

        if (!force && STATE.loaded && STATE.loadedId === list.id) return done();

        var cacheKey = 'iptv_cache_' + list.id;
        var timeKey = 'iptv_cache_t_' + list.id;
        var cached = sget(cacheKey, '');
        var age = Date.now() - (parseInt(sget(timeKey, 0), 10) || 0);

        if (!force && cached && age < CACHE_TTL && applyParsed(String(cached))) {
            STATE.loadedId = list.id;
            maybeLoadEpg(false);
            return done();
        }

        noty('IPTV: загрузка плейлиста...');

        download(list.url, function (text) {
            if (!applyParsed(text)) {
                noty('IPTV: в плейлисте не найдено каналов');
                return;
            }

            STATE.loadedId = list.id;

            try {
                if (text.length < CACHE_LIMIT) {
                    sset(cacheKey, text);
                    sset(timeKey, Date.now());
                }
            } catch (e) {}

            maybeLoadEpg(force);
            done();
        }, function (reason) {
            if (cached && applyParsed(String(cached))) {
                STATE.loadedId = list.id;
                noty('IPTV: не удалось обновить (' + reason + '), открыта сохранённая копия');
                maybeLoadEpg(false);
                done();
            } else {
                noty('IPTV: ошибка загрузки (' + reason + '). Проверьте ссылку или CORS-прокси');
            }
        });
    }

    /* =====================================================
       Программа передач (XMLTV)
       ===================================================== */

    function parseXmltvTime(s) {
        var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(String(s));
        if (!m) return 0;

        var t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));

        if (m[7]) {
            var sign = m[7].charAt(0) === '-' ? -1 : 1;
            var off = sign * (parseInt(m[7].substr(1, 2), 10) * 60 + parseInt(m[7].substr(3, 2), 10));
            t -= off * 60000;
        }
        return t;
    }

    function decodeEntities(s) {
        return String(s)
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&');
    }

    function EpgParser() {
        var wantedIds = {};
        var wantedNames = {};

        STATE.channels.forEach(function (c) {
            if (c.id) wantedIds[c.id] = true;
            wantedNames[norm(c.name)] = true;
        });

        var now = Date.now();
        var from = now - 2 * 3600 * 1000;
        var to = now + 36 * 3600 * 1000;
        var keep = {};
        var names = {};
        var progs = {};
        var buf = '';
        var re = /<channel\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>|<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g;

        function handleChannel(id, inner) {
            var dnRe = /<display-name[^>]*>([^<]*)<\/display-name>/g;
            var hit = !!wantedIds[id];
            var found = [];
            var d;

            while ((d = dnRe.exec(inner)) !== null) {
                var key = norm(decodeEntities(d[1]));
                if (!key) continue;
                found.push(key);
                if (wantedNames[key]) hit = true;
            }

            if (!hit) return;
            keep[id] = true;
            found.forEach(function (k) { if (!names[k]) names[k] = id; });
        }

        function handleProgramme(attrs, inner) {
            var ch = /channel="([^"]*)"/.exec(attrs);
            if (!ch || !(keep[ch[1]] || wantedIds[ch[1]])) return;

            var st = /start="([^"]+)"/.exec(attrs);
            var en = /stop="([^"]+)"/.exec(attrs);
            if (!st || !en) return;

            var s1 = parseXmltvTime(st[1]);
            var e1 = parseXmltvTime(en[1]);
            if (!s1 || !e1 || e1 < from || s1 > to) return;

            var ti = /<title[^>]*>([^<]*)<\/title>/.exec(inner);
            if (!ti) return;

            if (!progs[ch[1]]) progs[ch[1]] = [];
            progs[ch[1]].push([s1, e1, decodeEntities(ti[1]).trim()]);
        }

        this.feed = function (chunk) {
            buf += chunk;
            re.lastIndex = 0;

            var last = 0;
            var m;
            while ((m = re.exec(buf)) !== null) {
                last = re.lastIndex;
                if (m[1] !== undefined) handleChannel(m[1], m[2]);
                else handleProgramme(m[3], m[4]);
            }

            buf = buf.substring(last);

            if (buf.length > 4000000) {
                var i = buf.lastIndexOf('<');
                buf = i > 0 ? buf.substring(i) : '';
            }
        };

        this.result = function () {
            Object.keys(progs).forEach(function (k) {
                progs[k].sort(function (a, b) { return a[0] - b[0]; });
            });
            return { progs: progs, names: names, t: now };
        };
    }

    /* ---- чтение EPG: обычный XML и .gz ---- */

    function utf8Decode(u8, start, end) {
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder('utf-8').decode(u8.subarray(start, end));
        }

        var out = [];
        var chunk = [];
        var i = start;

        while (i < end) {
            var c = u8[i++];
            var cp;

            if (c < 0x80) cp = c;
            else if (c < 0xE0) cp = ((c & 0x1F) << 6) | (u8[i++] & 0x3F);
            else if (c < 0xF0) {
                cp = ((c & 0x0F) << 12) | ((u8[i++] & 0x3F) << 6) | (u8[i++] & 0x3F);
            } else {
                cp = ((c & 0x07) << 18) | ((u8[i++] & 0x3F) << 12) | ((u8[i++] & 0x3F) << 6) | (u8[i++] & 0x3F);
                cp -= 0x10000;
                chunk.push(0xD800 + (cp >> 10));
                cp = 0xDC00 + (cp & 0x3FF);
            }

            chunk.push(cp);
            if (chunk.length >= 8192) {
                out.push(String.fromCharCode.apply(null, chunk));
                chunk = [];
            }
        }

        if (chunk.length) out.push(String.fromCharCode.apply(null, chunk));
        return out.join('');
    }

    // Разбор байтов кусками, чтобы не подвешивать интерфейс
    function feedBytes(u8, parser, done, fail) {
        var SLICE = 2097152;
        var pos = 0;

        (function next() {
            try {
                if (pos >= u8.length) return done();

                var end = Math.min(u8.length, pos + SLICE);
                if (end < u8.length) {
                    while (end > pos && (u8[end] & 0xC0) === 0x80) end--;
                    if (end === pos) end = Math.min(u8.length, pos + SLICE);
                }

                parser.feed(utf8Decode(u8, pos, end));
                pos = end;
                setTimeout(next, 0);
            } catch (e) {
                fail(e && e.message ? e.message : String(e));
            }
        })();
    }

    // Запасная распаковка gzip на чистом JS (для старых телевизоров), алгоритм inflate
    var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    var CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

    function huffman(lengths, n) {
        var count = [];
        var symbol = [];
        var offs = [];
        var i;

        for (i = 0; i <= 15; i++) count[i] = 0;
        for (i = 0; i < n; i++) count[lengths[i]]++;

        offs[1] = 0;
        for (i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
        for (i = 0; i < n; i++) if (lengths[i] !== 0) symbol[offs[lengths[i]]++] = i;

        return { count: count, symbol: symbol };
    }

    function inflateRaw(src, sp, out) {
        var bitbuf = 0;
        var bitcnt = 0;
        var op = 0;

        function bits(need) {
            var val = bitbuf;
            while (bitcnt < need) {
                if (sp >= src.length) throw new Error('неожиданный конец данных');
                val |= src[sp++] << bitcnt;
                bitcnt += 8;
            }
            bitbuf = val >>> need;
            bitcnt -= need;
            return val & ((1 << need) - 1);
        }

        function decode(h) {
            var code = 0, first = 0, index = 0;
            for (var len = 1; len <= 15; len++) {
                code |= bits(1);
                var count = h.count[len];
                if (code - count < first) return h.symbol[index + (code - first)];
                index += count;
                first += count;
                first <<= 1;
                code <<= 1;
            }
            throw new Error('ошибка кода Хаффмана');
        }

        function codes(lc, dc) {
            for (;;) {
                var sym = decode(lc);
                if (sym < 256) {
                    if (op >= out.length) throw new Error('переполнение буфера');
                    out[op++] = sym;
                } else if (sym === 256) {
                    return;
                } else {
                    sym -= 257;
                    if (sym >= 29) throw new Error('неверный код длины');
                    var len = LBASE[sym] + bits(LEXT[sym]);
                    var ds = decode(dc);
                    var dist = DBASE[ds] + bits(DEXT[ds]);
                    if (dist > op || op + len > out.length) throw new Error('неверное расстояние');
                    while (len--) { out[op] = out[op - dist]; op++; }
                }
            }
        }

        var last, i;
        do {
            last = bits(1);
            var type = bits(2);

            if (type === 0) {
                bitbuf = 0;
                bitcnt = 0;
                var len0 = src[sp] | (src[sp + 1] << 8);
                sp += 4;
                if (op + len0 > out.length) throw new Error('переполнение буфера');
                for (i = 0; i < len0; i++) out[op++] = src[sp++];
            } else if (type === 1) {
                var fl = [];
                for (i = 0; i < 144; i++) fl[i] = 8;
                for (; i < 256; i++) fl[i] = 9;
                for (; i < 280; i++) fl[i] = 7;
                for (; i < 288; i++) fl[i] = 8;
                var fd = [];
                for (i = 0; i < 30; i++) fd[i] = 5;
                codes(huffman(fl, 288), huffman(fd, 30));
            } else if (type === 2) {
                var nlen = bits(5) + 257;
                var ndist = bits(5) + 1;
                var ncode = bits(4) + 4;
                var lengths = [];
                for (i = 0; i < 19; i++) lengths[i] = 0;
                for (i = 0; i < ncode; i++) lengths[CLORDER[i]] = bits(3);

                var clc = huffman(lengths, 19);
                var lens = [];
                var idx = 0;

                while (idx < nlen + ndist) {
                    var sy = decode(clc);
                    if (sy < 16) {
                        lens[idx++] = sy;
                    } else {
                        var prev = 0, rep;
                        if (sy === 16) {
                            if (idx === 0) throw new Error('неверные длины');
                            prev = lens[idx - 1];
                            rep = 3 + bits(2);
                        } else if (sy === 17) {
                            rep = 3 + bits(3);
                        } else {
                            rep = 11 + bits(7);
                        }
                        if (idx + rep > nlen + ndist) throw new Error('неверные длины');
                        while (rep--) lens[idx++] = prev;
                    }
                }

                codes(huffman(lens.slice(0, nlen), nlen), huffman(lens.slice(nlen), ndist));
            } else {
                throw new Error('неверный тип блока');
            }
        } while (!last);

        return op;
    }

    function gunzipJs(u8) {
        var flg = u8[3];
        var p = 10;

        if (flg & 4) p += 2 + (u8[p] | (u8[p + 1] << 8));
        if (flg & 8) { while (u8[p++] !== 0) {} }
        if (flg & 16) { while (u8[p++] !== 0) {} }
        if (flg & 2) p += 2;

        var n = u8.length;
        var isize = ((u8[n - 4]) | (u8[n - 3] << 8) | (u8[n - 2] << 16) | (u8[n - 1] << 24)) >>> 0;

        if (isize > GZIP_JS_MAX) throw new Error('файл слишком большой для этого телевизора');

        var out = new Uint8Array(isize);
        inflateRaw(u8, p, out);
        return out;
    }

    function hasNativeGzip() {
        return typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined' &&
            typeof TextDecoder !== 'undefined' && typeof Promise !== 'undefined';
    }

    function readEpg(buffer, done, fail) {
        var u8 = new Uint8Array(buffer);
        var parser = new EpgParser();
        var gz = u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;

        function finish() { done(parser.result()); }

        if (!gz) return feedBytes(u8, parser, finish, fail);

        noty('IPTV: распаковка программы передач...');

        function viaJs() {
            setTimeout(function () {
                try {
                    var out = gunzipJs(u8);
                    parser = new EpgParser();
                    feedBytes(out, parser, finish, fail);
                } catch (e) {
                    fail('gzip: ' + (e && e.message ? e.message : e));
                }
            }, 30);
        }

        if (hasNativeGzip()) {
            try {
                var reader = new Response(u8).body.pipeThrough(new DecompressionStream('gzip')).getReader();
                var dec = new TextDecoder('utf-8');

                (function pump() {
                    reader.read().then(function (r) {
                        if (r.done) {
                            parser.feed(dec.decode());
                            return finish();
                        }
                        parser.feed(dec.decode(r.value, { stream: true }));
                        pump();
                    }).catch(function () { viaJs(); });
                })();
                return;
            } catch (e) {}
        }

        viaJs();
    }

    function downloadBinary(url, ok, fail) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', buildUrl(url), true);
        xhr.responseType = 'arraybuffer';
        xhr.timeout = 180000;
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300 && xhr.response) ok(xhr.response);
            else fail('HTTP ' + xhr.status);
        };
        xhr.onerror = function () { fail('сеть или CORS'); };
        xhr.ontimeout = function () { fail('таймаут'); };
        xhr.send();
    }

    function maybeLoadEpg(force) {
        var url = String(sget('iptv_epg_url', '') || '').trim();
        if (!url || STATE.epgLoading) return;

        if (!force) {
            var cached = sget('iptv_epg', null);
            if (cached && typeof cached === 'object' && cached.progs && Date.now() - cached.t < EPG_TTL) {
                STATE.epg = cached;
                return;
            }
        }

        STATE.epgLoading = true;
        noty('IPTV: загрузка программы передач...');

        function fail(reason) {
            STATE.epgLoading = false;
            noty('IPTV: программа передач недоступна (' + reason + ')');
        }

        downloadBinary(url, function (buffer) {
            try {
                readEpg(buffer, function (epg) {
                    STATE.epgLoading = false;

                    if (!Object.keys(epg.progs).length) {
                        noty('IPTV: в программе передач нет данных для каналов плейлиста');
                        return;
                    }

                    STATE.epg = epg;

                    try {
                        if (JSON.stringify(epg).length < 1500000) sset('iptv_epg', epg);
                    } catch (e) {}

                    noty('IPTV: программа передач обновлена (' + Object.keys(epg.progs).length + ' каналов)');
                }, fail);
            } catch (e) {
                fail(e && e.message ? e.message : e);
            }
        }, fail);
    }

    function nowNext(c) {
        var e = STATE.epg;
        if (!e || !e.progs) return null;

        var id = c.id && e.progs[c.id] ? c.id : e.names[norm(c.orig || c.name)];
        var arr = id ? e.progs[id] : null;
        if (!arr) return null;

        var now = Date.now();
        for (var i = 0; i < arr.length; i++) {
            if (arr[i][0] <= now && now < arr[i][1]) {
                return { cur: arr[i], next: arr[i + 1] || null };
            }
        }
        return null;
    }

    function epgLine(c) {
        var n = nowNext(c);
        return n ? 'Сейчас: ' + n.cur[2] + ' (до ' + fmtTime(n.cur[1]) + ')' : '';
    }

    function playerLabel(c) {
        var n = nowNext(c);
        return n ? c.name + ' — ' + n.cur[2] : c.name;
    }

    /* =====================================================
       Представление: скрытие, переименование, PIN, сортировка
       ===================================================== */

    function hasPin() {
        return !!sget('iptv_pin', '');
    }

    function isUnlocked() {
        return !hasPin() || Date.now() < STATE.unlockedUntil;
    }

    function askPin(cb) {
        ask('Введите PIN', '', function (v) {
            if (v && 'p' + v === String(sget('iptv_pin', ''))) {
                STATE.unlockedUntil = Date.now() + UNLOCK_MS;
                cb(true);
            } else {
                noty('Неверный PIN');
                cb(false);
            }
        });
    }

    function buildView() {
        var hiddenCh = toSet(sget('iptv_hidden', []));
        var hiddenG = toSet(sget('iptv_hidden_groups', []));
        var locked = toSet(sget('iptv_locked', []));
        var names = sget('iptv_names', {});
        if (!names || typeof names !== 'object' || Array.isArray(names)) names = {};

        var unlocked = isUnlocked();
        var az = sortAz();

        var groups = {};
        var order = [];
        var all = [];
        var byUrl = {};

        STATE.channels.forEach(function (c) {
            if (hiddenCh[c.url] || hiddenG[c.group]) return;

            var item = {
                name: names[c.url] || c.name,
                orig: c.name,
                url: c.url,
                logo: c.logo,
                group: c.group,
                id: c.id,
                locked: !!locked[c.group]
            };

            if (!groups[c.group]) {
                groups[c.group] = [];
                order.push(c.group);
            }
            groups[c.group].push(item);

            if (!item.locked || unlocked) {
                all.push(item);
                byUrl[item.url] = item;
            }
        });

        function byName(a, b) {
            return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : (a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);
        }

        if (az) {
            all.sort(byName);
            order.sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
            order.forEach(function (g) { groups[g].sort(byName); });
        }

        return { all: all, groups: groups, order: order, byUrl: byUrl, locked: locked };
    }

    /* =====================================================
       Избранное, история, воспроизведение
       ===================================================== */

    function getFav() {
        var f = sget('iptv_fav', []);
        return Array.isArray(f) ? f : [];
    }

    function isFav(url) {
        return getFav().indexOf(url) !== -1;
    }

    function toggleFav(url) {
        var f = getFav().slice();
        var i = f.indexOf(url);
        if (i === -1) f.push(url); else f.splice(i, 1);
        sset('iptv_fav', f);
        return i === -1;
    }

    function remember(url) {
        var h = sget('iptv_hist', []);
        if (!Array.isArray(h)) h = [];
        if (h[0] === url) return;
        h = [url].concat(h.filter(function (u) { return u !== url; })).slice(0, 2);
        sset('iptv_hist', h);
    }

    function buildPlaylist(list) {
        return list.map(function (c) {
            return { title: playerLabel(c), url: c.url, iptv: true };
        });
    }

    function playChannel(list, index) {
        var playlist = buildPlaylist(list);

        STATE.current = { list: list, playlist: playlist, index: index, retries: 0 };
        remember(list[index].url);

        try {
            Lampa.Player.play(playlist[index]);
            Lampa.Player.playlist(playlist);
        } catch (e) {
            noty('IPTV: не удалось запустить плеер');
        }
    }

    function playByUrl(v, url) {
        var c = v.byUrl[url];
        if (!c) return noty('IPTV: канал не найден в текущем плейлисте');
        playChannel(v.all, v.all.indexOf(c));
    }

    /* ---- автоповтор при обрыве ---- */

    function currentItem() {
        var cur = STATE.current;
        if (!cur) return null;

        try {
            var pd = Lampa.Player.playdata && Lampa.Player.playdata();
            if (pd && pd.url) {
                for (var i = 0; i < cur.playlist.length; i++) {
                    if (cur.playlist[i].url === pd.url) {
                        cur.index = i;
                        return cur.playlist[i];
                    }
                }
            }
        } catch (e) {}

        return cur.playlist[cur.index] || null;
    }

    function onPlayError() {
        var cur = STATE.current;
        if (!cur || cur.retries >= 3) return;
        if (!(Lampa.Player.opened && Lampa.Player.opened())) return;

        cur.retries++;
        noty('IPTV: канал не отвечает, повтор ' + cur.retries + ' из 3');

        setTimeout(function () {
            try {
                var item = currentItem();
                if (item && Lampa.Player.opened && Lampa.Player.opened()) Lampa.Player.play(item);
            } catch (e) {}
        }, 2000);
    }

    function onPlayOk() {
        if (STATE.current) STATE.current.retries = 0;
    }

    function setupPlayerHooks() {
        try {
            var pv = Lampa.PlayerVideo;
            if (pv && pv.listener && pv.listener.follow) {
                pv.listener.follow('error', onPlayError);
                pv.listener.follow('canplay', onPlayOk);
                pv.listener.follow('play', onPlayOk);
            }
        } catch (e) {
            console.log('iptv_player', 'hooks', e);
        }
    }

    /* ---- переключение каналов цифрами ---- */

    function setupDigits() {
        var buffer = '';
        var timer = null;

        function digit(code) {
            if (code >= 48 && code <= 57) return code - 48;
            if (code >= 96 && code <= 105) return code - 96;
            return -1;
        }

        document.addEventListener('keydown', function (e) {
            try {
                var d = digit(e.keyCode);
                if (d < 0) return;
                if (!STATE.current) return;
                if (!(Lampa.Player.opened && Lampa.Player.opened())) return;

                buffer += String(d);
                if (buffer.length > 4) buffer = buffer.substring(buffer.length - 4);
                noty('Канал: ' + buffer);

                clearTimeout(timer);
                timer = setTimeout(function () {
                    var n = parseInt(buffer, 10);
                    buffer = '';
                    var cur = STATE.current;
                    if (!cur || !(n >= 1 && n <= cur.playlist.length)) {
                        return noty('IPTV: нет канала с таким номером');
                    }
                    cur.index = n - 1;
                    cur.retries = 0;
                    remember(cur.list[n - 1].url);
                    Lampa.Player.play(cur.playlist[n - 1]);
                }, 1500);
            } catch (err) {}
        }, true);
    }

    /* =====================================================
       Интерфейс: списки каналов
       ===================================================== */

    function channelSubtitle(c, index) {
        var epg = epgLine(c);
        return '№' + (index + 1) + ' · ' + esc(epg || c.group);
    }

    function channelActions(c, refresh) {
        var names = sget('iptv_names', {});
        if (!names || typeof names !== 'object' || Array.isArray(names)) names = {};
        var renamed = !!names[c.url];

        var items = [
            { title: isFav(c.url) ? 'Убрать из избранного' : 'Добавить в избранное', act: 'fav' },
            { title: 'Скрыть канал', act: 'hide' },
            { title: 'Переименовать', act: 'rename' }
        ];
        if (renamed) items.push({ title: 'Вернуть исходное название', act: 'reset' });

        Lampa.Select.show({
            title: esc(c.name),
            items: items,
            onBack: refresh,
            onSelect: function (item) {
                if (item.act === 'fav') {
                    noty(toggleFav(c.url) ? 'Добавлено в избранное' : 'Удалено из избранного');
                    refresh();
                } else if (item.act === 'hide') {
                    var h = sget('iptv_hidden', []).slice();
                    h.push(c.url);
                    sset('iptv_hidden', h);
                    noty('Канал скрыт (вернуть: Настройки → IPTV → Показать скрытые каналы)');
                    refresh(true);
                } else if (item.act === 'rename') {
                    ask('Новое название', c.name, function (v) {
                        if (v) {
                            names[c.url] = v;
                            sset('iptv_names', names);
                        }
                        refresh(true);
                    });
                } else if (item.act === 'reset') {
                    delete names[c.url];
                    sset('iptv_names', names);
                    refresh(true);
                }
            }
        });
    }

    function showChannels(title, list, page, editMode, backFn) {
        var total = Math.ceil(list.length / PAGE_SIZE) || 1;
        if (page >= total) page = total - 1;
        var start = page * PAGE_SIZE;
        var slice = list.slice(start, start + PAGE_SIZE);
        var items = [];

        if (page > 0) items.push({ title: '◂ Назад', nav: -1 });

        slice.forEach(function (c, i) {
            items.push({
                title: (isFav(c.url) ? '★ ' : '') + esc(c.name),
                subtitle: channelSubtitle(c, start + i),
                channel: c,
                index: start + i
            });
        });

        if (page < total - 1) items.push({ title: 'Далее ▸', nav: 1 });

        if (!items.length) {
            noty('IPTV: каналов нет');
            return backFn ? backFn() : back();
        }

        Lampa.Select.show({
            title: esc(title) + (total > 1 ? ' (' + (page + 1) + '/' + total + ')' : '') + (editMode ? ' — правка' : ''),
            items: items,
            onBack: function () {
                if (backFn) backFn(); else back();
            },
            onSelect: function (item) {
                if (item.nav) {
                    return showChannels(title, list, page + item.nav, editMode, backFn);
                }

                if (editMode) {
                    return channelActions(item.channel, function (rebuild) {
                        var fresh = list;
                        if (rebuild === true) {
                            var v = buildView();
                            fresh = list.filter(function (c) { return !!v.byUrl[c.url] || v.locked[c.group]; });
                            var nm = sget('iptv_names', {});
                            fresh = fresh.map(function (c) {
                                var copy = {};
                                for (var k in c) copy[k] = c[k];
                                copy.name = (nm && nm[c.url]) || c.orig || c.name;
                                return copy;
                            });
                        }
                        showChannels(title, fresh, page, editMode, backFn);
                    });
                }

                playChannel(list, item.index);
            }
        });
    }

    function openChannels(title, list, backFn) {
        if (gridMode() && STATE.gridOk) {
            try {
                STATE.gridCtx = { title: title, list: list, back: backFn };
                Lampa.Activity.push({ url: '', title: title, component: 'iptv_grid', page: 1 });
                return;
            } catch (e) {
                noty('IPTV: плитки недоступны, показан список');
            }
        }

        showChannels(title, list, 0, false, backFn);
    }

    function search(backFn) {
        ask('Поиск канала', '', function (value) {
            if (!value) return backFn();

            var q = value.toLowerCase();
            var v = buildView();
            var found = v.all.filter(function (c) {
                return c.name.toLowerCase().indexOf(q) !== -1;
            });

            if (!found.length) {
                noty('IPTV: ничего не найдено');
                return backFn();
            }

            openChannels('Поиск: ' + value, found, backFn);
        });
    }

    /* =====================================================
       Интерфейс: плитки (экспериментально)
       ===================================================== */

    function injectStyle() {
        if (document.getElementById('iptv-style')) return;

        var css = '' +
            '.iptv-grid__title{font-size:1.8em;padding:1em 1.5em .3em}' +
            '.iptv-grid{display:flex;flex-wrap:wrap;padding:.5em 1em 2em}' +
            '.iptv-tile{width:13em;margin:.5em;padding:.8em;border-radius:.7em;background:rgba(255,255,255,.08);text-align:center;box-sizing:border-box}' +
            '.iptv-tile.focus{background:#fff;color:#000}' +
            '.iptv-tile__logo{height:5em;display:flex;align-items:center;justify-content:center;font-size:2em;opacity:.9}' +
            '.iptv-tile__logo img{max-width:100%;max-height:5em;object-fit:contain}' +
            '.iptv-tile__name{margin-top:.4em;font-size:1.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.iptv-tile__epg{margin-top:.2em;font-size:.8em;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1.2em}';

        var st = document.createElement('style');
        st.id = 'iptv-style';
        st.appendChild(document.createTextNode(css));
        document.head.appendChild(st);
    }

    function GridComponent() {
        var scroll = new Lampa.Scroll({ mask: true, over: true, step: 250 });
        var html = $('<div></div>');
        var body = $('<div class="iptv-grid"></div>');
        var last = null;
        var ctx = STATE.gridCtx || { title: 'IPTV', list: [] };
        var shown = 0;
        var moreTile = null;
        var self = this;

        function initials(name) {
            var s = String(name || '?').replace(/[^A-Za-zА-Яа-яЁё0-9]/g, '');
            return (s.substring(0, 2) || '?').toUpperCase();
        }

        function makeTile(c, index) {
            var tile = $('<div class="iptv-tile selector"><div class="iptv-tile__logo"></div><div class="iptv-tile__name"></div><div class="iptv-tile__epg"></div></div>');
            var logo = tile.find('.iptv-tile__logo');

            tile.find('.iptv-tile__name').text((index + 1) + '. ' + c.name);
            tile.find('.iptv-tile__epg').text(epgLine(c).replace('Сейчас: ', ''));

            if (c.logo) {
                var img = $('<img>');
                img.on('error', function () {
                    img.remove();
                    logo.text(initials(c.name));
                });
                img.attr('src', c.logo);
                logo.append(img);
            } else {
                logo.text(initials(c.name));
            }

            tile.on('hover:focus', function () {
                last = tile[0];
                scroll.update(tile, true);
            });

            tile.on('hover:enter', function () {
                playChannel(ctx.list, index);
            });

            return tile;
        }

        function renderMore() {
            if (moreTile) { moreTile.remove(); moreTile = null; }

            var end = Math.min(ctx.list.length, shown + GRID_CHUNK);
            for (var i = shown; i < end; i++) body.append(makeTile(ctx.list[i], i));
            shown = end;

            if (shown < ctx.list.length) {
                moreTile = $('<div class="iptv-tile selector"><div class="iptv-tile__logo">+</div><div class="iptv-tile__name">Показать ещё</div><div class="iptv-tile__epg"></div></div>');
                moreTile.on('hover:focus', function () {
                    last = moreTile[0];
                    scroll.update(moreTile, true);
                });
                moreTile.on('hover:enter', function () {
                    renderMore();
                    Lampa.Controller.collectionSet(scroll.render());
                    Lampa.Controller.collectionFocus(false, scroll.render());
                });
                body.append(moreTile);
            }
        }

        this.create = function () {
            if (this.activity && this.activity.loader) this.activity.loader(true);

            html.append($('<div class="iptv-grid__title"></div>').text(ctx.title));
            scroll.append(body);
            html.append(scroll.render());
            renderMore();

            if (this.activity) {
                this.activity.loader(false);
                this.activity.toggle();
            }
            return this.render();
        };

        this.start = function () {
            if (Lampa.Activity.active && Lampa.Activity.active().activity !== this.activity) return;

            var Nav = Lampa.Navigator || window.Navigator;

            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(scroll.render());
                    Lampa.Controller.collectionFocus(last || false, scroll.render());
                },
                left: function () {
                    if (Nav.canmove('left')) Nav.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                right: function () { if (Nav.canmove('right')) Nav.move('right'); },
                up: function () {
                    if (Nav.canmove('up')) Nav.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function () { if (Nav.canmove('down')) Nav.move('down'); },
                back: function () {
                    Lampa.Activity.backward();
                    if (ctx.back) setTimeout(ctx.back, 300);
                }
            });

            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};
        this.render = function () { return html; };
        this.destroy = function () {
            try { scroll.destroy(); } catch (e) {}
            html.remove();
        };
    }

    function setupGrid() {
        try {
            var Nav = Lampa.Navigator || window.Navigator;
            if (!(Lampa.Component && Lampa.Component.add && Lampa.Scroll && Lampa.Activity && Nav && Nav.move && Nav.canmove)) return;
            injectStyle();
            Lampa.Component.add('iptv_grid', GridComponent);
            STATE.gridOk = true;
        } catch (e) {
            STATE.gridOk = false;
        }
    }

    /* =====================================================
       Интерфейс: главное меню и управление
       ===================================================== */

    function showGroups() {
        var v = buildView();
        var hist = sget('iptv_hist', []);
        if (!Array.isArray(hist)) hist = [];

        var last = hist[0] && v.byUrl[hist[0]];
        var prev = hist[1] && v.byUrl[hist[1]];
        var favCount = v.all.filter(function (c) { return isFav(c.url); }).length;
        var items = [];

        if (last) items.push({ title: '▶ Продолжить', subtitle: esc(last.name), act: 'continue' });
        if (prev) items.push({ title: '↔ Предыдущий канал', subtitle: esc(prev.name), act: 'prev' });

        items.push({ title: '★ Избранное', subtitle: favCount + ' каналов', act: 'fav' });
        items.push({ title: 'Все каналы', subtitle: v.all.length + ' каналов', act: 'all' });
        items.push({ title: 'Поиск', act: 'search' });

        v.order.forEach(function (g) {
            var lock = v.locked[g] && hasPin();
            items.push({
                title: (lock ? '(PIN) ' : '') + esc(g),
                subtitle: v.groups[g].length + ' каналов',
                act: 'group',
                group: g
            });
        });

        Lampa.Select.show({
            title: 'IPTV',
            items: items,
            onBack: back,
            onSelect: function (item) {
                var w = showGroups;

                if (item.act === 'continue') {
                    playByUrl(v, last.url);
                } else if (item.act === 'prev') {
                    playByUrl(v, prev.url);
                } else if (item.act === 'fav') {
                    var favs = v.all.filter(function (c) { return isFav(c.url); });
                    if (!favs.length) {
                        noty('Избранное пусто. Добавьте каналы: Настройки → IPTV → Изменить каналы');
                        return showGroups();
                    }
                    openChannels('Избранное', favs, w);
                } else if (item.act === 'all') {
                    openChannels('Все каналы', v.all, w);
                } else if (item.act === 'search') {
                    search(w);
                } else if (item.act === 'group') {
                    var open = function () { openChannels(item.group, v.groups[item.group], w); };

                    if (v.locked[item.group] && hasPin() && !isUnlocked()) {
                        askPin(function (ok) {
                            if (ok) { v = buildView(); open(); } else showGroups();
                        });
                    } else {
                        open();
                    }
                }
            }
        });
    }

    function needPin(cb) {
        if (!hasPin() || isUnlocked()) cb(true);
        else askPin(cb);
    }

    function gate(fn) {
        STATE.origin = Lampa.Controller.enabled().name;
        needPin(function (ok) {
            if (ok) fn(); else back();
        });
    }

    function actEpg() {
        var url = String(sget('iptv_epg_url', '') || '');

        ask('Ссылка на XMLTV (.xml или .xml.gz)', url, function (val) {
            if (val) {
                sset('iptv_epg_url', val);
                STATE.epg = null;
                maybeLoadEpg(true);
            }
            back();
        });
    }

    function actEpgOff() {
        sset('iptv_epg_url', '');
        sset('iptv_epg', null);
        STATE.epg = null;
        noty('Программа передач отключена');
        back();
    }

    function actProxy() {
        ask('CORS-прокси (префикс адреса)', String(sget('iptv_proxy', '') || ''), function (val) {
            if (val) {
                sset('iptv_proxy', val);
                STATE.loaded = false;
            }
            back();
        });
    }

    function actProxyOff() {
        sset('iptv_proxy', '');
        STATE.loaded = false;
        noty('CORS-прокси сброшен');
        back();
    }

    function actEdit() {
        loadPlaylist(false, function () {
            showChannels('Все каналы', buildView().all, 0, true, back);
        });
    }

    function actHideGroups() {
        loadPlaylist(false, function () {
            showGroupToggles('iptv_hidden_groups', 'Скрытые группы', back, null);
        });
    }

    function actUnhide() {
        sset('iptv_hidden', []);
        noty('Скрытые каналы возвращены');
        back();
    }

    function actReload() {
        STATE.epg = null;
        loadPlaylist(true, function () {
            noty('IPTV: плейлист обновлён');
            back();
        });
    }

    function actSleep() {
        setTimeout(function () {
            try { window.plugin_sleep_timer_api.open(); } catch (e) { noty('Установите плагин sleep_timer.js'); back(); }
        }, 100);
    }

    function addSettings() {
        Lampa.SettingsApi.addComponent({
            component: 'iptv_player',
            name: 'IPTV',
            icon: ICON
        });

        function button(name, title, desc, fn) {
            Lampa.SettingsApi.addParam({
                component: 'iptv_player',
                param: { name: name, type: 'button' },
                field: { name: title, description: desc || '' },
                onChange: function () { gate(fn); }
            });
        }

        function toggle(name, title, desc, def) {
            Lampa.SettingsApi.addParam({
                component: 'iptv_player',
                param: { name: name, type: 'trigger', default: def },
                field: { name: title, description: desc || '' }
            });
        }

        button('iptv_s_lists', 'Плейлисты', 'Добавить, переключить или удалить', function () { showLists(back); });
        button('iptv_s_epg', 'Программа передач (EPG)', 'Ссылка на XMLTV, поддерживается .xml.gz', actEpg);
        button('iptv_s_epgoff', 'Отключить программу передач', '', actEpgOff);
        toggle('iptv_grid', 'Вид: плитки с логотипами', 'Экспериментально. Выключено: обычный список', false);
        toggle('iptv_sort_az', 'Сортировать по алфавиту', 'Выключено: порядок как в плейлисте', false);
        button('iptv_s_edit', 'Изменить каналы', 'Избранное, скрыть, переименовать', actEdit);
        button('iptv_s_hideg', 'Скрытые группы', 'Выбрать группы, которые не показывать', actHideGroups);
        button('iptv_s_unhide', 'Показать скрытые каналы', 'Вернуть все скрытые каналы', actUnhide);
        button('iptv_s_pin', 'PIN-код на группы', 'Установить, изменить или удалить', function () { showPinMenu(back); });
        button('iptv_s_backup', 'Резервная копия', 'Экспорт и импорт настроек', function () { showBackup(back); });
        button('iptv_s_proxy', 'CORS-прокси', 'Если плейлист или программа не загружаются', actProxy);
        button('iptv_s_proxyoff', 'Сбросить CORS-прокси', '', actProxyOff);
        button('iptv_s_sleep', 'Таймер сна', 'Нужен плагин sleep_timer.js', actSleep);
        button('iptv_s_reload', 'Обновить плейлист и программу', 'Загрузить заново', actReload);
    }

    function showLists(backFn) {
        var lists = getLists();
        var act = activeList();
        var items = lists.map(function (l) {
            return { title: (act && act.id === l.id ? '● ' : '') + esc(l.name), subtitle: esc(shorten(l.url)), act: 'pick', id: l.id, name: l.name };
        });

        items.push({ title: '+ Добавить плейлист', act: 'add' });
        if (lists.length) items.push({ title: 'Удалить плейлист', act: 'del' });

        Lampa.Select.show({
            title: 'Плейлисты',
            items: items,
            onBack: backFn,
            onSelect: function (item) {
                if (item.act === 'pick') {
                    sset('iptv_active', item.id);
                    STATE.loaded = false;
                    noty('Активный плейлист: ' + item.name);
                    showLists(backFn);
                } else if (item.act === 'add') {
                    addPlaylist(function () {
                        showLists(backFn);
                    });
                } else if (item.act === 'del') {
                    showDeleteList(backFn);
                }
            }
        });
    }

    function showDeleteList(backFn) {
        var lists = getLists();

        Lampa.Select.show({
            title: 'Какой плейлист удалить?',
            items: lists.map(function (l) { return { title: esc(l.name), subtitle: esc(shorten(l.url)), id: l.id }; }),
            onBack: function () { showLists(backFn); },
            onSelect: function (item) {
                var rest = getLists().filter(function (l) { return l.id !== item.id; });
                sset('iptv_lists', rest);
                sset('iptv_cache_' + item.id, '');
                sset('iptv_cache_t_' + item.id, 0);
                if (sget('iptv_active', '') === item.id) sset('iptv_active', rest[0] ? rest[0].id : '');
                STATE.loaded = false;
                noty('Плейлист удалён');
                showLists(backFn);
            }
        });
    }

    function showGroupToggles(key, title, backFn, focus) {
        var set = toSet(sget(key, []));
        var items = STATE.groupOrder.map(function (g) {
            return { title: (set[g] ? '[x] ' : '[ ] ') + esc(g), group: g, selected: g === focus };
        });

        if (!items.length) {
            noty('Группы не найдены');
            return backFn();
        }

        Lampa.Select.show({
            title: title,
            items: items,
            onBack: backFn,
            onSelect: function (item) {
                var arr = sget(key, []).slice();
                var i = arr.indexOf(item.group);
                if (i === -1) arr.push(item.group); else arr.splice(i, 1);
                sset(key, arr);
                showGroupToggles(key, title, backFn, item.group);
            }
        });
    }

    function showPinMenu(backFn) {
        var items = [
            { title: hasPin() ? 'Изменить PIN' : 'Установить PIN', act: 'set' },
            { title: 'Закрытые группы', subtitle: 'какие группы просить PIN', act: 'groups' }
        ];
        if (hasPin()) items.push({ title: 'Удалить PIN', act: 'del' });

        Lampa.Select.show({
            title: 'PIN-код',
            items: items,
            onBack: backFn,
            onSelect: function (item) {
                var self = function () { showPinMenu(backFn); };

                if (item.act === 'set') {
                    var change = function () {
                        ask('Новый PIN (3–8 цифр)', '', function (v) {
                            if (!v) return self();
                            if (!/^\d{3,8}$/.test(v)) { noty('PIN должен состоять из 3–8 цифр'); return self(); }
                            sset('iptv_pin', 'p' + v);
                            noty('PIN установлен');
                            self();
                        });
                    };
                    needPin(function (ok) { if (ok) change(); else self(); });
                } else if (item.act === 'groups') {
                    showGroupToggles('iptv_locked', 'Закрытые группы (нужен PIN)', self, null);
                } else if (item.act === 'del') {
                    needPin(function (ok) {
                        if (ok) { sset('iptv_pin', ''); noty('PIN удалён'); }
                        self();
                    });
                }
            }
        });
    }

    /* ---- резервная копия ---- */

    var BACKUP_KEYS = ['iptv_lists', 'iptv_active', 'iptv_fav', 'iptv_hidden', 'iptv_hidden_groups',
        'iptv_names', 'iptv_locked', 'iptv_sort_az', 'iptv_grid', 'iptv_epg_url', 'iptv_proxy'];

    function exportBackup() {
        var data = {};
        BACKUP_KEYS.forEach(function (k) { data[k] = sget(k, null); });
        return btoa(unescape(encodeURIComponent(JSON.stringify(data))));
    }

    function importBackup(str) {
        var data = JSON.parse(decodeURIComponent(escape(atob(str.replace(/\s+/g, '')))));
        var n = 0;
        BACKUP_KEYS.forEach(function (k) {
            if (data[k] !== undefined && data[k] !== null) { sset(k, data[k]); n++; }
        });
        STATE.loaded = false;
        STATE.epg = null;
        return n;
    }

    function showBackup(backFn) {
        Lampa.Select.show({
            title: 'Резервная копия',
            items: [
                { title: 'Экспорт', subtitle: 'получить код настроек (PIN не включается)', act: 'export' },
                { title: 'Импорт', subtitle: 'вставить код настроек', act: 'import' }
            ],
            onBack: backFn,
            onSelect: function (item) {
                var self = function () { showBackup(backFn); };

                if (item.act === 'export') {
                    var code = exportBackup();
                    var copied = false;

                    try {
                        if (Lampa.Utils && Lampa.Utils.copyTextToClipboard) {
                            Lampa.Utils.copyTextToClipboard(code, function () { copied = true; noty('Код скопирован в буфер обмена'); }, function () {});
                        }
                    } catch (e) {}

                    ask('Код настроек (скопируйте)', code, function () {
                        if (!copied) noty('Если код не скопировался, выделите его в поле ввода вручную');
                        self();
                    });
                } else if (item.act === 'import') {
                    ask('Вставьте код настроек', '', function (str) {
                        if (!str) return self();
                        try {
                            noty('Импортировано параметров: ' + importBackup(str));
                        } catch (e) {
                            noty('Код повреждён или не подходит');
                        }
                        self();
                    });
                }
            }
        });
    }

    /* =====================================================
       Запуск
       ===================================================== */

    function open() {
        STATE.origin = Lampa.Controller.enabled().name;
        loadPlaylist(false, showGroups);
    }

    function addMenuButton() {
        var item = $(
            '<li class="menu__item selector" data-action="iptv_player">' +
                '<div class="menu__ico">' + ICON + '</div>' +
                '<div class="menu__text">IPTV</div>' +
            '</li>'
        );

        item.on('hover:enter', open);
        $('.menu .menu__list').eq(0).append(item);
    }

    function step(name, fn) {
        try {
            fn();
        } catch (e) {
            console.log('iptv_player', name, e);
            noty('IPTV: ошибка в шаге "' + name + '": ' + (e && e.message ? e.message : e));
        }
    }

    function start() {
        step('settings', addSettings);
        step('menu', addMenuButton);
        step('grid', setupGrid);
        step('player', setupPlayerHooks);
        step('digits', setupDigits);
    }

    if (window.appready) start();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
    }
})();
