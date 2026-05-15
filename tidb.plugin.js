/**
 * @name TheIntroDB
 * @description Skip intros, recaps, credits, and previews in TV shows and movies in Stremio Enhanced using TheIntroDB API
 * @updateUrl https://raw.githubusercontent.com/TheIntroDB/stremio-enhanced-plugin/refs/heads/main/tidb.plugin.js
 * @version 1.0.0
 * @author TheIntroDB
 */
/* jshint esversion: 11, browser: true, devel: true */
/* global StremioEnhancedAPI */

(function() {
	"use strict";

	const SERVER_URL = "https://api.theintrodb.org/v2";
	const ACTIVE_BTN_ID = "tidb-active-btn";
	const MAX_RETRIES = 3;
	const RETRY_DELAY = 2000;
	const TIDB_API_KEY_SETTING = "tidb_api_key";
	const TIDB_USER_AGENT = "TheIntroDB Stremio Enhanced Plugin";
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

	class TheIntroDBPlugin {
		constructor() {
			this.video = null;
			this.episodeId = null;
			this.title = null;
			this.segments = emptySegments();
			this.activeSegment = null;
			this.displayedSegmentType = null;
			this.skipButtonTimeout = null;
			this.overlayObserver = null;
			this.userApiKey = "";
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
						description: "Optional personal TheIntroDB API key to include your pending segments in playback results.",
						defaultValue: ""
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

				await StremioEnhancedAPI.registerSettings(schema);
				window.__tidbSettingsRegistered = true;
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

			this.userApiKey = normalizeApiKey(await StremioEnhancedAPI.getSetting(TIDB_API_KEY_SETTING));

			const visibility = {};
			for (const [segmentType, settingKey] of Object.entries(SEGMENT_BUTTON_SETTINGS)) {
				visibility[segmentType] = normalizeToggleValue(await StremioEnhancedAPI.getSetting(settingKey));
			}
			this.segmentButtonVisibility = visibility;
		}

		isSegmentButtonEnabled(segmentType) {
			return this.segmentButtonVisibility[segmentType] !== false;
		}

		getTidbHeaders() {
			const headers = {
				"User-Agent": TIDB_USER_AGENT
			};

			if (this.userApiKey) {
				headers.Authorization = `Bearer ${this.userApiKey}`;
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
			const urlContext = urlEpisodeId ? { episodeId: urlEpisodeId, title: this.extractTitleFromDocument() } : null;
			const shouldRefreshState = sourceChanged || now - this._lastStateCheckAt > 5000 || !this._lastStateContext;
			if (!shouldRefreshState && !urlChanged) return urlContext || this._lastStateContext;
			if (shouldRefreshState) { this._lastStateCheckAt = now; this._lastStateContext = await this.getPlaybackContextFromState(); }
			return this._lastStateContext || urlContext;
		}

		async checkPlaybackChange() {
			if (this._checkingPlayback) return;
			this._checkingPlayback = true;

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
				if (!episodeChanged && !videoChanged) return;
				if (this.video || this.episodeId) this.cleanup();

				this.video = video;
				this.episodeId = nextEpisodeId;
				this.title = context.title || null;

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
			if (m) { const s = url.match(/[?&]season=(\d+)/), e = url.match(/[?&]episode=(\d+)/); if (s && e) return `${m[1]}:${s[1]}:${e[1]}`; }
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
			const episodeId = seriesInfo && seriesInfo.season && seriesInfo.episode ? `${id}:${seriesInfo.season}:${seriesInfo.episode}` : id;

			let title = meta.name ? String(meta.name) : null;
			if (title && seriesInfo && seriesInfo.season != null && seriesInfo.episode != null) title = `${title} S${String(seriesInfo.season).padStart(2, "0")}E${String(seriesInfo.episode).padStart(2, "0")}`;
			return { episodeId, title };
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

			const parts = String(episodeId).split(":");
			const id = parts[0];
			const season = parts.length >= 3 ? parts[1] : null;
			const episode = parts.length >= 3 ? parts[2] : null;
			const isTvShow = parts.length >= 3;
			for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
				console.log(`[TheIntroDB] Fetching /media for episode ${episodeId} (attempt ${attempt})`);

				try {
					const isImdb = id.startsWith("tt");
					const queryParams = new URLSearchParams();

					if (isImdb) {
						queryParams.set("imdb_id", id);
					} else {
						queryParams.set("tmdb_id", id);
					}

					if (isTvShow) {
						queryParams.set("season", season);
						queryParams.set("episode", episode);
					}

					const res = await fetch(`${SERVER_URL}/media?${queryParams}`, {
						headers: this.getTidbHeaders()
					});

					if (res.status === 204) {
						this.segments = emptySegments();
						console.log(`[TheIntroDB] No skip data for episode ${episodeId} (${res.status})`);
						return null;
					}

					if (res.status === 404) {
						this.segments = emptySegments();
						console.warn(`[TheIntroDB] No data found for episode ${episodeId}`);
						return null;
					}

					if (!res.ok) {
						console.warn(`[TheIntroDB] Unexpected response for ${episodeId}: ${res.status}`);
						return null;
					}

					const json = await res.json();
					this.segments = emptySegments();

					for (const segmentType of SEGMENT_TYPES) {
						if (json[segmentType] && json[segmentType].length > 0) {
							this.segments[segmentType] = json[segmentType].map((segment) => ({
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
					return null;
				} catch (err) {
					console.error(`[TheIntroDB] Error fetching media for ${episodeId}:`, err);

					if (attempt < MAX_RETRIES) {
						await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
					} else {
						return null;
					}
				}
			}

			return null;
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
					Object.assign(highlight.style, { position: "absolute", top: `${trackEl.offsetTop}px`, left: `${startPct}%`, width: `${widthPct}%`, borderRadius: "4px", height: `${trackEl.clientHeight}px`, background: SEGMENT_COLORS[segmentType], pointerEvents: "none", zIndex: "0" });

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
						if (this.video.currentTime >= segment.start && this.video.currentTime < end) { seg = { type: segmentType, start: segment.start, end }; break; }
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
				if (!isOverlayHidden) { if (this.activeSegment && this.isSegmentButtonEnabled(this.activeSegment.type) && !document.getElementById(ACTIVE_BTN_ID)) this.showSkipButton(this.activeSegment); this.ensureHighlightsPresent(); }
			});
			this.overlayObserver.observe(playerContainer, { attributes: true, attributeFilter: ["class"] });
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
			if (document.getElementById(ACTIVE_BTN_ID) || !this.isSegmentButtonEnabled(segmentType)) return;

			const skipBtn = document.createElement("button");
			const icon = document.createElement("img");

			skipBtn.id = ACTIVE_BTN_ID;
			skipBtn.setAttribute("data-segment-type", segmentType);
			skipBtn.textContent = SEGMENT_LABELS[segmentType] || "Skip Segment";

			icon.src = "https://www.svgrepo.com/show/471906/skip-forward.svg";
			icon.alt = "Skip icon";
			icon.width = 24;
			icon.height = 24;
			icon.style.filter = "brightness(0) invert(1)";
			icon.style.pointerEvents = "none";

			Object.assign(skipBtn.style, { position: "absolute", bottom: "130px", right: "10vh", padding: "16px", background: "#0f0d20", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "24px", zIndex: 1000, display: "flex", alignItems: "center", gap: "8px", opacity: "0", transition: "opacity 0.5s ease-in-out" });

			skipBtn.prepend(icon);

			skipBtn.onmouseover = () => { skipBtn.style.backgroundColor = "#1b192b"; clearTimeout(this.skipButtonTimeout); };
			skipBtn.onmouseout = () => { skipBtn.style.backgroundColor = "#0f0d20"; this.skipButtonTimeout = setTimeout(() => this.hideSkipButton(), HIDE_TIMEOUT); };
			skipBtn.onclick = (event) => { event.preventDefault(); clearTimeout(this.skipButtonTimeout); if (this.video) { this.video.currentTime = segment.end; console.log(`[TheIntroDB] Skipping ${segmentType}: targetTime=${segment.end}`); } skipBtn.remove(); this.displayedSegmentType = null; };

			if (this.video && this.video.parentElement) {
				this.video.parentElement.appendChild(skipBtn);
			}

			setTimeout(() => { skipBtn.style.opacity = "1"; }, 50);

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

			if (this.overlayObserver) { this.overlayObserver.disconnect(); this.overlayObserver = null; }
			clearTimeout(this.skipButtonTimeout);
			this.removeActiveButton();
			Object.assign(this, { video: null, episodeId: null, title: null, segments: emptySegments(), activeSegment: null, displayedSegmentType: null, onTimeUpdate: null, onSeekedHandler: null, onMouseMoveHandler: null });
		}

		destroy() {
			this.cleanup();
			if (this._observer) { this._observer.disconnect(); this._observer = null; }
			if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null; }
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
