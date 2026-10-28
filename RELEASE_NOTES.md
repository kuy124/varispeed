Varispeed sets any HTML5 video from **1/16x to 100x**, and puts seek controls on the video itself.

![The Varispeed panel](https://raw.githubusercontent.com/kuy124/varispeed/main/docs/panel.png)

## Install

1. Download `varispeed-1.3.0.zip` below and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked** and select the unzipped folder.

Checked on Chrome 149. Needs a Chrome that supports `world: "MAIN"` content scripts.

## What changed

- **Slow range opened up.** Chrome's real floor is `0.0625`, not the `0.25` most speed extensions expose.
- **Ten presets, in two rows:** `0.25 0.5 0.75 1 1.5` and `2 3 4 5 8`.
- **Seek controls on the video.** A bar with a draggable playhead, `-10 -5 +5 +10`, live timecode, and the current rate. Renders in iframes and in fullscreen.
- **Panel timeline seeks too:** click to jump, drag to scrub, hover to preview, or type `hh:mm:ss` in one field.
- **Renamed** from Video Speeder to Varispeed, with new icons and a rebuilt panel.

## Known limits

- Per-site rates and keyboard shortcuts are not implemented.
- Loading unpacked means no auto-update.
- Chrome only.

Full detail, the file map, and the test suite are in the [README](https://github.com/kuy124/varispeed#readme).
