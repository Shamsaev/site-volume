// Фон: подсказывает контент-скриптам, какой сайт открыт во вкладке,
// и рисует на иконке бейдж с громкостью.

const BADGE = { quiet: '#4b5361', boost: '#c98a14', high: '#d6463a' };

// Контент-скрипт в iframe видит адрес iframe, а настройки берутся по сайту вкладки.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'get-host') {
    const url = sender.frameId === 0 ? sender.url : (sender.tab && sender.tab.url) || sender.url;
    return Promise.resolve({ host: hostFromUrl(url) });
  }
  return undefined;
});

async function getSites() {
  const { sites = {} } = await browser.storage.local.get('sites');
  return sites;
}

function paintBadge(tab, sites) {
  if (tab.id == null || tab.id === browser.tabs.TAB_ID_NONE) return;
  const host = hostFromUrl(tab.url);
  const s = host ? sites[host] : null;
  const pct = s ? Math.round(s.volume * 100) : 100;
  const text = pct === 100 ? '' : String(pct);

  browser.action.setBadgeText({ tabId: tab.id, text }).catch(() => {});
  if (text) {
    const color = pct > 300 ? BADGE.high : pct > 100 ? BADGE.boost : BADGE.quiet;
    browser.action.setBadgeBackgroundColor({ tabId: tab.id, color }).catch(() => {});
    if (browser.action.setBadgeTextColor) {
      browser.action.setBadgeTextColor({ tabId: tab.id, color: '#ffffff' }).catch(() => {});
    }
  }
}

async function refreshAll() {
  const [sites, tabs] = await Promise.all([getSites(), browser.tabs.query({})]);
  for (const tab of tabs) paintBadge(tab, sites);
}

browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url || info.status === 'complete') paintBadge(tab, await getSites());
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sites) refreshAll();
});

browser.runtime.onInstalled.addListener(refreshAll);
browser.runtime.onStartup.addListener(refreshAll);
