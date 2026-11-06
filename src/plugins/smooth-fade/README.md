# Smooth Fade

Real crossfade for Pear Desktop 3.12.0, where the official Crossfade plugin
can no longer get a second audio stream (pear-devs/pear-desktop#4775).

## How it works

- **Crossfade mode (default):** a hidden second YouTube Music player
  (`main.ts`, same session) loads the next queue item ~30 s before the end.
  During the last N seconds it fades that song in while the main player fades
  out (equal-power by default). When the main player moves on to the same
  song, it seeks to the helper's position, nudges its playback rate while
  still silent until both are within ~20 ms, then swaps back
  (`crossfade.ts`).
- **Fallback / fade mode:** a GainNode in the app's Web Audio graph fades the
  song out at its end and the next one in (`fader.ts`, math in
  `fade-plan.ts`). Used whenever a crossfade can't be set up: the first song
  after launch (queue not loaded yet), repeat-one, an ad in the helper,
  helper load failure.

Pausing or seeking out of an overlap cancels it; the helper fades out. On
stop/disable/error the gain goes back to 1.

Menu: Mode, Crossfade length, Fade out, Fade in, Fade curve.

Don't combine with the official Crossfade plugin. Equalizer is untested
(pear-devs/pear-desktop#4776).

## Build and install over an existing 3.12.0 install (Windows)

`pnpm dist:win` builds an nsis-web stub that downloads the *official* package,
so build an unpacked app and swap its files in instead:

```bash
pnpm install
pnpm build
pnpm electron-builder --win dir --x64 -p never
```

With YouTube Music closed, back up and replace these files in
`%LOCALAPPDATA%\Programs\youtube-music` with the ones from
`pack\win-unpacked`:

- `YouTube Music.exe` (it embeds the app.asar integrity hash)
- `resources\app.asar`
- `resources\app.asar.unpacked\`

Set `options.autoUpdates` to `false` in `%APPDATA%\YouTube Music\config.json`
so an official update doesn't overwrite the build. To roll back, copy the
backed-up files back.
