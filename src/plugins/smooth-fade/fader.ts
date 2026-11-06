import {
  curveSamples,
  gainAt,
  planFade,
  segments,
  type FadeCurve,
} from './fade-plan';

import type { MusicPlayer } from '@/types/music-player';

export type FadeMode = 'crossfade' | 'fade';

export type SmoothFadePluginConfig = {
  enabled: boolean;
  mode: FadeMode;
  crossfadeMs: number;
  fadeOutMs: number;
  fadeInMs: number;
  curve: FadeCurve;
};

const TICK_MS = 250;
const DURATION_STABLE_MS = 2000;
/** Position drift (s) beyond which we assume the user seeked */
const SEEK_DRIFT_S = 0.75;
/** Short ramp used whenever gain must jump, to avoid clicks */
const DECLICK_S = 0.05;
/** Spacing between automation events so curves never overlap */
const EVENT_GAP_S = 0.002;

/** Longest a crossfade may keep the next song silent before we give up */
const HOLD_MAX_MS = 10000;

const PLAYER_ENDED = 0;
export const PLAYER_PLAYING = 1;

export class Fader {
  config: SmoothFadePluginConfig | null = null;
  api: MusicPlayer | null = null;

  private context: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  /** Kept across stop/start so re-enabling can reattach without a reload */
  private last: {
    source: MediaElementAudioSourceNode;
    context: AudioContext;
  } | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private video: HTMLVideoElement | null = null;

  private songId = '';
  private duration = 0;
  private durationSince = 0;
  private signature = '';
  /** A new song is loading and hasn't played yet */
  private songStarting = false;
  /** Crossfade: fade-out length for the current song, replacing fadeOutMs */
  private fadeOutOverrideS: number | null = null;
  /** Crossfade: keep the next song silent until releaseHold() */
  private holdArmed = false;
  private holdSince: number | null = null;
  /** Song that took over from the helper, so it gets no fade-in */
  private noFadeInSongId = '';
  /** Ramp length for the next reschedule (defaults to DECLICK_S) */
  private nextRampS: number | null = null;
  /** Song time and context time when the current automation was scheduled */
  private anchor: {
    songTime: number;
    contextTime: number;
    rate: number;
  } | null = null;

  attach = (
    source: MediaElementAudioSourceNode,
    context: AudioContext,
  ): void => {
    if (this.source === source && this.gain) return;
    this.detach();

    try {
      const gain = context.createGain();
      gain.gain.value = 1;
      try {
        source.disconnect(context.destination);
      } catch {}
      source.connect(gain);
      gain.connect(context.destination);

      this.context = context;
      this.source = source;
      this.gain = gain;
      this.last = { source, context };
      this.sync(true);
    } catch (error) {
      console.error('[smooth-fade] attach failed', error);
      this.detach();
    }
  };

  detach = (): void => {
    const { source, context, gain } = this;
    this.resetGain();
    if (source && context && gain) {
      try {
        source.disconnect(gain);
      } catch {}
      try {
        gain.disconnect();
      } catch {}
      try {
        source.connect(context.destination);
      } catch {}
    }
    this.source = null;
    this.context = null;
    this.gain = null;
    this.anchor = null;
    this.signature = '';
  };

  start = (): void => {
    document.addEventListener('peard:audio-can-play', this.onAudioCanPlay, {
      passive: true,
    });
    document.addEventListener('videodatachange', this.onForcedSync, {
      passive: true,
    });
    this.interval ??= setInterval(() => this.sync(), TICK_MS);
    if (this.last) this.attach(this.last.source, this.last.context);
  };

  stop = (): void => {
    document.removeEventListener('peard:audio-can-play', this.onAudioCanPlay);
    document.removeEventListener('videodatachange', this.onForcedSync);
    this.unwatchVideo();
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.detach();
  };

  watchVideo = (video: HTMLVideoElement | null): void => {
    this.unwatchVideo();
    if (!video) return;
    this.video = video;
    // These only trigger a resync; all timing comes from the player API
    for (const event of ['play', 'pause', 'seeked', 'ratechange']) {
      video.addEventListener(event, this.onForcedSync, { passive: true });
    }
  };

  private unwatchVideo = (): void => {
    for (const event of ['play', 'pause', 'seeked', 'ratechange']) {
      this.video?.removeEventListener(event, this.onForcedSync);
    }
    this.video = null;
  };

  hasAudioGraph = (): boolean => this.gain !== null;

  private onAudioCanPlay = ({
    detail: { audioSource, audioContext },
  }: CustomEvent<Compressor>) => this.attach(audioSource, audioContext);

  private onForcedSync = () => this.sync(true);

  /** Never leave the player silent: drop all automation, gain = 1 */
  resetGain = (): void => {
    const { gain, context } = this;
    if (!gain || !context) return;
    try {
      gain.gain.cancelScheduledValues(0);
      gain.gain.setValueAtTime(1, context.currentTime);
    } catch {
      try {
        gain.gain.value = 1;
      } catch {}
    }
    this.anchor = null;
    this.signature = '';
  };

  setFadeOutOverride = (seconds: number | null): void => {
    if (this.fadeOutOverrideS === seconds) return;
    this.fadeOutOverrideS = seconds;
    this.sync(true);
  };

  /** The next song change starts silent and stays so until releaseHold() */
  armHold = (): void => {
    this.holdArmed = true;
  };

  isHolding = (): boolean => this.holdSince !== null;

  /** Bring the current song in over rampS, with no fade-in of its own */
  releaseHold = (rampS: number): void => {
    this.holdArmed = false;
    if (this.holdSince === null) return;
    this.holdSince = null;
    this.noFadeInSongId = this.songId;
    this.nextRampS = rampS;
    this.sync(true);
  };

  /** Drop any crossfade arrangement and go back to plain fading */
  disarm = (): void => {
    this.holdArmed = false;
    this.fadeOutOverrideS = null;
    if (this.holdSince !== null) this.releaseHold(DECLICK_S * 4);
    else this.sync(true);
  };

  sync = (force = false): void => {
    const { api, gain, context, config } = this;
    if (!api || !gain || !context || !config) return;

    try {
      const now = performance.now();
      const songTime = api.getCurrentTime();
      const duration = api.getDuration();
      const songId = api.getVideoData()?.video_id ?? '';
      const state = api.getPlayerState();
      const rate = api.getPlaybackRate() || 1;

      if (songId !== this.songId) {
        this.songId = songId;
        this.duration = duration;
        this.durationSince = now;
        this.songStarting = true;
        this.fadeOutOverrideS = null;
        if (this.holdArmed) {
          this.holdArmed = false;
          this.holdSince = now;
        } else {
          this.holdSince = null;
        }
        force = true;
      } else if (!(Math.abs(duration - this.duration) < 0.5)) {
        this.duration = duration;
        this.durationSince = now;
      }
      const durationStable =
        Number.isFinite(duration) &&
        duration > 0 &&
        now - this.durationSince >= DURATION_STABLE_MS;

      if (this.holdSince !== null && now - this.holdSince > HOLD_MAX_MS) {
        // Handover never happened: fall back to an ordinary fade-in
        this.holdSince = null;
        force = true;
      }
      const holding = this.holdSince !== null;

      const plan = planFade({
        duration,
        durationStable,
        fadeInS:
          songId === this.noFadeInSongId
            ? 0
            : Math.max(0, config.fadeInMs) / 1000,
        fadeOutS: this.fadeOutOverrideS ?? Math.max(0, config.fadeOutMs) / 1000,
      });

      const signature = JSON.stringify([
        songId,
        plan,
        state,
        rate,
        config.curve,
        holding,
      ]);
      let drift = 0;
      if (this.anchor) {
        const elapsed = context.currentTime - this.anchor.contextTime;
        const advanced = elapsed * this.anchor.rate;
        const expected = this.anchor.songTime + advanced;
        drift = Math.abs(songTime - expected);
      }
      if (holding && !force && signature === this.signature) return;
      if (!force && signature === this.signature && drift < SEEK_DRIFT_S) {
        return;
      }
      this.signature = signature;

      const param = gain.gain;
      const ctxNow = context.currentTime;
      // cancelAndHoldAtTime glitches for a render quantum when it cuts into
      // a value curve, so pin the current value explicitly instead
      const held = param.value;
      param.cancelScheduledValues(ctxNow);
      param.setValueAtTime(held, ctxNow);

      if (holding) {
        // The helper player is carrying this song; we stay silent
        param.linearRampToValueAtTime(0, ctxNow + DECLICK_S);
        this.anchor = null;
        return;
      }

      if (state === PLAYER_ENDED) this.songStarting = true;
      if (state !== PLAYER_PLAYING) {
        // Paused / buffering / loading: the audio thread would keep ramping
        // while the song stands still, so hold the gain for the current
        // position and reschedule on play. Right after a song change the
        // player still reports the old position, so use the song's start.
        param.linearRampToValueAtTime(
          gainAt(this.songStarting ? 0 : songTime, plan, config.curve),
          ctxNow + DECLICK_S,
        );
        // rate 0: position should stand still, so any move is a seek
        this.anchor = { songTime, contextTime: ctxNow, rate: 0 };
        return;
      }

      this.songStarting = false;
      const start = ctxNow + (this.nextRampS ?? DECLICK_S);
      this.nextRampS = null;
      const toContextTime = (s: number) => {
        const wallSeconds = (s - songTime) / rate;
        return start + wallSeconds;
      };
      param.linearRampToValueAtTime(
        gainAt(songTime, plan, config.curve),
        start,
      );
      for (const seg of segments(plan)) {
        const from = Math.max(seg.from, songTime);
        const wallSeconds = (seg.to - from) / rate;
        if (wallSeconds <= EVENT_GAP_S * 2) continue;
        param.setValueCurveAtTime(
          curveSamples(
            seg.kind,
            config.curve,
            (from - seg.from) / (seg.to - seg.from),
          ),
          toContextTime(from) + EVENT_GAP_S,
          wallSeconds - EVENT_GAP_S,
        );
      }
      this.anchor = { songTime, contextTime: ctxNow, rate };
    } catch (error) {
      console.error('[smooth-fade] sync failed, restoring gain', error);
      this.resetGain();
    }
  };
}
