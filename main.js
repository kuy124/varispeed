// Runs in the page's own world, so it can reach YouTube's player API.
// Content scripts live in an isolated world and cannot see page-added methods
// like #movie_player.setPlaybackRate, which is why setting video.playbackRate
// alone gets reset back to 1x on YouTube.
(() => {
  let rate = 1;

  function apply() {
    const p = document.querySelector('#movie_player, .html5-video-player');
    if (p && typeof p.setPlaybackRate === 'function') {
      try { p.setPlaybackRate(rate); return; } catch (e) {}
    }
    document.querySelectorAll('video').forEach((v) => {
      try { v.playbackRate = Math.min(rate, 16); } catch (e) {}
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__vs !== 1) return;
    rate = Number(e.data.rate) || 1;
    apply();
  });

  // YouTube drops the rate on every SPA navigation / new source.
  window.addEventListener('yt-navigate-finish', apply, true);
  window.addEventListener('loadedmetadata', apply, true);
})();
