# G2 H3 HTTP media fixture

`h3-generated-video.mp4` is a synthetic, offline-only HTTP integration-test output. It contains a moving FFmpeg test pattern and one H.264 video track; it has no audio track and contains no real user or news media. It is kept separate from the longer AI-news fixtures.

`ffprobe` reports H.264 Constrained Baseline, 320 × 180, 24 fps, 120 frames, and 5.000 seconds. The file is 248,226 bytes. It was generated with `libx264`, `yuv420p`, no B-frames, `-use_editlist 0`, and `setsar=0`; the output has neither MP4 edit-list boxes nor the optional `pasp` box rejected by the frozen G1 validator. It has no audio track, so it does not include AAC priming metadata. The frozen `validateMp4` parser accepts the checked-in file and reports a 5-second AVC MP4.

Reproduction command (with a local FFmpeg build that includes `libx264`):

```powershell
ffmpeg -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=320x180:rate=24:duration=5' -vf 'setsar=0' -an -frames:v 120 -c:v libx264 -preset ultrafast -crf 30 -profile:v baseline -level:v 3.0 -pix_fmt yuv420p -bf 0 -g 48 -keyint_min 48 -sc_threshold 0 -movflags +faststart -use_editlist 0 -video_track_timescale 12288 -brand isom -map_metadata -1 -y 'h3-generated-video.mp4'
```

This fixture is not loaded by production bootstrap and does not require a network connection or GPU.
