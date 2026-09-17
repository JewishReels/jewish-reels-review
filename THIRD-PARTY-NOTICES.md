# Bundled media tools

The desktop package includes separate command-line executables invoked by Jewish Reels. They are also usable independently.

* **FFmpeg / FFprobe 9.0.1**, Gyan essentials build, GPL version 3. The accompanying `resources/media-tools/LICENSE` is the build's license text. Build documentation: https://www.gyan.dev/ffmpeg/builds/ . Exact release: https://github.com/GyanD/codexffmpeg/releases/tag/9.0.1 . Corresponding FFmpeg source commit: https://github.com/FFmpeg/FFmpeg/commit/bf1b838f2a . The build page lists external libraries and configuration.
* **yt-dlp 2026.08.19**, official Windows standalone release: https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19 . Source and license documentation: https://github.com/yt-dlp/yt-dlp/tree/2026.08.19 . yt-dlp source is Unlicense; bundled Windows standalone components have their own applicable licenses, described in the project's license section.

The original download URLs and verified SHA-256 values are recorded in `resources/media-tools/tool-provenance.json`. Electron and Chromium notices accompany the desktop runtime. Keep these notices and accompanying license files with redistributed copies.

## Local frame screening

SigLIP 2 base: Google, Apache-2.0. Model: https://huggingface.co/google/siglip2-base-patch16-224 . ONNX conversion: https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX . The pinned revision and asset hashes are in resources/frame-filter/manifest.json. Text embeddings were generated from the fixed people and non-people prompts shipped with this app. The vision encoder runs locally.

Transformers.js 3.8.1 and ONNX Runtime are provided under their packaged licenses. Sharp and libvips notices are included with their native dependencies. The Apache-2.0 text accompanying the model is in resources/frame-filter/LICENSE.
