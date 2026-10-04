/**
 * IPTV для Lampa — версия 3.1
 *
 * - Группы каналов слева
 * - Каналы справа (список или плитки)
 * - При входе сразу каналы (настраивается)
 * - В плеере: prev / next канал, пауза, список каналов
 * - Несколько плейлистов, избранное, EPG, кэш, автоповтор
 *
 * Настройки: Настройки → IPTV
 */
(function () {
    'use strict';

    if (window.plugin_iptv_player_ready) return;
    window.plugin_iptv_player_ready = true;

    var ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 2l4 4 4-4"/></svg>';

    var CACHE_LIMIT = 2000000;
    var CACHE_TTL = 24 * 3600 * 1000;
    var EPG_TTL = 6 * 3600 * 1000;
    var DEFAULT_EPG = 'http://epg.it999.ru/epg2.xml.gz';
    var UNLOCK_MS = 30 * 60 * 1000;

    var STATE = {
        channels: [],
        groupOrder: [],
        loaded: false,
        loadedId: null,
        epg: null,
        epgLoading: false,
        unlockedUntil: 0,
        current: null,
        playlist: [],       // текущий список для prev/next в плеере
        playlistIndex: -1,
        origin: 'menu',
        activeGroup: null,
        panelFocus: 'channels'
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

    function noty(t) {
        try { Lampa.Noty.show(t); } catch (e) {}
    }

    function sget(k, d) {
        var v = Lampa.Storage.get(k, d);
        return v === undefined || v === null ? d : v;
    }

    function sset(k, v) {
        Lampa.Storage.set(k, v);
    }

    function toSet(arr) {
        var o = {};
        (Array.isArray(arr) ? arr : []).forEach(function (x) { o[x] = true; });
        return o;
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

    function flag(name, def) {
        try {
            if (Lampa.Storage.field) {
                var f = Lampa.Storage.field(name);
                if (f !== undefined && f !== null && f !== '') return truthy(f);
            }
        } catch (e) {}
        try {
            var raw = window.localStorage.getItem(name);
            if (raw !== null && raw !== '') return truthy(raw);
        } catch (e) {}
        return !!def;
    }

    function gridMode() {
        return flag('iptv_grid', false);
    }

    function ask(title, value, cb) {
        if (!(Lampa.Input && Lampa.Input.edit)) {
            noty('IPTV: ввод недоступен');
            return cb(null);
        }
        Lampa.Input.edit({ value: value || '', free: true, title: title }, function (v) {
            v = (v === undefined || v === null ? '' : String(v)).trim();
            setTimeout(function () { cb(v || null); }, 200);
        });
    }

    function selectShow(o) {
        Lampa.Select.show(o);
    }

    /* =====================================================
       Плейлисты
       ===================================================== */

    function getLists() {
        var l = sget('iptv_lists', []);
        if (!Array.isArray(l)) l = [];
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
        ask('Ссылка на плейлист (M3U)', '', function (url) {
            if (!url) return cb(false);
            if (!/^https?:\/\//i.test(url)) {
                noty('Ссылка должна начинаться с http:// или https://');
                return cb(false);
            }
            var lists = getLists();
            for (var i = 0; i < lists.length; i++) {
                if (lists[i].url === url) {
                    noty('Такой плейлист уже добавлен');
                    return cb(false);
                }
            }
            var m = /^https?:\/\/([^\/?#]+)/i.exec(url);
            var name = (lists.length ? 'Плейлист ' + (lists.length + 1) : 'Основной') + (m ? ' (' + m[1] + ')' : '');
            var id = 'l' + Date.now();
            lists.push({ id: id, name: name, url: url });
            sset('iptv_lists', lists);
            sset('iptv_active', id);
            STATE.loaded = false;
            noty('Плейлист добавлен: ' + name);
            cb(true);
        });
    }

    /* =====================================================
       Разбор M3U
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

    function proxiedUrl(url) {
        var proxy = String(sget('iptv_proxy', '') || '').trim();
        return proxy ? proxy + encodeURIComponent(url) : null;
    }

    function request(url, binary, timeout, ok, fail) {
        var alt = proxiedUrl(url);
        function attempt(target, viaProxy) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', target, true);
            if (binary) xhr.responseType = 'arraybuffer';
            xhr.timeout = timeout;
            function netFail(reason) {
                if (!viaProxy && alt) return attempt(alt, true);
                fail(viaProxy ? reason + ' (через прокси)' : reason);
            }
            xhr.onload = function () {
                var body = binary ? xhr.response : xhr.responseText;
                if (xhr.status >= 200 && xhr.status < 300 && body) ok(body);
                else fail('HTTP ' + xhr.status + (viaProxy ? ' через прокси' : ''));
            };
            xhr.onerror = function () { netFail('сеть или CORS'); };
            xhr.ontimeout = function () { netFail('таймаут'); };
            xhr.send();
        }
        attempt(url, false);
    }

    function download(url, ok, fail) {
        request(url, false, 40000, ok, fail);
    }

    function loadPlaylist(force, done) {
        var list = activeList();
        if (!list) {
            return addPlaylist(function (ok) {
                if (ok) loadPlaylist(true, done);
                else done();
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
                return done();
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
                noty('IPTV: не удалось обновить (' + reason + '), открыта копия');
                maybeLoadEpg(false);
                done();
            } else {
                noty('IPTV: ошибка загрузки (' + reason + ')');
                done();
            }
        });
    }

    /* =====================================================
       EPG
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

    function maybeLoadEpg(force) {
        var url = String(sget('iptv_epg_url', '') || '').trim();
        if (!url) return;
        if (STATE.epgLoading) return;
        if (!force && STATE.epg && (Date.now() - (STATE.epg.t || 0)) < EPG_TTL) return;

        STATE.epgLoading = true;
        noty('IPTV: загрузка программы передач...');

        download(url.replace(/\.gz$/i, ''), function (text) {
            try {
                STATE.epg = parseEpgSimple(text);
                noty('IPTV: программа передач загружена');
            } catch (e) {
                noty('IPTV: ошибка разбора EPG');
            }
            STATE.epgLoading = false;
        }, function () {
            download(url, function (text) {
                try {
                    STATE.epg = parseEpgSimple(text);
                    noty('IPTV: программа передач загружена');
                } catch (e) {
                    noty('IPTV: не удалось загрузить EPG');
                }
                STATE.epgLoading = false;
            }, function (r) {
                noty('IPTV: EPG недоступна (' + r + ')');
                STATE.epgLoading = false;
            });
        });
    }

    function parseEpgSimple(text) {
        var progs = {};
        var names = {};
        var now = Date.now();
        var from = now - 2 * 3600 * 1000;
        var to = now + 36 * 3600 * 1000;

        var chRe = /<channel\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g;
        var m;
        while ((m = chRe.exec(text)) !== null) {
            var id = m[1];
            var dnRe = /<display-name[^>]*>([^<]*)<\/display-name>/g;
            var d;
            while ((d = dnRe.exec(m[2])) !== null) {
                var key = norm(d[1]);
                if (key) names[key] = id;
            }
        }

        var prRe = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g;
        while ((m = prRe.exec(text)) !== null) {
            var attrs = m[1];
            var inner = m[2];
            var ch = /channel="([^"]*)"/.exec(attrs);
            var st = /start="([^"]+)"/.exec(attrs);
            var en = /stop="([^"]+)"/.exec(attrs);
            if (!ch || !st || !en) continue;
            var s1 = parseXmltvTime(st[1]);
            var e1 = parseXmltvTime(en[1]);
            if (!s1 || !e1 || e1 < from || s1 > to) continue;
            var ti = /<title[^>]*>([^<]*)<\/title>/.exec(inner);
            if (!ti) continue;
            if (!progs[ch[1]]) progs[ch[1]] = [];
            progs[ch[1]].push([s1, e1, ti[1].trim()]);
        }

        Object.keys(progs).forEach(function (k) {
            progs[k].sort(function (a, b) { return a[0] - b[0]; });
        });

        return { progs: progs, names: names, t: now };
    }

    function nowTitle(ch) {
        if (!STATE.epg || !ch) return '';
        var id = ch.id || (STATE.epg.names && STATE.epg.names[norm(ch.name)]);
        if (!id || !STATE.epg.progs[id]) return '';
        var now = Date.now();
        var list = STATE.epg.progs[id];
        for (var i = 0; i < list.length; i++) {
            if (list[i][0] <= now && now < list[i][1]) {
                return fmtTime(list[i][0]) + '–' + fmtTime(list[i][1]) + '  ' + list[i][2];
            }
        }
        return '';
    }

    /* =====================================================
       Избранное, скрытие, имена, PIN
       ===================================================== */

    function isFav(url) {
        return toSet(sget('iptv_fav', []))[url];
    }

    function toggleFav(url) {
        var arr = sget('iptv_fav', []).slice();
        var i = arr.indexOf(url);
        if (i === -1) arr.push(url); else arr.splice(i, 1);
        sset('iptv_fav', arr);
    }

    function isHidden(url) {
        return toSet(sget('iptv_hidden', []))[url];
    }

    function displayName(ch) {
        var names = sget('iptv_names', {});
        if (names && names[ch.url]) return names[ch.url];
        return ch.name;
    }

    function hasPin() {
        return !!String(sget('iptv_pin', '') || '').replace(/^p/, '');
    }

    function isUnlocked() {
        return Date.now() < (STATE.unlockedUntil || 0);
    }

    function askPin(cb) {
        ask('Введите PIN', '', function (v) {
            var pin = String(sget('iptv_pin', '') || '').replace(/^p/, '');
            if (v === pin) {
                STATE.unlockedUntil = Date.now() + UNLOCK_MS;
                cb(true);
            } else {
                noty('Неверный PIN');
                cb(false);
            }
        });
    }

    /* =====================================================
       Построение вида
       ===================================================== */

    function buildView() {
        var hiddenG = toSet(sget('iptv_hidden_groups', []));
        var locked = toSet(sget('iptv_locked', []));
        var sort = flag('iptv_sort_az', false);
        var groups = {};
        var order = [];
        var all = [];
        var byUrl = {};

        STATE.channels.forEach(function (c) {
            if (isHidden(c.url)) return;
            if (hiddenG[c.group]) return;
            var ch = {
                name: displayName(c),
                url: c.url,
                group: c.group,
                logo: c.logo,
                id: c.id,
                original: c
            };
            all.push(ch);
            byUrl[ch.url] = ch;
            if (!groups[ch.group]) {
                groups[ch.group] = [];
                order.push(ch.group);
            }
            groups[ch.group].push(ch);
        });

        if (sort) {
            all.sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
            order.sort(function (a, b) { return a.localeCompare(b, 'ru'); });
            Object.keys(groups).forEach(function (g) {
                groups[g].sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
            });
        }

        return { all: all, groups: groups, order: order, byUrl: byUrl, locked: locked };
    }

    /* =====================================================
       Воспроизведение + prev/next/pause/list
       ===================================================== */

    function setPlaylist(list, index) {
        STATE.playlist = list || [];
        STATE.playlistIndex = typeof index === 'number' ? index : -1;
    }

    function playChannel(ch, list) {
        if (!ch || !ch.url) return;

        if (list && list.length) {
            var idx = -1;
            for (var i = 0; i < list.length; i++) {
                if (list[i].url === ch.url) { idx = i; break; }
            }
            setPlaylist(list, idx >= 0 ? idx : 0);
        } else if (STATE.playlist.length) {
            var found = -1;
            for (var j = 0; j < STATE.playlist.length; j++) {
                if (STATE.playlist[j].url === ch.url) { found = j; break; }
            }
            if (found >= 0) STATE.playlistIndex = found;
        }

        STATE.current = ch;

        var hist = sget('iptv_hist', []);
        if (!Array.isArray(hist)) hist = [];
        hist = hist.filter(function (u) { return u !== ch.url; });
        hist.unshift(ch.url);
        if (hist.length > 30) hist = hist.slice(0, 30);
        sset('iptv_hist', hist);
        sset('iptv_last_group', ch.group || STATE.activeGroup || '');

        var title = ch.name;
        var epg = nowTitle(ch);
        if (epg) title += ' · ' + epg;

        Lampa.Player.play({
            url: ch.url,
            title: title,
            address: ch.url
        });
    }

    function playNext() {
        if (!STATE.playlist.length) return;
        var i = STATE.playlistIndex + 1;
        if (i >= STATE.playlist.length) i = 0;
        playChannel(STATE.playlist[i], STATE.playlist);
        noty('→ ' + STATE.playlist[i].name);
    }

    function playPrev() {
        if (!STATE.playlist.length) return;
        var i = STATE.playlistIndex - 1;
        if (i < 0) i = STATE.playlist.length - 1;
        playChannel(STATE.playlist[i], STATE.playlist);
        noty('← ' + STATE.playlist[i].name);
    }

    function togglePause() {
        try {
            if (Lampa.PlayerVideo && Lampa.PlayerVideo.video) {
                var v = Lampa.PlayerVideo.video();
                if (v) {
                    if (v.paused) {
                        v.play();
                        noty('▶ Play');
                    } else {
                        v.pause();
                        noty('⏸ Pause');
                    }
                    return;
                }
            }
        } catch (e) {}
        try {
            // fallback через события плеера
            Lampa.Player.toggle();
        } catch (e2) {
            noty('Пауза недоступна');
        }
    }

    function showPlayerChannelList() {
        if (!STATE.playlist.length) {
            noty('Список каналов пуст');
            return;
        }
        var items = STATE.playlist.map(function (ch, i) {
            return {
                title: (i === STATE.playlistIndex ? '▶ ' : '') + esc(ch.name),
                subtitle: esc(nowTitle(ch) || ch.group || ''),
                index: i,
                selected: i === STATE.playlistIndex
            };
        });
        selectShow({
            title: 'Каналы',
            items: items,
            onBack: function () {
                try { Lampa.Controller.toggle('player'); } catch (e) {}
            },
            onSelect: function (item) {
                playChannel(STATE.playlist[item.index], STATE.playlist);
            }
        });
    }

    function setupPlayerHooks() {
        // Клавиши в плеере: влево/вправо = prev/next, play/pause, канал-лист
        document.addEventListener('keydown', function (e) {
            try {
                if (!Lampa.Player || !Lampa.Player.playing || !Lampa.Player.playing()) return;
            } catch (err) {
                return;
            }

            var code = e.keyCode || e.which;

            // Не перехватываем, если открыт select/modal
            try {
                var ctrl = Lampa.Controller.enabled().name;
                if (ctrl === 'select' || ctrl === 'modal') return;
            } catch (err2) {}

            // Left = prev, Right = next
            if (code === 37 || code === 412) { // left / rewind
                e.preventDefault();
                e.stopPropagation();
                playPrev();
            } else if (code === 39 || code === 417) { // right / forward
                e.preventDefault();
                e.stopPropagation();
                playNext();
            } else if (code === 32 || code === 179 || code === 19) { // space / media play-pause / pause
                e.preventDefault();
                e.stopPropagation();
                togglePause();
            } else if (code === 48 || code === 96) { // 0 — список каналов
                e.preventDefault();
                e.stopPropagation();
                showPlayerChannelList();
            }
        }, true);

        // Кнопки в панели плеера (если API позволяет)
        try {
            Lampa.Player.listener.follow('ready', function () {
                injectPlayerButtons();
            });
        } catch (e) {}
    }

    function injectPlayerButtons() {
        // Пытаемся добавить кнопки в панель плеера Lampa
        try {
            var panel = document.querySelector('.player-panel .player-panel__center, .player-panel__body, .player-panel');
            if (!panel || document.getElementById('iptv-player-btns')) return;

            var wrap = document.createElement('div');
            wrap.id = 'iptv-player-btns';
            wrap.style.cssText = 'display:flex;gap:0.6em;align-items:center;margin:0 0.8em;';

            function mkBtn(label, title, fn) {
                var b = document.createElement('div');
                b.className = 'player-panel__button selector';
                b.textContent = label;
                b.title = title;
                b.style.cssText = 'padding:0.35em 0.7em;cursor:pointer;opacity:0.9;font-size:0.95em;';
                b.addEventListener('click', function (e) {
                    e.stopPropagation();
                    fn();
                });
                // Lampa hover
                $(b).on('hover:enter', fn);
                return b;
            }

            wrap.appendChild(mkBtn('⏮', 'Предыдущий канал', playPrev));
            wrap.appendChild(mkBtn('⏯', 'Пауза / Play', togglePause));
            wrap.appendChild(mkBtn('⏭', 'Следующий канал', playNext));
            wrap.appendChild(mkBtn('☰', 'Список каналов', showPlayerChannelList));

            panel.appendChild(wrap);
        } catch (e) {}
    }

    /* =====================================================
       ДВУХПАНЕЛЬНЫЙ ИНТЕРФЕЙС (группы слева)
       ===================================================== */

    function injectStyle() {
        if (document.getElementById('iptv-v3-style')) return;
        var css = [
            '.iptv-v3{display:flex;height:100%;width:100%;overflow:hidden;background:var(--color-background,#0f0f0f);}',
            /* группы СЛЕВА */
            '.iptv-v3__side{width:260px;max-width:30%;display:flex;flex-direction:column;background:rgba(0,0,0,0.28);border-right:1px solid rgba(255,255,255,0.07);flex-shrink:0;}',
            '.iptv-v3__side-head{padding:1.1em 1em 0.55em;font-size:1.08em;font-weight:600;opacity:0.8;}',
            '.iptv-v3__side-list{flex:1;overflow:auto;padding:0.2em 0.55em 1.2em;}',
            '.iptv-v3__grp{padding:0.62em 0.8em;border-radius:0.4em;margin:0.1em 0;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:0.45em;}',
            '.iptv-v3__grp.focus,.iptv-v3__grp:hover{background:rgba(255,255,255,0.09);}',
            '.iptv-v3__grp.active{background:rgba(33,150,243,0.25);color:#90caf9;}',
            '.iptv-v3__grp-count{opacity:0.45;font-size:0.84em;flex-shrink:0;}',
            /* каналы СПРАВА */
            '.iptv-v3__main{flex:1;display:flex;flex-direction:column;min-width:0;}',
            '.iptv-v3__head{padding:1.05em 1.3em 0.65em;display:flex;align-items:center;justify-content:space-between;gap:1em;}',
            '.iptv-v3__title{font-size:1.4em;font-weight:700;}',
            '.iptv-v3__meta{opacity:0.5;font-size:0.9em;}',
            '.iptv-v3__list{flex:1;overflow:auto;padding:0.25em 0.9em 1.4em;}',
            /* список */
            '.iptv-v3__ch{display:flex;align-items:center;gap:0.85em;padding:0.68em 0.85em;border-radius:0.42em;margin:0.12em 0;cursor:pointer;}',
            '.iptv-v3__ch.focus,.iptv-v3__ch:hover{background:rgba(255,255,255,0.08);}',
            '.iptv-v3__ch-num{width:2.1em;text-align:right;opacity:0.4;font-size:0.88em;flex-shrink:0;}',
            '.iptv-v3__ch-body{flex:1;min-width:0;}',
            '.iptv-v3__ch-name{font-size:1.06em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
            '.iptv-v3__ch-epg{font-size:0.8em;opacity:0.52;margin-top:0.12em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
            '.iptv-v3__ch-fav{color:#ffc107;margin-left:0.35em;}',
            /* плитки */
            '.iptv-v3__grid{display:flex;flex-wrap:wrap;gap:0.75em;padding:0.4em 0.2em 1.5em;}',
            '.iptv-v3__tile{width:140px;background:rgba(255,255,255,0.05);border-radius:0.5em;overflow:hidden;cursor:pointer;transition:background .15s,transform .12s;}',
            '.iptv-v3__tile.focus,.iptv-v3__tile:hover{background:rgba(255,255,255,0.12);transform:scale(1.03);}',
            '.iptv-v3__tile-logo{height:80px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.25);}',
            '.iptv-v3__tile-logo img{max-width:90%;max-height:70px;object-fit:contain;}',
            '.iptv-v3__tile-logo span{font-size:1.6em;opacity:0.35;}',
            '.iptv-v3__tile-name{padding:0.45em 0.5em 0.55em;font-size:0.88em;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
            '.iptv-v3__empty{padding:2em;text-align:center;opacity:0.5;}'
        ].join('');
        var s = document.createElement('style');
        s.id = 'iptv-v3-style';
        s.textContent = css;
        document.head.appendChild(s);
    }

    function MainPanel(object) {
        var html = $('<div class="iptv-v3"></div>');
        var side = $('<div class="iptv-v3__side"></div>');
        var main = $('<div class="iptv-v3__main"></div>');
        var chList = $('<div class="iptv-v3__list selector"></div>');
        var grpList = $('<div class="iptv-v3__side-list selector"></div>');
        var titleEl = $('<div class="iptv-v3__title"></div>');
        var metaEl = $('<div class="iptv-v3__meta"></div>');
        var view = null;
        var channelItems = [];
        var groupItems = [];
        var focusIndex = 0;
        var groupFocus = 0;

        function currentChannels() {
            if (!view) return [];
            if (STATE.activeGroup === '__fav__') {
                return view.all.filter(function (c) { return isFav(c.url); });
            }
            if (STATE.activeGroup === '__all__' || !STATE.activeGroup) {
                return view.all;
            }
            return view.groups[STATE.activeGroup] || [];
        }

        function renderChannels() {
            chList.empty();
            channelItems = [];
            var list = currentChannels();

            titleEl.text(
                STATE.activeGroup === '__fav__' ? '★ Избранное' :
                STATE.activeGroup === '__all__' ? 'Все каналы' :
                (STATE.activeGroup || 'Каналы')
            );
            metaEl.text(list.length + ' каналов' + (gridMode() ? ' · плитки' : ' · список'));

            if (!list.length) {
                chList.append('<div class="iptv-v3__empty">Нет каналов</div>');
                return;
            }

            if (gridMode()) {
                var grid = $('<div class="iptv-v3__grid"></div>');
                list.forEach(function (ch, i) {
                    var logoHtml = ch.logo
                        ? '<img src="' + esc(ch.logo) + '" alt="" onerror="this.parentNode.innerHTML=\'<span>📺</span>\'">'
                        : '<span>📺</span>';
                    var tile = $(
                        '<div class="iptv-v3__tile selector" data-index="' + i + '">' +
                        '<div class="iptv-v3__tile-logo">' + logoHtml + '</div>' +
                        '<div class="iptv-v3__tile-name">' + esc(ch.name) +
                        (isFav(ch.url) ? ' ★' : '') + '</div></div>'
                    );
                    tile.on('hover:enter', function () {
                        playChannel(ch, list);
                    });
                    tile.on('hover:long', function () {
                        toggleFav(ch.url);
                        noty(isFav(ch.url) ? 'В избранное' : 'Убрано из избранного');
                        renderChannels();
                        renderGroups();
                    });
                    grid.append(tile);
                    channelItems.push(tile);
                });
                chList.append(grid);
            } else {
                list.forEach(function (ch, i) {
                    var row = $(
                        '<div class="iptv-v3__ch selector" data-index="' + i + '">' +
                        '<div class="iptv-v3__ch-num">' + (i + 1) + '</div>' +
                        '<div class="iptv-v3__ch-body">' +
                        '<div class="iptv-v3__ch-name">' + esc(ch.name) +
                        (isFav(ch.url) ? '<span class="iptv-v3__ch-fav">★</span>' : '') +
                        '</div>' +
                        '<div class="iptv-v3__ch-epg">' + esc(nowTitle(ch) || ch.group || '') + '</div>' +
                        '</div></div>'
                    );
                    row.on('hover:enter', function () {
                        playChannel(ch, list);
                    });
                    row.on('hover:long', function () {
                        toggleFav(ch.url);
                        noty(isFav(ch.url) ? 'В избранное' : 'Убрано из избранного');
                        renderChannels();
                        renderGroups();
                    });
                    chList.append(row);
                    channelItems.push(row);
                });
            }
        }

        function renderGroups() {
            grpList.empty();
            groupItems = [];
            if (!view) return;

            var items = [];
            var favCount = view.all.filter(function (c) { return isFav(c.url); }).length;

            items.push({ id: '__fav__', title: '★ Избранное', count: favCount });
            items.push({ id: '__all__', title: 'Все каналы', count: view.all.length });

            view.order.forEach(function (g) {
                var lock = view.locked[g] && hasPin();
                items.push({
                    id: g,
                    title: (lock ? '🔒 ' : '') + g,
                    count: (view.groups[g] || []).length
                });
            });

            items.forEach(function (g, i) {
                var active = STATE.activeGroup === g.id ? ' active' : '';
                var row = $(
                    '<div class="iptv-v3__grp selector' + active + '" data-index="' + i + '">' +
                    '<span>' + esc(g.title) + '</span>' +
                    '<span class="iptv-v3__grp-count">' + g.count + '</span></div>'
                );
                row.on('hover:enter', function () {
                    var open = function () {
                        STATE.activeGroup = g.id;
                        sset('iptv_last_group', g.id);
                        renderGroups();
                        renderChannels();
                        STATE.panelFocus = 'channels';
                        focusIndex = 0;
                        applyFocus();
                    };
                    if (g.id !== '__fav__' && g.id !== '__all__' && view.locked[g.id] && hasPin() && !isUnlocked()) {
                        askPin(function (ok) { if (ok) open(); });
                    } else {
                        open();
                    }
                });
                grpList.append(row);
                groupItems.push(row);
            });
        }

        function applyFocus() {
            channelItems.forEach(function (el) { el.removeClass('focus'); });
            groupItems.forEach(function (el) { el.removeClass('focus'); });

            if (STATE.panelFocus === 'channels' && channelItems[focusIndex]) {
                channelItems[focusIndex].addClass('focus');
                try { channelItems[focusIndex][0].scrollIntoView({ block: 'nearest' }); } catch (e) {}
            } else if (STATE.panelFocus === 'groups' && groupItems[groupFocus]) {
                groupItems[groupFocus].addClass('focus');
                try { groupItems[groupFocus][0].scrollIntoView({ block: 'nearest' }); } catch (e) {}
            }
        }

        this.create = function () {
            injectStyle();

            // LEFT: groups
            side.append('<div class="iptv-v3__side-head">Группы</div>');
            side.append(grpList);

            // RIGHT: channels
            var head = $('<div class="iptv-v3__head"></div>');
            head.append(titleEl).append(metaEl);
            main.append(head).append(chList);

            html.append(side).append(main);

            view = buildView();

            var startMode = sget('iptv_start', 'last');
            if (startMode === 'fav') {
                STATE.activeGroup = '__fav__';
            } else if (startMode === 'all') {
                STATE.activeGroup = '__all__';
            } else {
                var last = sget('iptv_last_group', '');
                if (last === '__fav__' || last === '__all__' || (view.groups && view.groups[last])) {
                    STATE.activeGroup = last;
                } else {
                    STATE.activeGroup = (view.order && view.order[0]) || '__all__';
                }
            }

            renderGroups();
            renderChannels();
            return this.render();
        };

        this.start = function () {
            Lampa.Controller.add('content', {
                toggle: function () {
                    Lampa.Controller.collectionSet(html);
                    applyFocus();
                },
                left: function () {
                    // с каналов → в группы (слева)
                    if (STATE.panelFocus === 'channels') {
                        STATE.panelFocus = 'groups';
                        applyFocus();
                    } else {
                        Lampa.Controller.toggle('menu');
                    }
                },
                right: function () {
                    if (STATE.panelFocus === 'groups') {
                        STATE.panelFocus = 'channels';
                        applyFocus();
                    }
                },
                up: function () {
                    if (STATE.panelFocus === 'channels') {
                        if (focusIndex > 0) { focusIndex--; applyFocus(); }
                        else Lampa.Controller.toggle('head');
                    } else {
                        if (groupFocus > 0) { groupFocus--; applyFocus(); }
                        else Lampa.Controller.toggle('head');
                    }
                },
                down: function () {
                    if (STATE.panelFocus === 'channels') {
                        if (focusIndex < channelItems.length - 1) { focusIndex++; applyFocus(); }
                    } else {
                        if (groupFocus < groupItems.length - 1) { groupFocus++; applyFocus(); }
                    }
                },
                enter: function () {
                    if (STATE.panelFocus === 'channels' && channelItems[focusIndex]) {
                        channelItems[focusIndex].trigger('hover:enter');
                    } else if (STATE.panelFocus === 'groups' && groupItems[groupFocus]) {
                        groupItems[groupFocus].trigger('hover:enter');
                    }
                },
                back: function () {
                    Lampa.Activity.backward();
                }
            });
            Lampa.Controller.toggle('content');
        };

        this.pause = function () {};
        this.stop = function () {};
        this.render = function () { return html; };
        this.destroy = function () { html.remove(); };
    }

    /* =====================================================
       Настройки
       ===================================================== */

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
                onChange: fn
            });
        }

        function toggle(name, title, desc, def) {
            Lampa.SettingsApi.addParam({
                component: 'iptv_player',
                param: { name: name, type: 'trigger', default: def },
                field: { name: title, description: desc || '' }
            });
        }

        Lampa.SettingsApi.addParam({
            component: 'iptv_player',
            param: {
                name: 'iptv_start',
                type: 'select',
                values: {
                    last: 'Последняя группа',
                    fav: 'Избранное',
                    all: 'Все каналы'
                },
                default: 'last'
            },
            field: {
                name: 'Открывать при входе',
                description: 'Что показывать сразу при открытии IPTV'
            }
        });

        toggle('iptv_grid', 'Плитки с логотипами', 'Выкл — обычный список. Вкл — плитки', false);

        button('iptv_s_lists', 'Плейлисты', 'Добавить, переключить или удалить', function () {
            showLists(function () {});
        });

        button('iptv_s_epg', 'Программа передач (EPG)', 'По умолчанию: epg.it999.ru', function () {
            var cur = String(sget('iptv_epg_url', '') || '');
            ask('Ссылка на XMLTV (.xml / .xml.gz)', cur || DEFAULT_EPG, function (val) {
                if (val) {
                    sset('iptv_epg_url', val);
                    STATE.epg = null;
                    maybeLoadEpg(true);
                }
            });
        });

        button('iptv_s_epgoff', 'Отключить EPG', '', function () {
            sset('iptv_epg_url', '');
            STATE.epg = null;
            noty('Программа передач отключена');
        });

        toggle('iptv_sort_az', 'Сортировать по алфавиту', 'Выключено — как в плейлисте', false);
        toggle('iptv_retry', 'Автоповтор при обрыве', 'До 3 попыток', true);

        button('iptv_s_proxy', 'CORS-прокси', 'Если плейлист/EPG не грузятся', function () {
            ask('CORS-прокси (префикс)', String(sget('iptv_proxy', '') || ''), function (val) {
                if (val !== null) {
                    sset('iptv_proxy', val || '');
                    STATE.loaded = false;
                }
            });
        });

        button('iptv_s_reload', 'Обновить плейлист и EPG', '', function () {
            STATE.epg = null;
            loadPlaylist(true, function () {
                noty('IPTV: обновлено');
            });
        });
    }

    function showLists(backFn) {
        var lists = getLists();
        var act = activeList();
        var items = lists.map(function (l) {
            return {
                title: (act && act.id === l.id ? '● ' : '') + esc(l.name),
                subtitle: esc(l.url),
                act: 'pick',
                id: l.id,
                name: l.name
            };
        });
        items.push({ title: '+ Добавить плейлист', act: 'add' });
        if (lists.length) items.push({ title: 'Удалить плейлист', act: 'del' });

        selectShow({
            title: 'Плейлисты',
            items: items,
            onBack: backFn,
            onSelect: function (item) {
                if (item.act === 'pick') {
                    sset('iptv_active', item.id);
                    STATE.loaded = false;
                    noty('Активный: ' + item.name);
                    showLists(backFn);
                } else if (item.act === 'add') {
                    addPlaylist(function () { showLists(backFn); });
                } else if (item.act === 'del') {
                    selectShow({
                        title: 'Удалить плейлист?',
                        items: lists.map(function (l) {
                            return { title: esc(l.name), id: l.id };
                        }),
                        onBack: function () { showLists(backFn); },
                        onSelect: function (it) {
                            var rest = getLists().filter(function (l) { return l.id !== it.id; });
                            sset('iptv_lists', rest);
                            if (sget('iptv_active', '') === it.id) sset('iptv_active', rest[0] ? rest[0].id : '');
                            STATE.loaded = false;
                            noty('Удалено');
                            showLists(backFn);
                        }
                    });
                }
            }
        });
    }

    /* =====================================================
       Меню и запуск
       ===================================================== */

    function open() {
        STATE.origin = Lampa.Controller.enabled().name;
        loadPlaylist(false, function () {
            if (!STATE.loaded) {
                noty('Добавьте плейлист в Настройки → IPTV');
                return;
            }
            Lampa.Component.add('iptv_main', MainPanel);
            Lampa.Activity.push({
                url: '',
                title: 'IPTV',
                component: 'iptv_main',
                page: 1
            });
        });
    }

    function addMenuButton() {
        var item = $(
            '<li class="menu__item selector" data-action="iptv_player">' +
            '<div class="menu__ico">' + ICON + '</div>' +
            '<div class="menu__text">IPTV</div></li>'
        );
        item.on('hover:enter', open);
        $('.menu .menu__list').eq(0).append(item);
    }

    function start() {
        try { addSettings(); } catch (e) { console.log('iptv settings', e); }
        try { addMenuButton(); } catch (e) { console.log('iptv menu', e); }
        try { setupPlayerHooks(); } catch (e) { console.log('iptv player', e); }
    }

    if (window.appready) start();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
    }
})();
