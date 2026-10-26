// Общие помощники для фона и попапа.

const DEFAULTS = Object.freeze({ volume: 1, bass: 0, treble: 0 });

function isDefault(s) {
  return !s || (s.volume === 1 && s.bass === 0 && s.treble === 0);
}

// Ключ сайта: hostname без "www.". Для служебных страниц — null.
function hostFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.hostname.replace(/^www\./, '');
    }
    if (u.protocol === 'file:') return 'file';
  } catch (_) {
    // не URL — значит не сайт
  }
  return null;
}
