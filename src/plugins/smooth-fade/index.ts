import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import { Crossfader } from './crossfade';
import {
  Fader,
  PLAYER_PLAYING,
  type FadeMode,
  type SmoothFadePluginConfig,
} from './fader';
import { backend } from './main';

import type { FadeCurve } from './fade-plan';
import type { MenuTemplate } from '@/menu';
import type { MenuContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

export type { SmoothFadePluginConfig };

const fadeOutChoices = [2000, 3000, 4000, 6000, 8000, 10000, 12000];
const fadeInChoices = [0, 1000, 2000, 3000, 4000, 6000];
const curveChoices: FadeCurve[] = ['equal-power', 'linear'];
const modeChoices: FadeMode[] = ['crossfade', 'fade'];
const crossfadeChoices = [4000, 6000, 8000, 10000, 12000];

const fader = new Fader();
let crossfader: Crossfader | null = null;

/**
 * When enabled while a song is already playing, no new
 * 'peard:audio-can-play' arrives until the next load. Reload in place
 * (same trick as audio-compressor) so the gain node gets attached.
 */
const ensureAudioGraph = (playerApi: MusicPlayer) => {
  setTimeout(() => {
    if (fader.hasAudioGraph() || fader.api !== playerApi) return;
    if (playerApi.getPlayerState() !== PLAYER_PLAYING) return;
    playerApi.loadVideoById(
      playerApi.getPlayerResponse().videoDetails.videoId,
      playerApi.getCurrentTime(),
      playerApi.getUserPlaybackQualityPreference(),
    );
  }, 2000);
};

export default createPlugin({
  name: () => t('plugins.smooth-fade.name'),
  description: () => t('plugins.smooth-fade.description'),
  restartNeeded: false,
  addedVersion: '3.12.x',
  config: {
    enabled: false,
    mode: 'crossfade',
    crossfadeMs: 8000,
    fadeOutMs: 4000,
    fadeInMs: 2000,
    curve: 'equal-power',
  } as SmoothFadePluginConfig,
  menu: async ({
    getConfig,
    setConfig,
  }: MenuContext<SmoothFadePluginConfig>): Promise<MenuTemplate> => {
    const config = await getConfig();
    const seconds = (ms: number) =>
      t('plugins.smooth-fade.menu.seconds', { seconds: ms / 1000 });

    return [
      {
        label: t('plugins.smooth-fade.menu.mode.label'),
        type: 'submenu',
        submenu: modeChoices.map((mode) => ({
          label: t(`plugins.smooth-fade.menu.mode.${mode}`),
          type: 'radio',
          checked: config.mode === mode,
          click() {
            setConfig({ mode });
          },
        })),
      },
      {
        label: t('plugins.smooth-fade.menu.crossfade'),
        type: 'submenu',
        submenu: crossfadeChoices.map((ms) => ({
          label: seconds(ms),
          type: 'radio',
          checked: config.crossfadeMs === ms,
          click() {
            setConfig({ crossfadeMs: ms });
          },
        })),
      },
      {
        label: t('plugins.smooth-fade.menu.fade-out'),
        type: 'submenu',
        submenu: fadeOutChoices.map((ms) => ({
          label: seconds(ms),
          type: 'radio',
          checked: config.fadeOutMs === ms,
          click() {
            setConfig({ fadeOutMs: ms });
          },
        })),
      },
      {
        label: t('plugins.smooth-fade.menu.fade-in'),
        type: 'submenu',
        submenu: fadeInChoices.map((ms) => ({
          label: ms === 0 ? t('plugins.smooth-fade.menu.off') : seconds(ms),
          type: 'radio',
          checked: config.fadeInMs === ms,
          click() {
            setConfig({ fadeInMs: ms });
          },
        })),
      },
      {
        label: t('plugins.smooth-fade.menu.curve.label'),
        type: 'submenu',
        submenu: curveChoices.map((curve) => ({
          label: t(`plugins.smooth-fade.menu.curve.${curve}`),
          type: 'radio',
          checked: config.curve === curve,
          click() {
            setConfig({ curve });
          },
        })),
      },
    ];
  },
  backend,
  renderer: {
    async start({ getConfig, ipc }) {
      const config = await getConfig();
      fader.config = config;
      fader.start();
      crossfader = new Crossfader(fader, ipc.invoke);
      crossfader.config = config;
      crossfader.start();
    },
    onPlayerApiReady(playerApi) {
      fader.api = playerApi;
      if (crossfader) {
        crossfader.api = playerApi;
        crossfader.warmUp();
      }
      fader.watchVideo(document.querySelector('video'));
      ensureAudioGraph(playerApi);
      fader.sync(true);
    },
    onConfigChange(newConfig) {
      fader.config = newConfig;
      if (crossfader) {
        crossfader.config = newConfig;
        crossfader.warmUp();
      }
      fader.sync(true);
    },
    stop() {
      crossfader?.stop();
      crossfader = null;
      fader.stop();
      fader.api = null;
    },
  },
});
