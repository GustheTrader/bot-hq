// The home page lives on the local home server; this page only frames it.
// The framed page tells us its title and tint so the tab strip matches.
window.addEventListener('message', (event) => {
  if (event.origin !== 'http://127.0.0.1:7391') return;
  const data = event.data || {};
  if (typeof data.title === 'string' && data.title) document.title = data.title.slice(0, 80);
  if (typeof data.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.background)) {
    document.body.style.background = data.background;
  }
  // The Browser tile on the home page asks for a fresh tab.
  if (data.open === 'newtab') chrome.tabs.create({});
});
