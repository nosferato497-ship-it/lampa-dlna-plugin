/**
 * DLNA Plugin for Lampa
 * Version: 2.3.0 — forced native HTTP requests to bypass WebView CORS
 */
(function () {
    'use strict';
    if (window.dlna_plugin_ready) return;
    window.dlna_plugin_ready = true;

    const VERSION = '2.3.0';

    function noty(text, style, time) {
        try {
            const opts = {};
            if (style) opts.style = style;
            if (time) opts.time = time;
            Lampa.Noty.show(text, opts);
        } catch (e) { console.log('DLNA noty:', text); }
    }

    const DLNAServers = {
        get()      { try { return Lampa.Storage.get('dlna_servers', []); } catch (e) { return []; } },
        save(list) { try { Lampa.Storage.set('dlna_servers', list); } catch (e) {} },
        add(s) {
            const list = this.get();
            s.id = s.id || 'srv_' + Date.now();
            list.push(s);
            this.save(list);
            return s;
        },
        update(id, patch) {
            const list = this.get();
            const i = list.findIndex(s => s.id === id);
            if (i !== -1) { list[i] = Object.assign({}, list[i], patch); this.save(list); }
        },
        remove(id) { this.save(this.get().filter(s => s.id !== id)); }
    };

    // ============================================================
    // КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: ЗАПРОС ЧЕРЕЗ НАТИВНЫЙ МОСТ
    // ============================================================
    function nativeRequest(url, options) {
        return new Promise((resolve, reject) => {
            try {
                // Принудительно используем нативный режим Lampa
                Lampa.Request.native(url, (data) => {
                    resolve({
                        ok: true,
                        text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data)),
                        json: () => Promise.resolve(data)
                    });
                }, (error) => {
                    reject(new Error(error || 'Native request failed'));
                }, options);
            } catch (e) {
                reject(e);
            }
        });
    }

    const PATHS_TO_TRY = [
        '/rootDesc.xml', '/description.xml', '/',
        '/DeviceDescription.xml', '/upnp/rootDesc.xml', '/root.xml'
    ];

    async function probeServer(ip, port) {
        for (const path of PATHS_TO_TRY) {
            const url = `http://${ip}:${port}${path}`;
            try {
                const resp = await nativeRequest(url);
                const text = await resp.text();
                const doc = new DOMParser().parseFromString(text, 'text/xml');
                if (doc.querySelector('device') || doc.querySelector('serviceList')) {
                    return { path, xml: text, doc };
                }
            } catch (e) { /* next */ }
        }
        return null;
    }

    function extractControlURL(descDoc, baseURL) {
        try {
            for (const s of descDoc.getElementsByTagName('service')) {
                const type = s.getElementsByTagName('serviceType')[0]?.textContent || '';
                if (type.includes('ContentDirectory')) {
                    const ctrl = s.getElementsByTagName('controlURL')[0]?.textContent;
                    if (ctrl) return new URL(ctrl, baseURL).href;
                }
            }
        } catch (e) { console.error('extractControlURL error', e); }
        return null;
    }

    async function browseDirectory(controlURL, objectId) {
        objectId = objectId || '0';
        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
<ObjectID>${objectId}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag>
<Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>0</RequestedCount>
<SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`;

        // Для SOAP-запроса используем нативный мост с методом POST
        const resp = await nativeRequest(controlURL, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                'SOAPAction': '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'
            },
            body: soapBody
        });

        const text = await resp.text();
        return parseBrowseResponse(text);
    }

    function parseBrowseResponse(xmlText) {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
            const resultElement = xmlDoc.getElementsByTagName('Result')[0];
            if (!resultElement) return [];
            const didlDoc = parser.parseFromString(resultElement.textContent, 'text/xml');
            const items = [];
            for (const c of didlDoc.getElementsByTagName('container')) {
                items.push({ type: 'folder', id: c.getAttribute('id'), title: getText(c, 'dc:title') || 'Без названия' });
            }
            for (const it of didlDoc.getElementsByTagName('item')) {
                const res = it.getElementsByTagName('res')[0];
                const url = res?.textContent;
                const pi = res?.getAttribute('protocolInfo') || '';
                if (!url || !pi.includes('video')) continue;
                items.push({
                    type: 'video',
                    title: getText(it, 'dc:title') || 'Без названия',
                    url,
                    poster: getText(it, 'upnp:albumArtURI'),
                    description: getText(it, 'dc:description')
                });
            }
            return items;
        } catch (e) { console.error('parseBrowseResponse error', e); return []; }
    }

    function getText(node, tag) {
        const el = node.getElementsByTagName(tag)[0];
        return el ? el.textContent : null;
    }

    function sortItems(items, mode) {
        const copy = items.slice();
        if (mode === 'name') copy.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
        else copy.sort((a, b) => a.type === b.type ? a.title.localeCompare(b.title, 'ru') : (a.type === 'folder' ? -1 : 1));
        return copy;
    }

    async function ensureControlURL(server) {
        if (server.controlURL && Date.now() - (server.controlURLTime || 0) < 3600000) {
            return server.controlURL;
        }
        const probe = await probeServer(server.ip, server.port);
        if (!probe) return null;
        const base = `http://${server.ip}:${server.port}${probe.path}`;
        const ctrl = extractControlURL(probe.doc, base);
        if (ctrl) {
            DLNAServers.update(server.id, { controlURL: ctrl, controlURLTime: Date.now(), path: probe.path });
            server.controlURL = ctrl;
        }
        return ctrl;
    }

    // ============================================================
    // UI (без изменений)
    // ============================================================
    function showServersList() {
        try {
            const servers = DLNAServers.get();
            const items = servers.map(srv => ({
                title: '📺 ' + srv.name,
                subtitle: srv.ip + ':' + srv.port,
                _srv: srv
            }));
            items.push({ title: '➕ Добавить сервер', _add: true });

            Lampa.Select.show({
                title: 'DLNA Серверы',
                items: items,
                onSelect: (item) => {
                    try { Lampa.Select.close(); } catch (e) {}
                    setTimeout(() => {
                        if (item._add) addServerFlow();
                        else if (item._srv) openServerMenu(item._srv);
                    }, 150);
                },
                onBack: () => { try { Lampa.Controller.toggle('content'); } catch (e) {} }
            });
        } catch (e) {
            console.error('showServersList error', e);
            noty('Ошибка: ' + e.message, 'error', 5000);
        }
    }

    function openServerMenu(srv) {
        try {
            Lampa.Select.show({
                title: srv.name,
                items: [
                    { title: '▶ Открыть', _action: 'open' },
                    { title: '✎ Изменить', _action: 'edit' },
                    { title: '🗑 Удалить', _action: 'delete' },
                    { title: '⬅ Назад', _action: 'back' }
                ],
                onSelect: (item) => {
                    try { Lampa.Select.close(); } catch (e) {}
                    setTimeout(() => {
                        if (item._action === 'open') openServerRoot(srv);
                        else if (item._action === 'edit') editServerFlow(srv);
                        else if (item._action === 'delete') confirmDelete(srv);
                        else showServersList();
                    }, 150);
                },
                onBack: () => { try { Lampa.Controller.toggle('content'); } catch (e) {} }
            });
        } catch (e) {
            console.error('openServerMenu error', e);
            noty('Ошибка: ' + e.message, 'error', 5000);
        }
    }

    function confirmDelete(srv) {
        try {
            Lampa.Select.show({
                title: 'Удалить "' + srv.name + '"?',
                items: [
                    { title: 'Да, удалить', _action: 'yes' },
                    { title: 'Отмена', _action: 'no' }
                ],
                onSelect: (item) => {
                    try { Lampa.Select.close(); } catch (e) {}
                    setTimeout(() => {
                        if (item._action === 'yes') {
                            DLNAServers.remove(srv.id);
                            noty('Удалено');
                            showServersList();
                        } else {
                            openServerMenu(srv);
                        }
                    }, 150);
                },
                onBack: () => { try { Lampa.Controller.toggle('content'); } catch (e) {} }
            });
        } catch (e) { console.error('confirmDelete error', e); }
    }

    const PRESETS = [
        { name: 'Keenetic', port: '8200' },
        { name: 'MiniDLNA', port: '8200' },
        { name: 'Plex', port: '32469' },
        { name: 'Jellyfin', port: '8096' },
        { name: 'Windows Media', port: '2869' },
        { name: 'Другое', port: '49152' }
    ];

    function addServerFlow() {
        try {
            const items = PRESETS.map((p, i) => ({
                title: p.name,
                subtitle: 'порт ' + p.port,
                _i: i
            }));
            items.push({ title: '⬅ Назад', _back: true });

            Lampa.Select.show({
                title: 'Тип сервера',
                items: items,
                onSelect: (item) => {
                    try { Lampa.Select.close(); } catch (e) {}
                    setTimeout(() => {
                        if (item._back) showServersList();
                        else promptIP(PRESETS[item._i]);
                    }, 150);
                },
                onBack: () => { try { Lampa.Controller.toggle('content'); } catch (e) {} }
            });
        } catch (e) {
            console.error('addServerFlow error', e);
            noty('Ошибка: ' + e.message, 'error', 5000);
        }
    }

    function promptIP(preset) {
        try {
            Lampa.Input.edit({
                title: 'IP-адрес',
                value: Lampa.Storage.get('dlna_last_ip', '192.168.1.'),
                free: true
            }, (ip) => {
                if (!ip) return;
                Lampa.Storage.set('dlna_last_ip', ip);
                promptPort(preset, ip);
            });
        } catch (e) { console.error('promptIP error', e); noty('Ошибка ввода IP', 'error'); }
    }

    function promptPort(preset, ip) {
        try {
            Lampa.Input.edit({
                title: 'Порт',
                value: preset.port,
                free: true
            }, (port) => {
                if (!port) return;
                promptName(preset, ip, port);
            });
        } catch (e) { console.error('promptPort error', e); noty('Ошибка ввода порта', 'error'); }
    }

    function promptName(preset, ip, port) {
        try {
            Lampa.Input.edit({
                title: 'Название',
                value: preset.name,
                free: true
            }, (name) => {
                if (!name) return;
                saveServer({ name, ip, port });
            });
        } catch (e) { console.error('promptName error', e); noty('Ошибка ввода названия', 'error'); }
    }

    async function saveServer(data) {
        try {
            noty('Проверка подключения…');
            const probe = await probeServer(data.ip, data.port);
            if (!probe) {
                noty('Сервер не отвечает. Проверьте IP и порт.', 'error', 5000);
                showServersList();
                return;
            }
            const base = `http://${data.ip}:${data.port}${probe.path}`;
            const controlURL = extractControlURL(probe.doc, base);
            if (!controlURL) {
                noty('ContentDirectory не найден на сервере.', 'error', 5000);
                showServersList();
                return;
            }
            DLNAServers.add(Object.assign({}, data, {
                path: probe.path, controlURL, controlURLTime: Date.now()
            }));
            noty('Готово: ' + data.name);
            showServersList();
        } catch (e) {
            console.error('saveServer error', e);
            noty('Ошибка: ' + e.message, 'error', 5000);
        }
    }

    function editServerFlow(srv) {
        try {
            Lampa.Input.edit({
                title: 'IP-адрес',
                value: srv.ip,
                free: true
            }, (ip) => {
                if (!ip) return;
                Lampa.Input.edit({
                    title: 'Порт',
                    value: srv.port,
                    free: true
                }, (port) => {
                    if (!port) return;
                    Lampa.Input.edit({
                        title: 'Название',
                        value: srv.name,
                        free: true
                    }, (name) => {
                        if (!name) return;
                        DLNAServers.update(srv.id, { ip, port, name, controlURL: null, controlURLTime: 0 });
                        noty('Обновлено');
                        showServersList();
                    });
                });
            });
        } catch (e) { console.error('editServerFlow error', e); }
    }

    let navStack = [];

    async function openServerRoot(srv) {
        navStack = [{ srv: srv, objectId: '0', title: 'Корень: ' + srv.name }];
        await showFolder(0);
    }

    async function showFolder(index) {
        try {
            const cur = navStack[index];
            const srv = cur.srv;
            const ctrl = await ensureControlURL(srv);
            if (!ctrl) {
                noty('Сервер недоступен', 'error', 5000);
                showServersList();
                return;
            }

            noty('Загрузка…');
            let items;
            try {
                items = await browseDirectory(ctrl, cur.objectId);
            } catch (e) {
                console.error('browse error', e);
                noty('Ошибка загрузки: ' + e.message, 'error', 5000);
                return;
            }

            if (items.length === 0) {
                noty('Папка пуста');
                return;
            }

            const sorted = sortItems(items, 'type');
            const menuItems = [];

            if (index > 0) {
                menuItems.push({ title: '⬅ Назад', _back: true });
            }

            sorted.forEach(it => {
                if (it.type === 'folder') {
                    menuItems.push({ title: '📁 ' + it.title, _folder: it });
                } else if (it.type === 'video') {
                    menuItems.push({ title: '🎬 ' + it.title, subtitle: it.description || '', _video: it });
                }
            });

            if (index === 0) {
                menuItems.push({ title: '⬅ Выход', _exit: true });
            }

            Lampa.Select.show({
                title: cur.title,
                items: menuItems,
                onSelect: (item) => {
                    try { Lampa.Select.close(); } catch (e) {}
                    setTimeout(() => {
                        try {
                            if (item._back) {
                                navStack.pop();
                                showFolder(navStack.length - 1);
                            } else if (item._exit) {
                                showServersList();
                            } else if (item._folder) {
                                navStack.push({ srv: srv, objectId: item._folder.id, title: item._folder.title });
                                showFolder(navStack.length - 1);
                            } else if (item._video) {
                                playVideo(item._video);
                            }
                        } catch (e) {
                            console.error('nav error', e);
                            noty('Ошибка навигации', 'error');
                        }
                    }, 150);
                },
                onBack: () => {
                    try {
                        if (navStack.length > 1) {
                            navStack.pop();
                            setTimeout(() => showFolder(navStack.length - 1), 100);
                        } else {
                            Lampa.Controller.toggle('content');
                        }
                    } catch (e) {
                        console.error('onBack error', e);
                    }
                }
            });
        } catch (e) {
            console.error('showFolder error', e);
            noty('Ошибка: ' + e.message, 'error', 5000);
        }
    }

    function playVideo(item) {
        try {
            Lampa.Player.play({
                url: item.url,
                title: item.title,
                card: {
                    title: item.title,
                    poster_path: item.poster || '',
                    overview: item.description || ''
                }
            });
        } catch (e) {
            console.error('play error', e);
            noty('Не удалось запустить видео', 'error', 5000);
        }
    }

    // ============================================================
    // ИНИЦИАЛИЗАЦИЯ
    // ============================================================
    function init() {
        try {
            console.log('DLNA Plugin v' + VERSION + ': init');

            Lampa.SettingsApi.addComponent({
                component: 'dlna_plugin',
                name: 'DLNA Плагин',
                icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
                before: 'interface'
            });

            Lampa.SettingsApi.addParam({
                component: 'dlna_plugin',
                param: { name: 'dlna_open_btn', type: 'button', default: '' },
                field: { name: 'Открыть DLNA', description: 'Список серверов и воспроизведение' },
                onChange: () => {
                    setTimeout(showServersList, 300);
                }
            });

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
