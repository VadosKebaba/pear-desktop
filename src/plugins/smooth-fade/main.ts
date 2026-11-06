import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import { createBackend } from '@/utils';

import type { SmoothFadePluginConfig } from './fader';

export interface HelperStatus {
  /** Player state (1 = playing) */
  s: number;
  /** Song time (s) */
  t: number;
  /** Wall clock (ms since epoch, sub-ms) when t was read */
  at: number;
  id: string;
  ad: boolean;
  /** Helper's own fade gain */
  g: number;
}

const HELPER_URL = 'https://music.youtube.com/';
const LOAD_TIMEOUT_MS = 60000;
/** prepare() waits up to ~10 s for the song to start */
const RUN_TIMEOUT_MS = 15000;

/** Same pruning as do-not-track's in-player blocker, as a standalone script */
const AD_PRUNER_SCRIPT = `(() => {
  const keys = ['playerAds', 'adPlacements', 'adSlots'];
  const prune = (o) => {
    if (!o || typeof o !== 'object') return o;
    for (const target of [o, o.playerResponse, o.ytInitialPlayerResponse]) {
      if (target && typeof target === 'object') {
        for (const key of keys) delete target[key];
      }
    }
    return o;
  };
  JSON.parse = new Proxy(JSON.parse, {
    apply: (fn, self, args) => prune(Reflect.apply(fn, self, args)),
  });
  Response.prototype.json = new Proxy(Response.prototype.json, {
    apply: (fn, self, args) => Reflect.apply(fn, self, args).then(prune),
  });
  let initial;
  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    configurable: true,
    get: () => initial,
    set: (value) => (initial = prune(value)),
  });
})()`;

/**
 * Runs inside the hidden helper page (main world). Exposes a tiny control
 * surface: a WebAudio gain stage on the helper's own <video>, plus status.
 */
const HELPER_SCRIPT = `(() => {
  if (window.__sfHelper) return true;
  const ctx = new AudioContext();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  let video = null;
  const player = () => document.querySelector('#movie_player');
  const attach = () => {
    const v = document.querySelector('video');
    if (!v || v === video) return !!v;
    video = v;
    ctx.createMediaElementSource(v).connect(gain);
    return true;
  };
  const hold = (value) => {
    const p = gain.gain;
    const now = ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(value ?? p.value, now);
    return now;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__sfHelper = {
    status() {
      const p = player();
      return {
        s: p?.getPlayerState?.() ?? -1,
        t: p?.getCurrentTime?.() ?? 0,
        at: performance.timeOrigin + performance.now(),
        id: p?.getVideoData?.()?.video_id ?? '',
        ad: !!p?.classList.contains('ad-showing'),
        g: gain.gain.value,
      };
    },
    async prepare(id, volume) {
      const p = player();
      if (!p?.loadVideoById || !attach()) return false;
      hold(0);
      p.setVolume(volume);
      p.loadVideoById(id, 0);
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        attach();
        if (p.getPlayerState() === 1 && p.getVideoData()?.video_id === id) break;
      }
      p.pauseVideo();
      p.seekTo(0, true);
      await sleep(300);
      const st = this.status();
      return st.id === id && !st.ad;
    },
    async start(seconds, samples) {
      await ctx.resume();
      const now = hold(0);
      gain.gain.setValueCurveAtTime(Float32Array.from(samples), now + 0.01, seconds);
      player()?.playVideo();
      return this.status();
    },
    fadeOut(seconds) {
      const now = hold();
      gain.gain.linearRampToValueAtTime(0, now + seconds);
      setTimeout(() => player()?.pauseVideo(), seconds * 1000 + 50);
      return true;
    },
  };
  return true;
})()`;

/**
 * The Do Not Track preload only covers the main window, and an ad in the
 * helper would block every crossfade, so the helper gets its own preload
 * that injects the pruner into the page before YouTube's scripts run.
 */
const writeHelperPreload = (): string => {
  const file = path.join(app.getPath('temp'), 'pear-smooth-fade-helper.js');
  fs.writeFileSync(
    file,
    `require('electron').webFrame.executeJavaScript(${JSON.stringify(AD_PRUNER_SCRIPT)});`,
  );
  return file;
};

class Helper {
  private win: BrowserWindow | null = null;
  private loading: Promise<boolean> | null = null;

  constructor(private readonly parent: BrowserWindow) {}

  /** A hung helper page must never stall the caller */
  private run = <T>(code: string): Promise<T> =>
    Promise.race([
      this.win!.webContents.executeJavaScript(code, true) as Promise<T>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('helper timed out')), RUN_TIMEOUT_MS),
      ),
    ]);

  ensure = (): Promise<boolean> => {
    if (this.win && !this.win.isDestroyed() && !this.loading) {
      return Promise.resolve(true);
    }
    this.loading ??= this.load().finally(() => (this.loading = null));
    return this.loading;
  };

  private load = async (): Promise<boolean> => {
    this.destroy();
    const win = new BrowserWindow({
      show: false,
      // Closes together with the main window, so it never keeps the app alive
      parent: this.parent,
      webPreferences: {
        session: this.parent.webContents.session,
        backgroundThrottling: false,
        preload: writeHelperPreload(),
      },
    });
    this.win = win;
    win.webContents.setAudioMuted(true);
    try {
      await win.loadURL(HELPER_URL);
      const end = Date.now() + LOAD_TIMEOUT_MS;
      while (Date.now() < end) {
        const ready = await this.run<boolean>(
          "!!document.querySelector('#movie_player')?.loadVideoById",
        );
        if (ready) return await this.run<boolean>(HELPER_SCRIPT);
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (error) {
      console.error('[smooth-fade] helper load failed', error);
    }
    this.destroy();
    return false;
  };

  prepare = async (videoId: string, volume: number): Promise<boolean> => {
    if (!(await this.ensure())) return false;
    this.win!.webContents.setAudioMuted(true);
    return this.run<boolean>(
      `__sfHelper.prepare(${JSON.stringify(videoId)}, ${Number(volume)})`,
    );
  };

  start = async (
    seconds: number,
    samples: number[],
  ): Promise<HelperStatus | null> => {
    if (!this.win || this.win.isDestroyed()) return null;
    const status = await this.run<HelperStatus>(
      `__sfHelper.start(${Number(seconds)}, ${JSON.stringify(samples)})`,
    );
    this.win.webContents.setAudioMuted(false);
    return status;
  };

  status = async (): Promise<HelperStatus | null> => {
    if (!this.win || this.win.isDestroyed() || this.loading) return null;
    return this.run<HelperStatus>('__sfHelper.status()');
  };

  fadeOut = async (seconds: number): Promise<void> => {
    if (!this.win || this.win.isDestroyed() || this.loading) return;
    await this.run(`__sfHelper.fadeOut(${Number(seconds)})`);
    const win = this.win;
    const fadeMs = seconds * 1000;
    setTimeout(
      () => !win.isDestroyed() && win.webContents.setAudioMuted(true),
      fadeMs + 100,
    );
  };

  destroy = (): void => {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  };
}

const channels = [
  'smooth-fade:warm-up',
  'smooth-fade:prepare',
  'smooth-fade:start',
  'smooth-fade:status',
  'smooth-fade:fade-out',
];

export const backend = createBackend<
  { helper: Helper | null },
  SmoothFadePluginConfig
>({
  helper: null,

  start({ ipc, window }) {
    const helper = new Helper(window);
    this.helper = helper;
    // Failures here must never break playback: report "not ready" instead
    const safe =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>, fallback: R) =>
      async (...args: A) => {
        try {
          return await fn(...args);
        } catch (error) {
          console.error('[smooth-fade] helper call failed', error);
          return fallback;
        }
      };
    ipc.handle('smooth-fade:warm-up', safe(helper.ensure, false));
    ipc.handle('smooth-fade:prepare', safe(helper.prepare, false));
    ipc.handle('smooth-fade:start', safe(helper.start, null));
    ipc.handle('smooth-fade:status', safe(helper.status, null));
    ipc.handle('smooth-fade:fade-out', safe(helper.fadeOut, undefined));
  },

  stop({ ipc }) {
    for (const channel of channels) ipc.removeHandler(channel);
    this.helper?.destroy();
    this.helper = null;
  },
});
