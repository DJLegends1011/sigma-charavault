// CharaVault extension entry: wires the provider, its preview overlay and its Settings > Online
// section into Project Σ. The API half (client/charavault-api.js) and the server proxy
// (server/index.js) are owned by their own modules.

import { initCvApi, cvMetadataCache } from './charavault-api.js';
import charavaultProvider from './charavault-provider.js';
import charavaultBrowseView, {
    setCvSettings,
    closeCvPreviewModal,
    isCvPreviewOpen,
} from './charavault-browse.js';

// one eye button: flips its input between password and text, keeping the row's width
function wireVisibilityToggle(root, buttonId, inputId) {
    const btn = root?.querySelector?.(`#${buttonId}`) || document.getElementById(buttonId);
    const input = root?.querySelector?.(`#${inputId}`) || document.getElementById(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.innerHTML = show ? '<i class="fa-solid fa-eye-slash"></i>' : '<i class="fa-solid fa-eye"></i>';
        btn.title = show ? 'Hide' : 'Show';
    });
}

function buildCvSettingsSection(ctx, el) {
    el.innerHTML = `
        <div class="settings-group">
            <div class="settings-group-title"><i class="fa-solid fa-key"></i> Authentication</div>
            <div class="settings-row">
                <label for="settingsCharavaultAppPassword">App Password</label>
                <div class="settings-input-group">
                    <input type="password" id="settingsCharavaultAppPassword" class="glass-input" placeholder="cv_..." autocomplete="new-password" data-sensitive="true">
                    <button type="button" class="glass-btn icon-only" id="toggleCharavaultAppPasswordVisibility" title="Show/Hide"><i class="fa-solid fa-eye"></i></button>
                </div>
                <span class="settings-hint">Optional. CharaVault app password (cv_...) for higher rate limits, 18+ NSFW access, and card downloads. Generate one under Account &gt; App Passwords on <a href="https://charavault.net" target="_blank" rel="noopener">charavault.net</a>.</span>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title"><i class="fa-solid fa-network-wired"></i> Gateway (optional)</div>
            <details class="settings-advanced" id="cvGatewayAdvanced">
                <summary>Advanced: custom gateway / proxy override</summary>
                <div class="settings-row">
                    <label for="settingsCharavaultGatewayUrl">Gateway URL</label>
                    <input type="text" id="settingsCharavaultGatewayUrl" class="glass-input" placeholder="Leave empty for direct charavault.net access (e.g. https://proxy.example.com/v1/cv)">
                </div>
                <div class="settings-row">
                    <label for="settingsCharavaultGatewayCdnUrl">Gateway CDN URL</label>
                    <input type="text" id="settingsCharavaultGatewayCdnUrl" class="glass-input" placeholder="Optional — overrides thumbnail/CDN host">
                </div>
                <div class="settings-row">
                    <label for="settingsCharavaultGatewayKey">Gateway Key</label>
                    <div class="settings-input-group">
                        <input type="password" id="settingsCharavaultGatewayKey" class="glass-input" placeholder="Bearer token" autocomplete="new-password" data-sensitive="true">
                        <button type="button" class="glass-btn icon-only" id="toggleCharavaultGatewayKeyVisibility" title="Show/Hide"><i class="fa-solid fa-eye"></i></button>
                    </div>
                </div>
                <div class="settings-row">
                    <span class="settings-hint">Optional. Project Σ already routes CharaVault requests through its own server to avoid CORS issues. Only fill these if your server IP is geo-blocked (HTTP 451) and you relay through a self-hosted proxy such as <a href="https://github.com/AdamsGH/charlib-proxy" target="_blank" rel="noopener">AdamsGH/charlib-proxy</a>.</span>
                </div>
            </details>
        </div>`;

    const findEl = (id) => el?.querySelector?.(`#${id}`) || document.getElementById(id);
    const persist = (inputId, key) => {
        const input = findEl(inputId);
        if (!input) return;
        let lastSaved = String(ctx.settings.get(key) || '').trim();
        const save = (e) => {
            const next = String(e?.target?.value ?? input.value ?? '').trim();
            if (next === lastSaved) return;
            lastSaved = next;
            ctx.settings.set(key, next);
            // gateway/auth changes can invalidate every cached detail answer
            cvMetadataCache.clear();
        };
        input.addEventListener('change', save);
    };

    // populate from the extension's settings
    const appPassword = findEl('settingsCharavaultAppPassword');
    if (appPassword) appPassword.value = ctx.settings.get('appPassword') || '';
    const gatewayUrl = findEl('settingsCharavaultGatewayUrl');
    if (gatewayUrl) gatewayUrl.value = ctx.settings.get('gatewayUrl') || '';
    const gatewayCdnUrl = findEl('settingsCharavaultGatewayCdnUrl');
    if (gatewayCdnUrl) gatewayCdnUrl.value = ctx.settings.get('gatewayCdnUrl') || '';
    const gatewayKey = findEl('settingsCharavaultGatewayKey');
    if (gatewayKey) gatewayKey.value = ctx.settings.get('gatewayKey') || '';

    // a saved gateway value opens the group so it is never hidden behind "Advanced"
    if (ctx.settings.get('gatewayUrl') || ctx.settings.get('gatewayCdnUrl') || ctx.settings.get('gatewayKey')) {
        findEl('cvGatewayAdvanced')?.setAttribute('open', '');
    }

    persist('settingsCharavaultAppPassword', 'appPassword');
    persist('settingsCharavaultGatewayUrl', 'gatewayUrl');
    persist('settingsCharavaultGatewayCdnUrl', 'gatewayCdnUrl');
    persist('settingsCharavaultGatewayKey', 'gatewayKey');

    wireVisibilityToggle(el, 'toggleCharavaultAppPasswordVisibility', 'settingsCharavaultAppPassword');
    wireVisibilityToggle(el, 'toggleCharavaultGatewayKeyVisibility', 'settingsCharavaultGatewayKey');
}

export default {
    async init(ctx) {
        // 1. the API half reads its settings and transport through this facade
        initCvApi({
            CoreAPI: ctx.CoreAPI,
            getSetting: (k) => ctx.settings.get(k),
            setSetting: (k, v) => ctx.settings.set(k, v),
            debugLog: ctx.CoreAPI.debugLog,
            apiRequest: ctx.CoreAPI.apiRequest,
            settings: ctx.settings,
        });

        // 2. the browse view reads its NSFW preference through the same facade
        setCvSettings(ctx.settings);

        // 3. the provider: registering is the whole job, every surface derives from the row
        const manifestRow = {
            name: 'CharaVault',
            extNamespace: 'charavault',
            searchPrefixes: ['charavault', 'cv'],
            excludeTagKey: 'charavault',
            excludeInputPrefix: 'charavault',
            hosts: ['charavault.net'],
            icon: 'fa-solid fa-vault',
            iconUrl: ctx.CoreAPI.serverUrl
                ? ctx.CoreAPI.serverUrl('/api/ext/charavault/favicon.ico')
                : '/api/ext/charavault/favicon.ico',
            tagline: true,
            avatarTap: { imgId: 'cvCharAvatar' },
        };
        await ctx.providers.register(charavaultProvider, manifestRow);
        // Ensure test harnesses that stub ctx.providers.register still initialize the provider instance
        if (!charavaultProvider._manifest) {
            charavaultProvider._manifest = manifestRow;
            if (globalThis.window?.PROVIDER_MANIFEST) {
                globalThis.window.PROVIDER_MANIFEST.charavault = manifestRow;
            }
        }
        if (!charavaultProvider._coreAPI) {
            await charavaultProvider.init(ctx.CoreAPI);
        }

        // 4. the preview closes like the app's own dialogs, through the overlay ledger
        ctx.ui.addOverlay({ id: 'preview', close: closeCvPreviewModal, visible: isCvPreviewOpen });

        // 5. Settings > Online: auth and the optional gateway override (the host adds the
        //    exclude-tags group under this body)
        ctx.ui.addProviderSettingsSection('charavault', (el) => {
            buildCvSettingsSection(ctx, el);
        }, { excludeTagsHint: 'Tags entered here are always excluded from CharaVault browse results.' });

        // 6. a debugging/integration handle for anyone poking at CharaVault from the console
        globalThis.window.__SIGMA_CHARAVAULT__ = {
            version: '1.0.0',
            provider: charavaultProvider,
            browseView: charavaultBrowseView,
            renderSettings: (el) => buildCvSettingsSection(ctx, el),
        };
    },

    dispose() {
        delete globalThis.window?.__SIGMA_CHARAVAULT__;
        delete globalThis.window?.cvImportCharacter;
        if (globalThis.window?.PROVIDER_MANIFEST?.charavault) {
            delete globalThis.window.PROVIDER_MANIFEST.charavault;
        }
    },
};
