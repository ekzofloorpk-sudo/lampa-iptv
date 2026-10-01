(function () {
    'use strict';

    /*
     * Lampa IPTV Player
     * File: iptv_player.js
     * Version: 1.0.0
     *
     * Features:
     *  - M3U / M3U8 playlists
     *  - Multiple playlists
     *  - XMLTV EPG, including .xml.gz when the WebView supports DecompressionStream
     *  - EPG matching by tvg-id and normalized channel name
     *  - Groups, favorites, recent channels and search
     *  - TV-style channel list
     *  - Current/next programme and progress
     *  - Lampa Player integration
     *  - IPTV settings inside Lampa settings
     *  - LocalStorage persistence
     *
     * No external libraries are required.
     */

    var PLUGIN_ID = 'iptv_player';
    var VERSION = '1.0.0';

    var STORAGE = {
        playlists: 'iptv_player_playlists_v1',
        epg_url: 'iptv_player_epg_url_v1',
        epg_mode: 'iptv_player_epg_mode_v1',
        epg_refresh: 'iptv_player_epg_refresh_v1',
        show_logo: 'iptv_player_show_logo_v1',
        show_epg: 'iptv_player_show_epg_v1',
        show_progress: 'iptv_player_show_progress_v1',
        remember_channel: 'iptv_player_remember_channel_v1',
        last_channel: 'iptv_player_last_channel_v1',
        favorites: 'iptv_player_favorites_v1',
        recent: 'iptv_player_recent_v1',
        cache: 'iptv_player_cache_v1',
        last_epg: 'iptv_player_last_epg_v1'
    };

    var state = {
        playlists: [],
        channels: [],
        groups: [],
        filtered: [],
        currentGroup: 'Все каналы',
        search: '',
        epg: {},
        epgChannels: {},
        epgLoaded: false,
        loading: false
    };

    function storageGet(key, fallback) {
        try {
            var value = Lampa.Storage.get(key);
            return value === undefined || value === null ? fallback : value;
        } catch (e) {
            try {
                var value2 = localStorage.getItem(key);
                return value2 === null ? fallback : JSON.parse(value2);
            } catch (e2) {
                return fallback;
            }
        }
    }

    function storageSet(key, value) {
        try {
            Lampa.Storage.set(key, value);
        } catch (e) {
            try { localStorage.setItem(key, JSON.stringify(value)); } catch (e2) {}
        }
    }

    function notify(text) {
        try {
            if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(text);
        } catch (e) {}
    }

    function esc(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function normalize(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/[«»"'`]/g, '')
            .replace(/[^a-zа-я0-9]+/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function hash(text) {
        var h = 0, i;
        text = String(text || '');
        for (i = 0; i < text.length; i++) h = ((h << 5) - h) + text.charCodeAt(i) | 0;
        return String(Math.abs(h));
    }

    function parseBool(v, def) {
        if (v === true || v === false) return v;
        if (v === 'true') return true;
        if (v === 'false') return false;
        return def;
    }

    function absUrl(url, base) {
        if (!url) return '';
        try { return new URL(url, base).href; } catch (e) { return url; }
    }

    function attr(line, name) {
        var re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*"([^"]*)"', 'i');
        var m = line.match(re);
        if (!m) {
            re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "\\s*=\\s*'([^']*)'", 'i');
            m = line.match(re);
        }
        return m ? m[1] : '';
    }

    function parseM3U(text, playlist) {
        var lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
        var result = [];
        var current = null;
        var i;

        for (i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            if (/^#EXTINF/i.test(line)) {
                var comma = line.indexOf(',');
                var title = comma >= 0 ? line.substring(comma + 1).trim() : 'Без названия';

                current = {
                    id: attr(line, 'tvg-id') || '',
                    name: attr(line, 'tvg-name') || title,
                    title: title,
                    logo: attr(line, 'tvg-logo') || '',
                    group: attr(line, 'group-title') || 'Без группы',
                    language: attr(line, 'tvg-language') || '',
                    country: attr(line, 'tvg-country') || '',
                    url: '',
                    playlistId: playlist.id,
                    playlistName: playlist.name,
                    catchup: attr(line, 'catchup') || '',
                    catchupDays: attr(line, 'catchup-days') || '',
                    catchupSource: attr(line, 'catchup-source') || '',
                    headers: {}
                };

                var tvgUrl = attr(line, 'tvg-url');
                if (tvgUrl && !state.epg.urlFromPlaylist) state.epg.urlFromPlaylist = tvgUrl;
                continue;
            }

            if (/^#EXTVLCOPT:/i.test(line) && current) {
                var opt = line.substring(line.indexOf(':') + 1);
                var p = opt.indexOf('=');
                if (p > 0) current.headers[opt.substring(0, p).trim()] = opt.substring(p + 1).trim();
                continue;
            }

            if (/^#KODIPROP:/i.test(line) && current) continue;
            if (line.charAt(0) === '#') continue;

            if (current) {
                current.url = absUrl(line, playlist.url);
                current.uid = hash((current.id || '') + '|' + current.name + '|' + current.url);
                result.push(current);
                current = null;
            }
        }

        return result;
    }

    function fetchText(url, callback, error) {
        var req;
        try {
            req = new Lampa.Reguest();
            req.native(url, function (data) {
                callback(typeof data === 'string' ? data : String(data || ''));
            }, error || function () {});
            return;
        } catch (e) {}

        fetch(url, { credentials: 'omit' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.text();
            })
            .then(callback)
            .catch(error || function () {});
    }

    function fetchBinary(url, callback, error) {
        fetch(url, { credentials: 'omit' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .then(callback)
            .catch(error || function () {});
    }

    function decodeUtf8(buffer) {
        try { return new TextDecoder('utf-8').decode(buffer); } catch (e) {
            var bytes = new Uint8Array(buffer), out = '', i;
            for (i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
            return decodeURIComponent(escape(out));
        }
    }

    function parseXmltv(text) {
        var xml = new DOMParser().parseFromString(text, 'text/xml');
        var result = { channels: {}, programs: {} };

        var channelNodes = xml.getElementsByTagName('channel');
        var i;
        for (i = 0; i < channelNodes.length; i++) {
            var c = channelNodes[i];
            var id = c.getAttribute('id') || '';
            if (!id) continue;
            var dn = c.getElementsByTagName('display-name');
            var name = dn.length ? dn[0].textContent : id;
            var icon = c.getElementsByTagName('icon');
            result.channels[id] = {
                id: id,
                name: String(name || id).trim(),
                logo: icon.length ? (icon[0].getAttribute('src') || '') : ''
            };
        }

        var programmes = xml.getElementsByTagName('programme');
        for (i = 0; i < programmes.length; i++) {
            var p = programmes[i];
            var cid = p.getAttribute('channel') || '';
            if (!cid) continue;

            var start = parseXmltvDate(p.getAttribute('start'));
            var stop = parseXmltvDate(p.getAttribute('stop'));
            if (!start) continue;

            var titleNode = p.getElementsByTagName('title');
            var descNode = p.getElementsByTagName('desc');

            var item = {
                start: start,
                stop: stop || start + 3600000,
                title: titleNode.length ? String(titleNode[0].textContent || '').trim() : '',
                desc: descNode.length ? String(descNode[0].textContent || '').trim() : ''
            };

            if (!result.programs[cid]) result.programs[cid] = [];
            result.programs[cid].push(item);
        }

        Object.keys(result.programs).forEach(function (id) {
            result.programs[id].sort(function (a, b) { return a.start - b.start; });
        });

        return result;
    }

    function parseXmltvDate(value) {
        if (!value) return 0;
        var m = String(value).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/);
        if (!m) return Date.parse(value) || 0;

        var y = +m[1], mo = +m[2] - 1, d = +m[3], h = +m[4], mi = +m[5], s = +m[6];
        if (m[7]) {
            var utc = Date.UTC(y, mo, d, h, mi, s);
            var off = (+m[8] * 60) + (+m[9] * 60);
            return utc + (m[7] === '+' ? -off * 60000 : off * 60000);
        }
        return new Date(y, mo, d, h, mi, s).getTime();
    }

    function loadGzip(url, callback, error) {
        if (typeof DecompressionStream !== 'undefined') {
            fetch(url, { credentials: 'omit' }).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.body.pipeThrough(new DecompressionStream('gzip'));
            }).then(function (stream) {
                return new Response(stream).arrayBuffer();
            }).then(function (buffer) {
                callback(decodeUtf8(buffer));
            }).catch(error || function () {});
            return;
        }

        if (window.pako && pako.ungzip) {
            fetch(url, { credentials: 'omit' }).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.arrayBuffer();
            }).then(function (buffer) {
                callback(pako.ungzip(new Uint8Array(buffer), { to: 'string' }));
            }).catch(error || function () {});
            return;
        }

        (error || function () {})(new Error('В этой версии WebView нет поддержки gzip. Используйте XML без gzip или WebView с DecompressionStream.'));
    }

    function loadEpg(url, callback) {
        if (!url) {
            callback(false, 'URL EPG не задан');
            return;
        }

        var cached = storageGet(STORAGE.cache, null);
        var cachedTime = storageGet(STORAGE.last_epg, 0);
        var refreshHours = +(storageGet(STORAGE.epg_refresh, '6') || 6);

        if (cached && cachedTime && Date.now() - cachedTime < refreshHours * 3600000) {
            try {
                state.epg = JSON.parse(cached);
                state.epgLoaded = true;
                callback(true, 'EPG загружен из кэша');
                return;
            } catch (e) {}
        }

        var done = function (text) {
            try {
                var parsed = parseXmltv(text);
                state.epg = parsed;
                state.epgLoaded = true;
                try {
                    storageSet(STORAGE.cache, JSON.stringify(parsed));
                    storageSet(STORAGE.last_epg, Date.now());
                } catch (e) {}
                callback(true, 'EPG загружен: ' + Object.keys(parsed.channels).length + ' каналов');
            } catch (e2) {
                callback(false, 'Ошибка разбора EPG: ' + e2.message);
            }
        };

        var fail = function (e) { callback(false, 'Не удалось загрузить EPG: ' + (e && e.message ? e.message : 'ошибка сети')); };

        if (/\.gz(?:\?|$)/i.test(url)) loadGzip(url, done, fail);
        else fetchText(url, done, fail);
    }

    function loadPlaylists(done) {
        var list = storageGet(STORAGE.playlists, []);
        if (!Array.isArray(list)) list = [];

        state.playlists = list;
        state.channels = [];
        state.epg.urlFromPlaylist = '';

        if (!list.length) {
            done(false, 'Нет настроенных плейлистов');
            return;
        }

        var left = list.length;
        var loaded = 0;

        list.forEach(function (pl) {
            if (!pl.url) {
                if (--left === 0) done(loaded > 0, 'Загружено каналов: ' + state.channels.length);
                return;
            }

            fetchText(pl.url, function (text) {
                var parsed = parseM3U(text, pl);
                state.channels = state.channels.concat(parsed);
                loaded++;
                if (--left === 0) {
                    buildGroups();
                    done(loaded > 0, 'Загружено каналов: ' + state.channels.length);
                }
            }, function () {
                if (--left === 0) {
                    buildGroups();
                    done(loaded > 0, 'Плейлисты загружены частично');
                }
            });
        });
    }

    function buildGroups() {
        var map = {}, groups = ['Все каналы', 'Избранное', 'Недавние'];
        state.channels.forEach(function (c) {
            var g = c.group || 'Без группы';
            map[g] = true;
        });
        Object.keys(map).sort(function (a, b) {
            return a.localeCompare(b, 'ru');
        }).forEach(function (g) { groups.push(g); });
        state.groups = groups;
    }

    function favorites() {
        var f = storageGet(STORAGE.favorites, []);
        return Array.isArray(f) ? f : [];
    }

    function isFavorite(channel) {
        return favorites().indexOf(channel.uid) >= 0;
    }

    function toggleFavorite(channel) {
        var f = favorites(), i = f.indexOf(channel.uid);
        if (i >= 0) f.splice(i, 1);
        else f.push(channel.uid);
        storageSet(STORAGE.favorites, f);
    }

    function addRecent(channel) {
        var list = storageGet(STORAGE.recent, []);
        if (!Array.isArray(list)) list = [];
        list = list.filter(function (id) { return id !== channel.uid; });
        list.unshift(channel.uid);
        storageSet(STORAGE.recent, list.slice(0, 30));
        storageSet(STORAGE.last_channel, channel.uid);
    }

    function recentChannels() {
        var ids = storageGet(STORAGE.recent, []);
        if (!Array.isArray(ids)) ids = [];
        return ids.map(function (id) {
            return state.channels.filter(function (c) { return c.uid === id; })[0];
        }).filter(Boolean);
    }

    function channelMatches(channel, q) {
        var s = normalize(q);
        if (!s) return true;
        return normalize(channel.name).indexOf(s) >= 0 ||
            normalize(channel.title).indexOf(s) >= 0 ||
            normalize(channel.group).indexOf(s) >= 0 ||
            normalize(channel.id).indexOf(s) >= 0;
    }

    function getVisibleChannels() {
        var list;

        if (state.currentGroup === 'Избранное') {
            list = state.channels.filter(isFavorite);
        } else if (state.currentGroup === 'Недавние') {
            list = recentChannels();
        } else if (state.currentGroup === 'Все каналы') {
            list = state.channels.slice();
        } else {
            list = state.channels.filter(function (c) { return c.group === state.currentGroup; });
        }

        if (state.search) list = list.filter(function (c) { return channelMatches(c, state.search); });
        return list;
    }

    function epgForChannel(channel) {
        if (!state.epg || !state.epg.programs) return [];
        var programs = [];

        if (channel.id && state.epg.programs[channel.id]) programs = state.epg.programs[channel.id].slice();

        if (!programs.length) {
            var target = normalize(channel.name || channel.title);
            var id = Object.keys(state.epg.channels || {}).filter(function (k) {
                return normalize(state.epg.channels[k].name) === target;
            })[0];
            if (id && state.epg.programs[id]) programs = state.epg.programs[id].slice();
        }

        if (!programs.length) {
            var target2 = normalize(channel.name || channel.title);
            var keys = Object.keys(state.epg.channels || {});
            for (var i = 0; i < keys.length; i++) {
                var n = normalize(state.epg.channels[keys[i]].name);
                if (target2 && (n.indexOf(target2) >= 0 || target2.indexOf(n) >= 0)) {
                    programs = state.epg.programs[keys[i]] || [];
                    if (programs.length) break;
                }
            }
        }

        return programs;
    }

    function currentProgram(channel) {
        var now = Date.now(), p = epgForChannel(channel);
        for (var i = 0; i < p.length; i++) {
            if (now >= p[i].start && now < p[i].stop) return p[i];
        }
        return null;
    }

    function nextProgram(channel) {
        var now = Date.now(), p = epgForChannel(channel);
        for (var i = 0; i < p.length; i++) if (p[i].start > now) return p[i];
        return null;
    }

    function formatTime(ts) {
        if (!ts) return '--:--';
        var d = new Date(ts);
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }

    function progress(p) {
        if (!p || p.stop <= p.start) return 0;
        return Math.max(0, Math.min(100, ((Date.now() - p.start) / (p.stop - p.start)) * 100));
    }

    function player(channel) {
        if (!channel || !channel.url) return;

        addRecent(channel);

        try {
            if (Lampa.Player && Lampa.Player.play) {
                Lampa.Player.play({
                    url: channel.url,
                    title: channel.name || channel.title,
                    quality: 'auto'
                });
                return;
            }
        } catch (e) {}

        try {
            window.location.href = channel.url;
        } catch (e2) {}
    }

    function styles() {
        if (document.getElementById('iptv-player-style')) return;
        var style = document.createElement('style');
        style.id = 'iptv-player-style';
        style.innerHTML =
            '.iptv-root{padding:1.5em 3em 4em;color:#fff;min-height:100%;box-sizing:border-box}' +
            '.iptv-head{display:flex;align-items:center;gap:1em;margin-bottom:1.2em}' +
            '.iptv-title{font-size:2em;font-weight:600;flex:1}' +
            '.iptv-search{background:rgba(255,255,255,.1);border-radius:.5em;padding:.6em 1em;min-width:16em;color:#fff}' +
            '.iptv-groups{display:flex;gap:.6em;overflow:hidden;margin-bottom:1em}' +
            '.iptv-group{padding:.65em 1em;border-radius:.5em;background:rgba(255,255,255,.07);white-space:nowrap}' +
            '.iptv-group.focus,.iptv-card.focus{background:rgba(255,255,255,.18)}' +
            '.iptv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:.7em}' +
            '.iptv-card{display:flex;align-items:center;gap:.8em;padding:.8em;border-radius:.55em;background:rgba(255,255,255,.055);min-height:5em;box-sizing:border-box}' +
            '.iptv-logo{width:4em;height:4em;object-fit:contain;background:rgba(255,255,255,.06);border-radius:.4em;flex:none}' +
            '.iptv-logo-empty{width:4em;height:4em;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);border-radius:.4em;flex:none;font-size:1.5em}' +
            '.iptv-info{min-width:0;flex:1}.iptv-name{font-size:1.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.iptv-meta{font-size:.78em;opacity:.55;margin-top:.3em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
            '.iptv-progress{height:3px;background:rgba(255,255,255,.15);margin-top:.5em;border-radius:3px;overflow:hidden}' +
            '.iptv-progress i{display:block;height:100%;background:currentColor}' +
            '.iptv-star{font-size:1.4em;opacity:.8}' +
            '.iptv-empty{padding:4em;text-align:center;opacity:.6}' +
            '@media(max-width:700px){.iptv-root{padding:1em}.iptv-grid{grid-template-columns:1fr 1fr}.iptv-search{min-width:7em}}';
        document.head.appendChild(style);
    }

    function component(object) {
        var self = this;
        var activity = object.activity;
        var root, grid, groupsBox, searchInput;

        this.create = function () {
            styles();
            root = $('<div class="iptv-root"></div>');
            root.append('<div class="iptv-head"><div class="iptv-title">IPTV</div><input class="iptv-search" placeholder="Поиск канала..." /></div>');
            groupsBox = $('<div class="iptv-groups"></div>');
            grid = $('<div class="iptv-grid"></div>');
            root.append(groupsBox).append(grid);

            searchInput = root.find('.iptv-search');
            searchInput.on('input', function () {
                state.search = $(this).val();
                render();
            });

            activity.body().append(root);
            render();

            if (!state.channels.length) refresh();
        };

        function renderGroups() {
            groupsBox.empty();
            state.groups.forEach(function (g) {
                var b = $('<div class="selector iptv-group"></div>').text(g);
                if (g === state.currentGroup) b.addClass('focus');
                b.on('hover:enter', function () {
                    state.currentGroup = g;
                    render();
                });
                groupsBox.append(b);
            });
        }

        function render() {
            if (!grid) return;
            renderGroups();
            grid.empty();

            var list = getVisibleChannels();
            if (!list.length) {
                grid.append('<div class="iptv-empty">Каналы не найдены</div>');
                return;
            }

            list.forEach(function (channel) {
                var p = currentProgram(channel);
                var next = nextProgram(channel);
                var showEpg = parseBool(storageGet(STORAGE.show_epg, true), true);
                var showProgress = parseBool(storageGet(STORAGE.show_progress, true), true);
                var showLogo = parseBool(storageGet(STORAGE.show_logo, true), true);

                var logo = showLogo && channel.logo ?
                    '<img class="iptv-logo" src="' + esc(channel.logo) + '" onerror="this.style.display=\'none\'">' :
                    '<div class="iptv-logo-empty">TV</div>';

                var epgText = '';
                if (showEpg && p) {
                    epgText = '<div class="iptv-meta">' + esc(formatTime(p.start) + '  ' + p.title) +
                        (next ? ' · Далее: ' + esc(next.title) : '') + '</div>';
                    if (showProgress) epgText += '<div class="iptv-progress"><i style="width:' + progress(p) + '%"></i></div>';
                } else {
                    epgText = '<div class="iptv-meta">' + esc(channel.group || 'Без группы') + '</div>';
                }

                var star = isFavorite(channel) ? '★' : '☆';
                var card = $('<div class="selector iptv-card">' + logo +
                    '<div class="iptv-info"><div class="iptv-name">' + esc(channel.name || channel.title) + '</div>' +
                    epgText + '</div><div class="iptv-star">' + star + '</div></div>');

                card.on('hover:enter', function () { player(channel); });
                card.on('hover:long', function () {
                    toggleFavorite(channel);
                    render();
                });
                card.on('contextmenu', function (e) {
                    e.preventDefault();
                    toggleFavorite(channel);
                    render();
                });

                grid.append(card);
            });
        }

        function refresh() {
            activity.loader(true);
            loadPlaylists(function (ok, msg) {
                activity.loader(false);
                if (msg) notify(msg);

                var epgUrl = storageGet(STORAGE.epg_url, '');
                var mode = storageGet(STORAGE.epg_mode, 'custom');

                if (mode === 'playlist' && state.epg.urlFromPlaylist) epgUrl = state.epg.urlFromPlaylist;
                if (mode === 'custom' && epgUrl) {
                    loadEpg(epgUrl, function (epgOk, epgMsg) {
                        if (epgMsg) notify(epgMsg);
                        render();
                    });
                } else {
                    render();
                }
            });
        }

        this.destroy = function () {
            if (root) root.remove();
        };
    }

    function addSettings() {
        if (!Lampa.SettingsApi) return;

        var component = PLUGIN_ID;

        Lampa.SettingsApi.addComponent({
            component: component,
            name: 'IPTV',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="13" rx="2"/><path d="M8 21h8M12 18v3M8 9l4 2.5L8 14V9z"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: 'iptv_playlist_1', type: 'input', values: '', default: '' },
            field: { name: 'M3U URL', description: 'Ссылка на IPTV-плейлист M3U/M3U8. Для нескольких плейлистов добавьте URL через разделитель |' },
            onChange: function (value) {
                var urls = String(value || '').split('|').map(function (x) { return x.trim(); }).filter(Boolean);
                var old = storageGet(STORAGE.playlists, []);
                var out = [];
                urls.forEach(function (url, i) {
                    var found = old.filter(function (p) { return p.url === url; })[0];
                    out.push(found || { id: 'pl_' + hash(url), name: 'Плейлист ' + (i + 1), url: url });
                });
                storageSet(STORAGE.playlists, out);
            }
        });

        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: 'iptv_epg_mode', type: 'select', values: {
                custom: 'Свой URL',
                playlist: 'Из плейлиста'
            }, default: 'custom' },
            field: { name: 'Источник EPG', description: 'XMLTV. Поддерживаются XML и XML.GZ.' },
            onChange: function (value) { storageSet(STORAGE.epg_mode, value); }
        });

        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: 'iptv_epg_url', type: 'input', values: '', default: 'http://epg.one/ru2.xml.gz' },
            field: { name: 'EPG URL', description: 'Например: http://epg.one/ru2.xml.gz' },
            onChange: function (value) { storageSet(STORAGE.epg_url, value); }
        });

        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: 'iptv_epg_refresh', type: 'select', values: {
                '1': 'Каждый час',
                '6': 'Каждые 6 часов',
                '12': 'Каждые 12 часов',
                '24': 'Раз в сутки',
                '72': 'Раз в 3 суток'
            }, default: '6' },
            field: { name: 'Обновление EPG' },
            onChange: function (value) { storageSet(STORAGE.epg_refresh, value); }
        });

        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: 'iptv_show_logo', type: 'select', values: { 'true': 'Включено', 'false': 'Выключено' }, default: 'true' },
            field: { name: 'Логотипы каналов' },
            onChange: function (value) { storageSet(STORAGE.show_logo, value); }
        });

        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: 'iptv_show_epg', type: 'select', values: { 'true': 'Включено', 'false': 'Выключено' }, default: 'true' },
            field: { name: 'Показывать передачу' },
            onChange: function (value) { storageSet(STORAGE.show_epg, value); }
        });

        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: 'iptv_show_progress', type: 'select', values: { 'true': 'Включено', 'false': 'Выключено' }, default: 'true' },
            field: { name: 'Прогресс передачи' },
            onChange: function (value) { storageSet(STORAGE.show_progress, value); }
        });

        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: 'iptv_remember_channel', type: 'select', values: { 'true': 'Включено', 'false': 'Выключено' }, default: 'true' },
            field: { name: 'Запоминать последний канал' },
            onChange: function (value) { storageSet(STORAGE.remember_channel, value); }
        });

        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: 'iptv_refresh', type: 'trigger' },
            field: { name: 'Обновить IPTV сейчас', description: 'Перезагрузить плейлист и EPG' },
            onChange: function () {
                state.epgLoaded = false;
                notify('IPTV будет обновлён при следующем открытии');
            }
        });

        Lampa.SettingsApi.addParam({
            component: component,
            param: { name: 'iptv_clear_cache', type: 'trigger' },
            field: { name: 'Очистить кэш EPG', description: 'Удаляет сохранённую программу передач' },
            onChange: function () {
                storageSet(STORAGE.cache, '');
                storageSet(STORAGE.last_epg, 0);
                state.epg = {};
                state.epgLoaded = false;
                notify('Кэш EPG очищен');
            }
        });
    }

    function addMenu() {
        var item = $(
            '<li class="menu__item selector" data-action="iptv_player">' +
            '<div class="menu__ico">' +
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M8 21h8M12 18v3M8 9l4 2.5L8 14V9z"/></svg>' +
            '</div><div class="menu__text">IPTV</div></li>'
        );

        item.on('hover:enter', function () {
            Lampa.Activity.push({
                url: '',
                title: 'IPTV',
                component: PLUGIN_ID,
                page: 1
            });
        });

        var menu = $('.menu .menu__list').eq(0);
        if (menu.length && !menu.find('[data-action="iptv_player"]').length) menu.append(item);
    }

    function init() {
        if (window.__iptv_player_loaded) return;
        window.__iptv_player_loaded = true;

        if (!window.Lampa) return;

        Lampa.Component.add(PLUGIN_ID, component);
        addSettings();

        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') {
                setTimeout(addMenu, 300);
            }
        });

        // If the plugin was injected after app.ready.
        setTimeout(addMenu, 1000);
    }

    init();

})();
