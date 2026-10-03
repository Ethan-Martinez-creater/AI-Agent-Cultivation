import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileWorkspace, FileWorkspaceError } from './file-workspace.js';
import {
  inspectNewsMediaArtifact,
  inspectNewsMediaBytes,
  inspectNewsImageBytes,
  NewsMediaValidationError,
} from './w21-media-validation.js';

const testDataRoot = path.join(process.cwd(), '.test-data');
let testRoot = '';
let workspaceRoot = '';
let outsideRoot = '';

beforeEach(async () => {
  await mkdir(testDataRoot, { recursive: true });
  testRoot = await mkdtemp(path.join(testDataRoot, 'w21-media-'));
  workspaceRoot = path.join(testRoot, 'workspace');
  outsideRoot = path.join(testRoot, 'outside');
  await mkdir(workspaceRoot);
  await mkdir(outsideRoot);
});

describe('W2.1 media byte validation', () => {
  it('inspects the three playable offline acceptance MP4 files', async () => {
    for (const [name, duration, width, height] of [
      ['short', 60, 720, 1280],
      ['weekly', 300, 1280, 720],
      ['explainer', 180, 1280, 720],
    ] as const) {
      const facts = inspectNewsMediaBytes(
        await readFile(
          path.join(process.cwd(), 'scripts', 'fixtures', 'news-media', `${name}.mp4`),
        ),
      );
      expect(facts).toMatchObject({
        container: 'MP4',
        width,
        height,
        hasAudio: 1,
        videoCodec: 'avc1',
        audioCodec: 'mp4a',
      });
      expect(facts.durationSeconds).toBeCloseTo(duration, 0);
    }
  });
  it('reads bounded artifact bytes only through the canonical Workspace boundary', async () => {
    const media = waveBytes();
    const file = path.join(workspaceRoot, 'voice.wav');
    await writeFile(file, media);
    const workspace = await FileWorkspace.open(workspaceRoot);
    await expect(workspace.readArtifactBytes('voice.wav', 12_000)).resolves.toEqual(media);
    await expect(workspace.readArtifactBytes('voice.wav', 8)).rejects.toMatchObject({
      code: 'FILE_WORKSPACE_TOO_LARGE',
    });
    await expect(workspace.readArtifactBytes('../outside/secret.wav', 1024)).rejects.toMatchObject({
      code: 'FILE_WORKSPACE_PATH_ESCAPE',
    });
    await expect(workspace.readArtifactBytes('voice.wav', 11 * 1024 * 1024)).rejects.toMatchObject({
      code: 'FILE_WORKSPACE_TOO_LARGE',
    });

    const outsideFile = path.join(outsideRoot, 'secret.wav');
    const link = path.join(workspaceRoot, 'linked.wav');
    await writeFile(outsideFile, media);
    try {
      await symlink(outsideFile, link, 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS') return;
      throw error;
    }
    await expect(workspace.readArtifactBytes('linked.wav', 1024)).rejects.toBeInstanceOf(
      FileWorkspaceError,
    );
  });

  it('derives PCM codec, duration, channels, and sample rate from WAVE bytes', () => {
    expect(inspectNewsMediaBytes(waveBytes())).toEqual({
      container: 'WAV',
      mediaType: 'audio/wav',
      durationSeconds: 0.5,
      hasAudio: 1,
      codec: 'pcm_s16le',
      audioCodec: 'pcm_s16le',
      audioChannels: 1,
      sampleRateHz: 8_000,
    });
  });

  it('rejects malformed WAVE and unsupported non-PCM encodings', () => {
    const malformed = waveBytes();
    malformed.writeUInt32LE(malformed.byteLength + 10, 4);
    expect(() => inspectNewsMediaBytes(malformed)).toThrowError(
      expect.objectContaining({ code: 'NEWS_MEDIA_INVALID' }),
    );

    const compressed = waveBytes(3);
    expect(() => inspectNewsMediaBytes(compressed)).toThrowError(
      expect.objectContaining({ code: 'NEWS_MEDIA_UNSUPPORTED' }),
    );
  });

  it('reads actual MP4 box structure, track handlers, codecs, dimensions, and duration', () => {
    expect(inspectNewsMediaBytes(mp4Bytes())).toEqual({
      container: 'MP4',
      mediaType: 'video/mp4',
      durationSeconds: 2.5,
      hasAudio: 1,
      codec: 'avc1,mp4a',
      width: 640,
      height: 360,
      videoCodec: 'avc1',
      audioCodec: 'mp4a',
      audioChannels: 2,
      sampleRateHz: 48_000,
    });
  });

  it('fails closed for malformed MP4 structure and a video with no audio track', () => {
    expect(() => inspectNewsMediaBytes(Buffer.from('0000000866747970', 'hex'))).toThrowError(
      expect.objectContaining({ code: 'NEWS_MEDIA_INVALID' }),
    );
    expect(() => inspectNewsMediaBytes(mp4Bytes(false))).toThrowError(
      expect.objectContaining({ code: 'NEWS_MEDIA_INVALID' }),
    );
    expect(inspectNewsMediaBytes(mp4Bytes(false), { requireAudio: false })).toMatchObject({
      container: 'MP4',
      hasAudio: 0,
      videoCodec: 'avc1',
    });
    expect(() => inspectNewsMediaBytes(Buffer.from('not media'))).toThrowError(
      expect.objectContaining({ code: 'NEWS_MEDIA_UNSUPPORTED' }),
    );
  });

  it('verifies PNG signature, chunk CRCs, and bounded IHDR dimensions', () => {
    const png = pngBytes();
    expect(inspectNewsImageBytes(png)).toEqual({
      container: 'PNG',
      mediaType: 'image/png',
      hasAudio: 0,
      codec: 'PNG',
      width: 1,
      height: 1,
      bitDepth: 8,
      colorType: 4,
    });
    const damaged = Buffer.from(png);
    damaged[29] = damaged[29]! ^ 0xff;
    expect(() => inspectNewsImageBytes(damaged)).toThrowError(
      expect.objectContaining({ code: 'NEWS_MEDIA_INVALID' }),
    );
  });

  it('inspects media bytes submitted from the selected Workspace, not caller metadata', async () => {
    const file = path.join(workspaceRoot, 'draft.mp4');
    const bytes = mp4Bytes();
    await writeFile(file, bytes);
    const workspace = await FileWorkspace.open(workspaceRoot);
    await expect(inspectNewsMediaArtifact(workspace, 'draft.mp4')).resolves.toMatchObject({
      container: 'MP4',
      durationSeconds: 2.5,
      width: 640,
      height: 360,
      hasAudio: 1,
      videoCodec: 'avc1',
      audioCodec: 'mp4a',
    });
    await expect(inspectNewsMediaArtifact(workspace, '../outside/draft.mp4')).rejects.toMatchObject(
      {
        code: 'FILE_WORKSPACE_PATH_ESCAPE',
      },
    );
    expect(() => inspectNewsMediaBytes(Buffer.alloc(10 * 1024 * 1024 + 1))).toThrowError(
      new NewsMediaValidationError('NEWS_MEDIA_TOO_LARGE', 'Media file exceeds 10 MiB'),
    );
  });
});

function waveBytes(formatTag = 1): Buffer {
  const pcm = Buffer.alloc(8_000);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(formatTag, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(8_000, 4);
  fmt.writeUInt32LE(16_000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const fmtChunk = riffChunk('fmt ', fmt);
  const dataChunk = riffChunk('data', pcm);
  const body = Buffer.concat([Buffer.from('WAVE'), fmtChunk, dataChunk]);
  const result = Buffer.alloc(8 + body.byteLength);
  result.write('RIFF', 0, 'ascii');
  result.writeUInt32LE(body.byteLength, 4);
  body.copy(result, 8);
  return result;
}

function riffChunk(type: string, payload: Buffer): Buffer {
  const paddedSize = payload.byteLength + (payload.byteLength & 1);
  const chunk = Buffer.alloc(8 + paddedSize);
  chunk.write(type, 0, 'ascii');
  chunk.writeUInt32LE(payload.byteLength, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function mp4Bytes(includeAudio = true): Buffer {
  const ftyp = isoBox('ftyp', Buffer.from('isom\0\0\0\0mp41', 'ascii'));
  const movieHeader = Buffer.alloc(20);
  movieHeader.writeUInt32BE(1_000, 12);
  movieHeader.writeUInt32BE(2_500, 16);
  const tracks = [isoBox('trak', videoTrack())];
  if (includeAudio) tracks.push(isoBox('trak', audioTrack()));
  const moov = isoBox('moov', Buffer.concat([isoBox('mvhd', movieHeader), ...tracks]));
  const mdat = isoBox('mdat', Buffer.from([0, 1, 2, 3]));
  return Buffer.concat([ftyp, moov, mdat]);
}

function videoTrack(): Buffer {
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(640 * 65_536, 76);
  tkhd.writeUInt32BE(360 * 65_536, 80);
  const mdhd = Buffer.alloc(20);
  mdhd.writeUInt32BE(1_000, 12);
  mdhd.writeUInt32BE(2_500, 16);
  const hdlr = Buffer.alloc(12);
  hdlr.write('vide', 8, 'ascii');
  const visualEntry = Buffer.alloc(78);
  visualEntry.writeUInt16BE(640, 24);
  visualEntry.writeUInt16BE(360, 26);
  const stsd = sampleDescription('avc1', visualEntry);
  return Buffer.concat([
    isoBox('tkhd', tkhd),
    isoBox(
      'mdia',
      Buffer.concat([
        isoBox('mdhd', mdhd),
        isoBox('hdlr', hdlr),
        isoBox('minf', isoBox('stbl', stsd)),
      ]),
    ),
  ]);
}

function audioTrack(): Buffer {
  const tkhd = Buffer.alloc(84);
  const mdhd = Buffer.alloc(20);
  mdhd.writeUInt32BE(48_000, 12);
  mdhd.writeUInt32BE(120_000, 16);
  const hdlr = Buffer.alloc(12);
  hdlr.write('soun', 8, 'ascii');
  const audioEntry = Buffer.alloc(28);
  audioEntry.writeUInt16BE(2, 16);
  audioEntry.writeUInt16BE(16, 18);
  audioEntry.writeUInt32BE(48_000 * 65_536, 24);
  const stsd = sampleDescription('mp4a', audioEntry);
  return Buffer.concat([
    isoBox('tkhd', tkhd),
    isoBox(
      'mdia',
      Buffer.concat([
        isoBox('mdhd', mdhd),
        isoBox('hdlr', hdlr),
        isoBox('minf', isoBox('stbl', stsd)),
      ]),
    ),
  ]);
}

function sampleDescription(type: string, entryPayload: Buffer): Buffer {
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(1, 4);
  return isoBox('stsd', Buffer.concat([prefix, isoBox(type, entryPayload)]));
}

function isoBox(type: string, payload: Buffer): Buffer {
  const result = Buffer.alloc(8 + payload.byteLength);
  result.writeUInt32BE(result.byteLength, 0);
  result.write(type, 4, 'ascii');
  payload.copy(result, 8);
  return result;
}

function pngBytes(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 4;
  const imageData = deflateSync(Buffer.from([0, 0, 0, 0]));
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', imageData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + payload.byteLength);
  result.writeUInt32BE(payload.byteLength, 0);
  typeBytes.copy(result, 4);
  payload.copy(result, 8);
  result.writeUInt32BE(
    pngCrc32(result.subarray(4, 8 + payload.byteLength)),
    8 + payload.byteLength,
  );
  return result;
}

function pngCrc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
