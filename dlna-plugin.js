(function () {
    'use strict';
    if (window.dlna_test_ready) return;
    window.dlna_test_ready = true;

    function init() {
        console.log('DLNA TEST: init OK');
        try {
            Lampa.Noty.show('DLNA TEST v2.0.0 загружен!', { time: 10000 });
        } catch (e) {
            console.error('DLNA TEST: Noty error', e);
        }
        try {
            Lampa.SettingsApi.addComponent({
                component: 'dlna_test',
                name: 'DLNA TEST',
                icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>'
            });
            Lampa.SettingsApi.addParam({
                component: 'dlna_test',
                param: { name: 'dlna_test_btn', type: 'button', default: '' },
                field: { name: 'Тест кнопки', description: 'Нажми меня' },
                onChange: () => {
                    Lampa.Noty.show('Кнопка нажата!', { time: 5000 });
                }
            });
        } catch (e) {
            console.error('DLNA TEST: SettingsApi error', e);
        }
    }

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') init(); });
})();
