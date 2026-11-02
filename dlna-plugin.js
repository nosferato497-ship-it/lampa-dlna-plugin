/**
 * DLNA Plugin for Lampa
 * Version: 2.0.0 — built on native Lampa dialogs (Select/Input/Noty)
 * Target: Android TV (Xiaomi Mi Box S 4K)
 */
(function () {
    'use strict';

    if (window.dlna_plugin_ready) return;
    window.dlna_plugin_ready = true;

    const VERSION = '2.0.0';

    // ============================================================
    // ХРАНИЛИЩЕ СЕРВЕРОВ
    // ============================================================
    const DLNAServers = {
        get()      { return Lampa.Storage.get('dlna_servers', []); },
        save(list) { Lampa.Storage.set('dlna_servers', list); },
        add(s)     {
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
    // СЕТЬ
    // ============================================================
    const PATHS_TO_TRY = [
        '/rootDesc.xml', '/description.xml', '/',
        '/DeviceDescription.xml', '/upnp/rootDesc.xml', '/root.xml'
    ];

    async function probeServer(ip, port) {
        for (const path of PATHS_TO_TRY) {
            try {
                const url = `http://${ip}:${port}${path}`;
                const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
                if (!resp.ok) continue;
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
        for (const s of descDoc.getElementsByTagName('service')) {
            const type = s.getElementsByTagName('serviceType')[0]?.textContent || '';
            if (type.includes('ContentDirectory')) {
                const ctrl = s.getElementsByTagName('controlURL')[0]?.textContent;
                if (ctrl) return new URL(ctrl, baseURL).href;
            }
        }
        return null;
    }

    async function browseDirectory(controlURL, objectId = '0') {
        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
<ObjectID>${objectId}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag>
<Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>0</RequestedCount>
<SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`;
        const resp = await fetch(controlURL, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                'SOAPAction': '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'
            },
            body: soapBody
        });
        if (!resp.ok) throw new Error('Browse failed: ' + resp.status);
        return parseBrowseResponse(await resp.text());
    }

    function parseBrowseResponse(xmlText) {
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

    // ============================================================
    // ВСПОМОГАТЕЛЬНОЕ: ПРОВЕРКА controlURL
    // ============================================================
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
    // UI: СПИСОК СЕРВЕРОВ (через Lampa.Select)
    // ============================================================
    function showServersList() {
        const servers = DLNAServers.get();
        const items = [];

        servers.forEach((srv, idx) => {
            items.push({
                title: '📺 ' + srv.name,
                subtitle: srv.ip + ':' + srv.port,
                _action: () => openServerMenu(srv)
            });
        });

        items.push({
            title: '➕ Добавить сервер',
            subtitle: 'Ввести IP и порт вручную',
            _action: addServerFlow
        });

        if (servers.length > 0) {
            items.push({
                title: '🗑 Управление серверами',
                subtitle: 'Изменить или удалить',
                _action: () => openManageMenu()
            });
        }

        Lampa.Select.show({
            title: 'DLNA Серверы',
            items: items,
            onSelect: (item) => {
                Lampa.Select.close();
                setTimeout(() => { if (item._action) item._action(); }, 200);
            },
            onBack: () => Lampa.Controller.toggle('content')
        });
    }

    // ============================================================
    // UI: МЕНЮ КОНКРЕТНОГО СЕРВЕРА
    // ============================================================
    function openServerMenu(srv) {
        Lampa.Select.show({
            title: srv.name,
            items: [
                { title: '▶ Открыть', _action: () => openServerRoot(srv) },
                { title: '✎ Изменить', _action: () => editServerFlow(srv) },
                { title: '🗑 Удалить', _action: () => confirmDelete(srv) },
                { title: '⬅ Назад', _action: showServersList }
            ],
            onSelect: (item) => {
                Lampa.Select.close();
                setTimeout(() => { if (item._action) item._action(); }, 200);
            },
            onBack: () => Lampa.Controller.toggle('content')
        });
    }

    function confirmDelete(srv) {
        Lampa.Select.show({
            title: 'Удалить "' + srv.name + '"?',
            items: [
                { title: 'Да, удалить', _action: () => { DLNAServers.remove(srv.id); Lampa.Noty.show('Удалено'); showServersList(); } },
                { title: 'Отмена', _action: () => openServerMenu(srv) }
            ],
            onSelect: (item) => {
                Lampa.Select.close();
                setTimeout(() => { if (item._action) item._action(); }, 200);
            },
            onBack: () => Lampa.Controller.toggle('content')
        });
    }

    function openManageMenu() {
        const servers = DLNAServers.get();
        if (!servers.length) { showServersList(); return; }
        const items = servers.map(srv => ({
            title: srv.name,
            subtitle: srv.ip + ':' + srv.port,
            _action: () => openServerMenu(srv)
        }));
        items.push({ title: '⬅ Назад', _action: showServersList });
        Lampa.Select.show({
            title: 'Выберите сервер',
            items: items,
            onSelect: (item) => {
                Lampa.Select.close();
                setTimeout(() => { if (item._action) item._action(); }, 200);
            },
            onBack: () => Lampa.Controller.toggle('content')
        });
    }

    // ============================================================
    // UI: ДОБАВЛЕНИЕ / РЕДАКТИРОВАНИЕ СЕРВЕРА
    // ============================================================
    const PRESETS = [
        { name: 'MiniDLNA', port: '8200' },
        { name: 'Plex', port: '32469' },
        { name: 'Jellyfin', port: '8096' },
        { name: 'Windows Media', port: '2869' },
        { name: 'Другое', port: '49152' }
    ];

    function addServerFlow() {
        const items = PRESETS.map(p => ({
            title: p.name,
            subtitle: 'порт ' + p.port,
            _action: () => promptIP(p)
        }));
        items.push({ title: '⬅ Назад', _action: showServersList });
        Lampa.Select.show({
            title: 'Тип сервера',
            items: items,
            onSelect: (item) => {
                Lampa.Select.close();
                setTimeout(() => { if (item._action) item._action(); }, 200);
            },
            onBack: () => Lampa.Controller.toggle('content')
        });
    }

    function promptIP(preset) {
        Lampa.Input.edit({
            title: 'IP-адрес',
            value: Lampa.Storage.get('dlna_last_ip', '192.168.1.'),
            free: true
        }, (ip) => {
            if (!ip) return;
            Lampa.Storage.set('dlna_last_ip', ip);
            promptPort(preset, ip);
        });
    }

    function promptPort(preset, ip) {
        Lampa.Input.edit({
            title: 'Порт',
            value: preset.port,
            free: true
        }, (port) => {
            if (!port) return;
            promptName(preset, ip, port);
        });
    }

    function promptName(preset, ip, port) {
        Lampa.Input.edit({
            title: 'Название',
            value: preset.name,
            free: true
        }, (name) => {
            if (!name) return;
            saveServer({ name, ip, port });
        });
    }

    async function saveServer(data) {
        Lampa.Noty.show('Проверка подключения…');
        const probe = await probeServer(data.ip, data.port);
        if (!probe) {
            Lampa.Noty.show('Сервер не отвечает. Проверьте IP и порт.', { style: 'error', time: 5000 });
            showServersList();
            return;
        }
        const base = `http://${data.ip}:${data.port}${probe.path}`;
        const controlURL = extractControlURL(probe.doc, base);
        if (!controlURL) {
            Lampa.Noty.show('ContentDirectory не найден на сервере.', { style: 'error', time: 5000 });
            showServersList();
            return;
        }
        DLNAServers.add(Object.assign({}, data, {
            path: probe.path, controlURL, controlURLTime: Date.now()
        }));
        Lampa.Noty.show('Готово: ' + data.name);
        showServersList();
    }

    function editServerFlow(srv) {
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
                    Lampa.Noty.show('Обновлено');
                    showServersList();
                });
            });
        });
    }

    // ============================================================
    // UI: НАВИГАЦИЯ ПО ПАПКАМ
    // ============================================================
    async function openServerRoot(srv) {
        await browseFolder(srv, '0', 'Корень');
    }

    async function browseFolder(srv, objectId, folderTitle) {
        const ctrl = await ensureControlURL(srv);
        if (!ctrl) {
            Lampa.Noty.show('Сервер недоступен', { style: 'error', time: 5000 });
            showServersList();
            return;
        }

        let items;
        try {
            Lampa.Noty.show('Загрузка…');
            items = await browseDirectory(ctrl, objectId);
        } catch (e) {
            console.error('browseFolder error', e);
            Lampa.Noty.show('Ошибка загрузки', { style: 'error', time: 5000 });
            return;
        }

        if (items.length === 0) {
            Lampa.Noty.show('Папка пуста');
            return;
        }

        const sorted = sortItems(items, 'type');
        const menuItems = [];

        if (objectId !== '0') {
            menuItems.push({
                title: '⬅ Назад',
                subtitle: 'в родительский каталог',
                _action: () => Lampa.Activity.backward()
            });
        }

        sorted.forEach(it => {
            if (it.type === 'folder') {
                menuItems.push({
                    title: '📁 ' + it.title,
                    _action: () => {
                        // Открываем папку как новый Activity чтобы кнопка "назад" работала корректно
                        Lampa.Activity.push({
                            component: 'dlna_folder_stub',
                            title: it.title,
                            _srv: srv,
                            _objectId: it.id
                        });
                    }
                });
            } else if (it.type === 'video') {
                menuItems.push({
                    title: '🎬 ' + it.title,
                    subtitle: it.description || '',
                    _action: () => playVideo(it)
                });
            }
        });

        if (objectId === '0') {
            menuItems.push({ title: '⬅ Назад к серверам', _action: showServersList });
        }

        Lampa.Select.show({
            title: folderTitle,
            items: menuItems,
            onSelect: (item) => {
                Lampa.Select.close();
                setTimeout(() => { if (item._action) item._action(); }, 200);
            },
            onBack: () => Lampa.Controller.toggle('content')
        });
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
            Lampa.Noty.show('Не удалось запустить видео', { style: 'error' });
        }
    }

    // ============================================================
    // ЗАГЛУШКА-КОМПОНЕНТ: для стека «назад» при заходе в папку
    // ============================================================
    if (typeof Lampa !== 'undefined' && Lampa.Component) {
        Lampa.Component.add('dlna_folder_stub', {
            create() { return document.createElement('div'); },
            start() {
                const srv = this.activity._srv;
                const objectId = this.activity._objectId;
                const title = this.activity.title;
                // Как только экран создан — открываем Select с содержимым папки
                setTimeout(() => {
                    browseFolder(srv, objectId, title);
                }, 100);
            },
            stop() {}, destroy() {}
        });
    }

    // ============================================================
    // ЗАПУСК: КНОПКА В НАСТРОЙКАХ
    // ============================================================
    function init() {
        console.log('DLNA Plugin v' + VERSION + ': init');

        try {
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
                    Lampa.Settings.close();
                    setTimeout(showServersList, 300);
                }
            });
        } catch (e) {
            console.error('DLNA: settings error', e);
        }
    }

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') init(); });
})();
