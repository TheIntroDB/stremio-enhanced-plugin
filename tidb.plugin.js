/**
 * @name TIDB beta
 * @description Skip intros, recaps, credits, previews, and submit timestamps in Stremio Enhanced using TheIntroDB API
 * @updateUrl https://raw.githubusercontent.com/TheIntroDB/stremio-enhanced-plugin/refs/heads/main/tidb.plugin.js
 * @version 0.3.0
 * @author TheIntroDB
 */
/* jshint esversion: 11, browser: true, devel: true */
/* global StremioEnhancedAPI */

(function() {
	"use strict";

	const SERVER_URL = "https://api.theintrodb.org/v2";
	const ACTIVE_BTN_ID = "tidb-active-btn";
	const SUBMIT_BTN_ID = "tidb-submit-btn";
	const SUBMIT_MODAL_ID = "tidb-submit-modal";
	const MAX_RETRIES = 3;
	const RETRY_DELAY = 2000;
	const HIDE_TIMEOUT = 5000;
	const HIGHLIGHT_RETRY_COUNT = 12;
	const HIGHLIGHT_RETRY_DELAY = 500;
	const PLAYER_STATE_POLL_DELAY = 300;
	const PLAYER_STATE_MAX_WAIT_MS = 15000;

	const TIDB_API_KEY_SETTING = "tidb_api_key";
	const TMDB_API_TOKEN_SETTING = "tmdb_api_token";
	const SUBMISSION_UI_SETTING = "enable_submission_ui";
	const SEGMENT_BUTTON_SETTINGS = {
		intro: "show_intro_button",
		recap: "show_recap_button",
		credits: "show_credits_button",
		preview: "show_preview_button"
	};

	let video = null;
	let episodeId = null;
	let title = null;
	let segments = emptySegments();
	let activeSegment = null;
	let onTimeUpdate = null;
	let onSeekedHandler = null;
	let onMouseMoveHandler = null;
	let onDurationChangeHandler = null;
	let overlayObserver = null;
	let skipButtonTimeout = null;
	let displayedSegmentType = null;
	let skipHiddenBecauseOverlay = false;
	let highlightRefreshGeneration = 0;
	let highlightRefreshTimeout = null;
	let userApiKey = "";
	let tmdbApiToken = "";
	let submissionUiEnabled = true;
	let segmentButtonVisibility = {
		intro: true,
		recap: true,
		credits: true,
		preview: true
	};
	const settingsReady = initializeSettings();

	function emptySegments() {
		return {
			intro: [],
			recap: [],
			credits: [],
			preview: []
		};
	}

	async function initializeSettings() {
		if (typeof StremioEnhancedAPI === "undefined") {
			return;
		}

		await StremioEnhancedAPI.registerSettings([
			{
				key: TIDB_API_KEY_SETTING,
				type: "input",
				label: "TIDB API Key",
				description: "Optional personal TheIntroDB API key to include your pending segments in playback results and allow submissions.",
				defaultValue: ""
			},
			{
				key: TMDB_API_TOKEN_SETTING,
				type: "input",
				label: "TMDb API Read Access Token",
				description: "Optional TMDb token used to resolve IMDb IDs to TMDb IDs for submissions.",
				defaultValue: ""
			},
			{
				key: SUBMISSION_UI_SETTING,
				type: "toggle",
				label: "Enable Timestamp Submission UI",
				defaultValue: true
			},
			{
				key: SEGMENT_BUTTON_SETTINGS.intro,
				type: "toggle",
				label: "Show Intro Button",
				defaultValue: true
			},
			{
				key: SEGMENT_BUTTON_SETTINGS.recap,
				type: "toggle",
				label: "Show Recap Button",
				defaultValue: true
			},
			{
				key: SEGMENT_BUTTON_SETTINGS.credits,
				type: "toggle",
				label: "Show Credits Button",
				defaultValue: true
			},
			{
				key: SEGMENT_BUTTON_SETTINGS.preview,
				type: "toggle",
				label: "Show Preview Button",
				defaultValue: true
			}
		]);
	}

	function normalizeString(value) {
		return typeof value === "string" ? value.trim() : "";
	}

	function normalizeToggleValue(value) {
		return value !== false;
	}

	async function getSegmentButtonVisibility() {
		const visibility = {};
		for (const [segmentType, settingKey] of Object.entries(SEGMENT_BUTTON_SETTINGS)) {
			visibility[segmentType] = normalizeToggleValue(await StremioEnhancedAPI.getSetting(settingKey));
		}
		return visibility;
	}

	function isSegmentButtonEnabled(segmentType) {
		return segmentButtonVisibility[segmentType] !== false;
	}

	function getTidbHeaders() {
		return userApiKey ? { Authorization: `Bearer ${userApiKey}` } : {};
	}

	async function loadSettings() {
		if (typeof StremioEnhancedAPI === "undefined") {
			return;
		}
		userApiKey = normalizeString(await StremioEnhancedAPI.getSetting(TIDB_API_KEY_SETTING));
		tmdbApiToken = normalizeString(await StremioEnhancedAPI.getSetting(TMDB_API_TOKEN_SETTING));
		submissionUiEnabled = normalizeToggleValue(await StremioEnhancedAPI.getSetting(SUBMISSION_UI_SETTING));
		segmentButtonVisibility = await getSegmentButtonVisibility();
	}

	async function onPlay() {
		video = document.querySelector("video");
		if (!video) {
			return;
		}

		await settingsReady;
		await loadSettings();
		try {
			episodeId = await getEpisodeId();
			title = await getTitle();
			await fetchData();
		} catch (err) {
			console.error("[TheIntroDB] Failed to resolve player state:", err);
		}
	}

	async function fetchData() {
		if (!episodeId) {
			return null;
		}

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				const parts = episodeId.split(":");
				const id = parts[0];
				const isTvShow = parts.length === 3;
				const isImdb = id.startsWith("tt");
				const queryParams = new URLSearchParams();

				if (isImdb) {
					queryParams.set("imdb_id", id);
				} else {
					queryParams.set("tmdb_id", id);
				}

				if (isTvShow) {
					queryParams.set("season", parts[1]);
					queryParams.set("episode", parts[2]);
				}

				const res = await fetch(`${SERVER_URL}/media?${queryParams.toString()}`, {
					headers: getTidbHeaders()
				});

				if (res.status === 204 || res.status === 404) {
					segments = emptySegments();
					attachTimeUpdate();
					scheduleHighlightRefresh();
					refreshActionButtons();
					return null;
				}

				if (!res.ok) {
					throw new Error(`Unexpected response ${res.status}`);
				}

				const json = await res.json();
				segments = emptySegments();

				for (const segmentType of ["intro", "recap", "credits", "preview"]) {
					if (Array.isArray(json[segmentType]) && json[segmentType].length > 0) {
						segments[segmentType] = json[segmentType].map((segment) => ({
							start: typeof segment.start_ms === "number" ? segment.start_ms / 1000 : 0,
							end: typeof segment.end_ms === "number" ? segment.end_ms / 1000 : null
						}));
					}
				}

				attachTimeUpdate();
				scheduleHighlightRefresh();
				refreshActionButtons();
				if (onTimeUpdate) {
					onTimeUpdate();
				}
				return null;
			} catch (err) {
				console.error(`[TheIntroDB] Error fetching media for ${episodeId}:`, err);
				if (attempt < MAX_RETRIES) {
					await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
				}
			}
		}

		return null;
	}

	function cleanup() {
		if (video) {
			if (onTimeUpdate) video.removeEventListener("timeupdate", onTimeUpdate);
			if (onSeekedHandler) video.removeEventListener("seeked", onSeekedHandler);
			if (onDurationChangeHandler) video.removeEventListener("durationchange", onDurationChangeHandler);
			video.removeEventListener("loadedmetadata", onPlay);

			const playerContainer = getPlayerContainer();
			if (playerContainer && onMouseMoveHandler) {
				playerContainer.removeEventListener("mousemove", onMouseMoveHandler);
			}
		}

		if (overlayObserver) {
			overlayObserver.disconnect();
			overlayObserver = null;
		}

		clearTimeout(skipButtonTimeout);
		if (highlightRefreshTimeout) {
			clearTimeout(highlightRefreshTimeout);
			highlightRefreshTimeout = null;
		}
		removeNodeById(ACTIVE_BTN_ID);
		removeNodeById(SUBMIT_BTN_ID);
		removeNodeById(SUBMIT_MODAL_ID);
		removeHighlights();

		video = null;
		episodeId = null;
		title = null;
		segments = emptySegments();
		activeSegment = null;
		displayedSegmentType = null;
		onTimeUpdate = null;
		onSeekedHandler = null;
		onMouseMoveHandler = null;
		onDurationChangeHandler = null;
	}

	function getPlayerContainer() {
		return document.querySelector('[class*="player-container"]');
	}

	function isOverlayVisible() {
		const playerContainer = getPlayerContainer();
		if (!playerContainer) {
			return true;
		}
		return !Array.from(playerContainer.classList).some((className) => className.includes("overlayHidden"));
	}

	function removeNodeById(id) {
		const node = document.getElementById(id);
		if (node) {
			node.remove();
		}
	}

	function removeHighlights() {
		document.querySelectorAll(".segment-highlight").forEach((highlight) => highlight.remove());
	}

	function attachTimeUpdate() {
		if (!video) {
			return;
		}

		if (onTimeUpdate) {
			refreshActionButtons();
			return;
		}

		let lastMouseMoveTs = 0;
		const MOUSEMOVE_REFRESH_THROTTLE_MS = 150;

		onTimeUpdate = () => {
			let newActiveSegment = null;

			for (const [segmentType, segmentList] of Object.entries(segments)) {
				for (const segment of segmentList) {
					const segmentEnd = segment.end == null ? video.duration : segment.end;
					if (video.currentTime >= segment.start && video.currentTime < segmentEnd) {
						newActiveSegment = {
							type: segmentType,
							start: segment.start,
							end: segmentEnd,
							originalSegment: segment
						};
						break;
					}
				}
				if (newActiveSegment) {
					break;
				}
			}

			activeSegment = newActiveSegment;
			refreshActionButtons();
		};

		onSeekedHandler = () => {
			if (onTimeUpdate) {
				onTimeUpdate();
			}
		};

		onDurationChangeHandler = () => {
			scheduleHighlightRefresh();
		};

		onMouseMoveHandler = () => {
			const now = Date.now();
			if (now - lastMouseMoveTs >= MOUSEMOVE_REFRESH_THROTTLE_MS) {
				lastMouseMoveTs = now;
				refreshActionButtons();
			}
			if (document.getElementById(ACTIVE_BTN_ID) || document.getElementById(SUBMIT_BTN_ID)) {
				clearTimeout(skipButtonTimeout);
				skipButtonTimeout = setTimeout(hideFloatingButtons, HIDE_TIMEOUT);
			}
		};

		video.addEventListener("timeupdate", onTimeUpdate);
		video.addEventListener("seeked", onSeekedHandler);
		video.addEventListener("durationchange", onDurationChangeHandler);

		const playerContainer = getPlayerContainer();
		if (playerContainer) {
			playerContainer.addEventListener("mousemove", onMouseMoveHandler);
			overlayObserver = new MutationObserver(() => {
				refreshActionButtons();
				scheduleHighlightRefresh();
			});
			overlayObserver.observe(playerContainer, {
				attributes: true,
				attributeFilter: ["class"]
			});
		}

		refreshActionButtons();
	}

	function refreshActionButtons() {
		if (!video || !video.parentElement) {
			return;
		}

		const overlayVisible = isOverlayVisible();

		const segmentType = activeSegment && isSegmentButtonEnabled(activeSegment.type) ? activeSegment.type : null;

		if (segmentType !== displayedSegmentType) {
			removeNodeById(ACTIVE_BTN_ID);
			displayedSegmentType = segmentType;
			// New segment type: allow showing skip again even if overlay is hidden.
			skipHiddenBecauseOverlay = false;
		}

		// Skip button behavior: allow it to appear even when overlay controls are hidden.
		// But if it timed out while overlay was hidden, don't recreate it until overlay shows again.
		if (segmentType && !document.getElementById(ACTIVE_BTN_ID) && !(skipHiddenBecauseOverlay && !overlayVisible)) {
			showSkipButton(activeSegment);
		}

		// Submit button should follow Stremio's overlay visibility (like pause controls).
		if (overlayVisible) {
			if (submissionUiEnabled && !document.getElementById(SUBMIT_BTN_ID) && !document.getElementById(SUBMIT_MODAL_ID)) {
				showSubmitButton();
			}
		} else {
			// Ensure it does not linger when overlay is hidden.
			removeNodeById(SUBMIT_BTN_ID);
		}
	}

	function hideFloatingButtons() {
		// Only hide the skip button on inactivity; the submit button follows overlay visibility.
		hideSkipButton();
	}

	function hideSkipButton() {
		const playerContainer = getPlayerContainer();
		const overlayHidden = playerContainer && Array.from(playerContainer.classList).some((className) => className.includes("overlayHidden"));
		const button = document.getElementById(ACTIVE_BTN_ID);
		if (!button) {
			return;
		}

		if (overlayHidden) {
			skipHiddenBecauseOverlay = true;
			button.style.opacity = "0";
			setTimeout(() => {
				const stillThere = document.getElementById(ACTIVE_BTN_ID);
				if (stillThere && stillThere.style.opacity === "0") {
					stillThere.remove();
				}
			}, 500);
			return;
		}

		// Overlay visible again: allow skip to be shown.
		skipHiddenBecauseOverlay = false;
		button.style.opacity = "1";
		clearTimeout(skipButtonTimeout);
		skipButtonTimeout = setTimeout(hideSkipButton, HIDE_TIMEOUT);
	}

	function positionFloatingButtons() {
		const skipBtn = document.getElementById(ACTIVE_BTN_ID);
		const submitBtn = document.getElementById(SUBMIT_BTN_ID);
		const gap = 12;
		const baseRight = Math.max(24, Math.round(window.innerWidth * 0.08));
		const bottomPx = 128;

		if (skipBtn) {
			skipBtn.style.right = `${baseRight}px`;
			skipBtn.style.bottom = `${bottomPx}px`;
		}

		if (submitBtn) {
			if (skipBtn) {
				submitBtn.style.right = `${baseRight + skipBtn.offsetWidth + gap}px`;
				submitBtn.style.bottom = `${bottomPx}px`;
			} else {
				submitBtn.style.right = `${baseRight}px`;
				submitBtn.style.bottom = `${bottomPx}px`;
			}
		}
	}

	function showSubmitButton() {
		if (!submissionUiEnabled || !video || !video.parentElement || document.getElementById(SUBMIT_BTN_ID) || !isOverlayVisible()) {
			return;
		}

		const btn = document.createElement("button");
		btn.id = SUBMIT_BTN_ID;
		btn.textContent = "Submit";

		Object.assign(btn.style, {
			position: "absolute",
			bottom: "128px",
			right: "8vh",
			padding: "10px 18px",
			background: "rgba(15,13,32,0.88)",
			color: "#00dcb0",
			border: "1px solid rgba(0,240,181,0.25)",
			borderRadius: "999px",
			cursor: "pointer",
			fontSize: "16px",
			fontWeight: "600",
			zIndex: "1002",
			opacity: "0",
			transition: "opacity 0.2s ease"
		});

		btn.onmouseover = () => {
			btn.style.backgroundColor = "rgba(27,25,43,0.95)";
			clearTimeout(skipButtonTimeout);
		};

		btn.onmouseout = () => {
			btn.style.backgroundColor = "rgba(15,13,32,0.88)";
			skipButtonTimeout = setTimeout(hideFloatingButtons, HIDE_TIMEOUT);
		};

		btn.onclick = (event) => {
			event.preventDefault();
			openSubmitModal();
		};

		video.parentElement.appendChild(btn);
		requestAnimationFrame(() => {
			positionFloatingButtons();
			btn.style.opacity = "0.94";
		});
	}

	function formatTimeMMSS(totalSeconds) {
		const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
		const hh = Math.floor(sec / 3600);
		const mm = Math.floor((sec % 3600) / 60);
		const ss = sec % 60;
		if (hh > 0) {
			return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
		}
		return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
	}

	function parseTimeMMSS(value) {
		if (typeof value !== "string") {
			return 0;
		}

		const trimmed = value.trim();
		if (!trimmed) {
			return 0;
		}

		const parts = trimmed.split(":").map((part) => Number(part));
		if (parts.some((part) => Number.isNaN(part))) {
			return 0;
		}

		if (parts.length === 2) {
			return (parts[0] * 60) + parts[1];
		}

		if (parts.length === 3) {
			return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
		}

		return Number(trimmed) || 0;
	}

	function getParsedEpisodeInfo() {
		if (!episodeId) {
			return null;
		}

		const parts = episodeId.split(":");
		const id = parts[0];
		const isTvShow = parts.length === 3;
		return {
			baseId: id,
			isTvShow,
			isImdb: id.startsWith("tt"),
			season: isTvShow ? Number(parts[1]) : null,
			episode: isTvShow ? Number(parts[2]) : null
		};
	}

	async function resolveTmdbIdForSubmission() {
		const info = getParsedEpisodeInfo();
		if (!info) {
			throw new Error("Missing media ID");
		}

		if (!info.isImdb) {
			return Number(info.baseId);
		}

		if (!tmdbApiToken) {
			throw new Error("TMDb token required to resolve IMDb IDs for submission");
		}

		const res = await fetch(`https://api.themoviedb.org/3/find/${encodeURIComponent(info.baseId)}?external_source=imdb_id`, {
			headers: {
				Authorization: `Bearer ${tmdbApiToken}`,
				Accept: "application/json"
			}
		});

		if (!res.ok) {
			throw new Error(`TMDb lookup failed (${res.status})`);
		}

		const data = await res.json();
		const match = data.movie_results?.[0] || data.tv_results?.[0];
		if (!match || typeof match.id !== "number") {
			throw new Error("No TMDb match found");
		}

		return match.id;
	}

	function openSubmitModal() {
		if (!video || !video.parentElement) {
			return;
		}

		removeNodeById(SUBMIT_MODAL_ID);
		removeNodeById(SUBMIT_BTN_ID);

		const overlay = document.createElement("div");
		overlay.id = SUBMIT_MODAL_ID;

		const info = getParsedEpisodeInfo();
		const mediaMeta = info && info.isTvShow ? `S${String(info.season).padStart(2, "0")}E${String(info.episode).padStart(2, "0")}` : "Feature Film";
		const startDefault = formatTimeMMSS(video.currentTime || 0);

		Object.assign(overlay.style, {
			position: "absolute",
			right: "24px",
			bottom: "116px",
			zIndex: "2000",
			pointerEvents: "none",
			background: "transparent"
		});

		const panel = document.createElement("div");
		Object.assign(panel.style, {
			position: "relative",
			width: "min(330px, calc(100vw - 48px))",
			maxWidth: "calc(100vw - 48px)",
			background: "rgba(5,11,27,0.97)",
			color: "#d8fff6",
			borderRadius: "22px",
			padding: "18px",
			boxShadow: "0 20px 50px rgba(0,0,0,0.45)",
			border: "1px solid rgba(0,240,181,0.20)",
			fontFamily: "sans-serif",
			boxSizing: "border-box",
			pointerEvents: "auto"
		});

		for (const eventName of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "wheel"]) {
			panel.addEventListener(eventName, (event) => {
				event.stopPropagation();
			}, false);
		}


		panel.addEventListener("mousedown", (event) => {
			event.stopPropagation();
		});

		panel.addEventListener("touchstart", (event) => {
			event.stopPropagation();
		}, { passive: true });

		panel.innerHTML = `
			<div style="font-size:24px;font-weight:800;color:#00f0b5;margin-bottom:8px;line-height:1;">TIDB</div>
			<div style="font-size:16px;margin-bottom:8px;color:#d9e7ea;">Submit</div>
			<div style="padding:10px 12px;border:1px solid rgba(255,255,255,0.14);border-radius:12px;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;box-sizing:border-box;">${escapeHtml(title || "Detected")}</div>
			<div style="font-size:12px;opacity:0.72;margin-bottom:14px;">${escapeHtml(mediaMeta)}</div>
			<div style="font-size:11px;font-weight:700;color:#00f0b5;margin-bottom:7px;letter-spacing:0.04em;">SEGMENT</div>
			<div id="tidb-segment-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;"></div>
			<div style="font-size:11px;font-weight:700;color:#00f0b5;margin-bottom:7px;letter-spacing:0.04em;">TIME</div>
			<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin-bottom:8px;">
				<input id="tidb-start-input" value="${startDefault}" style="width:100%;min-width:0;background:#141518;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:999px;padding:12px 14px;font-size:18px;outline:none;box-sizing:border-box;" />
				<input id="tidb-end-input" value="" placeholder="01:30" style="width:100%;min-width:0;background:#141518;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:999px;padding:12px 14px;font-size:18px;outline:none;box-sizing:border-box;" />
			</div>
			<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin-bottom:14px;">
				<button id="tidb-set-start" style="min-width:0;border-radius:999px;padding:10px 12px;border:1px solid rgba(0,240,181,0.25);background:#162234;color:#c7fff0;cursor:pointer;font-size:12px;box-sizing:border-box;">Use current for start</button>
				<button id="tidb-set-end" style="min-width:0;border-radius:999px;padding:10px 12px;border:1px solid rgba(0,240,181,0.25);background:#162234;color:#c7fff0;cursor:pointer;font-size:12px;box-sizing:border-box;">Use current for end</button>
			</div>
			<button id="tidb-submit-accept" style="width:100%;padding:15px;border-radius:999px;border:1px solid rgba(0,240,181,0.35);background:#162234;color:#00f0b5;font-size:18px;font-weight:700;cursor:pointer;box-sizing:border-box;">ACCEPT</button>
			<div id="tidb-submit-status" style="margin-top:10px;min-height:18px;font-size:12px;"></div>
			<button id="tidb-submit-close" style="width:100%;margin-top:12px;padding:12px;border-radius:999px;border:1px solid rgba(255,255,255,0.10);background:#1b2233;color:#ff6b6b;cursor:pointer;font-size:14px;box-sizing:border-box;">Close</button>
		`;

		overlay.appendChild(panel);
		video.parentElement.appendChild(overlay);

		const segmentGrid = panel.querySelector("#tidb-segment-grid");
		const startInput = panel.querySelector("#tidb-start-input");
		const endInput = panel.querySelector("#tidb-end-input");
		const statusEl = panel.querySelector("#tidb-submit-status");
		let selectedSegment = "intro";

		function renderSegmentButtons() {
			segmentGrid.innerHTML = "";
			for (const type of ["intro", "recap", "credits", "preview"]) {
				const btn = document.createElement("button");
				const active = selectedSegment === type;
				btn.textContent = type.charAt(0).toUpperCase() + type.slice(1);
				Object.assign(btn.style, {
					padding: "12px 10px",
					borderRadius: "999px",
					cursor: "pointer",
					fontSize: "14px",
					fontWeight: active ? "700" : "500",
					border: active ? "1px solid rgba(0,240,181,0.55)" : "1px solid rgba(255,255,255,0.12)",
					background: active ? "#162234" : "#1b2233",
					color: active ? "#00f0b5" : "#9aa3b2",
					boxSizing: "border-box"
				});
				btn.onclick = () => {
					selectedSegment = type;
					renderSegmentButtons();
				};
				segmentGrid.appendChild(btn);
			}
		}

		renderSegmentButtons();

		panel.querySelector("#tidb-set-start").onclick = () => {
			startInput.value = formatTimeMMSS(video.currentTime || 0);
		};

		panel.querySelector("#tidb-set-end").onclick = () => {
			endInput.value = formatTimeMMSS(video.currentTime || 0);
		};

		panel.querySelector("#tidb-submit-close").onclick = () => {
			overlay.remove();
			refreshActionButtons();
		};

		panel.querySelector("#tidb-submit-accept").onclick = async () => {
			const startSec = parseTimeMMSS(startInput.value);
			const endTrimmed = endInput.value.trim();
			const endSec = endTrimmed === "" ? ((selectedSegment === "credits" || selectedSegment === "preview") ? null : 0) : parseTimeMMSS(endTrimmed);

			if (!userApiKey) {
				statusEl.textContent = "Add your TIDB API key in plugin settings.";
				statusEl.style.color = "#ff6b6b";
				return;
			}

			if (endSec !== null && endSec <= startSec) {
				statusEl.textContent = "End time must be greater than start time.";
				statusEl.style.color = "#ff6b6b";
				return;
			}

			statusEl.textContent = "Submitting...";
			statusEl.style.color = "#c7fff0";

			try {
				const tmdbId = await resolveTmdbIdForSubmission();
				const parsed = getParsedEpisodeInfo();
				const payload = {
					tmdb_id: tmdbId,
					type: parsed && parsed.isTvShow ? "tv" : "movie",
					segment: selectedSegment,
					start_sec: startSec,
					end_sec: endSec
				};

				if (parsed && parsed.isTvShow) {
					payload.season = parsed.season;
					payload.episode = parsed.episode;
				}

				const res = await fetch(`${SERVER_URL}/submit`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${userApiKey}`
					},
					body: JSON.stringify(payload)
				});

				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || err.message || `Submit failed (${res.status})`);
				}

				statusEl.textContent = "Submitted successfully.";
				statusEl.style.color = "#00f0b5";
				await fetchData();
			} catch (err) {
				statusEl.textContent = err && err.message ? err.message : "Connection failed.";
				statusEl.style.color = "#ff6b6b";
			}
		};
	}

	function escapeHtml(value) {
		return String(value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/\"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	function getSliderElements() {
		const slider = document.querySelector(".slider-container-nJz5F") || document.querySelector('[class*="slider-container"]');
		if (!slider) {
			return null;
		}
		const trackEl = slider.querySelector(".track-gItfW") || slider.querySelector('[class*="track-"]');
		const thumbEl = slider.querySelector(".thumb-PiTF5") || slider.querySelector('[class*="thumb-"]');
		return { slider, trackEl, thumbEl };
	}

	function scheduleHighlightRefresh() {
		highlightRefreshGeneration += 1;
		const generation = highlightRefreshGeneration;
		if (highlightRefreshTimeout) {
			clearTimeout(highlightRefreshTimeout);
			highlightRefreshTimeout = null;
		}

		let attempt = 0;
		const tryDraw = () => {
			if (generation !== highlightRefreshGeneration) {
				return;
			}
			attempt += 1;
			const ok = highlightRangeOnBar();
			if (!ok && attempt < HIGHLIGHT_RETRY_COUNT) {
				highlightRefreshTimeout = setTimeout(tryDraw, HIGHLIGHT_RETRY_DELAY);
			}
		};
		tryDraw();
	}

	function highlightRangeOnBar() {
		const els = getSliderElements();
		if (!els || !video || !video.duration || !Number.isFinite(video.duration)) {
			return false;
		}

		const { slider, trackEl, thumbEl } = els;
		removeHighlights();
		if (!trackEl) {
			return false;
		}

		const segmentColors = {
			intro: "rgba(255, 217, 0, 0.6)",
			recap: "rgba(255, 165, 0, 0.6)",
			credits: "rgba(100, 149, 237, 0.6)",
			preview: "rgba(144, 238, 144, 0.6)"
		};

		for (const [segmentType, segmentList] of Object.entries(segments)) {
			for (const segment of segmentList) {
				const segmentEnd = segment.end == null ? video.duration : segment.end;
				if (!(segmentEnd > segment.start)) {
					continue;
				}

				const highlight = document.createElement("div");
				const thumbLayer = thumbEl && thumbEl.parentNode;
				const startPct = (segment.start / video.duration) * 100;
				const widthPct = ((segmentEnd - segment.start) / video.duration) * 100;

				highlight.className = `segment-highlight segment-${segmentType}`;
				Object.assign(highlight.style, {
					position: "absolute",
					top: `${trackEl.offsetTop}px`,
					left: `${startPct}%`,
					width: `${widthPct}%`,
					borderRadius: "4px",
					height: `${trackEl.clientHeight || 6}px`,
					background: segmentColors[segmentType],
					pointerEvents: "none",
					zIndex: "0"
				});

				slider.insertBefore(highlight, thumbLayer && slider.contains(thumbLayer) ? thumbLayer : slider.firstChild);
			}
		}

		return true;
	}

	async function showSkipButton(segment) {
		if (!video || !video.parentElement || document.getElementById(ACTIVE_BTN_ID)) {
			return;
		}

		const segmentType = segment.type;
		if (!isSegmentButtonEnabled(segmentType)) {
			return;
		}

		const skipBtn = document.createElement("button");
		const icon = document.createElement("img");
		const segmentLabels = {
			intro: "Skip Intro",
			recap: "Skip Recap",
			credits: "Skip Credits",
			preview: "Skip Preview"
		};

		skipBtn.id = ACTIVE_BTN_ID;
		skipBtn.setAttribute("data-segment-type", segmentType);
		skipBtn.textContent = segmentLabels[segmentType] || "Skip Segment";

		icon.src = "https://www.svgrepo.com/show/471906/skip-forward.svg";
		icon.alt = "Skip icon";
		icon.width = 20;
		icon.height = 20;
		icon.style.filter = "brightness(0) invert(1)";
		icon.style.pointerEvents = "none";

		Object.assign(skipBtn.style, {
			position: "absolute",
			bottom: "128px",
			right: "8vh",
			padding: "13px 16px",
			background: "rgba(15,13,32,0.92)",
			color: "#fff",
			border: "none",
			borderRadius: "8px",
			cursor: "pointer",
			fontSize: "20px",
			fontWeight: "600",
			zIndex: "1001",
			display: "flex",
			alignItems: "center",
			gap: "8px",
			opacity: "0",
			transition: "opacity 0.5s ease-in-out"
		});

		skipBtn.prepend(icon);
		skipBtn.onmouseover = () => {
			skipBtn.style.backgroundColor = "rgba(27,25,43,0.96)";
			clearTimeout(skipButtonTimeout);
		};
		skipBtn.onmouseout = () => {
			skipBtn.style.backgroundColor = "rgba(15,13,32,0.92)";
			skipButtonTimeout = setTimeout(hideSkipButton, HIDE_TIMEOUT);
		};
		skipBtn.onclick = (event) => {
			event.preventDefault();
			clearTimeout(skipButtonTimeout);
			if (video) {
				video.currentTime = segment.end;
			}
			skipBtn.remove();
			displayedSegmentType = null;
			refreshActionButtons();
		};

		video.parentElement.appendChild(skipBtn);
		requestAnimationFrame(() => {
			positionFloatingButtons();
			skipBtn.style.opacity = "1";
		});

		// Auto-hide after inactivity even if the user never moves the mouse.
		clearTimeout(skipButtonTimeout);
		skipButtonTimeout = setTimeout(hideSkipButton, HIDE_TIMEOUT);
	}

	async function getTitle() {
		const { seriesInfo, meta } = await getPlayerState();
		let resolvedTitle = meta?.name || "Unknown Title";
		if (seriesInfo?.season != null && seriesInfo?.episode != null) {
			const season = String(seriesInfo.season).padStart(2, "0");
			const episode = String(seriesInfo.episode).padStart(2, "0");
			resolvedTitle = `${resolvedTitle} S${season}E${episode}`;
		}
		return resolvedTitle;
	}

	async function getPlayerState() {
		let state = null;
		const maxAttempts = Math.max(1, Math.ceil(PLAYER_STATE_MAX_WAIT_MS / PLAYER_STATE_POLL_DELAY));
		let attempts = 0;

		while (!state?.metaItem?.content && attempts < maxAttempts) {
			attempts += 1;
			state = await _eval("window.services.core.transport.getState('player')");
			if (!state?.metaItem?.content) {
				await new Promise((resolve) => setTimeout(resolve, PLAYER_STATE_POLL_DELAY));
			}
		}
		if (!state?.metaItem?.content) {
			throw new Error("Timed out waiting for player state");
		}
		return {
			seriesInfo: state.seriesInfo,
			meta: state.metaItem.content
		};
	}

	async function getEpisodeId() {
		const { seriesInfo, meta } = await getPlayerState();
		if (seriesInfo?.season != null && seriesInfo?.episode != null) {
			return `${meta.id}:${seriesInfo.season}:${seriesInfo.episode}`;
		}
		return meta.id;
	}

	function _eval(js) {
		return new Promise((resolve) => {
			const event = `stremio-enhanced-${Date.now()}-${Math.random().toString(16).slice(2)}`;
			const script = document.createElement("script");

			window.addEventListener(event, (browserEvent) => {
				script.remove();
				resolve(browserEvent.detail);
			}, { once: true });

			script.textContent = `
				(async () => {
					try {
						const res = ${js};
						if (res instanceof Promise) {
							res.then((result) => window.dispatchEvent(new CustomEvent("${event}", { detail: result })));
						} else {
							window.dispatchEvent(new CustomEvent("${event}", { detail: res }));
						}
					} catch (err) {
						console.error(err);
						window.dispatchEvent(new CustomEvent("${event}", { detail: null }));
					}
				})();
			`;

			document.head.appendChild(script);
		});
	}

	const observer = new MutationObserver(() => {
		const newVideo = document.querySelector("video");
		if (newVideo && newVideo !== video) {
			if (video) {
				cleanup();
			}
			video = newVideo;
			video.addEventListener("loadedmetadata", onPlay, { once: true });
		}
	});

	observer.observe(document.body, {
		childList: true,
		subtree: true
	});

	window.addEventListener("beforeunload", () => {
		localStorage.removeItem("updateReminder");
	});
})();
