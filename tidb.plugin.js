/**
 * @name TheIntroDB
 * @description Skip Intro for shows and movies in Stremio Enhanced using TheIntroDB API
 * @updateUrl https://raw.githubusercontent.com/TheIntroDB/stremio-enhanced-plugin/refs/heads/main/tidb.plugin.js
 * @version 0.1.1
 * @author TheIntroDB
 */

(function () {
  "use strict";

  const SERVER_URL = "https://api.theintrodb.org/v2";
  const API_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIxMDBiMDIzOWQzNGY5YzI0Yjc2MzM5Mjg2YjNlOWNiMSIsIm5iZiI6MTc0ODUwMzgzMS43NjMsInN1YiI6IjY4MzgwZDE3MDc5YTQyZTI4NzAzODYyMyIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.ykvYVrw8wjBdjkeb-71y1n1Z8ng3xE5ciodJ6FZgrNw";
  const ACTIVE_BTN_ID = "tidb-active-btn";
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 2000;

  let video = null;
  let episodeId = null;
  let title = null;
  let segments = { intro: [], recap: [], credits: [], preview: [] }; // Store all segment types
  let activeSegment = null; // Currently active segment
  let onTimeUpdate = null;
  let onSeekedHandler = null;
  let onMouseMoveHandler = null;
  let overlayObserver = null;
  let skipButtonTimeout = null;
  let displayedSegmentType = null;
  
  async function onPlay() {
    video = document.querySelector("video");
    episodeId = await getEpisodeId();
    title = await getTitle();
    console.log(`[TheIntroDB] \nEpisode ID: ${episodeId}, \nTitle: ${title}`);
    await fetchData();
  }
  async function fetchData() {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`[TheIntroDB] Fetching /media for episode ${episodeId} (attempt ${attempt})`);
      try {
        const parts = episodeId.split(':');
        const id = parts[0];
        const isTvShow = parts.length === 3;
        const isImdb = id.startsWith('tt');

        const queryParams = new URLSearchParams();

        if (isImdb) {
            queryParams.set('imdb_id', id);
        } else {
            queryParams.set('tmdb_id', id);
        }

        if (isTvShow) {
            queryParams.set('season', parts[1]);
            queryParams.set('episode', parts[2]);
        }

        const res = await fetch(`${SERVER_URL}/media?${queryParams}`, {
          headers: {
            'Authorization': `Bearer ${API_KEY}`
          }
        });
        if (res.status === 204) {
          segments = { intro: [], recap: [], credits: [], preview: [] };
          console.log(`[TheIntroDB] No skip data for episode ${episodeId} (${res.status})`);
          return null;
        }
        if (res.status === 404) {
          console.warn(`[TheIntroDB] No data found for episode ${episodeId}`);
          segments = { intro: [], recap: [], credits: [], preview: [] };
          return null;
        }
        if (!res.ok) {
          console.warn(`[TheIntroDB] Unexpected response for ${episodeId}: ${res.status}`);
          return null;
        }
        const json = await res.json();
        // Map TheIntroDB API response to our format
        segments = { intro: [], recap: [], credits: [], preview: [] };
        
        // Process all segment types
        ['intro', 'recap', 'credits', 'preview'].forEach(segmentType => {
          if (json[segmentType] && json[segmentType].length > 0) {
            segments[segmentType] = json[segmentType].map(segment => ({
              start: segment.start_ms ? segment.start_ms / 1000 : 0,
              end: segment.end_ms ? segment.end_ms / 1000 : null,
            }));
            console.log(`[TheIntroDB] Loaded ${segments[segmentType].length} ${segmentType} segments`);
          }
        });
        
        const totalSegments = Object.values(segments).flat().length;
        if (totalSegments === 0) {
          console.log(`[TheIntroDB] No segment data found for episode ${episodeId}`);
        }
        highlightRangeOnBar();
        attachTimeUpdate();
        return null;
      } catch (err) {
        console.error(`[TheIntroDB] Error fetching media for ${episodeId}:`, err);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY));
        } else {
          return null;
        }
      }
    }
    return null;
  }

  function cleanup() {
    console.log("[TheIntroDB] Cleaning up previous media...");

    // Remove event listeners from the old video element
    if (video) {
        video.removeEventListener("timeupdate", onTimeUpdate);
        video.removeEventListener("seeked", onSeekedHandler);
        video.removeEventListener("loadedmetadata", onPlay);
        const playerContainer = video.closest('.player-container');
        if (playerContainer) {
            playerContainer.removeEventListener('mousemove', onMouseMoveHandler);
        }
    }

    // Disconnect the overlay observer
    if (overlayObserver) {
        overlayObserver.disconnect();
        overlayObserver = null;
    }

    // Clear any pending timeouts
    clearTimeout(skipButtonTimeout);

    // Remove UI elements
    const existingButton = document.getElementById(ACTIVE_BTN_ID);
    if (existingButton) {
        existingButton.remove();
    }

    // Reset state variables
    video = null;
    episodeId = null;
    title = null;
    segments = { intro: [], recap: [], credits: [], preview: [] };
    activeSegment = null;
    displayedSegmentType = null;
    onTimeUpdate = null;
    onSeekedHandler = null;
    onMouseMoveHandler = null;
  }

  function attachTimeUpdate() {
    onTimeUpdate = async () => {
      // Find the current active segment
      let newActiveSegment = null;
      for (const [segmentType, segmentList] of Object.entries(segments)) {
        for (const segment of segmentList) {
          const segmentEnd = segment.end || video.duration;
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
        if (newActiveSegment) break;
      }
      activeSegment = newActiveSegment;

      const segmentType = activeSegment ? activeSegment.type : null;

      // If the segment state is different from what's displayed, update the UI
      if (segmentType !== displayedSegmentType) {
        const existingButton = document.getElementById(ACTIVE_BTN_ID);
        if (existingButton) {
          existingButton.remove();
        }

        if (activeSegment) {
          await showSkipButton(activeSegment);
        }
        
        displayedSegmentType = segmentType;
      }
    };

    onSeekedHandler = () => onTimeUpdate();

    onMouseMoveHandler = () => {
        // If the button is visible, reset its hide timer.
        if (document.getElementById(ACTIVE_BTN_ID)) {
            clearTimeout(skipButtonTimeout);
            skipButtonTimeout = setTimeout(hideSkipButton, HIDE_TIMEOUT);
        }
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeked", onSeekedHandler);

    const playerContainer = video.closest('[class*="player-container"]');
    if (playerContainer) {
        playerContainer.addEventListener('mousemove', onMouseMoveHandler);

        // This observer is the new core logic for re-showing the button.
        overlayObserver = new MutationObserver(() => {
            const isOverlayHidden = Array.from(playerContainer.classList).some(c => c.includes('overlayHidden'));
            // If the overlay is now visible, a segment is active, and the button is missing, show it.
            if (!isOverlayHidden && activeSegment && !document.getElementById(ACTIVE_BTN_ID)) {
                showSkipButton(activeSegment);
            }
        });

        overlayObserver.observe(playerContainer, { attributes: true, attributeFilter: ['class'] });
    }
  }



  async function highlightRangeOnBar() {
    const slider = document.querySelector(".slider-container-nJz5F");
    if (!slider) return;
    
    // Remove existing highlights
    const existingHighlights = slider.querySelectorAll(".segment-highlight");
    existingHighlights.forEach(h => h.remove());
    
    if (!video || !video.duration) return;
    
    const trackEl = slider.querySelector(".track-gItfW");
    if (!trackEl) return;
    
    // Segment colors
    const segmentColors = {
      intro: "rgba(255, 217, 0, 0.6)",      // Yellow
      recap: "rgba(255, 165, 0, 0.6)",      // Orange  
      credits: "rgba(100, 149, 237, 0.6)",   // Cornflower blue
      preview: "rgba(144, 238, 144, 0.6)"    // Light green
    };
    
    // Create highlights for all segments
    for (const [segmentType, segmentList] of Object.entries(segments)) {
      segmentList.forEach((segment) => {
        const highlight = document.createElement("div");
        highlight.className = `segment-highlight segment-${segmentType}`;
        
        const startPct = (segment.start / video.duration) * 100;
        const segmentEnd = segment.end || video.duration;
        const widthPct = ((segmentEnd - segment.start) / video.duration) * 100;
        
        Object.assign(highlight.style, {
          position: "absolute",
          top: trackEl.offsetTop + "px",
          left: `${startPct}%`,
          width: `${widthPct}%`,
          borderRadius: "4px",
          height: trackEl.clientHeight + "px",
          background: segmentColors[segmentType],
          pointerEvents: "none",
          zIndex: "0"
        });
        
        const thumbEl = slider.querySelector('.thumb-PiTF5');
        const thumbLayer = thumbEl && thumbEl.parentNode;
        slider.insertBefore(highlight, thumbLayer && slider.contains(thumbLayer) ? thumbLayer : slider.firstChild);
      });
    }
  }
  const HIDE_TIMEOUT = 5000; // 5 seconds

  function hideSkipButton() {
      const playerContainer = document.querySelector('[class*="player-container"]');
      const isOverlayHidden = playerContainer && Array.from(playerContainer.classList).some(c => c.includes('overlayHidden'));

      // Only hide the button if the overlay is also hidden
      if (isOverlayHidden) {
          const button = document.getElementById(ACTIVE_BTN_ID);
          if (button) {
              button.style.opacity = '0';
              setTimeout(() => {
                  if (button && button.style.opacity === '0') {
                      button.remove();
                  }
              }, 500);
          }
      } else {
          // If overlay is visible, ensure button is visible and reset timer
          const button = document.getElementById(ACTIVE_BTN_ID);
          if (button) {
              button.style.opacity = '1'; // Make button visible
          }
          clearTimeout(skipButtonTimeout);
          skipButtonTimeout = setTimeout(hideSkipButton, HIDE_TIMEOUT);
      }
  }


  async function showSkipButton(activeSegment) {
    if (document.getElementById(ACTIVE_BTN_ID)) return;
    const skipBtn = document.createElement("button");
    skipBtn.id = ACTIVE_BTN_ID;
    
    const segmentType = activeSegment.type;
    skipBtn.setAttribute('data-segment-type', segmentType);

    const segmentLabels = {
      intro: "Skip Intro",
      recap: "Skip Recap", 
      credits: "Skip Credits",
      preview: "Skip Preview"
    };
    skipBtn.textContent = segmentLabels[segmentType] || "Skip Segment";
    
    const icon = document.createElement("img");
    icon.src = "https://www.svgrepo.com/show/471906/skip-forward.svg";
    icon.alt = "Skip icon";
    icon.width = 24; icon.height = 24;
    icon.style.filter = "brightness(0) invert(1)";
    icon.style.pointerEvents = "none";
    Object.assign(skipBtn.style, {
      position: "absolute",
      bottom: "130px",
      right: "10vh",
      padding: "16px",
      background: "#0f0d20",
      color: "#fff",
      border: "none",
      borderRadius: "6px",
      cursor: "pointer",
      fontSize: "24px",
      zIndex: 1000,
      display: "flex",
      alignItems: "center",
      gap: "8px",
      opacity: "0", // Start transparent for fade-in
      transition: "opacity 0.5s ease-in-out" 
    });
    skipBtn.prepend(icon);

    skipBtn.onmouseover = () => {
        skipBtn.style.backgroundColor = "#1b192b";
        clearTimeout(skipButtonTimeout);
    };
    skipBtn.onmouseout = () => {
        skipBtn.style.backgroundColor = "#0f0d20";
        skipButtonTimeout = setTimeout(hideSkipButton, HIDE_TIMEOUT);
    };

    skipBtn.onclick = (e) => {
      e.preventDefault();
      clearTimeout(skipButtonTimeout);
      if (video) {
        video.currentTime = activeSegment.end;
        console.log(`[TheIntroDB] Skipping ${segmentType}: targetTime=${activeSegment.end}`);
      }
      skipBtn.remove();
      displayedSegmentType = null; // Reset state immediately on click
    };

    video.parentElement.appendChild(skipBtn);
    setTimeout(() => skipBtn.style.opacity = '1', 50); // Fade in

    skipButtonTimeout = setTimeout(hideSkipButton, HIDE_TIMEOUT);
  }
  
  async function getTitle() {
    const { seriesInfo, meta } = await getPlayerState();
    let title = meta?.name || "Unknown Title";
    if (seriesInfo?.season != null && seriesInfo?.episode != null) {
      const s = String(seriesInfo.season).padStart(2, "0");
      const e = String(seriesInfo.episode).padStart(2, "0");
      title = `${title} S${s}E${e}`;
    }
    return title;
  }
  async function getPlayerState() {
    let state = null;
    while (!state?.metaItem?.content) {
      state = await _eval("window.services.core.transport.getState('player')");
      if (!state?.metaItem?.content) await new Promise(r => setTimeout(r, 300));
    }
    return { seriesInfo: state.seriesInfo, meta: state.metaItem.content };
  }
  async function getEpisodeId() {
    const { seriesInfo, meta } = await getPlayerState();
    // For TV shows, seriesInfo is available
    if (seriesInfo && seriesInfo.season && seriesInfo.episode) {
        return `${meta.id}:${seriesInfo.season}:${seriesInfo.episode}`;
    }
    // For movies, seriesInfo is null
    return meta.id;
  }

  function _eval(js) {
    return new Promise((resolve) => {
      const event = "stremio-enhanced";
      const script = document.createElement("script");
      window.addEventListener(event, (e) => {
        script.remove();
        resolve(e.detail);
      }, { once: true });
      script.textContent = `
        (async () => {
          try {
            const res = ${js};
            if (res instanceof Promise) res.then(r => window.dispatchEvent(new CustomEvent('${event}', { detail: r })));
            else window.dispatchEvent(new CustomEvent('${event}', { detail: res }));
          } catch (err) {
            console.error(err);
            window.dispatchEvent(new CustomEvent('${event}', { detail: null }));
          }
        })();`;
      document.head.appendChild(script);
    });
  }

  /**
   * Attaches an observer to the document body to detect when a new video is loaded.
   * When a new video is detected, it cleans up the old video element and attaches the onPlay event listener to the new one.
   */
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

  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener("beforeunload", () => {
    localStorage.removeItem("updateReminder");
  });
})();