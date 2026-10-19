/**
 * @name TheIntroDB
 * @description Skip intros, recaps, credits, and previews in TV shows and movies in Stremio Enhanced using TheIntroDB API
 * @updateUrl https://raw.githubusercontent.com/TheIntroDB/stremio-enhanced-plugin/refs/heads/main/tidb.plugin.js
 * @version 1.1.4
 * @author TheIntroDB
 */
/* jshint esversion: 11, browser: true, devel: true */
/* global StremioEnhancedAPI */

(function() {
	"use strict";

	const PLUGIN_VERSION = "1.1.4";
	const SERVER_URL = "https://api.theintrodb.org/v4";
	const ACTIVE_BTN_ID = "tidb-active-btn";
	const MAX_RETRIES = 3;
	const RETRY_DELAY = 2000;
	// A 429's advertised reset can be a daily budget hours out; past this the plugin
	// gives up instead of parking the player on a timer.
	const MAX_RATE_LIMIT_WAIT = 30000;
	const TIDB_API_KEY_SETTING = "tidb_api_key";
	const ANALYTICS_SETTING = "anonymous_usage_reporting";
	const THEME_SETTING = "tidb_theme";
	const TIDB_USER_AGENT = "TheIntroDB Stremio Enhanced Plugin";

	const THEMES = {
		default: {
            background: "#0f0d20",
            hover: "#1b192b",
            border: "none",
            backdropFilter: "none",
            borderRadius: "6px",
            fontSize: "24px",
            padding: "16px",
			iconSize: "24"
        },
        glass: {
            background: "rgba(70,70,70,0.22)",
            hover: "rgba(255,255,255,0.22)",
            border: "1px solid rgba(255,255,255,0.04)",
            backdropFilter: "blur(10px)",
            borderRadius: "50px",
            fontSize: "15px",
            padding: "8px 16px",
			iconSize: "20"
        }
	};

	const SEGMENT_BUTTON_SETTINGS = {
		intro: "show_intro_button",
		recap: "show_recap_button",
		credits: "show_credits_button",
		preview: "show_preview_button"
	};
	const SEGMENT_TYPES = Object.keys(SEGMENT_BUTTON_SETTINGS);
	const SEGMENT_LABELS = Object.freeze({
		intro: "Skip Intro",
		recap: "Skip Recap",
		credits: "Skip Credits",
		preview: "Skip Preview"
	});
	const SEGMENT_COLORS = Object.freeze({
		intro: "rgba(255, 217, 0, 0.6)",
		recap: "rgba(255, 165, 0, 0.6)",
		credits: "rgba(100, 149, 237, 0.6)",
		preview: "rgba(144, 238, 144, 0.6)"
	});
	const HIDE_TIMEOUT = 5000;

	const APTABASE_APP_KEY = "A-SH-3524453842";
	const APTABASE_HOST = "https://analytics.theintrodb.org";
	const APTABASE_SDK_VERSION = "aptabase-web@userscript";
	const APTABASE_SESSION_TIMEOUT_SEC = 1 * 60 * 60;

	let _aptabaseAppKey = "";
	let _aptabaseApiUrl = null;
	let _aptabaseAppVersion = "";
	let _aptabaseIsDebug = null;
	let _aptabaseLocale = null;
	let _aptabaseSessionId = null;
	let _aptabaseLastTouched = 0;

	function aptabaseNewSessionId() {
		const epochInSeconds = Math.floor(Date.now() / 1000).toString();
		const random = Math.floor(Math.random() * 100000000).toString().padStart(8, "0");
		return epochInSeconds + random;
	}

	function aptabaseInMemorySessionId(timeoutSec) {
		const now = Date.now();
		const diffInSec = Math.floor((now - _aptabaseLastTouched) / 1000);
		if (!_aptabaseSessionId || diffInSec > timeoutSec) {
			_aptabaseSessionId = aptabaseNewSessionId();
		}
		_aptabaseLastTouched = now;
		return _aptabaseSessionId;
	}

	function aptabaseGetBrowserLocale() {
		if (_aptabaseLocale) return _aptabaseLocale;
		if (typeof navigator === "undefined") return undefined;
		_aptabaseLocale = (navigator.languages && navigator.languages.length > 0) ? navigator.languages[0] : navigator.language;
		return _aptabaseLocale;
	}

	function aptabaseGetIsDebug() {
		if (_aptabaseIsDebug !== null) return _aptabaseIsDebug;
		if (typeof location === "undefined") {
			_aptabaseIsDebug = false;
			return _aptabaseIsDebug;
		}
		_aptabaseIsDebug = location.hostname === "localhost";
		return _aptabaseIsDebug;
	}

	function aptabaseValidateAppKey(appKey) {
		const parts = String(appKey || "").split("-");
		return parts.length === 3 && ["US", "EU", "DEV", "SH"].includes(parts[1]);
	}

	function aptabaseGetApiUrl(appKey, options) {
		const region = String(appKey || "").split("-")[1];
		if (region === "SH") {
			if (!options || !options.host) return null;
			return `${options.host}/api/v0/event`;
		}
		const hosts = {
			US: "https://us.aptabase.com",
			EU: "https://eu.aptabase.com",
			DEV: "https://localhost:3000"
		};
		const host = (options && options.host) ? options.host : hosts[region];
		return host ? `${host}/api/v0/event` : null;
	}

	function aptabaseInit(appKey, options) {
		if (!aptabaseValidateAppKey(appKey)) return false;
		_aptabaseApiUrl = (options && options.apiUrl) ? options.apiUrl : aptabaseGetApiUrl(appKey, options);
		if (!_aptabaseApiUrl) return false;
		_aptabaseAppKey = appKey;
		_aptabaseAppVersion = (options && options.appVersion) ? String(options.appVersion) : "";
		return true;
	}

	async function aptabaseSendEvent(eventName, props) {
		if (typeof fetch !== "function" || !_aptabaseApiUrl || !_aptabaseAppKey) return;
		try {
			const sessionId = aptabaseInMemorySessionId(APTABASE_SESSION_TIMEOUT_SEC);
			const response = await fetch(_aptabaseApiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"App-Key": _aptabaseAppKey
				},
				credentials: "omit",
				body: JSON.stringify({
					timestamp: new Date().toISOString(),
					sessionId,
					eventName,
					systemProps: {
						locale: aptabaseGetBrowserLocale(),
						isDebug: aptabaseGetIsDebug(),
						appVersion: _aptabaseAppVersion,
						sdkVersion: APTABASE_SDK_VERSION
					},
					props
				})
			});
			if (response.status >= 300) {
				const responseBody = await response.text();
				console.warn(`Failed to send event "${eventName}": ${response.status} ${responseBody}`);
			}
		} catch (e) {
			console.warn(`Failed to send event "${eventName}"`);
			console.warn(e);
		}
	}

	function aptabaseTrackEvent(eventName, props) {
		aptabaseSendEvent(eventName, props);
	}

	function initAnalyticsOnce() {
		if (window.__tidbAnalyticsInitialized) return;
		const ok = aptabaseInit(APTABASE_APP_KEY, {
			host: APTABASE_HOST,
			appVersion: PLUGIN_VERSION
		});
		if (!ok) return;
		window.__tidbAnalyticsInitialized = true;
		aptabaseTrackEvent("plugin_started", {
			version: PLUGIN_VERSION
		});
	}

	function capitalize(value) {
		const str = String(value || "");
		return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
	}

	function emptySegments() {
		return Object.fromEntries(SEGMENT_TYPES.map((type) => [type, []]));
	}

	function normalizeApiKey(value) {
		return typeof value === "string" ? value.trim() : "";
	}

	function normalizeToggleValue(value) {
		return value !== false;
	}

	function getVideoDurationMs(video) {
		const durationSec = video && typeof video.duration === "number" ? video.duration : NaN;
		if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
		const durationMs = Math.round(durationSec * 1000);
		return durationMs > 0 ? durationMs : null;
	}

	// A 429 advertises its wait in Retry-After or X-RateLimit-Reset — a delta in
	// seconds, or an epoch in seconds or milliseconds. Those magnitudes do not
	// overlap, so they separate cleanly. Waiting out a daily budget would stall the
	// player for hours, so a wait past MAX_RATE_LIMIT_WAIT is not worth taking and
	// comes back as 0; a response with no usable hint falls back to RETRY_DELAY.
	function rateLimitDelayMs(res) {
		const raw = res.headers.get("Retry-After") || res.headers.get("X-RateLimit-Reset") || res.headers.get("X-RateLimit-Reset-After");
		const value = Number(raw);
		let waitMs;
		if (Number.isFinite(value) && value > 0) {
			waitMs = value > 1e12 ? value - Date.now() : value > 1e9 ? value * 1000 - Date.now() : value * 1000;
		} else {
			const dateMs = raw ? Date.parse(raw) : NaN;
			if (!Number.isFinite(dateMs)) return RETRY_DELAY;
			waitMs = dateMs - Date.now();
		}
		if (!(waitMs > 0)) return RETRY_DELAY;
		return waitMs > MAX_RATE_LIMIT_WAIT ? 0 : Math.round(waitMs);
	}

	function imdbIdentity(value) {
		const match = String(value).match(/tt\d+/i);
		return match ? { param: "imdb_id", value: match[0] } : null;
	}

	function numericIdentity(param, value) {
		const str = String(value);
		return /^\d+$/.test(str) ? { param: param, value: str } : null;
	}

	// Turns one raw id into the query parameter /media expects. A caller that knows
	// where the id came from pins the parameter; otherwise the id's own prefix names
	// the provider. "series:" and "movie:" are stripped first because they name the
	// content type rather than a provider ("series:tt0149460" is still an IMDb id).
	// "tt..." is always IMDb and a bare number is read as a TMDB id, which is the
	// convention this plugin already used. Anything else the API cannot resolve, so
	// it is dropped rather than sent as a guess.
	function normalizeMediaIdentity(param, rawValue) {
		const value = String(rawValue == null ? "" : rawValue).trim();
		if (!value) return null;

		const prefixed = value.match(/^([A-Za-z]+):(.+)$/);
		const prefix = prefixed ? prefixed[1].toLowerCase() : null;
		const provider = prefix === "series" || prefix === "movie" ? null : prefix;
		const rest = (prefixed ? prefixed[2] : value).trim();
		if (!rest) return null;

		if (provider === "imdb") return imdbIdentity(rest);
		if (provider === "tvdb") return numericIdentity("tvdb_id", rest);
		if (provider === "tmdb") return numericIdentity("tmdb_id", rest);
		if (provider !== null) return null;

		// No provider prefix: the pinned parameter decides, and "tt..." is IMDb either way.
		if (param === "imdb_id" || /^tt\d/i.test(rest)) return imdbIdentity(rest);
		if (param === "tvdb_id") return numericIdentity("tvdb_id", rest);
		if (param === "tmdb_id") return numericIdentity("tmdb_id", rest);
		if (/^\d+$/.test(rest)) return { param: "tmdb_id", value: rest };
		return null;
	}

	// The identities a meta item exposes, in the order they should be tried, with
	// duplicates removed. The meta id comes first because it is the identity the app
	// navigated to, so its numbering is the one the viewer is watching.
	function collectMediaIdentities(meta) {
		const identities = [];
		const seen = new Set();
		const add = (param, rawValue) => {
			const identity = normalizeMediaIdentity(param, rawValue);
			if (!identity) return;
			const key = identity.param + ":" + identity.value;
			if (seen.has(key)) return;
			seen.add(key);
			identities.push(identity);
		};

		if (meta) {
			add(null, meta.id);
			add("tvdb_id", meta.tvdb_id);
			add("tmdb_id", meta.tmdb_id != null ? meta.tmdb_id : meta.moviedb_id);
			add("imdb_id", meta.imdb_id);
		}

		return identities;
	}

	// "metaId:season:episode" for an episode, "metaId" for a movie. The meta id can
	// itself contain a colon ("tmdb:615"), so the trailing pair is matched first: a
	// plain split(":") would read "tmdb:615:6:1" as id "tmdb", season "615", episode "6".
	function parseEpisodeTarget(episodeId) {
		const value = String(episodeId == null ? "" : episodeId).trim();
		if (!value) return null;
		const trailing = value.match(/^(.*?):(\d+):(\d+)$/);
		return {
			metaId: trailing ? trailing[1] : value,
			season: trailing ? trailing[2] : null,
			episode: trailing ? trailing[3] : null,
			isTvShow: Boolean(trailing)
		};
	}

	class TheIntroDBPlugin {
		constructor() {
			this.video = null;
			this.episodeId = null;
			this.title = null;
			this.mediaIdentities = null;
			this.segments = emptySegments();
			this.activeSegment = null;
			this.displayedSegmentType = null;
			this.skipButtonTimeout = null;
			this.overlayObserver = null;
			this.userApiKey = "";
			this.apiKeyValidation = null;
			this._validatingApiKey = false;
			this.analyticsEnabled = true;
			this.theme = "glass";
			this.segmentButtonVisibility = Object.fromEntries(SEGMENT_TYPES.map((type) => [type, true]));
			this.onTimeUpdate = null;
			this.onSeekedHandler = null;
			this.onMouseMoveHandler = null;
			this.onLoadedMetadataHandler = null;
			this.settingsReady = this.initializeSettings();
			this._checkingPlayback = false;
			this._lastSeenUrl = null;
			this._lastStateContext = null;
			this._lastStateCheckAt = 0;
			this._lastVideoSource = null;
			this._lastFetchedDurationMs = null;
			this._checkTimer = null;
			this._observer = null;
			this.init();
		}

		init() {
			this._observer = new MutationObserver(() => {
				this.checkPlaybackChange();
			});
			this._observer.observe(document.body, {
				childList: true,
				subtree: true
			});
			this._checkTimer = setInterval(() => this.checkPlaybackChange(), 2000);
			this.checkPlaybackChange();
			this.injectSettingsStyles();
			this.injectSettingsModalUi();
		}

		async initializeSettings() {
			if (typeof StremioEnhancedAPI === "undefined") {
				return;
			}

			if (window.__tidbSettingsRegistered) {
				return;
			}

			try {
				const schema = [{
						key: TIDB_API_KEY_SETTING,
						type: "input",
						label: "TIDB API Key",
						defaultValue: ""
					},
					{
						key: THEME_SETTING,
						type: "select",
						label: "Button Theme",
						options: [{
							value: "default",
							label: "Default"
						}, {
							value: "glass",
							label: "Glass"
						}],
						defaultValue: "default"
					}
				];

				for (const segmentType of SEGMENT_TYPES) {
					schema.push({
						key: SEGMENT_BUTTON_SETTINGS[segmentType],
						type: "toggle",
						label: `Show ${capitalize(segmentType)} Button`,
						defaultValue: true
					});
				}

				schema.push({
					key: ANALYTICS_SETTING,
					type: "toggle",
					label: "Anonymous usage reporting",
					description: "Send anonymous feature usage events (e.g. button shown/clicked) to help improve the plugin. No media IDs or titles are sent.",
					defaultValue: true
				});

				await StremioEnhancedAPI.registerSettings(schema);
				window.__tidbSettingsRegistered = true;

				if (typeof StremioEnhancedAPI.onSettingsSaved === "function") {
					StremioEnhancedAPI.onSettingsSaved((newSettings) => {
						const newKey = normalizeApiKey(newSettings && newSettings[TIDB_API_KEY_SETTING]);
						this.userApiKey = newKey;
						this.apiKeyValidation = null;
						if (!newKey) return;
						this.validateApiKey().then((result) => {
							this.reportApiKeyValidation(result, true);
						});
					});
				}
			} catch (err) {
				const message = err && err.message ? String(err.message) : "";
				if (message.includes("settings schema registered")) {
					window.__tidbSettingsRegistered = true;
					return;
				}
				console.warn("[TheIntroDB] Failed to register settings:", err);
			}
		}

		async loadSettings() {
			if (typeof StremioEnhancedAPI === "undefined") {
				return;
			}

			this.theme = (await StremioEnhancedAPI.getSetting(THEME_SETTING)) || "default";
			this.userApiKey = normalizeApiKey(await StremioEnhancedAPI.getSetting(TIDB_API_KEY_SETTING));
			this.analyticsEnabled = normalizeToggleValue(await StremioEnhancedAPI.getSetting(ANALYTICS_SETTING));
			if (this.analyticsEnabled) initAnalyticsOnce();

			const visibility = {};
			for (const [segmentType, settingKey] of Object.entries(SEGMENT_BUTTON_SETTINGS)) {
				visibility[segmentType] = normalizeToggleValue(await StremioEnhancedAPI.getSetting(settingKey));
			}
			this.segmentButtonVisibility = visibility;
		}

		async validateApiKey(force = false, explicitKey = null) {
			const apiKey = explicitKey == null ? this.userApiKey : normalizeApiKey(explicitKey);

			if (!apiKey) {
				this.apiKeyValidation = { key: "", valid: false, stats: null, reason: "empty" };
				return this.apiKeyValidation;
			}

			if (!force && this.apiKeyValidation && this.apiKeyValidation.key === apiKey) {
				return this.apiKeyValidation;
			}

			try {
				const res = await fetch(`${SERVER_URL}/user/stats`, {
					headers: this.getTidbHeaders(apiKey)
				});

				let stats = null;
				let reason = "";
				if (res.status === 200) {
					try {
						stats = await res.json();
					} catch (err) {
						stats = null;
					}
					reason = stats && stats.error ? String(stats.error) : "";
				} else {
					try {
						const body = await res.json();
						reason = body && body.error ? String(body.error) : `HTTP ${res.status}`;
					} catch (err) {
						reason = `HTTP ${res.status}`;
					}
				}

				const validation = {
					key: apiKey,
					valid: res.status === 200 && !reason,
					stats: res.status === 200 && !reason ? stats : null,
					reason
				};
				if (explicitKey == null) this.apiKeyValidation = validation;
				return validation;
			} catch (err) {
				console.warn("[TheIntroDB] Could not validate API key:", err);
				const validation = {
					key: apiKey,
					valid: false,
					stats: null,
					reason: "network"
				};
				if (explicitKey == null) this.apiKeyValidation = validation;
				return validation;
			}
		}

		async maybeValidateApiKey() {
			if (this._validatingApiKey) return;
			this._validatingApiKey = true;

			try {
				if (typeof StremioEnhancedAPI !== "undefined") {
					try {
						const storedKey = normalizeApiKey(await StremioEnhancedAPI.getSetting(TIDB_API_KEY_SETTING));
						if (typeof storedKey === "string" && storedKey !== this.userApiKey) {
							this.userApiKey = storedKey;
						}
					} catch (err) {
						/* settings API unavailable — use last known key */
					}
				}

				if (!this.userApiKey) return;
				if (this.apiKeyValidation && this.apiKeyValidation.key === this.userApiKey) return;

				const result = await this.validateApiKey();
				this.reportApiKeyValidation(result);
			} finally {
				this._validatingApiKey = false;
			}
		}

		reportApiKeyValidation(result, showPillForValid = false) {
			if (!result) return;

			if (result.valid) {
				const stats = result.stats || {};
				const summary = `${stats.accepted || 0} accepted, ${stats.pending || 0} pending, ${stats.rejected || 0} rejected`;
				console.log(`[TheIntroDB] API key valid — ${summary}`);
				if (showPillForValid) {
					this.showApiKeyStatusPill(`TheIntroDB API key valid — ${summary}`, true);
				}
				return;
			}

			if (result.reason === "empty") {
				console.debug("[TheIntroDB] No API key configured (anonymous mode)");
				return;
			}

			console.warn(`[TheIntroDB] API key invalid: ${result.reason}`);
			this.showApiKeyStatusPill(`TheIntroDB API key invalid — ${result.reason}`, false);
		}

		showApiKeyStatusPill(message, valid = false) {
			try {
				if (document.getElementById("tidb-api-key-pill")) return;
				const pill = document.createElement("div");
				pill.id = "tidb-api-key-pill";
				pill.textContent = `${valid ? "✓" : "⚠"} ${message}`;
				Object.assign(pill.style, {
					position: "fixed",
					top: "16px",
					right: "16px",
					zIndex: "2147483647",
					padding: "10px 14px",
					borderRadius: "8px",
					background: valid ? "rgba(22, 163, 74, 0.92)" : "rgba(220, 38, 38, 0.92)",
					color: "#ffffff",
					font: "13px/1.4 -apple-system, 'Segoe UI', Roboto, sans-serif",
					boxShadow: "0 2px 12px rgba(0, 0, 0, 0.35)",
					pointerEvents: "none",
					maxWidth: "340px"
				});
				document.body.appendChild(pill);
				setTimeout(() => pill.remove(), 6000);
			} catch (err) {
				console.warn("[TheIntroDB] Failed to show API key status:", err);
			}
		}

		injectSettingsStyles() {
			if (document.getElementById("tidb-settings-css")) return;
			const style = document.createElement("style");
			style.id = "tidb-settings-css";
			style.textContent = `
				/* Stack plugin settings vertically as cards */
				#tidbpluginjs-settings-modal [class*="option-"] {
					display: flex !important;
					flex-direction: column !important;
					align-items: stretch !important;
					justify-content: flex-start !important;
					gap: 10px !important;
					margin-bottom: 14px !important;
					padding: 16px 18px !important;
					border-radius: 12px !important;
					background: rgba(255, 255, 255, 0.05) !important;
					border: 1px solid rgba(255, 255, 255, 0.09) !important;
				}
				#tidbpluginjs-settings-modal [class*="option-"] [class*="heading-"],
				#tidbpluginjs-settings-modal [class*="option-"] [class*="content-"] {
					width: 100% !important;
					max-width: none !important;
					flex: none !important;
					padding-right: 0 !important;
				}
				#tidbpluginjs-settings-modal [class*="option-"] input,
				#tidbpluginjs-settings-modal [class*="option-"] select {
					width: 100% !important;
					max-width: none !important;
				}
				/* Toggle rows: keep the toggle on the right of the card */
				#tidbpluginjs-settings-modal [class*="option-"]:has(.plugin-setting-toggle) {
					flex-direction: row !important;
					align-items: center !important;
					justify-content: space-between !important;
					gap: 16px !important;
				}
				#tidbpluginjs-settings-modal [class*="option-"]:has(.plugin-setting-toggle) [class*="heading-"] {
					flex: 1 1 auto !important;
					padding-right: 12px !important;
				}
				#tidbpluginjs-settings-modal [class*="option-"]:has(.plugin-setting-toggle) [class*="content-"] {
					flex: 0 0 auto !important;
					width: auto !important;
				}
				/* Responsive modal width */
				#tidbpluginjs-settings-modal div[style*="max-width: 800px"] {
					width: min(92vw, 720px) !important;
					max-width: 92vw !important;
				}
				/* Scroll chain: min-height 0 lets flex children shrink so the
				   settings list scrolls instead of overflowing the modal */
				#tidbpluginjs-settings-modal [class*="modal-dialog-container"],
				#tidbpluginjs-settings-modal [class*="modal-dialog-content"],
				#tidbpluginjs-settings-modal [class*="body-container"] {
					min-height: 0 !important;
					overflow: hidden !important;
				}
				#tidbpluginjs-settings-modal [class*="modal-dialog-container"] {
					max-height: 85vh !important;
				}
				#tidbpluginjs-settings-modal [class*="body-container"] {
					flex: 1 1 auto !important;
					display: flex !important;
					flex-direction: column !important;
				}
				#tidbpluginjs-settings-modal [class*="section-container"] {
					overflow-y: auto !important;
					overflow-x: hidden !important;
					max-height: 55vh !important;
					flex: 1 1 auto !important;
				}
				/* Test API key card status line */
				.tidb-api-key-status {
					font-size: 0.9em;
					line-height: 1.4;
					margin-top: 4px;
					white-space: normal;
				}
				.tidb-api-key-status.ok { color: #4ade80; }
				.tidb-api-key-status.err { color: #f87171; }
			`;
			document.head.appendChild(style);
		}

		injectSettingsModalUi() {
			if (this._settingsModalObserver) return;
			this._settingsModalObserver = new MutationObserver(() => this.enhanceSettingsModal());
			this._settingsModalObserver.observe(document.body, {
				childList: true,
				subtree: true
			});
		}

		enhanceSettingsModal() {
			// The app builds the modal id from the plugin file name:
			// "tidb.plugin.js" -> alphanumerics only -> "tidbpluginjs-settings-modal"
			const modal = document.getElementById("tidbpluginjs-settings-modal");
			if (!modal || modal.dataset.tidbEnhanced === "1") return;
			modal.dataset.tidbEnhanced = "1";

			const input = modal.querySelector('[data-key="tidb_api_key"]');
			const row = input && input.closest('[class*="option-"]');
			if (!row) return;

			const button = document.createElement("div");
			button.tabIndex = 0;
			button.className = "tidb-test-api-key-btn";
			button.style.cssText = "align-self:flex-start;margin-top:12px;padding:8px 20px;border-radius:18px;background:rgba(255,255,255,0.10);cursor:pointer;user-select:none;";
			const buttonLabel = document.createElement("div");
			buttonLabel.style.cssText = "font-size:0.9em;line-height:1;";
			buttonLabel.textContent = "Test API Key";
			button.appendChild(buttonLabel);

			const status = document.createElement("div");
			status.className = "tidb-api-key-status";

			button.addEventListener("click", async () => {
				const rawKey = input ? input.value : "";
				status.textContent = "Checking...";
				status.className = "tidb-api-key-status";
				const result = await this.validateApiKey(false, rawKey);
				if (result.valid) {
					const stats = result.stats || {};
					status.textContent = `Valid — ${stats.accepted || 0} accepted, ${stats.pending || 0} pending, ${stats.rejected || 0} rejected`;
					status.className = "tidb-api-key-status ok";
				} else {
					const reason = result.reason === "empty" ? "No API key entered" : result.reason;
					status.textContent = `Invalid — ${reason}`;
					status.className = "tidb-api-key-status err";
				}
			});

			row.append(button, status);
		}

		track(eventName, props) {
			if (!this.analyticsEnabled) return;
			initAnalyticsOnce();
			aptabaseTrackEvent(eventName, props);
		}

		isSegmentButtonEnabled(segmentType) {
			return this.segmentButtonVisibility[segmentType] !== false;
		}

		getTidbHeaders(apiKey = this.userApiKey) {
			const headers = {
				"User-Agent": TIDB_USER_AGENT
			};

			if (apiKey) {
				headers.Authorization = `Bearer ${apiKey}`;
			}

			return headers;
		}

		getVideoSource(video) {
			return video ? (video.currentSrc || video.src || video.getAttribute("src") || null) : null;
		}

		extractTitleFromDocument() {
			const raw = document && document.title ? String(document.title).trim() : "";
			if (!raw) {
				return null;
			}
			const cleaned = raw.replace(/\s+-\s+Stremio.*$/i, "").trim();
			return cleaned || raw;
		}

		async resolvePlaybackContext(urlChanged, sourceChanged) {
			const now = Date.now();
			const urlEpisodeId = this.extractEpisodeIdFromUrl();
			const urlContext = urlEpisodeId ? {
				episodeId: urlEpisodeId,
				title: this.extractTitleFromDocument()
			} : null;
			const shouldRefreshState = sourceChanged || now - this._lastStateCheckAt > 5000 || !this._lastStateContext;
			if (!shouldRefreshState && !urlChanged) return urlContext || this._lastStateContext;
			if (shouldRefreshState) {
				this._lastStateCheckAt = now;
				this._lastStateContext = await this.getPlaybackContextFromState();
			}
			return this._lastStateContext || urlContext;
		}

		async checkPlaybackChange() {
			if (this._checkingPlayback) return;
			this._checkingPlayback = true;

			this.maybeValidateApiKey();

			const video = document.querySelector("video");
			try {
				if (!video) return;
				const currentUrl = window.location.href;
				const urlChanged = currentUrl !== this._lastSeenUrl;
				const videoChanged = video !== this.video;
				const currentVideoSource = this.getVideoSource(video);
				const sourceChanged = Boolean(currentVideoSource && currentVideoSource !== this._lastVideoSource);
				this._lastSeenUrl = currentUrl;
				this._lastVideoSource = currentVideoSource;

				const context = await this.resolvePlaybackContext(urlChanged, sourceChanged);
				const nextEpisodeId = context && context.episodeId ? context.episodeId : null;
				if (!nextEpisodeId) return;

				const episodeChanged = nextEpisodeId !== this.episodeId;
				if (!episodeChanged && !videoChanged) {
					const durationMs = getVideoDurationMs(video);
					if (durationMs != null && durationMs !== this._lastFetchedDurationMs) {
						await this.fetchData();
					}
					return;
				}
				if (this.video || this.episodeId) this.cleanup();

				this.video = video;
				this.episodeId = nextEpisodeId;
				this.title = context.title || null;
				this.mediaIdentities = context.identities || null;

				if (!this.onLoadedMetadataHandler) this.onLoadedMetadataHandler = () => this.checkPlaybackChange();
				this.video.removeEventListener("loadedmetadata", this.onLoadedMetadataHandler);
				this.video.addEventListener("loadedmetadata", this.onLoadedMetadataHandler);

				await this.settingsReady;
				await this.loadSettings();

				console.log(`[TheIntroDB] \nEpisode ID: ${this.episodeId}, \nTitle: ${this.title || "Unknown Title"}`);
				await this.fetchData();
			} finally {
				this._checkingPlayback = false;
			}
		}

		extractEpisodeIdFromUrl() {
			const url = window.location.href;
			let m = url.match(/\/detail\/series\/([^/?#]+)\/(\d+)\/(\d+)/);
			if (m) return `${m[1]}:${m[2]}:${m[3]}`;
			m = url.match(/\/detail\/series\/([^/?#]+)/);
			if (m) {
				const s = url.match(/[?&]season=(\d+)/),
					e = url.match(/[?&]episode=(\d+)/);
				if (s && e) return `${m[1]}:${s[1]}:${e[1]}`;
			}
			m = url.match(/\/detail\/movie\/([^/?#]+)/);
			if (m) return m[1].split(":")[0];

			try {
				const decoded = decodeURIComponent(url);

				m = decoded.match(/\/series\/[^/]+\/([^/?#]+)/);
				if (m) {
					const parts = m[1].split(":");
					if (parts.length >= 3) return `${parts[0]}:${parts[1]}:${parts[2]}`;
				}

				m = decoded.match(/\/movie\/([^/]+)\/([^/?#]+)/);
				if (m) {
					for (const candidate of [m[2], m[1]]) {
						if (!candidate) continue;
						const imdbMatch = String(candidate).match(/tt\d{7,8}/);
						if (imdbMatch) return imdbMatch[0];
						const raw = String(candidate).split(":")[0];
						if (/^\d+$/.test(raw)) return raw;
						if (raw) return raw;
					}
				}
			} catch (_) {}

			return null;
		}

		async getPlaybackContextFromState() {
			const state = await this.waitForPlayerState();
			const meta = state && state.metaItem ? state.metaItem.content : null;
			if (!meta || !meta.id) return null;

			const seriesInfo = state.seriesInfo;
			const id = String(meta.id);
			// A season 0 episode is an episode, so this is a null check rather than a
			// truthiness test — the title below already read it that way.
			const hasEpisode = Boolean(seriesInfo) && seriesInfo.season != null && seriesInfo.episode != null;
			const episodeId = hasEpisode ? `${id}:${seriesInfo.season}:${seriesInfo.episode}` : id;

			let title = meta.name ? String(meta.name) : null;
			if (title && hasEpisode) title = `${title} S${String(seriesInfo.season).padStart(2, "0")}E${String(seriesInfo.episode).padStart(2, "0")}`;
			return {
				episodeId,
				title,
				identities: collectMediaIdentities(meta)
			};
		}

		async waitForPlayerState() {
			for (let i = 0; i < 40; i++) {
				const state = await this.evalInPage("window.services && window.services.core && window.services.core.transport && window.services.core.transport.getState('player')");
				if (state && state.metaItem && state.metaItem.content) return state;
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
			return null;
		}

		evalInPage(js) {
			return new Promise((resolve) => {
				const event = "stremio-enhanced-" + Math.random().toString(36).slice(2);
				const script = document.createElement("script");

				window.addEventListener(event, (browserEvent) => {
					script.remove();
					resolve(browserEvent.detail);
				}, {
					once: true
				});

				script.textContent = `(async()=>{try{const out=await (${js});window.dispatchEvent(new CustomEvent("${event}",{detail:out}));}catch(err){console.error(err);window.dispatchEvent(new CustomEvent("${event}",{detail:null}));}})();`;

				document.head.appendChild(script);
			});
		}

		async fetchData() {
			const video = this.video;
			const episodeId = this.episodeId;
			if (!video || !episodeId) {
				return null;
			}

			const target = parseEpisodeTarget(episodeId);
			const identities = this.mediaIdentities && this.mediaIdentities.length ? this.mediaIdentities : collectMediaIdentities({ id: target.metaId });
			const durationMs = getVideoDurationMs(video);
			this._lastFetchedDurationMs = durationMs;
			if (identities.length === 0) {
				console.warn(`[TheIntroDB] No usable media id for episode ${episodeId}`);
				this.segments = emptySegments();
				return null;
			}

			for (const identity of identities) {
				const outcome = await this.fetchIdentity(episodeId, identity, target, durationMs);
				if (outcome !== "next") {
					return null;
				}
			}

			this.segments = emptySegments();
			return null;
		}

		// Asks /media for one identity. Returns "loaded" once segment data has been
		// applied, "next" when this identity resolved to nothing and the next one should
		// be tried, and "stop" when the lookup cannot succeed at all — a rate limit or an
		// API that is not answering, where another identity would fail the same way.
		async fetchIdentity(episodeId, identity, target, durationMs) {
			for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
				console.log(`[TheIntroDB] Fetching /media for ${episodeId} as ${identity.param}=${identity.value} (attempt ${attempt})`);

				try {
					const queryParams = new URLSearchParams();
					queryParams.set(identity.param, identity.value);

					if (target.isTvShow) {
						queryParams.set("season", target.season);
						queryParams.set("episode", target.episode);
					}

					if (durationMs != null) queryParams.set("duration_ms", String(durationMs));

					const res = await fetch(`${SERVER_URL}/media?${queryParams}`, {
						headers: this.getTidbHeaders()
					});

					if (res.status === 429) {
						const waitMs = rateLimitDelayMs(res);
						console.warn(`[TheIntroDB] Rate limited for ${episodeId} (${identity.param}); waiting ${waitMs} ms`);
						if (waitMs > 0 && attempt < MAX_RETRIES) {
							await new Promise((resolve) => setTimeout(resolve, waitMs));
							continue;
						}
						return "stop";
					}

					if (res.status === 204 || res.status === 404) {
						console.log(`[TheIntroDB] No skip data for ${episodeId} via ${identity.param} (${res.status})`);
						return "next";
					}

					if (res.status >= 500) {
						// A server error is the API not answering, not this identity being
						// wrong. Retry the same request — a 502/503 is usually a blip — and if
						// it persists end the chain instead of spending a request per remaining
						// identity on an API that is down. The retry also covers a 503 that
						// carries Retry-After: a wait past MAX_RATE_LIMIT_WAIT is not worth
						// taking, so it falls back to RETRY_DELAY and the attempt cap bounds it.
						const waitMs = rateLimitDelayMs(res);
						const delayMs = waitMs > 0 ? waitMs : RETRY_DELAY;
						console.warn(`[TheIntroDB] Server error for ${episodeId} (${identity.param}): ${res.status}; waiting ${delayMs} ms`);
						if (attempt < MAX_RETRIES) {
							await new Promise((resolve) => setTimeout(resolve, delayMs));
							continue;
						}
						return "stop";
					}

					if (!res.ok) {
						console.warn(`[TheIntroDB] Unexpected response for ${episodeId} (${identity.param}): ${res.status}`);
						return "next";
					}

					this.applyMediaResponse(await res.json(), episodeId);
					return "loaded";
				} catch (err) {
					console.error(`[TheIntroDB] Error fetching media for ${episodeId} (${identity.param}):`, err);

					if (attempt < MAX_RETRIES) {
						await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
					}
				}
			}

			// The retries are spent: the API is not answering, so the next identity would
			// only repeat the same failure.
			return "stop";
		}

		applyMediaResponse(json, episodeId) {
			this.segments = emptySegments();

			for (const segmentType of SEGMENT_TYPES) {
				if (json[segmentType] && json[segmentType].length > 0) {
					this.segments[segmentType] = json[segmentType].filter((segment) => segment.start_ms > 0 || segment.end_ms > 0).map((segment) => ({
						start: segment.start_ms == null ? 0 : segment.start_ms / 1000,
						end: segment.end_ms == null ? null : segment.end_ms / 1000
					}));
					console.log(`[TheIntroDB] Loaded ${this.segments[segmentType].length} ${segmentType} segments`);
				}
			}

			if (Object.values(this.segments).flat().length === 0) {
				console.log(`[TheIntroDB] No segment data found for episode ${episodeId}`);
			}

			this.waitAndHighlight();
			this.attachTimeUpdate();
			if (this.onTimeUpdate) {
				this.onTimeUpdate();
				setTimeout(() => this.onTimeUpdate && this.onTimeUpdate(), 200);
			}
			this.track("segments_loaded", {
				has_intro: this.segments.intro && this.segments.intro.length > 0,
				has_recap: this.segments.recap && this.segments.recap.length > 0,
				has_credits: this.segments.credits && this.segments.credits.length > 0,
				has_preview: this.segments.preview && this.segments.preview.length > 0,
				total: Object.values(this.segments).reduce((acc, list) => acc + (list ? list.length : 0), 0)
			});
		}

		waitAndHighlight() {
			let tries = 20;
			const attempt = () => (!this.video || !this.video.duration) ? (tries-- > 0 ? setTimeout(attempt, 500) : null) : this.highlightRangeOnBar();
			attempt();
		}

		highlightRangeOnBar() {
			const slider = document.querySelector(".slider-container-nJz5F") || document.querySelector('[class*="slider-container"]');
			if (!slider || !this.video || !this.video.duration) return;
			slider.querySelectorAll(".segment-highlight").forEach((highlight) => highlight.remove());

			const trackEl = slider.querySelector(".track-gItfW") || slider.querySelector('[class*="track-"]');
			if (!trackEl) return;

			const thumbEl = slider.querySelector(".thumb-PiTF5") || slider.querySelector('[class*="thumb-"]');
			const thumbLayer = thumbEl && thumbEl.parentNode;
			const duration = this.video.duration;

			for (const [segmentType, segmentList] of Object.entries(this.segments)) {
				for (const segment of segmentList) {
					const highlight = document.createElement("div");
					const startPct = (segment.start / duration) * 100;
					const segmentEnd = segment.end || duration;
					const widthPct = ((segmentEnd - segment.start) / duration) * 100;

					highlight.className = `segment-highlight segment-${segmentType}`;
					Object.assign(highlight.style, {
						position: "absolute",
						top: `${trackEl.offsetTop}px`,
						left: `${startPct}%`,
						width: `${widthPct}%`,
						borderRadius: "4px",
						height: `${trackEl.clientHeight}px`,
						background: SEGMENT_COLORS[segmentType],
						pointerEvents: "none",
						zIndex: "0"
					});

					slider.insertBefore(highlight, thumbLayer && slider.contains(thumbLayer) ? thumbLayer : slider.firstChild);
				}
			}
		}

		ensureHighlightsPresent() {
			const slider = document.querySelector(".slider-container-nJz5F") || document.querySelector('[class*="slider-container"]');
			if (!slider || !this.video || !this.video.duration) return;
			if (slider.querySelector(".segment-highlight")) return;
			if (Object.values(this.segments).flat().length === 0) return;
			this.highlightRangeOnBar();
		}

		attachTimeUpdate() {
			if (!this.video) return;
			if (this.onTimeUpdate) this.video.removeEventListener("timeupdate", this.onTimeUpdate);
			if (this.onSeekedHandler) this.video.removeEventListener("seeked", this.onSeekedHandler);

			this.onTimeUpdate = () => {
				if (!this.video) return;
				let seg = null;
				for (const [segmentType, segmentList] of Object.entries(this.segments)) {
					for (const segment of segmentList) {
						const end = segment.end || this.video.duration;
						if (this.video.currentTime >= segment.start && this.video.currentTime < end) {
							seg = {
								type: segmentType,
								start: segment.start,
								end
							};
							break;
						}
					}
					if (seg) break;
				}

				this.activeSegment = seg;
				const nextType = seg && this.isSegmentButtonEnabled(seg.type) ? seg.type : null;
				if (nextType === this.displayedSegmentType) return;

				this.removeActiveButton();
				if (seg) this.showSkipButton(seg);
				this.displayedSegmentType = nextType;
			};

			this.onSeekedHandler = () => this.onTimeUpdate();
			this.onMouseMoveHandler = () => document.getElementById(ACTIVE_BTN_ID) ? (clearTimeout(this.skipButtonTimeout), this.skipButtonTimeout = setTimeout(() => this.hideSkipButton(), HIDE_TIMEOUT)) : null;
			this.video.addEventListener("timeupdate", this.onTimeUpdate);
			this.video.addEventListener("seeked", this.onSeekedHandler);
			this.onTimeUpdate();
			requestAnimationFrame(() => this.onTimeUpdate && this.onTimeUpdate());
			setTimeout(() => this.onTimeUpdate && this.onTimeUpdate(), 200);

			const playerContainer = this.video.closest('[class*="player-container"]');
			if (!playerContainer) return;
			playerContainer.removeEventListener("mousemove", this.onMouseMoveHandler);
			playerContainer.addEventListener("mousemove", this.onMouseMoveHandler);
			if (this.overlayObserver) this.overlayObserver.disconnect();
			this.overlayObserver = new MutationObserver(() => {
				const isOverlayHidden = Array.from(playerContainer.classList).some((className) => className.includes("overlayHidden"));
				if (!isOverlayHidden) {
					if (this.activeSegment && this.isSegmentButtonEnabled(this.activeSegment.type) && !document.getElementById(ACTIVE_BTN_ID)) this.showSkipButton(this.activeSegment);
					this.ensureHighlightsPresent();
				}
			});
			this.overlayObserver.observe(playerContainer, {
				attributes: true,
				attributeFilter: ["class"]
			});
		}

		removeActiveButton() {
			const existingButton = document.getElementById(ACTIVE_BTN_ID);
			if (existingButton) existingButton.remove();
		}

		hideSkipButton() {
			const playerContainer = document.querySelector('[class*="player-container"]');
			const isOverlayHidden = playerContainer && Array.from(playerContainer.classList).some((className) => className.includes("overlayHidden"));
			const button = document.getElementById(ACTIVE_BTN_ID);

			if (isOverlayHidden) {
				if (!button) return;
				button.style.opacity = "0";
				setTimeout(() => (button && button.style.opacity === "0") ? button.remove() : null, 500);
				return;
			}

			if (button) button.style.opacity = "1";
			clearTimeout(this.skipButtonTimeout);
			this.skipButtonTimeout = setTimeout(() => this.hideSkipButton(), HIDE_TIMEOUT);
		}

		showSkipButton(segment) {
			const segmentType = segment.type;
			const theme = THEMES[this.theme] || THEMES.default;

			if (document.getElementById(ACTIVE_BTN_ID) || !this.isSegmentButtonEnabled(segmentType)) return;
			this.track("skip_button_shown", {
				segment: segmentType
			});

			const skipBtn = document.createElement("button");
			const icon = document.createElement("img");

			skipBtn.id = ACTIVE_BTN_ID;
			skipBtn.setAttribute("data-segment-type", segmentType);
			skipBtn.textContent = SEGMENT_LABELS[segmentType] || "Skip Segment";

			icon.src = "https://www.svgrepo.com/show/471906/skip-forward.svg";
			icon.alt = "Skip icon";
			icon.width = theme.iconSize;
			icon.height = theme.iconSize;
			icon.style.filter = "brightness(0) invert(1)";
			icon.style.pointerEvents = "none";

			Object.assign(skipBtn.style, {
				position: "fixed",
				bottom: "130px",
				right: "10vh",
				padding: theme.padding,
				background: theme.background,
				color: "#fff",
				border: theme.border,
				borderRadius: theme.borderRadius,
				cursor: "pointer",
				fontSize: theme.fontSize,
				zIndex: 2147483647,
				display: "flex",
				alignItems: "center",
				gap: "8px",
				opacity: "0",
				transition: "opacity 0.5s ease-in-out, background 0.15s",
				backdropFilter: theme.backdropFilter
			});

			skipBtn.prepend(icon);

			skipBtn.onmouseover = () => {
				skipBtn.style.backgroundColor = theme.hover;
			};
			skipBtn.onmouseout = () => {
				skipBtn.style.backgroundColor = theme.background;
			};
			skipBtn.onclick = (event) => {
				event.preventDefault();
				clearTimeout(this.skipButtonTimeout);
				this.track("skip_clicked", {
					segment: segmentType
				});
				if (this.video) {
					this.video.currentTime = segment.end;
					console.log(`[TheIntroDB] Skipping ${segmentType}: targetTime=${segment.end}`);
				}
				skipBtn.remove();
				this.displayedSegmentType = null;
			};

			const playerContainer = this.video && typeof this.video.closest === "function" ? this.video.closest('[class*="player-container"]') : null;
			const mountPoint = playerContainer || document.body;
			mountPoint.appendChild(skipBtn);

			setTimeout(() => {
				skipBtn.style.opacity = "1";
			}, 50);

			this.skipButtonTimeout = setTimeout(() => this.hideSkipButton(), HIDE_TIMEOUT);
		}

		cleanup() {
			console.log("[TheIntroDB] Cleaning up previous media...");

			if (this.video) {
				if (this.onTimeUpdate) this.video.removeEventListener("timeupdate", this.onTimeUpdate);
				if (this.onSeekedHandler) this.video.removeEventListener("seeked", this.onSeekedHandler);
				if (this.onLoadedMetadataHandler) this.video.removeEventListener("loadedmetadata", this.onLoadedMetadataHandler);
				const playerContainer = this.video.closest('[class*="player-container"]');
				if (playerContainer && this.onMouseMoveHandler) playerContainer.removeEventListener("mousemove", this.onMouseMoveHandler);
			}

			if (this.overlayObserver) {
				this.overlayObserver.disconnect();
				this.overlayObserver = null;
			}
			clearTimeout(this.skipButtonTimeout);
			this.removeActiveButton();
			Object.assign(this, {
				video: null,
				episodeId: null,
				title: null,
				mediaIdentities: null,
				segments: emptySegments(),
				activeSegment: null,
				displayedSegmentType: null,
				onTimeUpdate: null,
				onSeekedHandler: null,
				onMouseMoveHandler: null,
				_lastFetchedDurationMs: null
			});
		}

		destroy() {
			this.cleanup();
			if (this._observer) {
				this._observer.disconnect();
				this._observer = null;
			}
			if (this._checkTimer) {
				clearInterval(this._checkTimer);
				this._checkTimer = null;
			}
		}
	}

	if (window.tidbPlugin && typeof window.tidbPlugin.destroy === "function") {
		window.tidbPlugin.destroy();
	}

	window.tidbPlugin = new TheIntroDBPlugin();
	if (!window.__tidbBeforeUnloadInstalled) {
		window.__tidbBeforeUnloadInstalled = true;
		window.addEventListener("beforeunload", () => {
			localStorage.removeItem("updateReminder");
		});
	}
})();
