/**
 * DLNA Plugin for Lampa
 * Version: 1.1.0
 * Target: Android TV (Xiaomi Mi Box S 4K)
 */
(function () {
    'use strict';

    if (window.dlna_plugin_ready) return;
    window.dlna_plugin_ready = true;

    const VERSION = '1.1.0';

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
    // СЕТЕВЫЕ ФУНКЦИИ
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

    async function checkServerStatus(srv) {
        try { return (await probeServer(srv.ip, srv.port)) ? 'online' : 'offline'; }
        catch (e) { return 'offline'; }
    }

    // ============================================================
    // CSS
    // ============================================================
    function injectStyles() {
        Lampa.Utils.putStyle(`
            .dlna-servers, .dlna-browser { padding: 1em 2em; }
            .dlna-servers__list, .dlna-browser__list { display: flex; flex-direction: column; gap: 0.6em; }
            .dlna-item { display: flex; flex-direction: column; padding: 1em 1.4em;
                border-radius: 0.6em; background: rgba(255,255,255,0.05);
                transition: background 0.15s, transform 0.1s; cursor: pointer; }
            .dlna-item.focus { background: rgba(255,255,255,0.18); transform: scale(1.01); }
            .dlna-item__title { font-size: 1.1em; font-weight: 500; color: #fff;
                display: flex; align-items: center; gap: 0.6em; }
            .dlna-item__sub { font-size: 0.85em; color: rgba(255,255,255,0.55); margin-top: 0.3em; }
            .dlna-item--action { background: rgba(90,120,255,0.12); border: 1px solid rgba(90,120,255,0.3); }
            .dlna-hint { padding: 1em; color: rgba(255,255,255,0.5); font-size: 0.9em; text-align: center; }
            .dlna-loading { padding: 2em; text-align: center; color: rgba(255,255,255,0.6); }
            .dlna-status { display: inline-block; width: 0.6em; height: 0.6em;
                border-radius: 50%; background: #888; }
            .dlna-status--online { background: #4caf50; box-shadow: 0 0 6px #4caf50; }
            .dlna-status--offline { background: #f44336; }
            .dlna-status--checking { background: #ffc107; animation: dlna-pulse 1s infinite; }
            @keyframes dlna-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        `);
    }

    // ============================================================
    // КОМПОНЕНТ: СПИСОК СЕРВЕРОВ
    // ============================================================
    if (typeof Lampa !== 'undefined' && Lampa.Component) {
        Lampa.Component.add('dlna_servers', {
            create() {
                console.log('DLNA: create dlna_servers');
                this.el = document.createElement('div');
                this.el.className = 'dlna-servers';
                this.el.innerHTML = '<div class="dlna-servers__list"></div>';
                return this.el;
            },
            start() {
                console.log('DLNA: start dlna_servers');
                this.render();
            },
            render() {
                try {
                    const list = this.el.querySelector('.dlna-servers__list');
                    if (!list) { console.error('DLNA: list element not found'); return; }
                    list.innerHTML = '';
                    const servers = DLNAServers.get();
                    const lastId = Lampa.Storage.get('dlna_last_server', '');

                    servers.forEach(srv => {
                        const item = document.createElement('div');
                        item.className = 'dlna-item selector';
                        item.innerHTML = `
                            <div class="dlna-item__title">
                                <span class="dlna-status dlna-status--checking" data-status-id="${srv.id}"></span>
                                ${srv.name}${srv.id === lastId ? ' <span style="opacity:.5;font-size:.8em">• последний</span>' : ''}
                            </div>
                            <div class="dlna-item__sub">${srv.ip}:${srv.port}</div>`;
                        item.addEventListener('hover:enter', () => this.openMenu(srv));
                        list.appendChild(item);
                        checkServerStatus(srv).then(status => {
                            const dot = item.querySelector(`[data-status-id="${srv.id}"]`);
                            if (dot) dot.className = `dlna-status dlna-status--${status}`;
                        });
                    });

                    const addBtn = document.createElement('div');
                    addBtn.className = 'dlna-item dlna-item--action selector';
                    addBtn.innerHTML = '<div class="dlna-item__title">➕ Добавить сервер</div>';
                    addBtn.addEventListener('hover:enter', () => this.addFlow());
                    list.appendChild(addBtn);

                    if (servers.length === 0) {
                        const hint = document.createElement('div');
                        hint.className = 'dlna-hint';
                        hint.textContent = 'Серверов пока нет. Нажмите «Добавить сервер».';
                        list.insertBefore(hint, addBtn);
                    }
                    console.log('DLNA: rendered', servers.length, 'servers');
                } catch (e) {
                    console.error('DLNA: render error', e);
                }
            },
            openMenu(srv) {
                Lampa.Select.show({
                    title: srv.name,
                    items: [
                        { title: 'Открыть', act: 'browse' },
                        { title: 'Изменить', act: 'edit' },
                        { title: 'Удалить', act: 'delete' }
                    ],
                    onSelect: (it) => {
                        Lampa.Select.close();
                        if (it.act === 'browse') {
                            Lampa.Storage.set('dlna_last_server', srv.id);
                            Lampa.Activity.push({
                                component: 'dlna_browser',
                                title: srv.name, server: srv,
                                objectId: '0', sortMode: 'type'
                            });
                        } else if (it.act === 'edit') {
                            this.addFlow(srv);
                        } else if (it.act === 'delete') {
                            Lampa.Select.show({
                                title: 'Удалить сервер?',
                                items: [{ title: 'Да' }, { title: 'Нет' }],
                                onSelect: (ans) => {
                                    Lampa.Select.close();
                                    if (ans.title === 'Да') { DLNAServers.remove(srv.id); this.render(); }
                                }
                            });
                        }
                    },
                    onBack: () => Lampa.Controller.toggle('content')
                });
            },
            addFlow(existing) {
                const presets = [
                    { name: 'MiniDLNA', port: '8200' },
                    { name: 'Plex', port: '32469' },
                    { name: 'Jellyfin', port: '8096' },
                    { name: 'Windows Media', port: '2869' },
                    { name: 'Другое', port: '49152' }
                ];
                Lampa.Select.show({
                    title: 'Тип сервера', items: presets,
                    onSelect: (preset) => {
                        Lampa.Select.close();
                        Lampa.Input.edit({
                            title: 'IP-адрес',
                            value: existing ? existing.ip : Lampa.Storage.get('dlna_last_ip', '192.168.1.'),
                            free: true
                        }, (ip) => {
                            if (!ip) return;
                            Lampa.Storage.set('dlna_last_ip', ip);
                            Lampa.Input.edit({
                                title: 'Порт',
                                value: existing ? existing.port : preset.port, free: true
                            }, (port) => {
                                if (!port) return;
                                Lampa.Input.edit({
                                    title: 'Название',
                                    value: existing ? existing.name : preset.name, free: true
                                }, (name) => {
                                    if (!name) return;
                                    this.saveAndTest({ id: existing?.id, name, ip, port });
                                });
                            });
                        });
                    },
                    onBack: () => Lampa.Controller.toggle('content')
                });
            },
            async saveAndTest(server) {
                Lampa.Noty.show('Проверка подключения…');
                const probe = await probeServer(server.ip, server.port);
                if (!probe) { Lampa.Noty.show('Сервер не отвечает.', { style: 'error' }); return; }
                const baseURL = `http://${server.ip}:${server.port}${probe.path}`;
                const controlURL = extractControlURL(probe.doc, baseURL);
                if (!controlURL) { Lampa.Noty.show('ContentDirectory не найден.', { style: 'error' }); return; }
                const data = Object.assign({}, server, { path: probe.path, controlURL, controlURLTime: Date.now() });
                if (server.id) DLNAServers.update(server.id, data);
                else DLNAServers.add(data);
                Lampa.Noty.show('Готово: ' + server.name);
                this.render();
            },
            stop() {}, destroy() {}
        });

        // ============================================================
        // КОМПОНЕНТ: БРАУЗЕР
        // ============================================================
        Lampa.Component.add('dlna_browser', {
            create() {
                this.el = document.createElement('div');
                this.el.className = 'dlna-browser';
                this.el.innerHTML = '<div class="dlna-browser__list"></div>';
                return this.el;
            },
            start() {
                this.server = this.activity.server;
                this.objectId = this.activity.objectId || '0';
                this.sortMode = this.activity.sortMode || 'type';
                this._destroyed = false;
                this.load();
            },
            async load() {
                const list = this.el.querySelector('.dlna-browser__list');
                list.innerHTML = '<div class="dlna-loading">Загрузка…</div>';
                try {
                    if (!this.server.controlURL || Date.now() - (this.server.controlURLTime || 0) > 3600000) {
                        const probe = await probeServer(this.server.ip, this.server.port);
                        if (this._destroyed) return;
                        if (!probe) { list.innerHTML = '<div>Сервер недоступен.</div>'; return; }
                        const base = `http://${this.server.ip}:${this.server.port}${probe.path}`;
                        const ctrl = extractControlURL(probe.doc, base);
                        DLNAServers.update(this.server.id, { controlURL: ctrl, controlURLTime: Date.now() });
                        this.server.controlURL = ctrl;
                    }
                    const items = await browseDirectory(this.server.controlURL, this.objectId);
                    if (this._destroyed) return;
                    if (items.length === 0) { list.innerHTML = '<div>Папка пуста</div>'; return; }
                    this.renderItems(sortItems(items, this.sortMode), list);
                } catch (err) {
                    if (this._destroyed) return;
                    console.error('DLNA browse error:', err);
                    list.innerHTML = '<div>Не удалось загрузить содержимое</div>';
                    Lampa.Noty.show('Ошибка загрузки DLNA', { style: 'error', time: 5000 });
                }
            },
            renderItems(items, list) {
                list.innerHTML = '';
                const sortBtn = document.createElement('div');
                sortBtn.className = 'dlna-item dlna-item--action selector';
                sortBtn.innerHTML = `<div class="dlna-item__title">⇅ Сортировка: ${this.sortMode === 'name' ? 'по имени' : 'папки первыми'}</div>`;
                sortBtn.addEventListener('hover:enter', () => this.openSortMenu());
                list.appendChild(sortBtn);

                items.forEach(item => {
                    const el = document.createElement('div');
                    el.className = 'dlna-item selector';
                    el.innerHTML = `<div class="dlna-item__title">${item.title}</div>`;
                    el.addEventListener('hover:enter', () => this.onItem(item));
                    list.appendChild(el);
                });
            },
            onItem(item) {
                if (item.type === 'folder') {
                    Lampa.Activity.push({
                        component: 'dlna_browser', title: item.title,
                        server: this.server, objectId: item.id, sortMode: this.sortMode
                    });
                } else if (item.type === 'video') {
                    Lampa.Player.play({
                        url: item.url, title: item.title,
                        card: { title: item.title, poster_path: item.poster || '', overview: item.description || '' }
                    });
                }
            },
            openSortMenu() {
                Lampa.Select.show({
                    title: 'Сортировка',
                    items: [{ title: 'По имени', act: 'name' }, { title: 'Сначала папки', act: 'type' }],
                    onSelect: (item) => {
                        Lampa.Select.close();
                        Lampa.Activity.replace({
                            component: 'dlna_browser', title: this.activity.title,
                            server: this.server, objectId: this.objectId, sortMode: item.act
                        });
                    },
                    onBack: () => Lampa.Controller.toggle('content')
                });
            },
            stop() {},
            destroy() { this._destroyed = true; this.el.remove(); }
        });
    } else {
        console.error('DLNA: Lampa.Component API not available');
    }

    // ============================================================
    // ДОБАВЛЕНИЕ ПУНКТА В МЕНЮ (с повтором и несколькими селекторами)
    // ============================================================
    function addDLNAMenuItem(attempt) {
        attempt = attempt || 0;
        if (attempt > 15) { console.warn('DLNA: не удалось найти меню'); return; }

        const selectors = [
            '.menu .menu__list',
            '.menu__list',
            '.navigation .menu__list',
            '.menu-open .menu__list'
        ];
        let menu = null, usedSelector = '';
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) { menu = el; usedSelector = sel; break; }
        }

        if (!menu) {
            console.log('DLNA: menu not found, retry', attempt + 1);
            setTimeout(() => addDLNAMenuItem(attempt + 1), 500);
            return;
        }

        if (menu.querySelector('.menu__item--dlna')) {
            console.log('DLNA: menu item already exists');
            return;
        }

        console.log('DLNA: adding menu item to', usedSelector);
        const btn = document.createElement('li');
        btn.className = 'menu__item selector menu__item--dlna';
        btn.innerHTML = `<div class="menu__ico">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
        </div><div class="menu__text">DLNA</div>`;
        btn.addEventListener('hover:enter', () => {
            console.log('DLNA: menu clicked');
            Lampa.Activity.push({ component: 'dlna_servers', title: 'DLNA серверы' });
        });
        menu.appendChild(btn);
        console.log('DLNA: menu item added');
    }

    // ============================================================
    // ИНИЦИАЛИЗАЦИЯ
    // ============================================================
    function init() {
        console.log('DLNA Plugin v' + VERSION + ': init');
        try { injectStyles(); } catch (e) { console.error('DLNA: styles error', e); }

        try {
            Lampa.SettingsApi.addComponent({
                component: 'dlna_plugin',
                name: 'DLNA Плагин',
                icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>',
                before: 'interface'
            });
            Lampa.SettingsApi.addParam({
                component: 'dlna_plugin',
                param: { name: 'dlna_enabled', type: 'trigger', default: true },
                field: { name: 'Включить DLNA', description: 'Активировать пункт меню DLNA' }
            });
            Lampa.SettingsApi.addParam({
                component: 'dlna_plugin',
                param: { name: 'dlna_manage', type: 'trigger', default: false },
                field: { name: 'Управление серверами', description: 'Открыть список DLNA-серверов' },
                onChange: () => {
                    Lampa.Storage.set('dlna_manage', false);
                    Lampa.Activity.push({ component: 'dlna_servers', title: 'DLNA серверы' });
                }
            });
        } catch (e) { console.error('DLNA: settings error', e); }

        addDLNAMenuItem();
    }

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') init(); });
})();
