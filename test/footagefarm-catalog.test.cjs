const test = require('node:test');
const assert = require('node:assert/strict');
const { reelRows } = require('../lib/footagefarm.cjs');

test('Footage Farm catalog keeps each numeric ID with the canonical URL in its own card', () => {
  const sourcePage = 'https://footagefarm.com/subthemes/wwi/generic';
  const html = `
    <a href="https://footagefarm.com/reel-details/outside/page/header-link">Header link</a>
    <div class="block-single theme-single">
      <!-- <a href="https://footagefarm.com/reel-details/101/219">Legacy details link</a> -->
      <a href="https://footagefarm.com/reel-details/wwi/generic/first-reel">First reel</a>
      <span data-url="https://footagefarm.com/reel-details/101/219"></span>
    </div>
    <div class="theme-single extra block-single">
      <!--
        <a href="https://footagefarm.com/reel-details/wrong/commented/not-this-reel">Old canonical link</a>
        <span data-url="https://footagefarm.com/reel-details/999/219"></span>
      -->
      <a href="https:\\/\\/footagefarm.com\\/reel-details\\/wwi\\/generic\\/second-reel">Second reel</a>
      <span data-url="https:\\/\\/footagefarm.com\\/reel-details\\/102\\/219"></span>
    </div>
    <div class="block-single theme-single">
      <a href="https://footagefarm.com/reel-details/wwi/generic/last-reel">Last reel</a>
      <span data-url="https://footagefarm.com/reel-details/103/219"></span>
    </div>
    <a href="https://footagefarm.com/reel-details/outside/page/footer-link">Footer link</a>
  `;

  assert.deepEqual(reelRows(html, sourcePage), [
    {
      id: '101',
      url: 'https://footagefarm.com/reel-details/wwi/generic/first-reel',
      title: 'first reel',
      source_page: sourcePage,
      share_url: 'https://footagefarm.com/reel-details/101/219'
    },
    {
      id: '102',
      url: 'https://footagefarm.com/reel-details/wwi/generic/second-reel',
      title: 'second reel',
      source_page: sourcePage,
      share_url: 'https://footagefarm.com/reel-details/102/219'
    },
    {
      id: '103',
      url: 'https://footagefarm.com/reel-details/wwi/generic/last-reel',
      title: 'last reel',
      source_page: sourcePage,
      share_url: 'https://footagefarm.com/reel-details/103/219'
    }
  ]);
});

test('Footage Farm catalog falls back to the numeric share URL when a card has no canonical link', () => {
  const sourcePage = 'https://footagefarm.com/subthemes/wwi/generic';
  const html = `
    <div class="block-single theme-single">
      <!-- <a href="https://footagefarm.com/reel-details/104/219">Legacy details link</a> -->
      <img src="/images/request_preview.svg" alt="Request preview">
    </div>
    <a href="https://footagefarm.com/reel-details/outside/page/must-not-bind">Footer link</a>
  `;

  assert.deepEqual(reelRows(html, sourcePage), [{
    id: '104',
    url: 'https://footagefarm.com/reel-details/104/219',
    title: 'Footage Farm reel 104',
    source_page: sourcePage,
    share_url: 'https://footagefarm.com/reel-details/104/219'
  }]);
});
