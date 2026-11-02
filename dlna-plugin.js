/**
 * DLNA Plugin for Lampa
 * Version: 2.5.1
 *
 * 2.5.1: меню больше не вызывает Select.close() (из-за этого срабатывал onBack
 *        вместе с выбранным действием), индикатор загрузки с отменой, кеш папок,
 *        таймаут поиска описания 4 с, без повторного запроса через XHR.
 *
 * Изменения 2.5.0 относительно 2.4.0:
 *  - сетевые запросы через new Lampa.Reguest().native(url, ok, err, post, params)
 *    с dataType: 'text'; запасной вариант — XMLHttpRequest
 *  - код переписан на ES5 (без ?., стрелок, async/await, let/const, шаблонных строк),
 *    чтобы грузиться на старых TV-WebView
 *  - выход из тупиков навигации: при пустой папке или ошибке возвращаемся назад
 *  - сброс устаревшего controlURL и повторная попытка при ошибке Browse
 *  - экранирование ObjectID в SOAP, проверка <parsererror>, trim() у URL
 *  - учёт <URLBase>, поиск тегов без привязки к префиксу namespace
 *  - постраничный Browse (по 200 элементов)
 *  - возврат фокуса в тот контроллер, из которого плагин открыли
 *  - убран нерабочий пресет Windows Media, добавлен ввод пути описания вручную
 *
 * Важно: DLNA-серверы не отдают CORS-заголовки. В браузерной Lampa
 * и на части ТВ запросы будут заблокированы; надёжно работает там,
 * где запросы идут в обход CORS (например, Android-приложение Lampa).
 */
(function () {
    'use strict';

    if (window.dlna_plugin_ready) return;
    window.dlna_plugin_ready = true;

    var VERSION = '2.5.1';
    var REQUEST_TIMEOUT = 15000;   // Browse
    var PROBE_TIMEOUT = 4000;      // поиск описания устройства
    var CONTROL_URL_TTL = 3600000;
    var BROWSE_PAGE = 200;
    var BROWSE_MAX = 5000;
    var MENU_DELAY = 150;

    // ============================================================
    // Утилиты
    // ============================================================

    function noty(text, style, time) {
        try {
            var opts = {};
            if (style) opts.style = style;
            if (time) opts.time = time;
            Lampa.Noty.show(text, opts);
        } catch (e) { console.log('DLNA noty:', text); }
    }

    function later(fn, delay) {
        setTimeout(fn, typeof delay === 'number' ? delay : MENU_DELAY);
    }

    function xmlEscape(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function trim(str) {
        return str == null ? '' : String(str).replace(/^\s+|\s+$/g, '');
    }

    function resolveURL(relative, base) {
        relative = trim(relative);
        if (!relative) return null;
        if (/^https?:\/\//i.test(relative)) return relative;
        try {
            return new URL(relative, base).href;
        } catch (e) {
            var m = String(base).match(/^(https?:\/\/[^\/]+)/i);
            if (!m) return null;
            return m[1] + (relative.charAt(0) === '/' ? '' : '/') + relative;
        }
    }

    function parseXML(text) {
        if (!text) return null;
        try {
            var doc = new DOMParser().parseFromString(text, 'text/xml');
            if (!doc || doc.getElementsByTagName('parsererror').length) return null;
            return doc;
        } catch (e) { return null; }
    }

    // Поиск по локальному имени тега, независимо от префикса namespace
    function byName(node, localName) {
        if (!node) return [];
        if (node.getElementsByTagNameNS) {
            var list = node.getElementsByTagNameNS('*', localName);
            if (list && list.length) return list;
        }
        return node.getElementsByTagName(localName);
    }

    function firstText(node, localName) {
        var el = byName(node, localName)[0];
        return el ? trim(el.textContent) : '';
    }

    function toArray(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) out.push(list[i]);
        return out;
    }

    // ============================================================
    // Хранилище серверов
    // ============================================================

    var DLNAServers = {
        get: function () {
            try {
                var list = Lampa.Storage.get('dlna_servers', '[]');
                if (typeof list === 'string') list = JSON.parse(list || '[]');
                return Array.isArray(list) ? list : [];
            } catch (e) { return []; }
        },
        save: function (list) {
            try { Lampa.Storage.set('dlna_servers', list); } catch (e) {}
        },
        find: function (id) {
            var list = this.get();
            for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
            return null;
        },
        add: function (s) {
            var list = this.get();
            s.id = s.id || 'srv_' + Date.now();
            list.push(s);
            this.save(list);
            return s;
        },
        update: function (id, patch) {
            var list = this.get();
            for (var i = 0; i < list.length; i++) {
                if (list[i].id === id) {
                    for (var k in patch) if (patch.hasOwnProperty(k)) list[i][k] = patch[k];
                    this.save(list);
                    return list[i];
                }
            }
            return null;
        },
        remove: function (id) {
            this.save(this.get().filter(function (s) { return s.id !== id; }));
        }
    };

    // ============================================================
    // Сеть
    // ============================================================

    function dataToText(data) {
        if (data == null) return '';
        if (typeof data === 'string') return data;
        try {
            if (data.nodeType) return new XMLSerializer().serializeToString(data);
        } catch (e) {}
        return '';
    }

    function xhrRequest(url, opts) {
        return new Promise(function (resolve, reject) {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open(opts.body ? 'POST' : 'GET', url, true);
                xhr.timeout = opts.timeout || REQUEST_TIMEOUT;
                var h = opts.headers || {};
                for (var k in h) if (h.hasOwnProperty(k)) {
                    try { xhr.setRequestHeader(k, h[k]); } catch (e) {}
                }
                xhr.onload = function () {
                    if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
                    else reject(new Error('HTTP ' + xhr.status));
                };
                xhr.onerror = function () { reject(new Error('Сетевая ошибка (возможно, CORS)')); };
                xhr.ontimeout = function () { reject(new Error('Таймаут')); };
                xhr.send(opts.body || null);
            } catch (e) { reject(e); }
        });
    }

    function lampaRequest(url, opts) {
        return new Promise(function (resolve, reject) {
            var net = new Lampa.Reguest();
            try { net.timeout(opts.timeout || REQUEST_TIMEOUT); } catch (e) {}
            net.native(
                url,
                function (data) { resolve(dataToText(data)); },
                function (a, c) {
                    var msg = 'Ошибка запроса';
                    try { if (net.errorDecode) msg = net.errorDecode(a, c) || msg; } catch (e) {}
                    reject(new Error(msg));
                },
                opts.body || false,
                { dataType: 'text', headers: opts.headers || {} }
            );
        });
    }

    function request(url, opts) {
        opts = opts || {};
        var hasLampa = false;
        try { hasLampa = typeof Lampa.Reguest === 'function'; } catch (e) {}
        // Без повторной попытки через XHR: она удваивала время ожидания
        return hasLampa ? lampaRequest(url, opts) : xhrRequest(url, opts);
    }

    // ============================================================
    // UPnP / DLNA
    // ============================================================

    var PATHS_TO_TRY = [
        '/rootDesc.xml', '/description.xml', '/DeviceDescription.xml',
        '/upnp/rootDesc.xml', '/root.xml', '/dmr/description.xml', '/'
    ];

    function baseOf(server) {
        return 'http://' + server.ip + ':' + server.port;
    }

    function isDeviceDescription(doc) {
        return !!(doc && (byName(doc, 'device').length || byName(doc, 'serviceList').length));
    }

    function probeServer(server) {
        var paths = [];
        if (server.path) paths.push(server.path);
        PATHS_TO_TRY.forEach(function (p) { if (paths.indexOf(p) === -1) paths.push(p); });

        var i = 0;
        function next() {
            if (i >= paths.length) return Promise.resolve(null);
            var path = paths[i++];
            if (path.charAt(0) !== '/') path = '/' + path;
            var url = baseOf(server) + path;
            return request(url, { timeout: PROBE_TIMEOUT }).then(function (text) {
                var doc = parseXML(text);
                if (isDeviceDescription(doc)) return { path: path, url: url, doc: doc };
                return next();
            }, function () { return next(); });
        }
        return next();
    }

    function extractControlURL(doc, descURL) {
        var base = firstText(doc, 'URLBase') || descURL;
        var services = toArray(byName(doc, 'service'));
        for (var i = 0; i < services.length; i++) {
            var type = firstText(services[i], 'serviceType');
            if (type.indexOf('ContentDirectory') !== -1) {
                var ctrl = firstText(services[i], 'controlURL');
                if (ctrl) return { url: resolveURL(ctrl, base), type: type };
            }
        }
        return null;
    }

    function discover(server) {
        return probeServer(server).then(function (probe) {
            if (!probe) return null;
            var ctrl = extractControlURL(probe.doc, probe.url);
            if (!ctrl || !ctrl.url) return { probe: probe, control: null };
            return { probe: probe, control: ctrl };
        });
    }

    function ensureControlURL(server, force) {
        if (!force && server.controlURL && Date.now() - (server.controlURLTime || 0) < CONTROL_URL_TTL) {
            return Promise.resolve(server.controlURL);
        }
        return discover(server).then(function (res) {
            if (!res || !res.control) return null;
            var patch = {
                controlURL: res.control.url,
                serviceType: res.control.type,
                controlURLTime: Date.now(),
                path: res.probe.path
            };
            DLNAServers.update(server.id, patch);
            for (var k in patch) server[k] = patch[k];
            return server.controlURL;
        });
    }

    function soapBrowse(controlURL, serviceType, objectId, start, count) {
        serviceType = serviceType || 'urn:schemas-upnp-org:service:ContentDirectory:1';
        var body =
            '<?xml version="1.0" encoding="utf-8"?>' +
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
            '<s:Body><u:Browse xmlns:u="' + xmlEscape(serviceType) + '">' +
            '<ObjectID>' + xmlEscape(objectId) + '</ObjectID>' +
            '<BrowseFlag>BrowseDirectChildren</BrowseFlag>' +
            '<Filter>*</Filter>' +
            '<StartingIndex>' + start + '</StartingIndex>' +
            '<RequestedCount>' + count + '</RequestedCount>' +
            '<SortCriteria></SortCriteria>' +
            '</u:Browse></s:Body></s:Envelope>';

        return request(controlURL, {
            body: body,
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                'SOAPAction': '"' + serviceType + '#Browse"'
            }
        }).then(function (text) {
            var doc = parseXML(text);
            if (!doc) throw new Error('Некорректный ответ сервера');
            var fault = firstText(doc, 'faultstring') || firstText(doc, 'errorDescription');
            if (fault) throw new Error('SOAP: ' + fault);
            var result = firstText(doc, 'Result');
            return {
                items: parseDIDL(result),
                returned: parseInt(firstText(doc, 'NumberReturned'), 10) || 0,
                total: parseInt(firstText(doc, 'TotalMatches'), 10) || 0
            };
        });
    }

    function browseDirectory(server, objectId) {
        var all = [];
        function page(start) {
            return soapBrowse(server.controlURL, server.serviceType, objectId, start, BROWSE_PAGE)
                .then(function (res) {
                    all = all.concat(res.items);
                    var got = start + res.returned;
                    if (res.returned > 0 && got < res.total && got < BROWSE_MAX) return page(got);
                    return all;
                });
        }
        return page(0);
    }

    function pickVideoRes(item) {
        var list = toArray(byName(item, 'res'));
        for (var i = 0; i < list.length; i++) {
            var pi = list[i].getAttribute('protocolInfo') || '';
            var url = trim(list[i].textContent);
            if (url && pi.indexOf('video') !== -1) return url;
        }
        return null;
    }

    function parseDIDL(didlText) {
        var doc = parseXML(didlText);
        if (!doc) return [];
        var items = [];

        toArray(byName(doc, 'container')).forEach(function (c) {
            items.push({
                type: 'folder',
                id: c.getAttribute('id'),
                title: firstText(c, 'title') || 'Без названия'
            });
        });

        toArray(byName(doc, 'item')).forEach(function (it) {
            var cls = firstText(it, 'class');
            var url = pickVideoRes(it);
            if (!url && cls.indexOf('videoItem') === -1) return;
            if (!url) return;
            items.push({
                type: 'video',
                title: firstText(it, 'title') || 'Без названия',
                url: url,
                poster: firstText(it, 'albumArtURI'),
                description: firstText(it, 'description') || firstText(it, 'longDescription')
            });
        });

        return items;
    }

    function sortItems(items) {
        return items.slice().sort(function (a, b) {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            try { return a.title.localeCompare(b.title, 'ru', { numeric: true }); }
            catch (e) { return a.title < b.title ? -1 : a.title > b.title ? 1 : 0; }
        });
    }

    // ============================================================
    // UI
    // ============================================================

    var returnController = 'content';

    function rememberController() {
        try {
            var en = Lampa.Controller.enabled();
            if (en && en.name) returnController = en.name;
        } catch (e) {}
    }

    function backToApp() {
        try { Lampa.Controller.toggle(returnController || 'content'); }
        catch (e) {
            try { Lampa.Controller.toggle('content'); } catch (e2) {}
        }
    }

    // Lampa сама скрывает меню при выборе пункта (без вызова onBack),
    // а при «Назад» сама закрывает его и вызывает onBack.
    // Поэтому здесь НЕЛЬЗЯ вызывать Lampa.Select.close(): close() дергает onBack,
    // и вместе с выбранным действием срабатывало ещё и «назад».
    function showMenu(title, items, onSelect, onBack) {
        Lampa.Select.show({
            title: title,
            items: items,
            onSelect: function (item) {
                later(function () {
                    try { onSelect(item); }
                    catch (e) {
                        console.error('DLNA menu error', e);
                        noty('Ошибка: ' + e.message, 'error', 5000);
                    }
                }, 50);
            },
            onBack: function () {
                later(function () {
                    try { (onBack || backToApp)(); }
                    catch (e) { console.error('DLNA back error', e); backToApp(); }
                }, 50);
            }
        });
    }

    // Индикатор загрузки, чтобы было видно, что идёт работа
    var spinnerOn = false;
    function spinner(on, onCancel) {
        try {
            if (on && !spinnerOn) {
                spinnerOn = true;
                Lampa.Loading.start(function () {
                    spinner(false);
                    if (onCancel) onCancel();
                });
            } else if (!on && spinnerOn) {
                spinnerOn = false;
                Lampa.Loading.stop();
            }
        } catch (e) { spinnerOn = on; }
    }

    function showServersList() {
        try {
            var items = DLNAServers.get().map(function (srv) {
                return { title: '📺 ' + srv.name, subtitle: srv.ip + ':' + srv.port, _srv: srv };
            });
            items.push({ title: '➕ Добавить сервер', _add: true });

            showMenu('DLNA серверы', items, function (item) {
                if (item._add) addServerFlow();
                else if (item._srv) openServerMenu(item._srv);
            });
        } catch (e) {
            console.error('showServersList error', e);
            noty('Ошибка: ' + e.message, 'error', 5000);
        }
    }

    function openServerMenu(srv) {
        showMenu(srv.name, [
            { title: '▶ Открыть', _action: 'open' },
            { title: '✎ Изменить', _action: 'edit' },
            { title: '🔄 Переподключить', _action: 'reprobe' },
            { title: '🗑 Удалить', _action: 'delete' },
            { title: '⬅ Назад', _action: 'back' }
        ], function (item) {
            if (item._action === 'open') openServerRoot(srv);
            else if (item._action === 'edit') editServerFlow(srv);
            else if (item._action === 'reprobe') reprobe(srv);
            else if (item._action === 'delete') confirmDelete(srv);
            else showServersList();
        }, showServersList);
    }

    function reprobe(srv) {
        spinner(true);
        ensureControlURL(srv, true).then(function (ctrl) {
            spinner(false);
            noty(ctrl ? 'Сервер найден' : 'Сервер не найден', ctrl ? null : 'error', 4000);
            openServerMenu(srv);
        }, function (e) {
            spinner(false);
            noty('Ошибка: ' + e.message, 'error', 5000);
            openServerMenu(srv);
        });
    }

    function confirmDelete(srv) {
        showMenu('Удалить «' + srv.name + '»?', [
            { title: 'Да, удалить', _action: 'yes' },
            { title: 'Отмена', _action: 'no' }
        ], function (item) {
            if (item._action === 'yes') {
                DLNAServers.remove(srv.id);
                noty('Удалено');
                showServersList();
            } else openServerMenu(srv);
        }, function () { openServerMenu(srv); });
    }

    var PRESETS = [
        { name: 'Keenetic', port: '8200', path: '/rootDesc.xml' },
        { name: 'MiniDLNA / ReadyMedia', port: '8200', path: '/rootDesc.xml' },
        { name: 'Plex', port: '32469', path: '/DeviceDescription.xml' },
        { name: 'Serviio', port: '8895', path: '' },
        { name: 'Universal Media Server', port: '5001', path: '/description/fetch' },
        { name: 'Другое (указать путь)', port: '49152', path: '', askPath: true }
    ];

    function addServerFlow() {
        var items = PRESETS.map(function (p, i) {
            return { title: p.name, subtitle: 'порт ' + p.port, _i: i };
        });
        items.push({ title: '⬅ Назад', _back: true });

        showMenu('Тип сервера', items, function (item) {
            if (item._back) showServersList();
            else promptIP(PRESETS[item._i]);
        }, showServersList);
    }

    function input(title, value, cb, onCancel) {
        try {
            Lampa.Input.edit({ title: title, value: value || '', free: true, nosave: true }, function (val) {
                val = trim(val);
                if (!val) { if (onCancel) onCancel(); else showServersList(); return; }
                cb(val);
            });
        } catch (e) {
            console.error('DLNA input error', e);
            noty('Ошибка ввода', 'error');
        }
    }

    function promptIP(preset) {
        var last = '192.168.1.';
        try { last = Lampa.Storage.get('dlna_last_ip', last) || last; } catch (e) {}
        input('IP-адрес', last, function (ip) {
            try { Lampa.Storage.set('dlna_last_ip', ip); } catch (e) {}
            input('Порт', preset.port, function (port) {
                var askName = function (path) {
                    input('Название', preset.name, function (name) {
                        saveServer({ name: name, ip: ip, port: port, path: path || '' });
                    });
                };
                if (preset.askPath) {
                    input('Путь к описанию (например /rootDesc.xml), «-» — авто', '-', function (p) {
                        askName(p === '-' ? '' : p);
                    });
                } else askName(preset.path);
            });
        });
    }

    function saveServer(data) {
        spinner(true);
        discover(data).then(function (res) {
            spinner(false);
            if (!res) {
                noty('Сервер не отвечает. Проверьте IP и порт.', 'error', 5000);
                showServersList();
                return;
            }
            if (!res.control) {
                noty('ContentDirectory не найден на сервере.', 'error', 5000);
                showServersList();
                return;
            }
            DLNAServers.add({
                name: data.name, ip: data.ip, port: data.port,
                path: res.probe.path,
                controlURL: res.control.url,
                serviceType: res.control.type,
                controlURLTime: Date.now()
            });
            noty('Готово: ' + data.name);
            showServersList();
        }).catch(function (e) {
            spinner(false);
            console.error('saveServer error', e);
            noty('Ошибка: ' + e.message, 'error', 5000);
            showServersList();
        });
    }

    function editServerFlow(srv) {
        var back = function () { openServerMenu(srv); };
        input('IP-адрес', srv.ip, function (ip) {
            input('Порт', srv.port, function (port) {
                input('Название', srv.name, function (name) {
                    var updated = DLNAServers.update(srv.id, {
                        ip: ip, port: port, name: name,
                        controlURL: null, controlURLTime: 0,
                        path: (ip === srv.ip && port === srv.port) ? srv.path : ''
                    });
                    noty('Обновлено');
                    openServerMenu(updated || srv);
                }, back);
            }, back);
        }, back);
    }

    // ============================================================
    // Навигация по папкам
    // ============================================================

    var navStack = [];
    var loading = false;

    function openServerRoot(srv) {
        rememberServer(srv);
        navStack = [{ objectId: '0', title: srv.name, srv: srv }];
        showFolder();
    }

    function rememberServer(srv) {
        var fresh = DLNAServers.find(srv.id);
        if (fresh) for (var k in fresh) srv[k] = fresh[k];
    }

    function goBack() {
        if (navStack.length > 1) {
            navStack.pop();
            var prev = navStack[navStack.length - 1];
            // папка уже загружалась — показываем из кеша без запроса
            if (prev.items) renderFolder(prev, prev.items);
            else showFolder();
        } else {
            var srv = navStack[0] && navStack[0].srv;
            navStack = [];
            if (srv) openServerMenu(srv); else showServersList();
        }
    }

    function loadItems(srv, objectId) {
        return ensureControlURL(srv, false).then(function (ctrl) {
            if (!ctrl) throw new Error('Сервер недоступен');
            return browseDirectory(srv, objectId).catch(function () {
                // controlURL мог устареть (сменился IP/порт сервиса) — переопрашиваем
                return ensureControlURL(srv, true).then(function (ctrl2) {
                    if (!ctrl2) throw new Error('Сервер недоступен');
                    return browseDirectory(srv, objectId);
                });
            });
        });
    }

    function showFolder() {
        if (loading || !navStack.length) return;
        var cur = navStack[navStack.length - 1];
        var srv = cur.srv;

        loading = true;
        var cancelled = false;
        spinner(true, function () {
            cancelled = true;
            loading = false;
            goBack();
        });

        loadItems(srv, cur.objectId).then(function (items) {
            if (cancelled) return;
            loading = false;
            spinner(false);
            if (!items.length) {
                noty('Папка пуста');
                goBack();
                return;
            }
            cur.items = items;
            renderFolder(cur, items);
        }, function (e) {
            if (cancelled) return;
            loading = false;
            spinner(false);
            console.error('DLNA browse error', e);
            noty('Ошибка загрузки: ' + e.message, 'error', 5000);
            goBack();
        });
    }

    function renderFolder(cur, items) {
        var menu = [];
        var depth = navStack.length;

        if (depth > 1) menu.push({ title: '⬅ Назад', _back: true });

        sortItems(items).forEach(function (it) {
            if (it.type === 'folder') menu.push({ title: '📁 ' + it.title, _folder: it });
            else menu.push({ title: '🎬 ' + it.title, subtitle: it.description || '', _video: it });
        });

        if (depth === 1) menu.push({ title: '⬅ Выход', _exit: true });

        var title = navStack.map(function (n) { return n.title; }).slice(-2).join(' / ');

        showMenu(title, menu, function (item) {
            if (item._back) goBack();
            else if (item._exit) { navStack = []; showServersList(); }
            else if (item._folder) {
                navStack.push({ objectId: item._folder.id, title: item._folder.title, srv: cur.srv });
                showFolder();
            } else if (item._video) playVideo(item._video, items);
        }, goBack);
    }

    function playVideo(item, siblings) {
        try {
            var videos = (siblings || []).filter(function (it) { return it.type === 'video'; });
            var data = {
                url: item.url,
                title: item.title
            };
            Lampa.Player.play(data);
            if (videos.length > 1) {
                try {
                    Lampa.Player.playlist(sortItems(videos).map(function (v) {
                        return { url: v.url, title: v.title };
                    }));
                } catch (e) {}
            }
        } catch (e) {
            console.error('DLNA play error', e);
            noty('Не удалось запустить видео', 'error', 5000);
        }
    }

    // ============================================================
    // Инициализация
    // ============================================================

    function open() {
        rememberController();
        showServersList();
    }

    function init() {
        try {
            console.log('DLNA Plugin v' + VERSION + ': init');

            Lampa.SettingsApi.addComponent({
                component: 'dlna_plugin',
                name: 'DLNA',
                icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">' +
                      '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-6v2h3v2H7v-2h3v-2H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v8h14V7H5z"/></svg>',
                before: 'interface'
            });

            Lampa.SettingsApi.addParam({
                component: 'dlna_plugin',
                param: { name: 'dlna_open_btn', type: 'button', 'default': '' },
                field: { name: 'Открыть DLNA', description: 'Список серверов и воспроизведение' },
                onChange: function () { later(open, 300); }
            });

            // доступ из консоли / других плагинов
            window.dlna_plugin = { open: open, version: VERSION };

            console.log('DLNA Plugin v' + VERSION + ': ready');
        } catch (e) {
            console.error('DLNA init error', e);
        }
    }

    try {
        if (window.appready) init();
        else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') init(); });
    } catch (e) {
        console.error('DLNA boot error', e);
    }
})();
