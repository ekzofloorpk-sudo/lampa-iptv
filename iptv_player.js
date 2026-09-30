(function () {
    'use strict';

    /**
     * IPTV для Lampa, версия 2
     *
     * - Несколько плейлистов (M3U/M3U8) с переключением
     * - Программа передач (XMLTV): "сейчас идёт" в списках и в названии в плеере
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
     * Все настройки находятся внутри пункта "IPTV" (раздела в настройках Lampa нет).
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
    var EPG_MAX_CHARS = 80000000;
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

    function parseEpg(text) {
        var now = Date.now();
        var from = now - 2 * 3600 * 1000;
        var to = now + 36 * 3600 * 1000;
        var names = {};
        var progs = {};
        var m;

        var chRe = /<channel\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g;
        while ((m = chRe.exec(text)) !== null) {
            var dnRe = /<display-name[^>]*>([^<]*)<\/display-name>/g;
            var d;
            while ((d = dnRe.exec(m[2])) !== null) {
                var key = norm(decodeEntities(d[1]));
                if (key && !names[key]) names[key] = m[1];
            }
        }

        var pRe = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g;
        while ((m = pRe.exec(text)) !== null) {
            var st = /start="([^"]+)"/.exec(m[1]);
            var en = /stop="([^"]+)"/.exec(m[1]);
            var ch = /channel="([^"]*)"/.exec(m[1]);
            if (!st || !en || !ch) continue;

            var s = parseXmltvTime(st[1]);
            var e = parseXmltvTime(en[1]);
            if (!s || !e || e < from || s > to) continue;

            var ti = /<title[^>]*>([^<]*)<\/title>/.exec(m[2]);
            if (!ti) continue;

            if (!progs[ch[1]]) progs[ch[1]] = [];
            progs[ch[1]].push([s, e, decodeEntities(ti[1]).trim()]);
        }

        Object.keys(progs).forEach(function (k) {
            progs[k].sort(function (a, b) { return a[0] - b[0]; });
        });

        return { progs: progs, names: names, t: now };
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

        download(url, function (text) {
            STATE.epgLoading = false;

            if (text.length > EPG_MAX_CHARS || text.indexOf('<tv') === -1) {
                noty('IPTV: программа передач не прочитана (нужен несжатый XMLTV-файл)');
                return;
            }

            try {
                STATE.epg = parseEpg(text);
                var size = JSON.stringify(STATE.epg).length;
                if (size < 1500000) sset('iptv_epg', STATE.epg);
                noty('IPTV: программа передач обновлена');
            } catch (e) {
                noty('IPTV: ошибка разбора программы передач');
            }
        }, function (reason) {
            STATE.epgLoading = false;
            noty('IPTV: программа передач недоступна (' + reason + ')');
        });
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
        var sortAz = sget('iptv_sort', 'list') === 'az';

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

        if (sortAz) {
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
                    noty('Канал скрыт (вернуть: Управление → Показать скрытые каналы)');
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
        if (sget('iptv_view', 'list') === 'grid' && STATE.gridOk) {
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
        items.push({ title: 'Управление', subtitle: esc((activeList() || {}).name || ''), act: 'manage' });

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
                        noty('Избранное пусто. Добавьте каналы: Управление → Изменить каналы');
                        return showGroups();
                    }
                    openChannels('Избранное', favs, w);
                } else if (item.act === 'all') {
                    openChannels('Все каналы', v.all, w);
                } else if (item.act === 'search') {
                    search(w);
                } else if (item.act === 'manage') {
                    if (hasPin()) {
                        askPin(function (ok) { if (ok) showManage(); else showGroups(); });
                    } else {
                        showManage();
                    }
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

    function showManage() {
        var act = activeList();
        var epgUrl = String(sget('iptv_epg_url', '') || '');
        var proxy = String(sget('iptv_proxy', '') || '');
        var hiddenCount = (sget('iptv_hidden', []) || []).length;

        var items = [
            { title: 'Плейлисты', subtitle: esc(act ? act.name : 'не добавлены'), act: 'lists' },
            { title: 'Вид: ' + (sget('iptv_view', 'list') === 'grid' ? 'плитки' : 'список'),
              subtitle: STATE.gridOk ? 'нажмите, чтобы переключить' : 'плитки недоступны в этой версии Lampa', act: 'view' },
            { title: 'Сортировка: ' + (sget('iptv_sort', 'list') === 'az' ? 'по алфавиту' : 'как в плейлисте'), act: 'sort' },
            { title: 'Изменить каналы', subtitle: 'избранное, скрыть, переименовать', act: 'edit' },
            { title: 'Скрытые группы', act: 'hidegroups' },
            { title: 'Показать скрытые каналы', subtitle: hiddenCount + ' скрыто', act: 'unhide' },
            { title: 'Программа передач (EPG)', subtitle: epgUrl ? esc(shorten(epgUrl)) : 'не задана', act: 'epg' },
            { title: 'PIN-код на группы', subtitle: hasPin() ? 'установлен' : 'не установлен', act: 'pin' },
            { title: 'Резервная копия', subtitle: 'экспорт и импорт', act: 'backup' },
            { title: 'CORS-прокси', subtitle: proxy ? esc(shorten(proxy)) : 'не задан', act: 'proxy' },
            { title: 'Обновить плейлист и программу', act: 'reload' }
        ];

        if (epgUrl) items.push({ title: 'Отключить программу передач', act: 'epgoff' });
        if (proxy) items.push({ title: 'Сбросить CORS-прокси', act: 'proxyoff' });
        if (window.plugin_sleep_timer_api) items.splice(items.length - 1, 0, { title: 'Таймер сна', act: 'sleep' });

        Lampa.Select.show({
            title: 'Управление IPTV',
            items: items,
            onBack: showGroups,
            onSelect: function (item) {
                var m = showManage;

                if (item.act === 'lists') showLists(m);
                else if (item.act === 'view') {
                    if (!STATE.gridOk) { noty('Плитки недоступны: в этой версии Lampa нет нужных функций'); return m(); }
                    sset('iptv_view', sget('iptv_view', 'list') === 'grid' ? 'list' : 'grid');
                    m();
                } else if (item.act === 'sort') {
                    sset('iptv_sort', sget('iptv_sort', 'list') === 'az' ? 'list' : 'az');
                    m();
                } else if (item.act === 'edit') {
                    var v = buildView();
                    showChannels('Все каналы', v.all, 0, true, m);
                } else if (item.act === 'hidegroups') {
                    showGroupToggles('iptv_hidden_groups', 'Скрытые группы', m, null);
                } else if (item.act === 'unhide') {
                    sset('iptv_hidden', []);
                    noty('Скрытые каналы возвращены');
                    m();
                } else if (item.act === 'epg') {
                    ask('Ссылка на XMLTV (несжатый .xml)', epgUrl, function (val) {
                        if (val) {
                            sset('iptv_epg_url', val);
                            STATE.epg = null;
                            maybeLoadEpg(true);
                        }
                        m();
                    });
                } else if (item.act === 'epgoff') {
                    sset('iptv_epg_url', '');
                    sset('iptv_epg', null);
                    STATE.epg = null;
                    noty('Программа передач отключена');
                    m();
                } else if (item.act === 'pin') {
                    showPinMenu(m);
                } else if (item.act === 'backup') {
                    showBackup(m);
                } else if (item.act === 'proxy') {
                    ask('CORS-прокси (префикс адреса)', proxy, function (val) {
                        if (val) { sset('iptv_proxy', val); STATE.loaded = false; }
                        m();
                    });
                } else if (item.act === 'proxyoff') {
                    sset('iptv_proxy', '');
                    STATE.loaded = false;
                    noty('CORS-прокси сброшен');
                    m();
                } else if (item.act === 'reload') {
                    STATE.epg = null;
                    loadPlaylist(true, showGroups);
                } else if (item.act === 'sleep') {
                    setTimeout(function () {
                        try { window.plugin_sleep_timer_api.open(); } catch (e) { noty('Таймер сна недоступен'); }
                    }, 100);
                }
            }
        });
    }

    function showLists(backFn) {
        var lists = getLists();
        var act = activeList();
        var items = lists.map(function (l) {
            return { title: (act && act.id === l.id ? '● ' : '') + esc(l.name), subtitle: esc(shorten(l.url)), act: 'pick', id: l.id };
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
                    loadPlaylist(false, showGroups);
                } else if (item.act === 'add') {
                    addPlaylist(function (ok) {
                        if (ok) loadPlaylist(true, showGroups); else showLists(backFn);
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
                    if (hasPin()) askPin(function (ok) { if (ok) change(); else self(); });
                    else change();
                } else if (item.act === 'groups') {
                    showGroupToggles('iptv_locked', 'Закрытые группы (нужен PIN)', self, null);
                } else if (item.act === 'del') {
                    askPin(function (ok) {
                        if (ok) { sset('iptv_pin', ''); noty('PIN удалён'); }
                        self();
                    });
                }
            }
        });
    }

    /* ---- резервная копия ---- */

    var BACKUP_KEYS = ['iptv_lists', 'iptv_active', 'iptv_fav', 'iptv_hidden', 'iptv_hidden_groups',
        'iptv_names', 'iptv_locked', 'iptv_sort', 'iptv_view', 'iptv_epg_url', 'iptv_proxy'];

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
