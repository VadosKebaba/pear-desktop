import { curveSamples } from './fade-plan';
import {
  PLAYER_PLAYING,
  type Fader,
  type SmoothFadePluginConfig,
} from './fader';

import type { HelperStatus } from './main';
import type { GetState, QueueItem } from '@/types/datahost-get-state';
import type { MusicPlayer } from '@/types/music-player';

const TICK_MS = 250;
/** Start loading the next song in the helper this long before the overlap */
const PREPARE_LEAD_S = 30;
/** Swap from helper to main player once they are this close (s) */
const ALIGN_TOLERANCE_S = 0.02;
/** Seeks get within this; playback-rate nudging does the rest */
const COARSE_TOLERANCE_S = 0.3;
const ALIGN_ATTEMPTS = 4;
const NUDGE_STEPS = 20;
const NUDGE_WINDOW_S = 0.5;
/** Equal-gain swap between two copies of the same aligned audio */
const SWAP_S = 0.4;
const CANCEL_FADE_S = 0.3;
const HANDOVER_TIMEOUT_MS = 8000;

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

type State =
  | { name: 'idle' }
  | { name: 'preparing' | 'ready' | 'failed'; songId: string; nextId: string }
  | { name: 'overlap' | 'handover'; songId: string; nextId: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wallNow = () => performance.timeOrigin + performance.now();
/** Where the helper's song is at wall time `at`, from a timestamped status */
const helperTimeAt = (h: HelperStatus, at: number) => {
  const elapsedS = (at - h.at) / 1000;
  return h.t + elapsedS;
};

const queueVideoId = (item: QueueItem | undefined): string | undefined =>
  item?.playlistPanelVideoRenderer?.videoId ??
  item?.playlistPanelVideoWrapperRenderer?.primaryRenderer
    ?.playlistPanelVideoRenderer?.videoId;

/** All ids a queue item can play as (song and music-video versions) */
const queueItemIds = (item: QueueItem | undefined): string[] => [
  queueVideoId(item) ?? '',
  ...(item?.playlistPanelVideoWrapperRenderer?.counterpart ?? []).map(
    (c) => c.counterpartRenderer?.playlistPanelVideoRenderer?.videoId ?? '',
  ),
];

const readQueue = () =>
  document
    .querySelector<HTMLElement & { getState: () => GetState }>(
      'ytmusic-player-bar',
    )
    ?.getState().queue;

/**
 * Real crossfade with a second, hidden player (see main.ts): it starts the
 * next song while this player fades out, and once this player has moved on
 * to the same song we seek it to the helper's position and swap back.
 */
export class Crossfader {
  config: SmoothFadePluginConfig | null = null;
  api: MusicPlayer | null = null;

  private state: State = { name: 'idle' };
  private interval: ReturnType<typeof setInterval> | null = null;
  private durationSeen = { songId: '', duration: 0, since: 0 };

  constructor(
    private readonly fader: Fader,
    private readonly invoke: Invoke,
  ) {}

  start = (): void => {
    this.interval ??= setInterval(() => this.tick(), TICK_MS);
  };

  /** Load the hidden player early: its first page load takes a while */
  warmUp = (): void => {
    if (this.config?.mode !== 'crossfade') return;
    this.invoke('smooth-fade:warm-up').catch(() => {});
  };

  stop = (): void => {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.cancel();
  };

  private crossfadeS = () =>
    Math.max(1, (this.config?.crossfadeMs ?? 0) / 1000);

  private nextVideoId = (currentId: string): string | null => {
    const queue = readQueue();
    if (!queue || queue.repeatMode === 'ONE') return null;
    const items = queue.items ?? [];
    // selectedItemIndex can be stale right after launch; trust it only if
    // it really is the playing song
    let index = queue.selectedItemIndex;
    if (!queueItemIds(items[index]).includes(currentId)) {
      index = items.findIndex((item) => queueItemIds(item).includes(currentId));
      if (index < 0) return null;
    }
    const next =
      queueVideoId(items[index + 1]) ??
      (queue.repeatMode === 'ALL' ? queueVideoId(items[0]) : undefined);
    return next && next !== currentId ? next : null;
  };

  private status = async (): Promise<HelperStatus | null> =>
    (await this.invoke('smooth-fade:status')) as HelperStatus | null;

  /** Back to plain fading; the helper fades out if it was audible */
  private cancel = (): void => {
    const { name } = this.state;
    if (name === 'overlap' || name === 'handover') {
      this.invoke('smooth-fade:fade-out', CANCEL_FADE_S).catch(() => {});
    }
    if (name !== 'idle') this.fader.disarm();
    this.state = { name: 'idle' };
  };

  private tick = (): void => {
    const { api, config } = this;
    if (!api || !config) return;
    if (config.mode !== 'crossfade') {
      if (this.state.name !== 'idle') this.cancel();
      return;
    }
    try {
      this.step(api, config);
    } catch (error) {
      console.error('[smooth-fade] crossfade failed, falling back', error);
      this.cancel();
    }
  };

  private step = (api: MusicPlayer, config: SmoothFadePluginConfig) => {
    const t = api.getCurrentTime();
    const d = api.getDuration();
    const songId = api.getVideoData()?.video_id ?? '';
    const playing = api.getPlayerState() === PLAYER_PLAYING;
    const crossS = this.crossfadeS();
    const zoneStart = d - crossS;
    const fadeInS = config.fadeInMs / 1000;

    const seen = this.durationSeen;
    if (seen.songId !== songId || Math.abs(seen.duration - d) > 0.5) {
      this.durationSeen = { songId, duration: d, since: performance.now() };
    }
    const durationStable =
      d > 0 && performance.now() - this.durationSeen.since >= 2000;

    const state = this.state;
    switch (state.name) {
      case 'idle': {
        if (
          !playing ||
          !durationStable ||
          api.isMuted() ||
          d < 3 * (crossS + fadeInS) ||
          t < zoneStart - PREPARE_LEAD_S ||
          t > zoneStart - 1
        ) {
          return;
        }
        const nextId = this.nextVideoId(songId);
        if (!nextId) {
          this.state = { name: 'failed', songId, nextId: '' };
          return;
        }
        this.state = { name: 'preparing', songId, nextId };
        this.invoke('smooth-fade:prepare', nextId, api.getVolume())
          .then((ok) => {
            const now = this.state;
            if (now.name !== 'preparing' || now.nextId !== nextId) return;
            if (ok) {
              this.state = { ...now, name: 'ready' };
              this.fader.setFadeOutOverride(crossS);
            } else {
              this.state = { ...now, name: 'failed' };
            }
          })
          .catch(() => {
            if (this.state.name === 'preparing') {
              this.state = { name: 'failed', songId, nextId };
            }
          });
        return;
      }
      case 'failed':
      case 'preparing': {
        // Retry with the next song; a failed song just gets the plain fade
        if (songId !== state.songId) this.state = { name: 'idle' };
        return;
      }
      case 'ready': {
        if (
          songId !== state.songId ||
          this.nextVideoId(songId) !== state.nextId ||
          t < zoneStart - PREPARE_LEAD_S - 5
        ) {
          this.cancel();
          return;
        }
        if (playing && t >= zoneStart) {
          this.state = { ...state, name: 'overlap' };
          this.fader.armHold();
          const samples = Array.from(
            curveSamples(
              'in',
              config.curve,
              Math.min(1, (t - zoneStart) / crossS),
            ),
          );
          this.invoke('smooth-fade:start', Math.max(0.5, d - t), samples).catch(
            () => this.cancel(),
          );
        }
        return;
      }
      case 'overlap': {
        if (songId !== state.songId) {
          this.handover(state.songId, state.nextId).catch(() => this.cancel());
          return;
        }
        if (!playing || t < zoneStart - 0.5) this.cancel();
        return;
      }
      case 'handover':
        return;
    }
  };

  /** This player moved to the next song: align it with the helper, swap */
  private handover = async (fromId: string, nextId: string) => {
    const api = this.api!;
    this.state = { name: 'handover', songId: fromId, nextId };
    const deadline = Date.now() + HANDOVER_TIMEOUT_MS;
    const stillValid = () =>
      this.state.name === 'handover' && Date.now() < deadline;

    if (api.getVideoData()?.video_id !== nextId) {
      this.cancel();
      return;
    }
    // The player ignores seeks while it is still loading the new song
    while (stillValid() && api.getPlayerState() !== PLAYER_PLAYING) {
      await sleep(25);
    }
    /** How far (s) this player is ahead of the helper; null if unknown */
    const measure = async (): Promise<number | null> => {
      const mainT = api.getCurrentTime();
      const mainAt = wallNow();
      const h = await this.status();
      if (!h || h.id !== nextId || h.s !== PLAYER_PLAYING) return null;
      return mainT - helperTimeAt(h, mainAt);
    };

    // Coarse: seek next to the helper (seeks land ~0.1 s off, at best)
    let lead = 0.4;
    let diff: number | null = null;
    for (let attempt = 0; attempt < ALIGN_ATTEMPTS && stillValid(); attempt++) {
      const h = await this.status();
      if (!h || h.id !== nextId || h.s !== PLAYER_PLAYING) break;
      const target = helperTimeAt(h, wallNow()) + lead;
      api.seekTo(target);
      let seekedAt = Date.now();
      while (
        stillValid() &&
        !(
          api.getPlayerState() === PLAYER_PLAYING &&
          api.getCurrentTime() >= target - 0.05
        )
      ) {
        if (Date.now() - seekedAt > 1000 && api.getCurrentTime() < target - 1) {
          api.seekTo(target); // seek was dropped; ask again
          seekedAt = Date.now();
        }
        await sleep(25);
      }
      await sleep(150); // let playback settle after the seek
      diff = await measure();
      if (diff === null || Math.abs(diff) <= COARSE_TOLERANCE_S) break;
      // Main landed `diff` away from the helper; compensate next time
      lead = Math.max(0.1, lead - diff);
    }

    // Fine: this player is silent, so nudge its speed until it lines up
    let aligned = diff !== null && Math.abs(diff) <= ALIGN_TOLERANCE_S;
    const video = document.querySelector('video');
    if (video && diff !== null && Math.abs(diff) <= COARSE_TOLERANCE_S) {
      try {
        for (let i = 0; i < NUDGE_STEPS && stillValid() && !aligned; i++) {
          if (diff === null || Math.abs(diff) > COARSE_TOLERANCE_S) break;
          // Close the gap over about NUDGE_WINDOW_S
          const correction = diff / NUDGE_WINDOW_S;
          video.playbackRate = Math.min(1.2, Math.max(0.8, 1 - correction));
          await sleep(200);
          diff = await measure();
          aligned = diff !== null && Math.abs(diff) <= ALIGN_TOLERANCE_S;
        }
      } finally {
        video.playbackRate = api.getPlaybackRate() || 1;
      }
    }
    if (this.state.name !== 'handover') return;

    // Even if alignment missed, swap: a short overlap beats a stuck helper
    const swapS = aligned ? SWAP_S : SWAP_S * 2;
    this.invoke('smooth-fade:fade-out', swapS).catch(() => {});
    this.fader.releaseHold(swapS);
    this.state = { name: 'idle' };
  };
}
