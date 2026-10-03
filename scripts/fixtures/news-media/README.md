# Offline news media fixtures

Synthetic test media only. Not reporting on real products, not a news release, and not loaded by production bootstrap. The three MP4s contain a uniform frame and a test tone; editorial/QA fixture facts are synthetic. They exercise actual container bytes, file delivery, hash checks, duration, orientation and audio presence without network access.

| Case               | Video         | Duration    | Size       |
| ------------------ | ------------- | ----------- | ---------- |
| Single-topic Short | short.mp4     | 60 seconds  | 720 × 1280 |
| Three-story weekly | weekly.mp4    | 300 seconds | 1280 × 720 |
| Product Explainer  | explainer.mp4 | 180 seconds | 1280 × 720 |

Generated with the existing local FFmpeg executable using lavfi color at 1 fps, sine at 8000 Hz, libx264/yuv420p and AAC/16 kbps, `-movflags +faststart`. `visual.png` is a 640 × 360 color image. Test WAV is generated from a deterministic PCM header/sample buffer inside the acceptance harness. No FFmpeg installation or production shell capability is added.
