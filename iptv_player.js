(function () {
    'use strict';

    /**
     * IPTV для Lampa
     * - Пункт "IPTV" в главном меню
     * - Загрузка M3U/M3U8-плейлиста по ссылке из настроек
     * - Группы, поиск, избранное
     * - Переключение каналов внутри плеера (список группы передаётся как плейлист)
     * - Кэш плейлиста на случай, если ссылка временно недоступна
     *
     * Ссылка на плейлист вводится в самом меню IPTV (без раздела в настройках Lampa).
     */

    if (window.plugin_iptv_player_ready) return;
    window.plugin_iptv_player_ready = true;

    var ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 2l4 4 4-4"/></svg>';

    var PAGE_SIZE = 60;
    var CACHE_LIMIT = 2000000; // символов

    var STATE = { channels: [], groups: {}, groupOrder: [], loaded: false };

    /* ---------- утилиты ---------- */

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function noty(text) {
        try { Lampa.Noty.show(text); } catch (e) {}
    }

    function getFav() {
        var f = Lampa.Storage.get('iptv_fav', []);
        return Array.isArray(f) ? f : [];
    }

    function setFav(arr) {
        Lampa.Storage.set('iptv_fav', arr);
    }

    function isFav(url) {
        return getFav().indexOf(url) !== -1;
    }

    function toggleFav(url) {
        var f = getFav();
        var i = f.indexOf(url);
        if (i === -1) f.push(url); else f.splice(i, 1);
        setFav(f);
        return i === -1;
    }

    function editSetting(key, title, done) {
        if (!(Lampa.Input && Lampa.Input.edit)) {
            noty('IPTV: ввод недоступен в этой версии Lampa');
            return;
        }

        Lampa.Input.edit({
            value: Lampa.Storage.get(key, '') || '',
            free: true,
            title: title
        }, function (value) {
            value = (value || '').trim();
            if (!value) return done(false);
            Lampa.Storage.set(key, value);
            STATE.loaded = false;
            done(true);
        });
    }

    function shorten(str) {
        str = String(str || '');
        return str.length > 50 ? str.substring(0, 47) + '...' : str;
    }

    /* ---------- загрузка и разбор M3U ---------- */

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
                cur = {
                    name: name || 'Без названия',
                    group: g && g[1] ? g[1] : 'Без группы',
                    logo: logo ? logo[1] : ''
                };
            } else if (line.charAt(0) === '#') {
                if (line.indexOf('#EXTGRP:') === 0 && cur) cur.group = line.substring(8).trim() || cur.group;
            } else if (cur) {
                cur.url = line;
                channels.push(cur);
                if (!groups[cur.group]) {
                    groups[cur.group] = [];
                    order.push(cur.group);
                }
                groups[cur.group].push(cur);
                cur = null;
            }
        }

        return { channels: channels, groups: groups, order: order };
    }

    function applyParsed(text) {
        var p = parseM3U(text);
        STATE.channels = p.channels;
        STATE.groups = p.groups;
        STATE.groupOrder = p.order;
        STATE.loaded = p.channels.length > 0;
        return STATE.loaded;
    }

    function buildUrl(url) {
        var proxy = (Lampa.Storage.get('iptv_proxy', '') || '').trim();
        return proxy ? proxy + encodeURIComponent(url) : url;
    }

    function download(url, ok, fail) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', buildUrl(url), true);
        xhr.timeout = 25000;
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) ok(xhr.responseText);
            else fail('HTTP ' + xhr.status);
        };
        xhr.onerror = function () { fail('сеть или CORS'); };
        xhr.ontimeout = function () { fail('таймаут'); };
        xhr.send();
    }

    function loadPlaylist(force, done) {
        var url = (Lampa.Storage.get('iptv_url', '') || '').trim();

        if (!url) {
            return editSetting('iptv_url', 'Ссылка на плейлист (M3U)', function (ok) {
                if (ok) loadPlaylist(true, done);
            });
        }

        if (STATE.loaded && !force) return done();

        noty('IPTV: загрузка плейлиста...');

        download(url, function (text) {
            if (!applyParsed(text)) {
                noty('IPTV: в плейлисте не найдено каналов');
                return;
            }

            try {
                if (text.length < CACHE_LIMIT) Lampa.Storage.set('iptv_cache', text);
            } catch (e) {}

            done();
        }, function (reason) {
            var cached = Lampa.Storage.get('iptv_cache', '');
            if (cached && applyParsed(cached)) {
                noty('IPTV: не удалось обновить (' + reason + '), открыта сохранённая копия');
                done();
            } else {
                noty('IPTV: ошибка загрузки (' + reason + '). Проверьте ссылку или CORS-прокси (пункты внизу списка IPTV)');
            }
        });
    }

    /* ---------- интерфейс ---------- */

    function playChannel(list, index) {
        var playlist = list.map(function (c) {
            return { title: c.name, url: c.url, iptv: true };
        });

        try {
            Lampa.Player.play(playlist[index]);
            Lampa.Player.playlist(playlist);
        } catch (e) {
            noty('IPTV: не удалось запустить плеер');
        }
    }

    function showChannels(title, list, page, editMode, backFn) {
        var enabled = Lampa.Controller.enabled().name;
        var total = Math.ceil(list.length / PAGE_SIZE) || 1;
        var start = page * PAGE_SIZE;
        var slice = list.slice(start, start + PAGE_SIZE);
        var items = [];

        if (page > 0) items.push({ title: '◂ Назад', nav: -1 });

        slice.forEach(function (c, i) {
            items.push({
                title: (isFav(c.url) ? '★ ' : '') + esc(c.name),
                subtitle: esc(c.group),
                channel: c,
                index: start + i
            });
        });

        if (page < total - 1) items.push({ title: 'Далее ▸', nav: 1 });

        if (!items.length) {
            noty('IPTV: каналов нет');
            return backFn ? backFn() : Lampa.Controller.toggle(enabled);
        }

        Lampa.Select.show({
            title: esc(title) + (total > 1 ? ' (' + (page + 1) + '/' + total + ')' : '') + (editMode ? ' — избранное' : ''),
            items: items,
            onBack: function () {
                if (backFn) backFn(); else Lampa.Controller.toggle(enabled);
            },
            onSelect: function (item) {
                if (item.nav) {
                    return showChannels(title, list, page + item.nav, editMode, backFn);
                }

                if (editMode) {
                    var added = toggleFav(item.channel.url);
                    noty(added ? 'Добавлено в избранное' : 'Удалено из избранного');
                    return showChannels(title, list, page, editMode, backFn);
                }

                playChannel(list, item.index);
            }
        });
    }

    function search(backFn) {
        if (!(Lampa.Input && Lampa.Input.edit)) {
            noty('IPTV: поиск недоступен в этой версии Lampa');
            return backFn();
        }

        Lampa.Input.edit({ value: '', free: true, title: 'Поиск канала' }, function (value) {
            var q = (value || '').trim().toLowerCase();
            if (!q) return backFn();

            var found = STATE.channels.filter(function (c) {
                return c.name.toLowerCase().indexOf(q) !== -1;
            });

            if (!found.length) {
                noty('IPTV: ничего не найдено');
                return backFn();
            }

            showChannels('Поиск: ' + value, found, 0, false, backFn);
        });
    }

    function showGroups() {
        var enabled = Lampa.Controller.enabled().name;
        var favCount = STATE.channels.filter(function (c) { return isFav(c.url); }).length;

        var items = [
            { title: '★ Избранное', subtitle: favCount + ' каналов', act: 'fav' },
            { title: 'Все каналы', subtitle: STATE.channels.length + ' каналов', act: 'all' },
            { title: 'Поиск', act: 'search' }
        ];

        STATE.groupOrder.forEach(function (g) {
            items.push({ title: esc(g), subtitle: STATE.groups[g].length + ' каналов', act: 'group', group: g });
        });

        items.push({ title: 'Изменить избранное', act: 'edit' });
        items.push({ title: 'Обновить плейлист', act: 'reload' });
        items.push({ title: 'Ссылка на плейлист', subtitle: esc(shorten(Lampa.Storage.get('iptv_url', ''))), act: 'set_url' });

        var proxy = Lampa.Storage.get('iptv_proxy', '');
        items.push({ title: 'CORS-прокси', subtitle: proxy ? esc(shorten(proxy)) : 'не задан', act: 'set_proxy' });
        if (proxy) items.push({ title: 'Сбросить CORS-прокси', act: 'clear_proxy' });

        Lampa.Select.show({
            title: 'IPTV',
            items: items,
            onBack: function () {
                Lampa.Controller.toggle(enabled);
            },
            onSelect: function (item) {
                var back = showGroups;

                if (item.act === 'fav') {
                    var favs = STATE.channels.filter(function (c) { return isFav(c.url); });
                    if (!favs.length) {
                        noty('Избранное пусто. Добавьте каналы через «Изменить избранное»');
                        return showGroups();
                    }
                    showChannels('Избранное', favs, 0, false, back);
                } else if (item.act === 'all') {
                    showChannels('Все каналы', STATE.channels, 0, false, back);
                } else if (item.act === 'search') {
                    search(back);
                } else if (item.act === 'group') {
                    showChannels(item.group, STATE.groups[item.group], 0, false, back);
                } else if (item.act === 'edit') {
                    showChannels('Все каналы', STATE.channels, 0, true, back);
                } else if (item.act === 'reload') {
                    loadPlaylist(true, showGroups);
                } else if (item.act === 'set_url') {
                    editSetting('iptv_url', 'Ссылка на плейлист (M3U)', function (ok) {
                        if (ok) loadPlaylist(true, showGroups); else showGroups();
                    });
                } else if (item.act === 'set_proxy') {
                    editSetting('iptv_proxy', 'CORS-прокси (префикс адреса)', function () {
                        showGroups();
                    });
                } else if (item.act === 'clear_proxy') {
                    Lampa.Storage.set('iptv_proxy', '');
                    STATE.loaded = false;
                    noty('CORS-прокси сброшен');
                    showGroups();
                }
            }
        });
    }

    function open() {
        loadPlaylist(false, showGroups);
    }

    /* ---------- меню и настройки ---------- */

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
    }

    if (window.appready) start();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
    }
})();
