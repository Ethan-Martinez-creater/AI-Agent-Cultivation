import { FileWorkspace } from './file-workspace.js';

const MAX_NEWS_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_NEWS_MEDIA_DURATION_SECONDS = 24 * 60 * 60;

export type NewsMediaMetadata = {
  container: 'WAV' | 'MP4';
  mediaType: 'audio/wav' | 'video/mp4';
  durationSeconds: number;
  hasAudio: 0 | 1;
  codec: string;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  sampleRateHz?: number;
};

export type NewsMediaValidationErrorCode =
  | 'NEWS_MEDIA_TOO_LARGE'
  | 'NEWS_MEDIA_UNSUPPORTED'
  | 'NEWS_MEDIA_INVALID';

export type NewsImageMetadata = {
  container: 'PNG';
  mediaType: 'image/png';
  hasAudio: 0;
  codec: 'PNG';
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
};

export class NewsMediaValidationError extends Error {
  constructor(
    readonly code: NewsMediaValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NewsMediaValidationError';
  }
}

/**
 * Inspect actual bytes read through an already authorized FileWorkspace. The caller must first
 * establish artifact and Mission provenance; this function accepts no filesystem path authority.
 */
export async function inspectNewsMediaArtifact(
  workspace: FileWorkspace,
  relativePath: string,
): Promise<NewsMediaMetadata> {
  let bytes: Buffer;
  try {
    bytes = await workspace.readArtifactBytes(relativePath, MAX_NEWS_MEDIA_BYTES);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'FILE_WORKSPACE_TOO_LARGE') {
      throw new NewsMediaValidationError('NEWS_MEDIA_TOO_LARGE', 'Media file exceeds 10 MiB');
    }
    throw error;
  }
  return inspectNewsMediaBytes(bytes);
}

/** Deterministic bounded parser for PCM RIFF/WAVE and ISO Base Media MP4 containers. */
export function inspectNewsMediaBytes(
  input: Uint8Array,
  options: { requireAudio?: boolean } = {},
): NewsMediaMetadata {
  if (input.byteLength > MAX_NEWS_MEDIA_BYTES) {
    throw new NewsMediaValidationError('NEWS_MEDIA_TOO_LARGE', 'Media file exceeds 10 MiB');
  }
  const bytes = Buffer.from(input);
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return inspectWave(bytes);
  }
  if (bytes.byteLength >= 8 && ascii(bytes, 4, 4) === 'ftyp')
    return inspectMp4(bytes, options.requireAudio !== false);
  throw new NewsMediaValidationError('NEWS_MEDIA_UNSUPPORTED', 'Unsupported media container');
}

/** Inspect bounded PNG container bytes for genuine image metadata and intact chunk checksums. */
export async function inspectNewsImageArtifact(
  workspace: FileWorkspace,
  relativePath: string,
): Promise<NewsImageMetadata> {
  let bytes: Buffer;
  try {
    bytes = await workspace.readArtifactBytes(relativePath, MAX_NEWS_MEDIA_BYTES);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'FILE_WORKSPACE_TOO_LARGE') {
      throw new NewsMediaValidationError('NEWS_MEDIA_TOO_LARGE', 'Image file exceeds 10 MiB');
    }
    throw error;
  }
  return inspectNewsImageBytes(bytes);
}

export function inspectNewsImageBytes(input: Uint8Array): NewsImageMetadata {
  if (input.byteLength > MAX_NEWS_MEDIA_BYTES) {
    throw new NewsMediaValidationError('NEWS_MEDIA_TOO_LARGE', 'Image file exceeds 10 MiB');
  }
  const bytes = Buffer.from(input);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.byteLength < 8 || !bytes.subarray(0, 8).equals(signature)) {
    throw new NewsMediaValidationError('NEWS_MEDIA_UNSUPPORTED', 'Unsupported image container');
  }
  let cursor = 8;
  let header: { width: number; height: number; bitDepth: number; colorType: number } | null = null;
  let imageDataFound = false;
  let endFound = false;
  while (cursor < bytes.byteLength) {
    if (cursor + 12 > bytes.byteLength) return invalid('Truncated PNG chunk');
    const length = bytes.readUInt32BE(cursor);
    const type = ascii(bytes, cursor + 4, 4);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength)
      return invalid('PNG chunk exceeds file size');
    if (crc32(bytes.subarray(cursor + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)) {
      return invalid('PNG chunk checksum mismatch');
    }
    if (header === null && type !== 'IHDR') return invalid('PNG must begin with IHDR');
    if (type === 'IHDR') {
      if (header !== null || length !== 13) return invalid('Invalid or duplicate PNG IHDR');
      const width = bytes.readUInt32BE(dataStart);
      const height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8]!;
      const colorType = bytes[dataStart + 9]!;
      const validDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        width < 1 ||
        height < 1 ||
        width > 16_384 ||
        height > 16_384 ||
        !validDepths[colorType]?.includes(bitDepth) ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        (bytes[dataStart + 12] !== 0 && bytes[dataStart + 12] !== 1)
      ) {
        return invalid('Unsupported or invalid PNG image header');
      }
      header = { width, height, bitDepth, colorType };
    } else if (type === 'IDAT') {
      if (length === 0) return invalid('Empty PNG image data chunk');
      imageDataFound = true;
    } else if (type === 'IEND') {
      if (length !== 0 || !imageDataFound || chunkEnd !== bytes.byteLength) {
        return invalid('Invalid PNG end chunk');
      }
      endFound = true;
    }
    cursor = chunkEnd;
    if (endFound) break;
  }
  if (header === null || !imageDataFound || !endFound || cursor !== bytes.byteLength) {
    return invalid('PNG requires intact IHDR, IDAT, and IEND chunks');
  }
  return {
    container: 'PNG',
    mediaType: 'image/png',
    hasAudio: 0,
    codec: 'PNG',
    ...header,
  };
}

type Box = { type: string; start: number; payloadStart: number; end: number };

function inspectWave(bytes: Buffer): NewsMediaMetadata {
  if (bytes.byteLength < 12 || bytes.readUInt32LE(4) + 8 !== bytes.byteLength) {
    return invalid('RIFF size does not match the file');
  }
  let cursor = 12;
  let format: {
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    blockAlign: number;
  } | null = null;
  let dataBytes: number | null = null;
  while (cursor < bytes.byteLength) {
    if (cursor + 8 > bytes.byteLength) return invalid('Truncated WAVE chunk header');
    const id = ascii(bytes, cursor, 4);
    const size = bytes.readUInt32LE(cursor + 4);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.byteLength) {
      return invalid('WAVE chunk exceeds the declared container');
    }
    if (id === 'fmt ') {
      if (format !== null || size < 16) return invalid('Invalid or duplicate WAVE format chunk');
      const formatTag = bytes.readUInt16LE(dataStart);
      const channels = bytes.readUInt16LE(dataStart + 2);
      const sampleRate = bytes.readUInt32LE(dataStart + 4);
      const byteRate = bytes.readUInt32LE(dataStart + 8);
      const blockAlign = bytes.readUInt16LE(dataStart + 12);
      const bitsPerSample = bytes.readUInt16LE(dataStart + 14);
      if (formatTag !== 1) {
        throw new NewsMediaValidationError(
          'NEWS_MEDIA_UNSUPPORTED',
          'Only integer PCM WAVE is supported',
        );
      }
      const validBits =
        bitsPerSample === 8 || bitsPerSample === 16 || bitsPerSample === 24 || bitsPerSample === 32;
      const expectedAlign = channels * (bitsPerSample / 8);
      if (
        channels < 1 ||
        channels > 32 ||
        sampleRate < 8_000 ||
        sampleRate > 384_000 ||
        !validBits ||
        blockAlign !== expectedAlign ||
        byteRate !== sampleRate * blockAlign
      ) {
        return invalid('Inconsistent PCM WAVE format metadata');
      }
      format = { channels, sampleRate, bitsPerSample, blockAlign };
    } else if (id === 'data') {
      if (dataBytes !== null) return invalid('Duplicate WAVE data chunk');
      dataBytes = size;
    }
    cursor = dataEnd + (size & 1);
    if (cursor > bytes.byteLength) return invalid('Missing WAVE chunk padding');
  }
  if (cursor !== bytes.byteLength || format === null || dataBytes === null || dataBytes === 0) {
    return invalid('WAVE requires one format chunk and non-empty audio data');
  }
  if (dataBytes % format.blockAlign !== 0)
    return invalid('PCM data ends in a partial sample frame');
  const durationSeconds = dataBytes / (format.sampleRate * format.blockAlign);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    return invalid('Invalid WAVE duration');
  const codec = `pcm_s${format.bitsPerSample === 8 ? '8' : `${format.bitsPerSample}le`}`;
  return {
    container: 'WAV',
    mediaType: 'audio/wav',
    durationSeconds,
    hasAudio: 1,
    codec,
    audioCodec: codec,
    audioChannels: format.channels,
    sampleRateHz: format.sampleRate,
  };
}

function inspectMp4(bytes: Buffer, requireAudio: boolean): NewsMediaMetadata {
  try {
    return parseMp4(bytes, requireAudio);
  } catch (error) {
    if (error instanceof NewsMediaValidationError) throw error;
    return invalid('Malformed ISO BMFF media metadata');
  }
}

function parseMp4(bytes: Buffer, requireAudio: boolean): NewsMediaMetadata {
  let top: Box[];
  try {
    top = readBoxes(bytes, 0, bytes.byteLength);
  } catch {
    return invalid('Malformed ISO BMFF box structure');
  }
  const fileTypes = top.filter((box) => box.type === 'ftyp');
  const movieBoxes = top.filter((box) => box.type === 'moov');
  const mediaData = top.filter((box) => box.type === 'mdat' && box.end > box.payloadStart);
  if (
    fileTypes.length !== 1 ||
    movieBoxes.length !== 1 ||
    mediaData.length === 0 ||
    fileTypes[0]!.end - fileTypes[0]!.payloadStart < 8
  ) {
    return invalid('MP4 must contain one ftyp, one moov, and media data');
  }
  const ftyp = fileTypes[0]!;
  const majorBrand = ascii(bytes, ftyp.payloadStart, 4);
  if (!/^[\x20-\x7e]{4}$/.test(majorBrand)) return invalid('Invalid MP4 file type brand');
  const ftypLength = ftyp.end - ftyp.payloadStart;
  if ((ftypLength - 8) % 4 !== 0) return invalid('Invalid MP4 compatible brand list');

  let moovChildren: Box[];
  try {
    moovChildren = readBoxes(bytes, movieBoxes[0]!.payloadStart, movieBoxes[0]!.end);
  } catch {
    return invalid('Malformed MP4 movie box');
  }
  const movieHeaders = moovChildren.filter((box) => box.type === 'mvhd');
  if (movieHeaders.length !== 1) return invalid('MP4 requires one movie header');
  const durationSeconds = readMovieDuration(bytes, movieHeaders[0]!);
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > MAX_NEWS_MEDIA_DURATION_SECONDS
  )
    return invalid('Invalid MP4 duration');

  const videoTracks: { width: number; height: number; codec: string }[] = [];
  const audioTracks: { codec: string; channels: number; sampleRate: number }[] = [];
  try {
    for (const track of moovChildren.filter((box) => box.type === 'trak')) {
      const parsed = parseTrack(bytes, track);
      if (parsed?.kind === 'vide') videoTracks.push(...parsed.entries);
      if (parsed?.kind === 'soun') audioTracks.push(...parsed.entries);
    }
  } catch {
    return invalid('Malformed MP4 track or codec metadata');
  }
  if (videoTracks.length === 0) return invalid('MP4 has no readable video track');
  if (requireAudio && audioTracks.length === 0) return invalid('MP4 has no readable audio track');
  const video = videoTracks[0]!;
  const audio = audioTracks[0]!;
  if (
    video.width < 1 ||
    video.height < 1 ||
    video.width > 16_384 ||
    video.height > 16_384 ||
    (audio &&
      (audio.channels < 1 ||
        audio.channels > 32 ||
        audio.sampleRate < 8_000 ||
        audio.sampleRate > 384_000))
  ) {
    return invalid('MP4 track metadata is outside supported bounds');
  }
  const codecs = [...new Set([video.codec, ...audioTracks.map((entry) => entry.codec)])];
  return {
    container: 'MP4',
    mediaType: 'video/mp4',
    durationSeconds,
    hasAudio: audio ? 1 : 0,
    codec: codecs.join(','),
    width: video.width,
    height: video.height,
    videoCodec: video.codec,
    ...(audio
      ? { audioCodec: audio.codec, audioChannels: audio.channels, sampleRateHz: audio.sampleRate }
      : {}),
  };
}

function parseTrack(
  bytes: Buffer,
  track: Box,
):
  | { kind: 'vide'; entries: { width: number; height: number; codec: string }[] }
  | { kind: 'soun'; entries: { codec: string; channels: number; sampleRate: number }[] }
  | null {
  const children = readBoxes(bytes, track.payloadStart, track.end);
  const mediaBoxes = children.filter((box) => box.type === 'mdia');
  if (mediaBoxes.length !== 1) return null;
  const media = readBoxes(bytes, mediaBoxes[0]!.payloadStart, mediaBoxes[0]!.end);
  const handlers = media.filter((box) => box.type === 'hdlr');
  const handlersAreValid =
    handlers.length === 1 && handlers[0]!.end - handlers[0]!.payloadStart >= 12;
  if (!handlersAreValid) throw new Error('Invalid MP4 handler');
  const kind = ascii(bytes, handlers[0]!.payloadStart + 8, 4);
  if (kind !== 'vide' && kind !== 'soun') return null;
  const headers = children.filter((box) => box.type === 'tkhd');
  const mediaHeaders = media.filter((box) => box.type === 'mdhd');
  const minfBoxes = media.filter((box) => box.type === 'minf');
  if (headers.length !== 1 || mediaHeaders.length !== 1 || minfBoxes.length !== 1) {
    throw new Error('Invalid MP4 track structure');
  }
  readMovieDuration(bytes, mediaHeaders[0]!); // Validate track timebase and duration.
  const sampleTables = readBoxes(bytes, minfBoxes[0]!.payloadStart, minfBoxes[0]!.end);
  const stblBoxes = sampleTables.filter((box) => box.type === 'stbl');
  if (stblBoxes.length !== 1) throw new Error('Invalid MP4 sample table');
  const sampleBoxes = readBoxes(bytes, stblBoxes[0]!.payloadStart, stblBoxes[0]!.end);
  const descriptions = sampleBoxes.filter((box) => box.type === 'stsd');
  if (descriptions.length !== 1) throw new Error('Invalid MP4 sample descriptions');
  const entries = readSampleEntries(bytes, descriptions[0]!);
  if (kind === 'soun') {
    if (
      entries.some(
        (entry) =>
          !isFourCC(entry.type) ||
          entry.payloadStart + 28 > entry.end ||
          bytes.readUInt16BE(entry.payloadStart + 8) > 2 ||
          (bytes.readUInt16BE(entry.payloadStart + 8) === 1 &&
            entry.payloadStart + 44 > entry.end) ||
          (bytes.readUInt16BE(entry.payloadStart + 8) === 2 && entry.payloadStart + 64 > entry.end),
      )
    ) {
      throw new Error('Malformed MP4 audio sample entry');
    }
    return {
      kind,
      entries: entries.map((entry) => ({
        codec: entry.type,
        channels: bytes.readUInt16BE(entry.payloadStart + 16),
        sampleRate: bytes.readUInt32BE(entry.payloadStart + 24) / 65_536,
      })),
    };
  }
  const version = bytes[headers[0]!.payloadStart]!;
  const dimensionOffset = version === 1 ? 88 : 76;
  const headerPayloadLength = headers[0]!.end - headers[0]!.payloadStart;
  if ((version !== 0 && version !== 1) || headerPayloadLength < dimensionOffset + 8) {
    throw new Error('Malformed MP4 track header');
  }
  const width = bytes.readUInt32BE(headers[0]!.payloadStart + dimensionOffset) / 65_536;
  const height = bytes.readUInt32BE(headers[0]!.payloadStart + dimensionOffset + 4) / 65_536;
  if (
    entries.some((entry) => !isFourCC(entry.type) || entry.payloadStart + 78 > entry.end) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    throw new Error('Malformed MP4 video sample entry');
  }
  return { kind, entries: entries.map((entry) => ({ width, height, codec: entry.type })) };
}

function readSampleEntries(bytes: Buffer, stsd: Box): Box[] {
  if (stsd.end - stsd.payloadStart < 8) throw new Error('Truncated MP4 sample description');
  const count = bytes.readUInt32BE(stsd.payloadStart + 4);
  const entries = readBoxes(bytes, stsd.payloadStart + 8, stsd.end);
  if (count === 0 || count !== entries.length) throw new Error('Invalid MP4 sample entry count');
  return entries;
}

function readMovieDuration(bytes: Buffer, box: Box): number {
  if (box.end - box.payloadStart < 20) throw new Error('Truncated MP4 time header');
  const version = bytes[box.payloadStart]!;
  let timescale: number;
  let duration: number;
  if (version === 0) {
    timescale = bytes.readUInt32BE(box.payloadStart + 12);
    duration = bytes.readUInt32BE(box.payloadStart + 16);
  } else if (version === 1) {
    if (box.end - box.payloadStart < 32) throw new Error('Truncated version 1 MP4 time header');
    timescale = bytes.readUInt32BE(box.payloadStart + 20);
    duration = safeIntegerFromU64(bytes.readBigUInt64BE(box.payloadStart + 24));
  } else {
    throw new Error('Unsupported MP4 time header version');
  }
  if (
    !Number.isSafeInteger(timescale) ||
    timescale < 1 ||
    !Number.isSafeInteger(duration) ||
    duration < 1
  ) {
    throw new Error('Invalid MP4 timebase');
  }
  return duration / timescale;
}

function readBoxes(bytes: Buffer, start: number, end: number): Box[] {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end > bytes.length ||
    start > end
  ) {
    throw new Error('Invalid MP4 box range');
  }
  const boxes: Box[] = [];
  let cursor = start;
  while (cursor < end) {
    if (cursor + 8 > end || boxes.length >= 100_000)
      throw new Error('Truncated or excessive MP4 boxes');
    const size32 = bytes.readUInt32BE(cursor);
    const type = ascii(bytes, cursor + 4, 4);
    let headerLength = 8;
    let size: number;
    if (size32 === 1) {
      if (cursor + 16 > end) throw new Error('Truncated extended MP4 box');
      const extended = bytes.readBigUInt64BE(cursor + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Oversized MP4 box');
      size = Number(extended);
      headerLength = 16;
    } else if (size32 === 0) {
      size = end - cursor;
    } else {
      size = size32;
    }
    if (type === 'uuid') headerLength += 16;
    if (size < headerLength || cursor + size > end) throw new Error('Invalid MP4 box size');
    boxes.push({ type, start: cursor, payloadStart: cursor + headerLength, end: cursor + size });
    cursor += size;
  }
  if (cursor !== end) throw new Error('Misaligned MP4 boxes');
  return boxes;
}

function safeIntegerFromU64(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MP4 duration is not bounded');
  return Number(value);
}

function ascii(bytes: Buffer, offset: number, length: number): string {
  if (offset < 0 || length < 0 || offset + length > bytes.length)
    throw new Error('Truncated media field');
  return bytes.toString('latin1', offset, offset + length);
}

function isFourCC(value: string): boolean {
  return /^[\x20-\x7e]{4}$/.test(value);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function invalid(message: string): never {
  throw new NewsMediaValidationError('NEWS_MEDIA_INVALID', message);
}
