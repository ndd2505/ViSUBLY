// Unit tests for the Chrome extension's stream grouping (browser-extension/chrome/lib/streams.js).
// Run: node scripts/test-extension-streams.mjs
import assert from 'node:assert/strict';
import {
  upsertStream, buildGroups, isShortGroup, isRenditionChild, pickBestGroup, describeGroups,
  markPlaybackStart, formatDuration, formatApproxSize, streamKey, SHORT_MP4_BYTES,
} from '../browser-extension/chrome/lib/streams.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log('ok -', name); };
let clock = 1_000_000;
const add = (list, url, type = 'hls', extra = {}) => {
  clock += 1000;
  return upsertStream(list, { url, type, headers: {}, ...extra }, { now: clock, pageUrl: 'https://site.example/watch/1', pageTitle: 'Phim hay', ...(extra.ctx || {}) });
};
const masterProbe = (base, durationSec = 2472, extra = {}) => ({
  ok: true, kind: 'master', durationSec, isLive: false, isShort: false, renditions: [],
  variants: [
    { url: `${base}/1080/index.m3u8`, height: 1080, resolution: '1920x1080', bandwidth: 6e6, estBytes: Math.round(6e6 * durationSec / 8) },
    { url: `${base}/720/index.m3u8`, height: 720, resolution: '1280x720', bandwidth: 3e6, estBytes: Math.round(3e6 * durationSec / 8) },
    { url: `${base}/480/index.m3u8`, height: 480, resolution: '854x480', bandwidth: 1.4e6, estBytes: Math.round(1.4e6 * durationSec / 8) },
  ],
  ...extra,
});

// 1. master + 3 variant children -> one group (both before and after probing)
{
  const base = 'https://cdn.example.com/v/abc123';
  const list = [];
  add(list, `${base}/index.m3u8?t=1`);
  add(list, `${base}/1080/index.m3u8?t=1`);
  add(list, `${base}/720/index.m3u8?t=1`);
  add(list, `${base}/480/index.m3u8?t=1`);
  let groups = buildGroups(list);
  assert.equal(groups.length, 1, 'heuristic merges renditions before probing');
  assert.equal(groups[0].members.length, 4);
  assert.equal(groups[0].root.url, `${base}/index.m3u8?t=1`);
  const probes = { [streamKey(`${base}/index.m3u8`)]: masterProbe(base) };
  groups = buildGroups(list, probes);
  assert.equal(groups.length, 1); assert.equal(groups[0].members.length, 4);
  const view = describeGroups(groups, { pageTitle: 'Phim hay' });
  assert.equal(view.groups.length, 1); assert.equal(view.short.length, 0);
  assert.equal(view.groups[0].title, 'Phim hay');
  assert.equal(view.groups[0].duration, '41:12');
  assert.deepEqual(view.groups[0].variants.map((v) => v.label), ['1080p', '720p', '480p']);
  assert.equal(view.groups[0].variants[0].size, '~1.7 GB');
  ok('master + 3 variants merge into one group (heuristic and probe)');
}

// 1b. renditions with opaque names only merge once the master is probed
{
  const base = 'https://media.example.net/p/x';
  const list = [];
  add(list, `${base}/master.m3u8`);
  add(list, `${base}/index-v1-a1.m3u8`);
  add(list, `${base}/index-v2-a1.m3u8`);
  assert.equal(buildGroups(list).length, 3, 'opaque names are not guessed');
  const probes = {
    [streamKey(`${base}/master.m3u8`)]: {
      ok: true, kind: 'master', durationSec: 600, isLive: false, isShort: false, renditions: [],
      variants: [{ url: `${base}/index-v1-a1.m3u8`, height: 1080 }, { url: `${base}/index-v2-a1.m3u8`, height: 720 }],
    },
  };
  const groups = buildGroups(list, probes);
  assert.equal(groups.length, 1); assert.equal(groups[0].members.length, 3);
  ok('probed master adopts its variant playlists');
}

// 2. two separate videos stay two groups
{
  const list = [];
  add(list, 'https://cdn.example.com/v/abc123/index.m3u8');
  add(list, 'https://cdn.example.com/v/abc123/1080/index.m3u8');
  add(list, 'https://cdn.example.com/v/def456/index.m3u8');
  add(list, 'https://cdn.example.com/v/def456/720/index.m3u8');
  const groups = buildGroups(list);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.members.length), [2, 2]);
  const view = describeGroups(groups, { pageTitle: 'Trang' });
  assert.deepEqual(view.groups.map((g) => g.title).sort(), ['Video 1', 'Video 2']);
  assert.ok(view.groups.every((g) => /abc123|def456/.test(g.hint)), 'multi-group cards carry a filename hint');
  ok('two separate videos stay two groups');
}

// 3. short previews are flagged (probe isShort; small mp4 without duration)
{
  const list = [];
  add(list, 'https://cdn.example.com/v/main/index.m3u8');
  add(list, 'https://cdn.example.com/previews/p1/index.m3u8');
  add(list, 'https://cdn.example.com/previews/p2/index.m3u8');
  add(list, 'https://cdn.example.com/teaser.mp4', 'mp4', { sizeHint: 3 * 1024 * 1024 });
  add(list, 'https://cdn.example.com/full.mp4', 'mp4', { sizeHint: SHORT_MP4_BYTES + 1 });
  add(list, 'https://cdn.example.com/unknown.mp4', 'mp4', { sizeHint: 0 });
  const shortProbe = { ok: true, kind: 'media', variants: [], durationSec: 15, isLive: false, isShort: true };
  const probes = {
    [streamKey('https://cdn.example.com/v/main/index.m3u8')]: masterProbe('https://cdn.example.com/v/main', 180),
    [streamKey('https://cdn.example.com/previews/p1/index.m3u8')]: shortProbe,
    [streamKey('https://cdn.example.com/previews/p2/index.m3u8')]: shortProbe,
  };
  const groups = buildGroups(list, probes);
  const flags = Object.fromEntries(groups.map((g) => [g.root.url.split('/').slice(-2).join('/'), isShortGroup(g)]));
  assert.deepEqual(flags, {
    'main/index.m3u8': false, 'p1/index.m3u8': true, 'p2/index.m3u8': true,
    'cdn.example.com/teaser.mp4': true, 'cdn.example.com/full.mp4': false, 'cdn.example.com/unknown.mp4': false,
  });
  const view = describeGroups(groups, { pageTitle: 'Trang' });
  assert.equal(view.groups.length, 3); assert.equal(view.short.length, 3);
  assert.equal(view.short[0].title.startsWith('Video ngắn'), true);
  // A live stream is never "short" just because its window is small.
  const live = buildGroups([{ id: 'l', key: 'k', url: 'https://x.example/live.m3u8', type: 'hls', seq: 1, detectedAt: 1 }],
    { k: { ok: true, kind: 'media', variants: [], durationSec: 0, isLive: true, isShort: false } });
  assert.equal(isShortGroup(live[0]), false);
  assert.equal(describeGroups(live).groups[0].isLive, true);
  ok('short previews are flagged; unknown stays normal');
}

// 4. identical URLs dedupe
{
  const list = [];
  add(list, 'https://cdn.example.com/v/abc/index.m3u8?sig=1');
  add(list, 'https://cdn.example.com/v/abc/index.m3u8?sig=2');
  add(list, 'https://cdn.example.com/v/abc/index.m3u8?sig=2');
  assert.equal(list.length, 1);
  assert.equal(list[0].url, 'https://cdn.example.com/v/abc/index.m3u8?sig=2', 'keeps the freshest URL');
  assert.ok(list[0].detectedAt > list[0].firstSeenAt);
  ok('identical URLs dedupe');
}

// 5. the heuristic does not over-merge unrelated playlists under one CDN root
{
  const root = 'https://cdn.example.com/hls';
  const list = [];
  add(list, `${root}/master.m3u8`);
  add(list, `${root}/a8f3k2/master.m3u8`);
  add(list, `${root}/a8f3k2/720/index.m3u8`);
  add(list, `${root}/teaser-2024/index.m3u8`);
  add(list, `${root}/2024/index.m3u8`);
  add(list, `${root}/preview/clip/index.m3u8`);
  add(list, `${root}/other-video-2024/index.m3u8`);
  add(list, `${root}/x9y8z7w6/index.m3u8`);
  add(list, `${root}/index.m3u8`); // same folder, plain name: a different playlist until probed
  const groups = buildGroups(list);
  const roots = groups.map((g) => g.root.url.slice(root.length + 1));
  assert.deepEqual(roots, [
    'master.m3u8', 'a8f3k2/master.m3u8', 'teaser-2024/index.m3u8', '2024/index.m3u8', 'preview/clip/index.m3u8',
    'other-video-2024/index.m3u8', 'x9y8z7w6/index.m3u8', 'index.m3u8',
  ]);
  assert.equal(groups[1].members.length, 2, 'the 720 rendition joins its own folder master, not the root one');
  assert.equal(isRenditionChild(`${root}/a/master.m3u8`, `${root}/b/720/index.m3u8`), false);
  assert.equal(isRenditionChild(`${root}/a/master.m3u8`, `${root}/a/video_720p.m3u8`), true);
  assert.equal(isRenditionChild(`${root}/a/playlist.m3u8`, `${root}/a/chunklist_w1234_b800000.m3u8`), true);
  assert.equal(isRenditionChild(`${root}/a/master.m3u8`, `${root}/a/hd/index.m3u8`), true);
  assert.equal(isRenditionChild(`${root}/a/master.m3u8`, `${root}/a/stream_1/index.m3u8`), true);
  assert.equal(isRenditionChild(`${root}/a/m.m3u8?tok=abc`, `${root}/a/q/index.m3u8?tok=abc`), true, 'same signed query');
  assert.equal(isRenditionChild(`${root}/a/m.m3u8?tok=abc`, `${root}/a/q/index.m3u8?tok=xyz`), false);
  assert.equal(isRenditionChild('https://other.example/hls/a/master.m3u8', `${root}/a/720/index.m3u8`), false);
  ok('heuristic does not over-merge unrelated playlists from the same CDN root');
}

// 6. best group for the pill: non-short, detected during playback, duration match, else score
{
  const list = [];
  add(list, 'https://cdn.example.com/v/main/index.m3u8');
  add(list, 'https://cdn.example.com/v/other/index.m3u8');
  markPlaybackStart(list, clock + 500); // main video started: both fetched within the window
  add(list, 'https://cdn.example.com/previews/p1/index.m3u8', 'hls', { ctx: { playing: true } }); // hover preview while playing
  const probes = {
    [streamKey('https://cdn.example.com/previews/p1/index.m3u8')]: { ok: true, kind: 'media', variants: [], durationSec: 15, isLive: false, isShort: true },
    [streamKey('https://cdn.example.com/v/main/index.m3u8')]: masterProbe('https://cdn.example.com/v/main', 2472),
    [streamKey('https://cdn.example.com/v/other/index.m3u8')]: masterProbe('https://cdn.example.com/v/other', 95),
  };
  const groups = buildGroups(list, probes);
  assert.equal(pickBestGroup(groups, { duration: 2472.1 }).root.url, 'https://cdn.example.com/v/main/index.m3u8', 'duration match');
  assert.equal(pickBestGroup(groups, { duration: 95 }).root.url, 'https://cdn.example.com/v/other/index.m3u8');
  const best = pickBestGroup(groups, {});
  assert.equal(isShortGroup(best), false, 'never the preview while a normal group exists');
  const mp4 = [];
  add(mp4, 'https://cdn.example.com/a.mp4', 'mp4', { sizeHint: 9e8 });
  add(mp4, 'https://cdn.example.com/b.mp4', 'mp4', { sizeHint: 8e8 });
  assert.equal(pickBestGroup(buildGroups(mp4), { src: 'https://cdn.example.com/b.mp4' }).root.url, 'https://cdn.example.com/b.mp4', 'direct src match');
  assert.equal(pickBestGroup([], {}), null);
  ok('pill picks the main video, not a preview');
}

// 7. formatting
assert.equal(formatDuration(2472), '41:12'); assert.equal(formatDuration(3725), '1:02:05'); assert.equal(formatDuration(0), '');
assert.equal(formatApproxSize(1.1 * 1024 ** 3), '~1.1 GB'); assert.equal(formatApproxSize(640 * 1024 ** 2), '~640 MB');
ok('duration and size labels');

console.log(`ALL PASSED (${passed})`);
