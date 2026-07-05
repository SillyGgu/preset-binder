import {
    getRequestHeaders,
    saveSettingsDebounced,
    eventSource,
    event_types,
} from '../../../../script.js';

import {
    extension_settings,
} from '../../../extensions.js';

import {
    openai_setting_names,
    openai_settings,
    oai_settings,
    setupChatCompletionPromptManager,
} from '../../../openai.js';

import {
    callGenericPopup,
    POPUP_TYPE,
} from '../../../popup.js';

const extensionName = 'preset-binder';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const GLOBAL_PROMPT_ORDER_ID = 100001;
const MAX_MEMO_LENGTH = 20000;
const POPUP_THEME_PROPS = [
    '--pb-bg-main',
    '--pb-bg-header',
    '--pb-bg-input',
    '--pb-bg-group',
    '--pb-text-main',
    '--pb-text-sub',
    '--pb-accent',
    '--pb-accent-hover',
    '--pb-border',
    '--pb-border-light',
    '--pb-shadow',
    '--pb-control-border',
    '--pb-control-bg',
    '--pb-control-bg-hover',
    '--pb-picked-bg-start',
    '--pb-picked-bg-end',
    '--pb-picked-shadow',
];

const DEFAULT_SETTINGS = {
    showWandButton: true,
    rememberWindow: true,
    activeTab: 'current',
    theme: 'default',
    window: { left: 180, top: 110, width: 760, height: 560 },
    bindersByPreset: {},
    snapshotsByPreset: {},
    notesByPreset: {},
};

let settings;
let dragFrame = null;
let resizeFrame = null;
let promptSaveTimer = null;
let memoSaveTimer = null;
let stateSyncTimer = null;
let lastStateSyncSnapshot = '';

function ensureSettings() {
    settings = extension_settings[extensionName] = Object.assign(
        structuredClone(DEFAULT_SETTINGS),
        extension_settings[extensionName] || {},
    );
    settings.bindersByPreset ||= {};
    settings.snapshotsByPreset ||= {};
    settings.notesByPreset ||= {};
    settings.window ||= structuredClone(DEFAULT_SETTINGS.window);
    settings.theme ||= DEFAULT_SETTINGS.theme;
}

function saveSettings() {
    saveSettingsDebounced();
}

function savePromptSettingsDebounced(pm) {
    clearTimeout(promptSaveTimer);
    promptSaveTimer = setTimeout(() => {
        if (pm?.saveServiceSettings) pm.saveServiceSettings();
        else saveCurrentPresetFile();
    }, 250);
}

function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function getActiveTheme() {
    const className = document.getElementById('preset-binder-window')?.className || '';
    return className.match(/\btheme-([a-z0-9_-]+)\b/)?.[1] || settings.theme || 'default';
}

function getPopupThemeStyle() {
    const source = document.getElementById('preset-binder-window');
    if (!source) return '';
    const computed = getComputedStyle(source);
    return POPUP_THEME_PROPS
        .map(prop => {
            const value = computed.getPropertyValue(prop).trim();
            return value ? `${prop}:${value.replaceAll(';', '')}` : '';
        })
        .filter(Boolean)
        .join(';');
}

function syncDocumentThemeVariables() {
    const style = getPopupThemeStyle();
    const targets = [document.documentElement, document.body].filter(Boolean);
    const theme = getActiveTheme();

    document.documentElement.dataset.presetBinderTheme = theme;
    document.body.dataset.presetBinderTheme = theme;

    if (!style) return;
    for (const declaration of style.split(';')) {
        const [prop, ...valueParts] = declaration.split(':');
        const value = valueParts.join(':').trim();
        if (!prop?.trim() || !value) continue;
        for (const target of targets) {
            target.style.setProperty(prop.trim(), value);
        }
    }
}

function applyPopupThemeToElement(element, theme, style) {
    if (!element) return;
    element.classList.add('pb-popup-shell', 'pb-popup-theme', `theme-${theme}`);
    if (style) {
        for (const declaration of style.split(';')) {
            const [prop, ...valueParts] = declaration.split(':');
            const value = valueParts.join(':').trim();
            if (prop?.trim() && value) element.style.setProperty(prop.trim(), value);
        }
    }
}

function getThemedPopupHtml(html) {
    const theme = getActiveTheme();
    const style = getPopupThemeStyle();
    return `<div class="pb-popup-theme theme-${escapeHtml(theme)}" style="${escapeHtml(style)}">${html}</div>`;
}

function getPopupThemeAttribute() {
    const style = getPopupThemeStyle();
    return style ? ` style="${escapeHtml(style)}"` : '';
}

function applyPopupTheme(popupOrRoot) {
    applyThemeClass();
    syncDocumentThemeVariables();
    const theme = getActiveTheme();
    const style = getPopupThemeStyle();
    const themedElements = [
        popupOrRoot?.dlg,
        popupOrRoot?.body,
        popupOrRoot?.content,
        popupOrRoot?.buttonControls,
    ].filter(Boolean);

    const contentRoot = popupOrRoot?.content || popupOrRoot?.body || popupOrRoot?.dlg || popupOrRoot;
    const themedContent = contentRoot?.querySelector?.('.pb-picker, .pb-move-dialog, .pb-insert-dialog');
    const popupRoot = themedContent?.closest?.('.popup, .dialogue_popup, .modal, [role="dialog"]');
    if (themedContent) themedElements.push(themedContent);
    if (popupRoot) {
        themedElements.push(
            popupRoot,
            popupRoot.querySelector('.popup-body, .dialogue_popup_text, .modal-body'),
            popupRoot.querySelector('.popup-content, .dialogue_popup_content, .modal-content'),
            popupRoot.querySelector('.popup-controls, .dialogue_popup_controls, .modal-footer'),
        );
    }

    for (const element of themedElements) applyPopupThemeToElement(element, theme, style);
}

function withPopupThemeOptions(options = {}) {
    const originalOnOpen = options.onOpen;
    return {
        ...options,
        onOpen: popup => {
            applyPopupTheme(popup);
            if (typeof originalOnOpen === 'function') originalOnOpen(popup);
        },
    };
}

function normalizePromptName(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getCurrentPresetName() {
    return oai_settings?.preset_settings_openai || $('#settings_preset_openai option:selected').text().trim() || '';
}

function getPromptOrder(serviceSettings = oai_settings) {
    return (serviceSettings?.prompt_order || [])
        .find(entry => String(entry.character_id) === String(GLOBAL_PROMPT_ORDER_ID))?.order || [];
}

function getPromptManager() {
    return setupChatCompletionPromptManager(oai_settings);
}

function getPromptRows() {
    let serviceSettings = oai_settings;
    try {
        serviceSettings = getPromptManager().serviceSettings || oai_settings;
    } catch {
        serviceSettings = oai_settings;
    }

    const order = getPromptOrder(serviceSettings);
    const promptMap = new Map((serviceSettings?.prompts || []).map(prompt => [prompt.identifier, prompt]));

    return order
        .map(entry => {
            const prompt = promptMap.get(entry.identifier);
            if (!prompt) return null;
            return {
                id: entry.identifier,
                name: prompt.name || entry.identifier,
                enabled: !!entry.enabled,
                entry,
            };
        })
        .filter(Boolean);
}

function getPromptStateRowsDirect() {
    const order = getPromptOrder(oai_settings);
    return order.map(entry => ({
        id: entry.identifier,
        enabled: !!entry.enabled,
    }));
}

function getBindersForPreset(preset, create = false) {
    if (!preset) return [];
    if (create) settings.bindersByPreset[preset] ||= [];
    return settings.bindersByPreset[preset] || [];
}

function getSnapshotsForPreset(preset, create = false) {
    if (!preset) return [];
    if (create) settings.snapshotsByPreset[preset] ||= [];
    return settings.snapshotsByPreset[preset] || [];
}

function getCurrentBinders(create = false) {
    return getBindersForPreset(getCurrentPresetName(), create);
}

function getCurrentSnapshots(create = false) {
    return getSnapshotsForPreset(getCurrentPresetName(), create);
}

function getMemoRecordForPreset(preset) {
    if (!preset) return null;
    const record = settings.notesByPreset?.[preset];
    if (!record) return null;
    if (typeof record === 'string') return { text: record, updatedAt: 0 };
    return record;
}

function getMemoTextForPreset(preset) {
    return getMemoRecordForPreset(preset)?.text || '';
}

function setMemoForPreset(preset, text) {
    if (!preset) return;
    let value = String(text ?? '').replace(/\r\n/g, '\n');
    if (value.length > MAX_MEMO_LENGTH) {
        value = value.slice(0, MAX_MEMO_LENGTH);
        toastr.warning(`프리셋 메모는 ${MAX_MEMO_LENGTH.toLocaleString()}자까지만 저장됩니다.`);
    }

    if (!value.trim()) {
        delete settings.notesByPreset[preset];
    } else {
        settings.notesByPreset[preset] = {
            text: value,
            updatedAt: Date.now(),
        };
    }
    saveSettings();
}

function saveMemoDebounced(preset, text, onSaved = null) {
    clearTimeout(memoSaveTimer);
    memoSaveTimer = setTimeout(() => {
        setMemoForPreset(preset, text);
        if (typeof onSaved === 'function') onSaved();
    }, 300);
}

function formatMemoTime(timestamp) {
    if (!timestamp) return '저장 전';
    try {
        return new Date(timestamp).toLocaleString();
    } catch {
        return '저장됨';
    }
}

function getPresetData(presetName) {
    if (!presetName) return null;
    if (presetName === getCurrentPresetName()) return oai_settings;
    return openai_settings?.[openai_setting_names?.[presetName]] || null;
}

function getPresetNames() {
    return Object.keys(openai_setting_names || {})
        .filter(name => !!getPresetData(name))
        .sort((a, b) => a.localeCompare(b));
}

function getPromptRowsFromPreset(presetName) {
    const preset = getPresetData(presetName);
    if (!preset) return [];
    const order = getPromptOrder(preset);
    const promptMap = new Map((preset.prompts || []).map(prompt => [prompt.identifier, prompt]));
    const inOrder = new Set(order.map(entry => entry.identifier));

    const orderedRows = order
        .map((entry, index) => {
            const prompt = promptMap.get(entry.identifier);
            if (!prompt) return null;
            return {
                id: entry.identifier,
                name: prompt.name || entry.identifier,
                enabled: !!entry.enabled,
                index,
                entry,
            };
        })
        .filter(Boolean);
    const unorderedRows = (preset.prompts || [])
        .filter(prompt => !inOrder.has(prompt.identifier))
        .map((prompt, index) => ({
            id: prompt.identifier,
            name: prompt.name || prompt.identifier,
            enabled: false,
            index: orderedRows.length + index,
            entry: null,
        }));

    return [...orderedRows, ...unorderedRows];
}

function getUsedPromptIdsForPreset(presetName, exceptBinderId = null) {
    const used = new Set();
    for (const binder of getBindersForPreset(presetName)) {
        if (exceptBinderId && binder.id === exceptBinderId) continue;
        for (const promptId of binder.promptIds || []) {
            used.add(promptId);
        }
    }
    return used;
}

function makePromptLabels(prompts, promptIds) {
    const names = new Map(prompts.map(prompt => [prompt.id, prompt.name]));
    return Object.fromEntries(promptIds.map(promptId => [promptId, names.get(promptId) || promptId]));
}

function makeUniquePromptId(baseId, existingIds) {
    let id = baseId;
    if (!existingIds.has(id)) return id;
    const cleanBase = String(baseId || 'prompt').replace(/_\d+$/, '');
    let counter = 1;
    while (existingIds.has(`${cleanBase}_${counter}`)) counter++;
    return `${cleanBase}_${counter}`;
}

function removePromptsFromPreset(preset, promptIds) {
    const ids = new Set(promptIds);
    preset.prompts = (preset.prompts || []).filter(prompt => !ids.has(prompt.identifier));
    for (const orderBlock of preset.prompt_order || []) {
        if (orderBlock.order) {
            orderBlock.order = orderBlock.order.filter(entry => !ids.has(entry.identifier));
        }
    }
}

async function savePresetFile(presetName, preset) {
    if (!presetName || !preset) return;
    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ apiId: 'openai', name: presetName, preset }),
    });
    if (!response.ok) throw new Error(`Failed to save preset: ${presetName}`);
}

async function saveCurrentPresetFile() {
    const name = getCurrentPresetName();
    if (!name) return;
    try {
        await savePresetFile(name, oai_settings);
    } catch (error) {
        console.warn(`[${extensionName}] Failed to save preset`, error);
    }
}

function updateCurrentStPreset() {
    const $button = $('#update_oai_preset, [data-preset-manager-update="openai"]').first();
    if (!$button.length || $button.is(':disabled') || $button.hasClass('disabled')) {
        toastr.warning('ST 현재 프리셋 저장 버튼을 찾지 못했습니다.');
        return;
    }

    $button.trigger('click');
}

function getCurrentPresetLineHtml(preset) {
    return `
        <div class="pb-preset-line">
            <span>현재 프리셋</span>
            <strong>${escapeHtml(preset)}</strong>
            <button class="pb-icon-btn pb-save-st-preset" type="button" title="ST 현재 프리셋 업데이트" aria-label="ST 현재 프리셋 업데이트"><i class="fa-solid fa-save"></i></button>
        </div>
    `;
}

function bindCurrentPresetLine($scope) {
    $scope.find('.pb-save-st-preset').off('click.presetBinder').on('click.presetBinder', updateCurrentStPreset);
}

function setPromptEnabled(promptId, enabled) {
    const pm = getPromptManager();
    const entry = pm.getPromptOrderEntry(pm.activeCharacter, promptId)
        || getPromptOrder(pm.serviceSettings || oai_settings).find(item => item.identifier === promptId);
    if (!entry) return false;

    entry.enabled = !!enabled;
    if (pm.tokenHandler?.getCounts) {
        const counts = pm.tokenHandler.getCounts();
        counts[promptId] = null;
    }
    savePromptSettingsDebounced(pm);
    lastStateSyncSnapshot = '';
    return true;
}

function applySnapshot(snapshot) {
    const pm = getPromptManager();
    const order = getPromptOrder(pm.serviceSettings || oai_settings);
    const entries = new Map(order.map(entry => [entry.identifier, entry]));
    let changed = 0;

    for (const [promptId, enabled] of Object.entries(snapshot.states || {})) {
        const entry = pm.getPromptOrderEntry(pm.activeCharacter, promptId) || entries.get(promptId);
        if (!entry) continue;
        entry.enabled = !!enabled;
        changed++;
        if (pm.tokenHandler?.getCounts) {
            const counts = pm.tokenHandler.getCounts();
            counts[promptId] = null;
        }
    }

    pm.saveServiceSettings();
    toastr.success(`${snapshot.title} 불러오기 완료 (${changed}개)`);
    lastStateSyncSnapshot = '';
    updateVisibleToggleStates();
}

function toggleMarkedPrompt(row) {
    const $row = $(row);
    const binderIndex = Number($row.data('binder-index'));
    const promptId = $row.data('id');
    const binder = getCurrentBinders()[binderIndex];
    if (!binder) return;
    binder.markedPromptIds ||= [];
    const marked = new Set(binder.markedPromptIds);
    if (marked.has(promptId)) marked.delete(promptId);
    else marked.add(promptId);
    binder.markedPromptIds = [...marked];
    saveSettings();
    $row.toggleClass('pb-marked', marked.has(promptId));
}

async function addToWandMenu() {
    if ($('#preset_binder_wand_button').length > 0) return;

    try {
        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        const $menu = $('#extensionsMenu');
        if (!$menu.length) {
            setTimeout(addToWandMenu, 1000);
            return;
        }
        $menu.append(buttonHtml);
        $('#preset_binder_wand_button').on('click', openBinderWindow);
        updateWandButton();
    } catch (error) {
        console.error(`[${extensionName}] Failed to add wand button`, error);
        setTimeout(addToWandMenu, 1000);
    }
}

function updateWandButton() {
    $('#preset_binder_wand_button').toggle(!!settings.showWandButton);
}

function getMobileTopInset() {
    if (!window.matchMedia('(max-width: 680px)').matches) return 8;
    const selectorCandidates = [
        '#top-bar',
        '#topBar',
        '#top-settings-holder',
        '#top_settings_holder',
        '.top-bar',
        '.topBar',
        'header',
    ];
    const candidates = selectorCandidates
        .flatMap(selector => Array.from(document.querySelectorAll(selector)))
        .filter(Boolean);
    const fixedTopElements = Array.from(document.body.querySelectorAll('*')).filter(element => {
        const style = getComputedStyle(element);
        if (!['fixed', 'sticky'].includes(style.position)) return false;
        const rect = element.getBoundingClientRect();
        return rect.height > 0
            && rect.height < window.innerHeight * 0.35
            && rect.top <= 4
            && rect.bottom > 8;
    });

    const bottom = [...candidates, ...fixedTopElements].reduce((max, element) => {
        if (element.closest?.('#preset-binder-window')) return max;
        const rect = element.getBoundingClientRect();
        if (rect.height <= 0 || rect.top > 12 || rect.bottom > window.innerHeight * 0.4) return max;
        return Math.max(max, rect.bottom);
    }, 0);

    return Math.max(8, Math.ceil(bottom) + 8);
}

function applyMobileWindowInset() {
    const $window = $('#preset-binder-window');
    if (!$window.length) return;
    const top = getMobileTopInset();
    document.documentElement.style.setProperty('--pb-mobile-top-inset', `${top}px`);
}

function openBinderWindow() {
    if (!$('#preset-binder-window').length) {
        createBinderWindow();
    }
    applyMobileWindowInset();
    $('#preset-binder-window').show();
    renderBinderWindow();
}

function closeBinderWindow() {
    $('#preset-binder-window').hide();
}

function applyThemeClass() {
    const theme = settings.theme || 'default';
    const $window = $('#preset-binder-window');
    if (!$window.length) return;
    $window.removeClass((_, className) => (className.match(/\btheme-\S+/g) || []).join(' '));
    $window.addClass(`theme-${theme}`);
    syncDocumentThemeVariables();
}

function createBinderWindow() {
    const win = settings.rememberWindow ? settings.window : DEFAULT_SETTINGS.window;
    const html = `
        <div id="preset-binder-window" class="theme-${escapeHtml(settings.theme || 'default')}" style="left:${win.left}px;top:${win.top}px;width:${win.width}px;height:${win.height}px;">
            <div class="pb-titlebar">
                <div class="pb-title">
                    <i class="fa-solid fa-bookmark"></i>
                    <span>Preset Binder</span>
                </div>
                <button class="pb-icon-btn" id="pb-close" title="닫기" aria-label="닫기"><i class="fa-solid fa-times"></i></button>
            </div>
            <div class="pb-tabs">
                <button class="pb-tab" data-tab="current">현재 프리셋</button>
                <button class="pb-tab" data-tab="memo">프리셋 메모</button>
                <button class="pb-tab" data-tab="data">저장 데이터</button>
            </div>
            <div class="pb-toolbar">
                <button class="pb-primary" id="pb-add"><i class="fa-solid fa-plus"></i><span>추가</span></button>
                <button class="pb-soft" id="pb-save-snapshot"><i class="fa-solid fa-save"></i><span>저장</span></button>
                <select id="pb-snapshot-select"></select>
                <button class="pb-soft" id="pb-load-snapshot"><i class="fa-solid fa-undo"></i><span>불러오기</span></button>
            </div>
            <div class="pb-body"></div>
            <div class="pb-resize" title="크기 조절"></div>
        </div>
    `;

    $('body').append(html);
    $('#pb-close').on('click', closeBinderWindow);
    $('#pb-add').on('click', openPromptPicker);
    $('#pb-save-snapshot').on('click', saveCurrentSnapshot);
    $('#pb-load-snapshot').on('click', loadSelectedSnapshot);
    $('#preset-binder-window .pb-tab').on('click', function () {
        settings.activeTab = $(this).data('tab');
        saveSettings();
        renderBinderWindow();
    });
    enableWindowDrag();
    enableWindowResize();
}

function renderBinderWindow() {
    const $window = $('#preset-binder-window');
    if (!$window.length || !$window.is(':visible')) return;
    applyThemeClass();
    applyMobileWindowInset();

    const preset = getCurrentPresetName();
    const snapshots = getCurrentSnapshots();
    const $select = $('#pb-snapshot-select');
    const validTabs = new Set(['current', 'memo', 'data']);
    if (!validTabs.has(settings.activeTab)) settings.activeTab = 'current';
    $window.toggleClass('pb-tab-memo', settings.activeTab === 'memo');

    $window.find('.pb-tab').removeClass('active');
    $window.find(`.pb-tab[data-tab="${settings.activeTab}"]`).addClass('active');

    $select.empty().append('<option value="">저장된 설정 선택</option>');
    snapshots.forEach(snapshot => {
        $select.append(`<option value="${escapeHtml(snapshot.id)}">${escapeHtml(snapshot.title)}</option>`);
    });

    if (settings.activeTab === 'data') {
        renderDataTab(preset, snapshots);
    } else if (settings.activeTab === 'memo') {
        renderMemoTab(preset);
    } else {
        renderCurrentTab(preset);
    }
}

function renderCurrentTab(preset) {
    const $body = $('#preset-binder-window .pb-body');
    let prompts = [];
    try {
        prompts = getPromptRows();
    } catch (error) {
        $body.html('<div class="pb-empty">현재 프리셋의 프롬프트를 읽지 못했습니다.</div>');
        return;
    }

    const stateById = new Map(prompts.map(row => [row.id, row.enabled]));
    const nameById = new Map(prompts.map(row => [row.id, row.name]));
    const binders = getCurrentBinders();

    if (!preset) {
        $body.html('<div class="pb-empty">먼저 프리셋을 선택하세요.</div>');
        return;
    }

    if (!binders.length) {
        $body.html(`
            ${getCurrentPresetLineHtml(preset)}
            <div class="pb-empty">아직 묶음이 없습니다. 상단의 추가 버튼으로 첫 묶음을 만들어보세요.</div>
        `);
        bindCurrentPresetLine($body);
        return;
    }

    const cards = binders.map((binder, binderIndex) => {
        binder.markedPromptIds ||= [];
        const markedIds = new Set(binder.markedPromptIds);
        const rows = binder.promptIds.map(promptId => {
            const name = nameById.get(promptId) || binder.promptLabels?.[promptId] || promptId;
            const enabled = stateById.get(promptId) || false;
            return `
                <div class="pb-prompt-toggle${markedIds.has(promptId) ? ' pb-marked' : ''}" data-binder-index="${binderIndex}" data-id="${escapeHtml(promptId)}">
                    <span title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                    <input type="checkbox" class="pb-toggle-input" data-id="${escapeHtml(promptId)}" ${enabled ? 'checked' : ''}>
                </div>
            `;
        }).join('');
        const isFirst = binderIndex === 0;
        const isLast = binderIndex === binders.length - 1;

        return `
            <section class="pb-card" data-index="${binderIndex}">
                <header>
                    <strong>${escapeHtml(binder.title)}</strong>
                    <div class="pb-card-actions">
                        <button class="pb-icon-btn pb-move-binder-order" data-index="${binderIndex}" data-dir="up" title="위로" aria-label="위로" ${isFirst ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
                        <button class="pb-icon-btn pb-move-binder-order" data-index="${binderIndex}" data-dir="down" title="아래로" aria-label="아래로" ${isLast ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
                        <button class="pb-icon-btn pb-edit-binder" data-index="${binderIndex}" title="편집" aria-label="편집"><i class="fa-solid fa-pencil"></i></button>
                        <button class="pb-icon-btn pb-transfer-binder" data-index="${binderIndex}" title="이동/복사" aria-label="이동/복사"><i class="fa-solid fa-arrow-right"></i></button>
                        <button class="pb-icon-btn pb-delete-binder" data-index="${binderIndex}" title="삭제" aria-label="삭제"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </header>
                <div class="pb-card-list">${rows || '<div class="pb-muted">현재 프리셋에 남아있는 프롬프트가 없습니다.</div>'}</div>
            </section>
        `;
    }).join('');

    $body.html(`
        ${getCurrentPresetLineHtml(preset)}
        <div class="pb-mobile-hint">토글을 길게 눌러 표시</div>
        <div class="pb-card-grid">${cards}</div>
    `);

    bindCurrentPresetLine($body);

    $body.find('.pb-toggle-input').on('pointerdown click', function (event) {
        event.stopPropagation();
    });

    $body.find('.pb-toggle-input').on('change', function () {
        const promptId = $(this).data('id');
        const checked = $(this).prop('checked');
        const ok = setPromptEnabled(promptId, checked);
        if (!ok) toastr.warning('프롬프트를 찾지 못했습니다.');
        $body.find('.pb-toggle-input').filter((_, input) => $(input).data('id') === promptId).prop('checked', checked);
    });

    $body.find('.pb-prompt-toggle').on('contextmenu', function (event) {
        event.preventDefault();
        if (this._pbIgnoreContextUntil && Date.now() < this._pbIgnoreContextUntil) return;
        toggleMarkedPrompt(this);
    });

    $body.find('.pb-prompt-toggle').each((_, row) => {
        let pressTimer = null;
        let startX = 0;
        let startY = 0;
        let longPressed = false;
        const clearPress = () => {
            if (pressTimer) clearTimeout(pressTimer);
            pressTimer = null;
        };

        row.addEventListener('pointerdown', event => {
            if (!window.matchMedia('(max-width: 680px)').matches) return;
            if (event.target.closest('.pb-toggle-input')) return;
            startX = event.clientX;
            startY = event.clientY;
            longPressed = false;
            row.classList.add('pb-pressing');
            clearPress();
            pressTimer = setTimeout(() => {
                longPressed = true;
                row._pbIgnoreContextUntil = Date.now() + 900;
                row.classList.remove('pb-pressing');
                toggleMarkedPrompt(row);
            }, 550);
        });

        row.addEventListener('pointermove', event => {
            if (!pressTimer) return;
            if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) {
                row.classList.remove('pb-pressing');
                clearPress();
            }
        });

        row.addEventListener('pointerup', event => {
            row.classList.remove('pb-pressing');
            clearPress();
            if (longPressed) {
                event.preventDefault();
                event.stopPropagation();
            }
        });

        row.addEventListener('pointercancel', () => {
            row.classList.remove('pb-pressing');
            clearPress();
        });
    });

    $body.find('.pb-move-binder-order').on('click', function () {
        const index = Number($(this).data('index'));
        const dir = $(this).data('dir');
        const binders = getCurrentBinders();
        const targetIndex = dir === 'up' ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= binders.length) return;
        [binders[index], binders[targetIndex]] = [binders[targetIndex], binders[index]];
        saveSettings();
        renderBinderWindow();
    });

    $body.find('.pb-edit-binder').on('click', function () {
        editBinder(Number($(this).data('index')));
    });

    $body.find('.pb-transfer-binder').on('click', function () {
        transferBinder(Number($(this).data('index')));
    });

    $body.find('.pb-delete-binder').on('click', async function () {
        const index = Number($(this).data('index'));
        const binders = getCurrentBinders();
        const title = binders[index]?.title || '묶음';
        const ok = await callGenericPopup(`"${title}" 묶음을 삭제할까요?`, POPUP_TYPE.CONFIRM);
        if (!ok) return;
        binders.splice(index, 1);
        saveSettings();
        renderBinderWindow();
    });
}

function renderMemoTab(preset) {
    const $body = $('#preset-binder-window .pb-body');
    if (!preset) {
        $body.html('<div class="pb-empty">먼저 프리셋을 선택하세요.</div>');
        return;
    }

    const record = getMemoRecordForPreset(preset);
    const memo = record?.text || '';
    $body.html(`
        ${getCurrentPresetLineHtml(preset)}
        <section class="pb-memo-panel">
            <textarea id="pb-preset-memo" class="pb-memo-textarea" maxlength="${MAX_MEMO_LENGTH}" placeholder="프리셋 제작자의 안내, 사용법, 주의사항을 적어두세요.">${escapeHtml(memo)}</textarea>
            <div class="pb-memo-footer">
                <span id="pb-memo-status">마지막 저장: ${escapeHtml(formatMemoTime(record?.updatedAt))}</span>
                <span id="pb-memo-count">${memo.length.toLocaleString()} / ${MAX_MEMO_LENGTH.toLocaleString()}</span>
                <button class="pb-soft" id="pb-clear-memo" type="button"><i class="fa-solid fa-eraser"></i><span>비우기</span></button>
            </div>
        </section>
    `);
    bindCurrentPresetLine($body);

    const $textarea = $('#pb-preset-memo');
    const $status = $('#pb-memo-status');
    const $count = $('#pb-memo-count');

    $textarea.on('input', function () {
        const value = this.value;
        $count.text(`${value.length.toLocaleString()} / ${MAX_MEMO_LENGTH.toLocaleString()}`);
        $status.text('저장 대기 중...');
        saveMemoDebounced(preset, value, () => {
            $status.text(`마지막 저장: ${formatMemoTime(Date.now())}`);
        });
    });

    $textarea.on('blur', function () {
        clearTimeout(memoSaveTimer);
        setMemoForPreset(preset, this.value);
        $status.text(`마지막 저장: ${formatMemoTime(Date.now())}`);
    });

    $('#pb-clear-memo').on('click', function () {
        clearTimeout(memoSaveTimer);
        $textarea.val('');
        setMemoForPreset(preset, '');
        $count.text(`0 / ${MAX_MEMO_LENGTH.toLocaleString()}`);
        $status.text('메모가 비워졌습니다.');
    });
}

function renderDataTab(preset, snapshots) {
    const allPresetNames = [...new Set([
        ...Object.keys(settings.bindersByPreset || {}),
        ...Object.keys(settings.snapshotsByPreset || {}),
        ...Object.keys(settings.notesByPreset || {}),
    ])].filter(presetName => {
        if (!presetName) return false;
        const presetBinders = settings.bindersByPreset[presetName];
        const presetSnapshots = settings.snapshotsByPreset[presetName];
        const presetMemo = getMemoTextForPreset(presetName);
        return (Array.isArray(presetBinders) && presetBinders.length > 0)
            || (Array.isArray(presetSnapshots) && presetSnapshots.length > 0)
            || !!presetMemo.trim();
    }).sort((a, b) => a.localeCompare(b));
    const totalBinders = Object.values(settings.bindersByPreset || {})
        .reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
    const totalSnapshots = Object.values(settings.snapshotsByPreset || {})
        .reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
    const totalNotes = Object.values(settings.notesByPreset || {})
        .reduce((sum, record) => {
            const text = typeof record === 'string' ? record : record?.text;
            return sum + (String(text || '').trim() ? 1 : 0);
        }, 0);
    const presetSections = allPresetNames.map(presetName => {
        const presetBinders = settings.bindersByPreset[presetName] || [];
        const presetSnapshots = settings.snapshotsByPreset[presetName] || [];
        const presetMemo = getMemoRecordForPreset(presetName);
        const memoText = presetMemo?.text || '';
        const memoSummary = memoText.replace(/\s+/g, ' ').trim();
        const binderRows = presetBinders.map(binder => {
            const names = binder.promptIds.map(promptId => binder.promptLabels?.[promptId] || promptId);
            const summary = names.slice(0, 5).join(', ') + (names.length > 5 ? ` 외 ${names.length - 5}개` : '');
            return `
                <div class="pb-data-row">
                    <b>${escapeHtml(binder.title)}</b>
                    <span title="${escapeHtml(names.join(', '))}">${escapeHtml(summary || '프롬프트 없음')}</span>
                    <button class="pb-icon-btn pb-delete-data-binder" data-preset="${escapeHtml(presetName)}" data-id="${escapeHtml(binder.id)}" title="묶음 삭제" aria-label="묶음 삭제"><i class="fa-solid fa-trash"></i></button>
                </div>
            `;
        }).join('');
        const snapshotRows = presetSnapshots.map(snapshot => `
            <div class="pb-snapshot-row">
                <span>${escapeHtml(snapshot.title)}</span>
                <button class="pb-icon-btn pb-delete-snapshot" data-preset="${escapeHtml(presetName)}" data-id="${escapeHtml(snapshot.id)}" title="삭제" aria-label="삭제"><i class="fa-solid fa-trash"></i></button>
            </div>
        `).join('');
        const memoRow = memoSummary ? `
            <div class="pb-data-row pb-data-memo-row">
                <b>프리셋 메모</b>
                <span title="${escapeHtml(memoSummary)}">${escapeHtml(memoSummary.slice(0, 120))}${memoSummary.length > 120 ? '...' : ''}</span>
                <button class="pb-icon-btn pb-delete-memo" data-preset="${escapeHtml(presetName)}" title="메모 삭제" aria-label="메모 삭제"><i class="fa-solid fa-trash"></i></button>
            </div>
        ` : '';

        return `
            <section class="pb-data-section">
                <header>
                    <strong>${escapeHtml(presetName)}</strong>
                    <small>묶음 ${presetBinders.length}개 · 저장 ${presetSnapshots.length}개 · 메모 ${memoSummary ? 1 : 0}개</small>
                </header>
                ${binderRows ? `<div class="pb-data-list">${binderRows}</div>` : '<div class="pb-empty compact">저장된 묶음이 없습니다.</div>'}
                ${snapshotRows ? `<div class="pb-snapshot-list">${snapshotRows}</div>` : ''}
                ${memoRow ? `<div class="pb-data-list">${memoRow}</div>` : ''}
            </section>
        `;
    }).join('');
    const $body = $('#preset-binder-window .pb-body');
    $body.html(`
        <div class="pb-data-panel">
            <div class="pb-theme-panel">
                <span>테마 선택</span>
                <div class="pb-theme-dots">
                    ${['default', 'lavender', 'pink', 'blue', 'white', 'dark'].map(theme => `
                        <button class="pb-theme-dot pb-theme-${theme}${(settings.theme || 'default') === theme ? ' active' : ''}" data-theme="${theme}" title="${theme}" aria-label="${theme}"></button>
                    `).join('')}
                </div>
            </div>
            <div class="pb-preset-line">
                <span>현재 프리셋</span>
                <strong>${escapeHtml(preset || '프리셋 없음')}</strong>
            </div>
            <button class="pb-danger" id="pb-clear-current"><i class="fa-solid fa-eraser"></i><span>현재 프리셋 데이터 삭제</span></button>
            <button class="pb-danger" id="pb-clear-all"><i class="fa-solid fa-trash"></i><span>Preset Binder 전체 데이터 삭제</span></button>
            <div class="pb-data-summary">
                <div><b>${totalBinders}</b><span>전체 묶음</span></div>
                <div><b>${totalSnapshots}</b><span>전체 저장 설정</span></div>
                <div><b>${totalNotes}</b><span>전체 메모</span></div>
            </div>
            ${presetSections || '<div class="pb-empty compact">저장된 데이터가 없습니다.</div>'}
        </div>
    `);

    $('#pb-clear-current').on('click', clearCurrentPresetData);
    $('#pb-clear-all').on('click', clearAllData);
    $('.pb-theme-dot').on('click', function () {
        settings.theme = $(this).data('theme') || 'default';
        saveSettings();
        applyThemeClass();
        renderBinderWindow();
    });
    $('.pb-delete-snapshot').on('click', function () {
        deleteSnapshot($(this).data('id'), $(this).data('preset'));
    });
    $('.pb-delete-data-binder').on('click', function () {
        deleteBinderFromPreset($(this).data('preset'), $(this).data('id'));
    });
    $('.pb-delete-memo').on('click', function () {
        deleteMemoFromPreset($(this).data('preset'));
    });
}

async function showPromptSelectionPopup({
    presetName,
    initialIds = [],
    excludedIds = new Set(),
    initialTitle = '',
    requireTitle = true,
    okButton = '등록',
}) {
    const prompts = presetName === getCurrentPresetName() ? getPromptRows() : getPromptRowsFromPreset(presetName);
    const initialSet = new Set(initialIds);
    const visiblePrompts = prompts.filter(prompt => initialSet.has(prompt.id) || !excludedIds.has(prompt.id));

    if (!visiblePrompts.length) {
        toastr.warning('선택할 프롬프트가 없습니다.');
        return null;
    }

    const selectedIds = new Set(initialIds);
    let titleValue = initialTitle;
    const rows = visiblePrompts.map((prompt, index) => `
        <label class="pb-picker-row" data-id="${escapeHtml(prompt.id)}">
            <input type="checkbox" class="pb-picker-check" data-id="${escapeHtml(prompt.id)}" data-index="${index}" ${selectedIds.has(prompt.id) ? 'checked' : ''}>
            <span>${escapeHtml(prompt.name)}</span>
            <em class="${prompt.enabled ? 'pb-state-on' : 'pb-state-off'}">${prompt.enabled ? 'ON' : 'OFF'}</em>
        </label>
    `).join('');

    const pickerHtml = `
        <div class="pb-picker"${getPopupThemeAttribute()}>
            ${requireTitle ? `
                <label class="pb-picker-title">
                    <span>묶음 이름</span>
                    <input type="text" id="pb-picker-title-input" value="${escapeHtml(initialTitle)}" placeholder="묶음 이름">
                </label>
            ` : ''}
            <div class="pb-picker-tools">
                <button class="pb-picker-btn" id="pb-picker-all" type="button">전체</button>
                <button class="pb-picker-btn" id="pb-picker-none" type="button">해제</button>
            </div>
            <div class="pb-picker-list">${rows}</div>
        </div>
    `;

    const observer = new MutationObserver(() => {
        applyPopupTheme(document.body);
        const syncPickedRows = () => {
            $('.pb-picker-check').each((_, input) => {
                $(input).closest('.pb-picker-row').toggleClass('pb-picked', $(input).prop('checked'));
            });
        };
        const guardOkButton = () => {
            if (!requireTitle) return;
            const input = document.getElementById('pb-picker-title-input');
            if (!input || input._pbGuarded) return;
            input._pbGuarded = true;
            const popup = input.closest('.popup, .dialogue_popup, .modal, [role="dialog"]') || document.body;
            popup.addEventListener('click', event => {
                const target = event.target.closest('button, .menu_button, input[type="button"]');
                if (!target) return;
                const text = (target.textContent || target.value || '').trim();
                const isCancel = /취소|cancel/i.test(text);
                const isOk = !isCancel && (
                    target.id?.toLowerCase().includes('ok')
                    || target.className?.toString().toLowerCase().includes('ok')
                    || text === okButton
                    || /확인|등록|저장|ok/i.test(text)
                );
                if (!isOk || input.value.trim()) return;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                input.focus();
                input.classList.add('pb-title-missing');
                toastr.warning('묶음 이름을 입력하세요.');
            }, true);
        };
        $('#pb-picker-title-input').off('input.pb').on('input.pb', function () {
            titleValue = $(this).val();
            $(this).toggleClass('pb-title-missing', !titleValue.trim());
        });
        $('#pb-picker-all').off('click.pb').on('click.pb', () => {
            visiblePrompts.forEach(prompt => selectedIds.add(prompt.id));
            $('.pb-picker-check').prop('checked', true);
            syncPickedRows();
        });
        $('#pb-picker-none').off('click.pb').on('click.pb', () => {
            selectedIds.clear();
            $('.pb-picker-check').prop('checked', false);
            syncPickedRows();
        });
        $('.pb-picker-check').off('change.pb').on('change.pb', function () {
            const promptId = $(this).data('id');
            if ($(this).prop('checked')) selectedIds.add(promptId);
            else selectedIds.delete(promptId);
            syncPickedRows();
        });
        syncPickedRows();
        guardOkButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const confirmed = await callGenericPopup(getThemedPopupHtml(pickerHtml), POPUP_TYPE.CONFIRM, '', withPopupThemeOptions({ okButton, cancelButton: '취소' }));
    titleValue = $('#pb-picker-title-input').val() || titleValue;
    observer.disconnect();
    if (!confirmed) return null;

    const selected = [...selectedIds];
    if (!selected.length) {
        toastr.warning('선택한 프롬프트가 없습니다.');
        return null;
    }

    if (requireTitle && !titleValue?.trim()) {
        toastr.warning('묶음 이름을 입력하세요.');
        return null;
    }

    return {
        title: titleValue.trim(),
        promptIds: selected,
        prompts,
    };
}

async function openPromptPicker() {
    const presetName = getCurrentPresetName();
    const result = await showPromptSelectionPopup({
        presetName,
        excludedIds: getUsedPromptIdsForPreset(presetName),
        okButton: '등록',
    });
    if (!result) return;

    getCurrentBinders(true).push({
        id: makeId('binder'),
        title: result.title,
        promptIds: result.promptIds,
        promptLabels: makePromptLabels(result.prompts, result.promptIds),
        markedPromptIds: [],
        createdAt: Date.now(),
    });
    saveSettings();
    renderBinderWindow();
}

async function editBinder(index) {
    const presetName = getCurrentPresetName();
    const binders = getCurrentBinders();
    const binder = binders[index];
    if (!binder) return;

    const result = await showPromptSelectionPopup({
        presetName,
        initialIds: binder.promptIds || [],
        excludedIds: getUsedPromptIdsForPreset(presetName, binder.id),
        initialTitle: binder.title,
        okButton: '저장',
    });
    if (!result) return;

    const selectedSet = new Set(result.promptIds);
    binder.title = result.title;
    binder.promptIds = result.promptIds;
    binder.promptLabels = makePromptLabels(result.prompts, result.promptIds);
    binder.markedPromptIds = (binder.markedPromptIds || []).filter(promptId => selectedSet.has(promptId));
    saveSettings();
    renderBinderWindow();
}

async function chooseDestinationPreset(sourcePreset) {
    const destinationNames = getPresetNames().filter(name => name !== sourcePreset);
    const options = destinationNames
        .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
        .join('');
    if (!options) {
        toastr.warning('이동할 대상 프리셋이 없습니다.');
        return null;
    }

    let selected = destinationNames[0] || '';
    let mode = 'copy';
    const html = `
        <div class="pb-move-dialog"${getPopupThemeAttribute()}>
            <label>
                <span>도착 프리셋</span>
                <select id="pb-move-preset">${options}</select>
            </label>
            <div class="pb-transfer-mode">
                <label><input type="radio" name="pb-transfer-mode" value="copy" checked> 복사: 원본 프리셋은 그대로 둡니다</label>
                <label><input type="radio" name="pb-transfer-mode" value="move"> 이동: 성공 후 원본 프리셋에서 해당 프롬프트와 묶음을 제거합니다</label>
            </div>
        </div>
    `;
    const observer = new MutationObserver(() => {
        applyPopupTheme(document.body);
        const $select = $('#pb-move-preset');
        if (!$select.length) return;
        selected ||= $select.val();
        $select.off('change.pb').on('change.pb', function () {
            selected = $(this).val();
        });
        $('input[name="pb-transfer-mode"]').off('change.pb').on('change.pb', function () {
            mode = $(this).val();
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const ok = await callGenericPopup(getThemedPopupHtml(html), POPUP_TYPE.CONFIRM, '', withPopupThemeOptions({ okButton: '다음', cancelButton: '취소' }));
    selected = $('#pb-move-preset').val() || selected;
    mode = $('input[name="pb-transfer-mode"]:checked').val() || mode;
    observer.disconnect();
    return ok ? { presetName: selected, mode } : null;
}

async function chooseInsertAfterPrompt(targetPresetName, matchedIds) {
    const prompts = getPromptRowsFromPreset(targetPresetName);
    const movingIds = new Set(matchedIds);
    const visiblePrompts = prompts.filter(prompt => !movingIds.has(prompt.id));
    const rows = [
        `<button class="pb-insert-slot" data-after=""><span></span><b>맨 위에 넣기</b><span></span></button>`,
        ...visiblePrompts.map(prompt => `
            <div class="pb-insert-row">
                <span>${escapeHtml(prompt.name)}</span>
            </div>
            <button class="pb-insert-slot" data-after="${escapeHtml(prompt.id)}"><span></span><b>이 아래에 넣기</b><span></span></button>
        `),
    ].join('');

    let insertAfterId = '';
    const html = `
        <div class="pb-insert-dialog"${getPopupThemeAttribute()}>
            <div class="pb-insert-note">도착 프리셋에서 묶음이 들어갈 위치를 선택하세요.</div>
            <div class="pb-insert-list">${rows}</div>
        </div>
    `;
    const observer = new MutationObserver(() => {
        applyPopupTheme(document.body);
        $('.pb-insert-slot').off('click.pb').on('click.pb', function (event) {
            event.preventDefault();
            insertAfterId = $(this).data('after') || '';
            $('.pb-insert-slot').removeClass('pb-slot-selected');
            $(this).addClass('pb-slot-selected');
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const ok = await callGenericPopup(getThemedPopupHtml(html), POPUP_TYPE.CONFIRM, '', withPopupThemeOptions({ okButton: '이동', cancelButton: '취소' }));
    observer.disconnect();
    return ok ? insertAfterId : null;
}

async function transferBinder(index) {
    const sourcePresetName = getCurrentPresetName();
    const sourceBinders = getCurrentBinders();
    const binder = sourceBinders[index];
    if (!binder) return;

    const destination = await chooseDestinationPreset(sourcePresetName);
    if (!destination?.presetName) return;
    const targetPresetName = destination.presetName;

    const sourcePreset = getPresetData(sourcePresetName);
    const targetPreset = getPresetData(targetPresetName);
    if (!sourcePreset || !targetPreset) {
        toastr.error('프리셋 데이터를 읽지 못했습니다.');
        return;
    }
    const targetPrompts = getPromptRowsFromPreset(targetPresetName);
    const sourcePrompts = getPromptRowsFromPreset(sourcePresetName);
    const sourceById = new Map(sourcePrompts.map(prompt => [prompt.id, prompt]));
    const sourcePromptDefs = new Map((sourcePreset.prompts || []).map(prompt => [prompt.identifier, prompt]));
    const targetByName = new Map(targetPrompts.map(prompt => [normalizePromptName(prompt.name), prompt]));
    const targetById = new Map(targetPrompts.map(prompt => [prompt.id, prompt]));
    const targetExistingIds = new Set((targetPreset.prompts || []).map(prompt => prompt.identifier));
    const targetOrder = getPromptOrder(targetPreset);
    const targetOrderIds = new Set(targetOrder.map(entry => entry.identifier));
    const transferRows = [];
    const missingSourceDefs = [];

    for (const sourcePromptId of binder.promptIds || []) {
        const sourceName = sourceById.get(sourcePromptId)?.name
            || binder.promptLabels?.[sourcePromptId]
            || sourcePromptId;
        const sourceEnabled = sourceById.get(sourcePromptId)?.enabled ?? true;
        const existingTarget = targetByName.get(normalizePromptName(sourceName)) || targetById.get(sourcePromptId);
        if (existingTarget) {
            transferRows.push({ id: existingTarget.id, name: existingTarget.name, enabled: sourceEnabled, created: false, sourceId: sourcePromptId });
            continue;
        }

        const sourceDef = sourcePromptDefs.get(sourcePromptId);
        if (!sourceDef) {
            missingSourceDefs.push(sourceName);
            continue;
        }

        const clonedPrompt = JSON.parse(JSON.stringify(sourceDef));
        const newId = makeUniquePromptId(clonedPrompt.identifier || sourcePromptId, targetExistingIds);
        const wasRenamed = newId !== clonedPrompt.identifier;
        clonedPrompt.identifier = newId;
        if (wasRenamed) {
            clonedPrompt.name = clonedPrompt.name ? `${clonedPrompt.name} (${newId.split('_').at(-1)})` : newId;
        }
        targetExistingIds.add(newId);
        targetPreset.prompts ||= [];
        targetPreset.prompts.push(clonedPrompt);
        transferRows.push({
            id: newId,
            name: clonedPrompt.name || newId,
            enabled: sourceEnabled,
            created: true,
            sourceId: sourcePromptId,
        });
    }

    if (!transferRows.length) {
        const preview = missingSourceDefs.slice(0, 3).join(', ');
        toastr.warning(`원본 프리셋에서 복사할 프롬프트 정의를 찾지 못했습니다${preview ? `: ${preview}` : ''}`);
        return;
    }

    const transferIds = transferRows.map(prompt => prompt.id);
    const insertAfterId = await chooseInsertAfterPrompt(targetPresetName, transferIds);
    if (insertAfterId === null) return;

    const moving = [];
    const remaining = [];
    const movingSet = new Set(transferIds);
    for (const entry of targetOrder) {
        if (movingSet.has(entry.identifier)) {
            const transferRow = transferRows.find(prompt => prompt.id === entry.identifier);
            moving.push({ ...entry, enabled: transferRow?.enabled ?? entry.enabled });
        }
        else remaining.push(entry);
    }
    for (const prompt of transferRows) {
        if (!targetOrderIds.has(prompt.id)) {
            moving.push({ identifier: prompt.id, enabled: prompt.enabled });
        }
    }

    const insertAt = insertAfterId
        ? Math.max(0, remaining.findIndex(entry => entry.identifier === insertAfterId) + 1)
        : 0;
    remaining.splice(insertAt, 0, ...moving);
    const orderBlock = (targetPreset.prompt_order || [])
        .find(entry => String(entry.character_id) === String(GLOBAL_PROMPT_ORDER_ID));
    if (orderBlock) orderBlock.order = remaining;

    const targetBinders = getBindersForPreset(targetPresetName, true);
    let title = binder.title;
    if (targetBinders.some(item => item.title === title)) {
        title = `${title} 복사`;
    }
    targetBinders.push({
        id: makeId('binder'),
        title,
        promptIds: transferIds,
        promptLabels: Object.fromEntries(transferRows.map(prompt => [prompt.id, prompt.name])),
        markedPromptIds: [],
        createdAt: Date.now(),
    });

    try {
        await savePresetFile(targetPresetName, targetPreset);
        if (destination.mode === 'move') {
            removePromptsFromPreset(sourcePreset, binder.promptIds || []);
            sourceBinders.splice(index, 1);
            await savePresetFile(sourcePresetName, sourcePreset);
            if (sourcePresetName === getCurrentPresetName()) {
                oai_settings.prompts = sourcePreset.prompts;
                oai_settings.prompt_order = sourcePreset.prompt_order;
            }
        }
        saveSettings();
        const verb = destination.mode === 'move' ? '이동' : '복사';
        const createdCount = transferRows.filter(prompt => prompt.created).length;
        const suffix = missingSourceDefs.length ? ` / 원본 누락 ${missingSourceDefs.length}개` : '';
        toastr.success(`${targetPresetName}에 묶음을 ${verb}했습니다. (${transferIds.length}개, 새로 추가 ${createdCount}개${suffix})`);
        renderBinderWindow();
    } catch (error) {
        console.error(`[${extensionName}] transfer failed`, error);
        toastr.error('대상 프리셋 저장에 실패했습니다.');
    }
}

async function saveCurrentSnapshot() {
    let prompts = [];
    try {
        prompts = getPromptRows();
    } catch (error) {
        toastr.error('현재 설정을 저장하지 못했습니다.');
        return;
    }

    const title = await callGenericPopup('현재 ON/OFF 설정 이름을 입력하세요.', POPUP_TYPE.INPUT, '');
    if (!title?.trim()) return;

    const states = {};
    prompts.forEach(prompt => {
        states[prompt.id] = prompt.enabled;
    });

    getCurrentSnapshots(true).push({
        id: makeId('snapshot'),
        title: title.trim(),
        states,
        createdAt: Date.now(),
    });
    saveSettings();
    renderBinderWindow();
    toastr.success('현재 프롬프트 ON/OFF 설정을 저장했습니다.');
}

function loadSelectedSnapshot() {
    const id = $('#pb-snapshot-select').val();
    if (!id) {
        toastr.warning('불러올 설정을 선택하세요.');
        return;
    }
    const snapshot = getCurrentSnapshots().find(item => item.id === id);
    if (!snapshot) {
        toastr.warning('저장 설정을 찾지 못했습니다.');
        return;
    }
    applySnapshot(snapshot);
}

async function deleteSnapshot(id, presetName = getCurrentPresetName()) {
    const snapshots = settings.snapshotsByPreset[presetName] || [];
    const index = snapshots.findIndex(item => item.id === id);
    if (index < 0) return;
    const ok = await callGenericPopup(`"${snapshots[index].title}" 저장 설정을 삭제할까요?`, POPUP_TYPE.CONFIRM);
    if (!ok) return;
    snapshots.splice(index, 1);
    saveSettings();
    renderBinderWindow();
}

async function deleteBinderFromPreset(presetName, binderId) {
    const binders = settings.bindersByPreset[presetName] || [];
    const index = binders.findIndex(item => item.id === binderId);
    if (index < 0) return;
    const ok = await callGenericPopup(`"${binders[index].title}" 묶음을 삭제할까요?`, POPUP_TYPE.CONFIRM);
    if (!ok) return;
    binders.splice(index, 1);
    if (!binders.length) delete settings.bindersByPreset[presetName];
    saveSettings();
    renderBinderWindow();
}

async function deleteMemoFromPreset(presetName) {
    if (!presetName || !settings.notesByPreset?.[presetName]) return;
    const ok = await callGenericPopup(`"${presetName}"의 프리셋 메모를 삭제할까요?`, POPUP_TYPE.CONFIRM);
    if (!ok) return;
    delete settings.notesByPreset[presetName];
    saveSettings();
    renderBinderWindow();
}

async function clearCurrentPresetData() {
    const preset = getCurrentPresetName();
    if (!preset) return;
    const ok = await callGenericPopup(`"${preset}"의 Preset Binder 데이터만 삭제할까요?`, POPUP_TYPE.CONFIRM);
    if (!ok) return;
    delete settings.bindersByPreset[preset];
    delete settings.snapshotsByPreset[preset];
    delete settings.notesByPreset[preset];
    saveSettings();
    renderBinderWindow();
}

async function clearAllData() {
    const ok = await callGenericPopup('Preset Binder의 모든 묶음, 저장 설정, 메모를 삭제할까요?', POPUP_TYPE.CONFIRM);
    if (!ok) return;
    settings.bindersByPreset = {};
    settings.snapshotsByPreset = {};
    settings.notesByPreset = {};
    saveSettings();
    renderBinderWindow();
}

function enableWindowDrag() {
    const $window = $('#preset-binder-window');
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let nextDx = 0;
    let nextDy = 0;
    let finalLeft = 0;
    let finalTop = 0;

    function paintDrag() {
        dragFrame = null;
        $window.css('transform', `translate3d(${nextDx}px, ${nextDy}px, 0)`);
    }

    $window.find('.pb-titlebar').on('mousedown', function (event) {
        if ($(event.target).closest('button').length) return;
        dragging = true;
        const rect = $window[0].getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        nextDx = 0;
        nextDy = 0;
        finalLeft = startLeft;
        finalTop = startTop;
        $window.addClass('pb-dragging');
        $('body').addClass('pb-moving');
        event.preventDefault();
    });

    $(document).on('mousemove.presetBinderDrag', function (event) {
        if (!dragging) return;
        finalLeft = Math.max(8, startLeft + event.clientX - startX);
        finalTop = Math.max(8, startTop + event.clientY - startY);
        nextDx = finalLeft - startLeft;
        nextDy = finalTop - startTop;
        if (!dragFrame) dragFrame = requestAnimationFrame(paintDrag);
    });

    $(document).on('mouseup.presetBinderDrag', function () {
        if (!dragging) return;
        dragging = false;
        if (dragFrame) {
            cancelAnimationFrame(dragFrame);
            dragFrame = null;
        }
        $window.removeClass('pb-dragging');
        $window.css({ left: finalLeft, top: finalTop, transform: '' });
        $('body').removeClass('pb-moving');
        rememberWindowRect();
    });
}

function enableWindowResize() {
    const $window = $('#preset-binder-window');
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;
    let nextWidth = 0;
    let nextHeight = 0;

    function paintResize() {
        resizeFrame = null;
        $window.css({ width: nextWidth, height: nextHeight });
    }

    $window.find('.pb-resize').on('mousedown', function (event) {
        resizing = true;
        startX = event.clientX;
        startY = event.clientY;
        startWidth = $window.outerWidth();
        startHeight = $window.outerHeight();
        $('body').addClass('pb-moving');
        event.preventDefault();
    });

    $(document).on('mousemove.presetBinderResize', function (event) {
        if (!resizing) return;
        nextWidth = Math.max(420, Math.min(window.innerWidth - 20, startWidth + event.clientX - startX));
        nextHeight = Math.max(360, Math.min(window.innerHeight - 20, startHeight + event.clientY - startY));
        if (!resizeFrame) resizeFrame = requestAnimationFrame(paintResize);
    });

    $(document).on('mouseup.presetBinderResize', function () {
        if (!resizing) return;
        resizing = false;
        if (resizeFrame) {
            cancelAnimationFrame(resizeFrame);
            resizeFrame = null;
            paintResize();
        }
        $('body').removeClass('pb-moving');
        rememberWindowRect();
    });
}

function rememberWindowRect() {
    if (!settings.rememberWindow) return;
    const rect = $('#preset-binder-window')[0]?.getBoundingClientRect();
    if (!rect) return;
    settings.window = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    };
    saveSettings();
}

function resetWindowRect() {
    settings.window = structuredClone(DEFAULT_SETTINGS.window);
    saveSettings();
    const win = settings.window;
    $('#preset-binder-window').css({ left: win.left, top: win.top, width: win.width, height: win.height });
}

function updateVisibleToggleStates() {
    if (!$('#preset-binder-window').is(':visible') || settings.activeTab !== 'current') return;

    const rows = getPromptStateRowsDirect();
    const snapshot = JSON.stringify(rows.map(row => [row.id, row.enabled]));
    if (snapshot === lastStateSyncSnapshot) return;
    lastStateSyncSnapshot = snapshot;

    const stateById = new Map(rows.map(row => [row.id, row.enabled]));
    $('#preset-binder-window .pb-toggle-input').each((_, input) => {
        const $input = $(input);
        const promptId = $input.data('id');
        if (!stateById.has(promptId)) return;
        const enabled = stateById.get(promptId);
        if ($input.prop('checked') !== enabled) {
            $input.prop('checked', enabled);
        }
    });
}

function startStateSync() {
    if (stateSyncTimer) return;
    stateSyncTimer = setInterval(updateVisibleToggleStates, 300);
}

function wireSettingsPanel() {
    $('#preset_binder_show_wand').prop('checked', settings.showWandButton);
    $('#preset_binder_remember_window').prop('checked', settings.rememberWindow);

    $('#preset_binder_show_wand').on('change', function () {
        settings.showWandButton = $(this).prop('checked');
        saveSettings();
        updateWandButton();
    });

    $('#preset_binder_remember_window').on('change', function () {
        settings.rememberWindow = $(this).prop('checked');
        saveSettings();
    });

    $('#preset_binder_reset_window').on('click', resetWindowRect);
}

(async function () {
    ensureSettings();
    await addToWandMenu();

    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $('#extensions_settings2').append(settingsHtml);
    wireSettingsPanel();
    startStateSync();
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        lastStateSyncSnapshot = '';
        renderBinderWindow();
    });

    eventSource.on(event_types.APP_READY, () => {
        updateWandButton();
    });

    $(window).on('resize.presetBinderInset orientationchange.presetBinderInset', applyMobileWindowInset);

    console.log(`[${extensionName}] loaded`);
})();
