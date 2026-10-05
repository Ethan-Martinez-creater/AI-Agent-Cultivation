import { DomainError } from '@cultivation/shared';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_BOXES = 100_000;
const MAX_TABLE_ENTRIES = 1_000_000;

interface Box {
  type: string;
  start: number;
  payloadStart: number;
  end: number;
  size: number;
}

interface ParseContext {
  bytes: Buffer;
  boxCount: number;
}

interface MediaRange {
  start: number;
  end: number;
}

interface SampleTable {
  sampleCount: number;
  sampleSizes: number[] | null;
  constantSampleSize: number;
  chunks: number[];
  stsc: Array<{ firstChunk: number; samplesPerChunk: number; descriptionIndex: number }>;
  timing: Array<{ count: number; delta: number }>;
  composition: Array<{ count: number; offset: number }> | null;
  syncSamples: number[] | null;
}

interface TrackFacts {
  handler: 'vide' | 'soun';
  trackId: number;
  duration: number;
  timescale: number;
  width: number | null;
  height: number | null;
  codec: string;
  sampleCount: number;
  ranges: MediaRange[];
}

function unsupported(message = 'MP4 container or metadata is unsupported'): never {
  throw new DomainError('UNSUPPORTED_MEDIA_TYPE', message);
}

function tooLarge(): never {
  throw new DomainError('INPUT_TOO_LARGE', 'MP4 exceeds the 16 MiB validation limit');
}

function requireRange(bytes: Buffer, start: number, length: number, end = bytes.length): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    start < 0 ||
    start > end ||
    length > end - start
  )
    unsupported('MP4 box is truncated');
}

function u32(bytes: Buffer, offset: number, end = bytes.length): number {
  requireRange(bytes, offset, 4, end);
  return bytes.readUInt32BE(offset);
}

function u64(bytes: Buffer, offset: number, end = bytes.length): number {
  requireRange(bytes, offset, 8, end);
  const value = bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported('MP4 integer exceeds the safe range');
  return Number(value);
}

function boxList(context: ParseContext, start: number, end: number, depth = 0): Box[] {
  if (depth > 16) unsupported('MP4 nesting is too deep');
  if (start < 0 || end < start || end > context.bytes.length)
    unsupported('MP4 parent boundary is invalid');
  const boxes: Box[] = [];
  let cursor = start;
  while (cursor < end) {
    if (end - cursor < 8) unsupported('MP4 box header is truncated');
    const shortSize = u32(context.bytes, cursor, end);
    const type = context.bytes.toString('latin1', cursor + 4, cursor + 8);
    if (!/^[\x20-\x7e]{4}$/u.test(type)) unsupported('MP4 box type is invalid');
    let headerSize = 8;
    let size: number;
    if (shortSize === 1) {
      if (end - cursor < 16) unsupported('MP4 extended box header is truncated');
      headerSize = 16;
      size = u64(context.bytes, cursor + 8, end);
    } else if (shortSize === 0) {
      unsupported('MP4 boxes with an implicit end are not supported');
    } else {
      size = shortSize;
    }
    if (type === 'uuid') unsupported('MP4 uuid boxes are not supported');
    if (size < headerSize || size > end - cursor)
      unsupported('MP4 box exceeds its parent boundary');
    context.boxCount++;
    if (context.boxCount > MAX_BOXES) unsupported('MP4 contains too many boxes');
    if (['moof', 'mfra', 'mvex', 'tfhd', 'tfdt', 'trun', 'trex'].includes(type))
      unsupported('Fragmented MP4 is not supported');
    if (
      ['pssh', 'sinf', 'schm', 'schi', 'tenc', 'senc', 'saiz', 'saio', 'encv', 'enca'].includes(
        type,
      )
    )
      unsupported('Encrypted MP4 is not supported');
    const boxEnd = cursor + size;
    boxes.push({ type, start: cursor, payloadStart: cursor + headerSize, end: boxEnd, size });
    cursor = boxEnd;
  }
  if (cursor !== end) unsupported('MP4 boxes do not fill their parent');
  return boxes;
}

function only(boxes: Box[], type: string, required = true): Box | null {
  const matches = boxes.filter((box) => box.type === type);
  if (matches.length > 1 || (required && matches.length !== 1))
    unsupported(`MP4 ${type} box is missing or repeated`);
  return matches[0] ?? null;
}

function checkTypes(boxes: Box[], allowed: string[]): void {
  for (const box of boxes)
    if (!allowed.includes(box.type)) unsupported(`MP4 ${box.type} box is not supported here`);
}

function fullBox(
  context: ParseContext,
  box: Box,
  allowedVersions: number[] = [0],
): { version: number; flags: number; body: number } {
  requireRange(context.bytes, box.payloadStart, 4, box.end);
  const version = context.bytes[box.payloadStart]!;
  const flags =
    (context.bytes[box.payloadStart + 1]! << 16) |
    (context.bytes[box.payloadStart + 2]! << 8) |
    context.bytes[box.payloadStart + 3]!;
  if (!allowedVersions.includes(version)) unsupported(`MP4 ${box.type} version is not supported`);
  return { version, flags, body: box.payloadStart + 4 };
}

function parseFileType(context: ParseContext, box: Box): string {
  const length = box.end - box.payloadStart;
  if (length < 8 || (length - 8) % 4 !== 0) unsupported('MP4 ftyp box is malformed');
  const bytes = context.bytes;
  const majorBrand = bytes.toString('latin1', box.payloadStart, box.payloadStart + 4);
  if (!/^[\x20-\x7e]{4}$/u.test(majorBrand)) unsupported('MP4 ftyp brand is invalid');
  return majorBrand.trim();
}

function parseMovieHeader(
  context: ParseContext,
  box: Box,
): { timescale: number; duration: number } {
  const { version, flags, body } = fullBox(context, box, [0, 1]);
  if (flags !== 0) unsupported('MP4 mvhd flags are invalid');
  if (box.end - box.payloadStart !== (version === 0 ? 100 : 112))
    unsupported('MP4 mvhd size is invalid');
  const bytes = context.bytes;
  const timescaleOffset = body + (version === 0 ? 8 : 16);
  const durationOffset = timescaleOffset + 4;
  const timescale = u32(bytes, timescaleOffset, box.end);
  const duration =
    version === 0 ? u32(bytes, durationOffset, box.end) : u64(bytes, durationOffset, box.end);
  const unknownDuration = version === 0 ? 0xffffffff : Number.MAX_SAFE_INTEGER;
  if (!timescale || !duration || duration === unknownDuration)
    unsupported('MP4 movie duration is unknown');
  return { timescale, duration };
}

function parseTrackHeader(
  context: ParseContext,
  box: Box,
): {
  trackId: number;
  duration: number;
  width: number;
  height: number;
} {
  const { version, flags, body } = fullBox(context, box, [0, 1]);
  if ((flags & 1) === 0 || (flags & ~7) !== 0)
    unsupported('MP4 track is disabled or has unsupported flags');
  if (box.end - box.payloadStart !== (version === 0 ? 84 : 96))
    unsupported('MP4 tkhd size is invalid');
  const bytes = context.bytes;
  const trackId = u32(bytes, body + (version === 0 ? 8 : 16), box.end);
  const durationOffset = body + (version === 0 ? 16 : 24);
  const duration =
    version === 0 ? u32(bytes, durationOffset, box.end) : u64(bytes, durationOffset, box.end);
  const matrixOffset = body + (version === 0 ? 36 : 48);
  const matrix: number[] = [];
  for (let index = 0; index < 9; index++)
    matrix.push(u32(bytes, matrixOffset + index * 4, box.end));
  const identity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  if (matrix.some((value, index) => value !== identity[index]))
    unsupported('MP4 track transforms are not supported');
  const dimensionsOffset = body + (version === 0 ? 72 : 84);
  const widthFixed = u32(bytes, dimensionsOffset, box.end);
  const heightFixed = u32(bytes, dimensionsOffset + 4, box.end);
  if (!trackId || !duration) unsupported('MP4 track identity or duration is invalid');
  return { trackId, duration, width: widthFixed / 65536, height: heightFixed / 65536 };
}

function parseMediaHeader(
  context: ParseContext,
  box: Box,
): { timescale: number; duration: number } {
  const { version, flags, body } = fullBox(context, box, [0, 1]);
  if (flags !== 0) unsupported('MP4 mdhd flags are invalid');
  if (box.end - box.payloadStart !== (version === 0 ? 24 : 36))
    unsupported('MP4 mdhd size is invalid');
  const bytes = context.bytes;
  const timescaleOffset = body + (version === 0 ? 8 : 16);
  const durationOffset = timescaleOffset + 4;
  const timescale = u32(bytes, timescaleOffset, box.end);
  const duration =
    version === 0 ? u32(bytes, durationOffset, box.end) : u64(bytes, durationOffset, box.end);
  const unknownDuration = version === 0 ? 0xffffffff : Number.MAX_SAFE_INTEGER;
  if (!timescale || !duration || duration === unknownDuration)
    unsupported('MP4 media duration is unknown');
  return { timescale, duration };
}

function parseHandler(context: ParseContext, box: Box): 'vide' | 'soun' {
  const { version, flags, body } = fullBox(context, box, [0]);
  if (version !== 0 || flags !== 0) unsupported('MP4 hdlr fields are invalid');
  requireRange(context.bytes, body, 20, box.end);
  if (
    box.end - body < 20 ||
    context.bytes.readUInt32BE(body) !== 0 ||
    context.bytes.subarray(body + 8, body + 20).some((value) => value !== 0)
  )
    unsupported('MP4 hdlr reserved fields are invalid');
  const handler = context.bytes.toString('latin1', body + 4, body + 8);
  if (handler !== 'vide' && handler !== 'soun')
    unsupported('MP4 contains an unsupported track type');
  const name = context.bytes.subarray(body + 20, box.end);
  if (
    name.length &&
    (name[name.length - 1] !== 0 ||
      name.subarray(0, -1).some((value) => value < 0x20 || value > 0x7e))
  )
    unsupported('MP4 handler name is malformed');
  return handler;
}

function parseDataInformation(context: ParseContext, box: Box): void {
  const children = boxList(context, box.payloadStart, box.end, 4);
  checkTypes(children, ['dref', 'free']);
  const dref = only(children, 'dref')!;
  const { version, flags, body } = fullBox(context, dref, [0]);
  if (version !== 0 || flags !== 0) unsupported('MP4 dref header is invalid');
  const entryCount = u32(context.bytes, body, dref.end);
  const entries = boxList(context, body + 4, dref.end, 5);
  if (entryCount !== 1 || entries.length !== 1 || entries[0]!.type !== 'url ')
    unsupported('MP4 external media references are not supported');
  const url = entries[0]!;
  const entry = fullBox(context, url, [0]);
  if (entry.flags !== 1 || entry.body !== url.end)
    unsupported('MP4 media reference is not self-contained');
}

function parseAvcConfiguration(context: ParseContext, box: Box): string {
  const bytes = context.bytes;
  const start = box.payloadStart;
  requireRange(bytes, start, 7, box.end);
  if (bytes[start] !== 1) unsupported('AVC configuration version is invalid');
  const profile = bytes[start + 1]!;
  const compatibility = bytes[start + 2]!;
  const level = bytes[start + 3]!;
  const lengthField = bytes[start + 4]!;
  const spsField = bytes[start + 5]!;
  if ((lengthField & 0xfc) !== 0xfc || (lengthField & 3) === 2 || (spsField & 0xe0) !== 0xe0)
    unsupported('AVC configuration reserved bits are invalid');
  let cursor = start + 6;
  const spsCount = spsField & 0x1f;
  if (!spsCount) unsupported('AVC configuration has no SPS');
  for (let index = 0; index < spsCount; index++) {
    const length = u16(bytes, cursor, box.end);
    cursor += 2;
    requireRange(bytes, cursor, length, box.end);
    if (!length || (bytes[cursor]! & 0x1f) !== 7) unsupported('AVC SPS record is invalid');
    cursor += length;
  }
  requireRange(bytes, cursor, 1, box.end);
  const ppsCount = bytes[cursor++]!;
  if (!ppsCount) unsupported('AVC configuration has no PPS');
  for (let index = 0; index < ppsCount; index++) {
    const length = u16(bytes, cursor, box.end);
    cursor += 2;
    requireRange(bytes, cursor, length, box.end);
    if (!length || (bytes[cursor]! & 0x1f) !== 8) unsupported('AVC PPS record is invalid');
    cursor += length;
  }
  if (cursor !== box.end) unsupported('AVC configuration has unsupported trailing data');
  return `avc1.${profile.toString(16).padStart(2, '0')}${compatibility.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
}

function u16(bytes: Buffer, offset: number, end: number): number {
  requireRange(bytes, offset, 2, end);
  return bytes.readUInt16BE(offset);
}

function parseVideoDescription(
  context: ParseContext,
  entry: Box,
  expectedWidth: number,
  expectedHeight: number,
): string {
  const bytes = context.bytes;
  requireRange(bytes, entry.payloadStart, 78, entry.end);
  if (!['avc1', 'avc3'].includes(entry.type))
    unsupported('Only AVC video sample entries are supported');
  if (u16(bytes, entry.payloadStart + 6, entry.end) !== 1)
    unsupported('MP4 video sample entry uses an external data reference');
  const width = u16(bytes, entry.payloadStart + 24, entry.end);
  const height = u16(bytes, entry.payloadStart + 26, entry.end);
  if (!width || !height || width !== expectedWidth || height !== expectedHeight)
    unsupported('MP4 track and video sample dimensions disagree');
  const children = boxList(context, entry.payloadStart + 78, entry.end, 6);
  checkTypes(children, ['avcC', 'colr', 'btrt', 'fiel']);
  const avcC = only(children, 'avcC')!;
  const codec = parseAvcConfiguration(context, avcC);
  for (const child of children) {
    if (child.type === 'colr' && child.end - child.payloadStart < 4)
      unsupported('MP4 color metadata is truncated');
    if (child.type === 'btrt' && child.end - child.payloadStart !== 12)
      unsupported('MP4 bitrate metadata is malformed');
    if (child.type === 'fiel' && child.end - child.payloadStart !== 2)
      unsupported('MP4 field metadata is malformed');
  }
  return codec;
}

function readBits(bytes: Buffer, start: number, bitOffset: number, count: number): number {
  if (count < 1 || count > 24) unsupported('AAC bit field is invalid');
  requireRange(bytes, start, Math.ceil((bitOffset + count) / 8));
  let result = 0;
  for (let index = 0; index < count; index++) {
    const absolute = bitOffset + index;
    const bit = (bytes[start + Math.floor(absolute / 8)]! >> (7 - (absolute % 8))) & 1;
    result = (result << 1) | bit;
  }
  return result;
}

interface Descriptor {
  tag: number;
  start: number;
  end: number;
}
function descriptorList(bytes: Buffer, start: number, end: number): Descriptor[] {
  const result: Descriptor[] = [];
  let cursor = start;
  while (cursor < end) {
    if (end - cursor < 2) unsupported('MP4 ES descriptor is truncated');
    const tag = bytes[cursor++]!;
    let length = 0;
    let complete = false;
    for (let count = 0; count < 4; count++) {
      requireRange(bytes, cursor, 1, end);
      const part = bytes[cursor++]!;
      length = length * 128 + (part & 0x7f);
      if ((part & 0x80) === 0) {
        complete = true;
        break;
      }
    }
    if (!complete || length > end - cursor) unsupported('MP4 ES descriptor length is invalid');
    result.push({ tag, start: cursor, end: cursor + length });
    cursor += length;
  }
  return result;
}

function parseAacConfiguration(
  bytes: Buffer,
  start: number,
  end: number,
  entryChannels: number,
  entryRate: number,
): string {
  let bitOffset = 0;
  const read = (count: number) => {
    if (bitOffset + count > (end - start) * 8)
      unsupported('AAC decoder configuration is truncated');
    const value = readBits(bytes, start, bitOffset, count);
    bitOffset += count;
    return value;
  };
  let objectType = read(5);
  if (objectType === 31) objectType = 32 + read(6);
  const frequencyIndex = read(4);
  let sampleRate: number;
  const rates = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ];
  if (frequencyIndex === 15) sampleRate = read(24);
  else {
    sampleRate = rates[frequencyIndex] ?? 0;
    if (!sampleRate) unsupported('AAC sample rate index is invalid');
  }
  const channelConfig = read(4);
  const channels = [0, 1, 2, 3, 4, 5, 6, 8][channelConfig] ?? 0;
  if (
    objectType < 1 ||
    objectType > 4 ||
    !channels ||
    channels !== entryChannels ||
    sampleRate !== entryRate
  )
    unsupported('AAC decoder configuration disagrees with its sample entry');
  // AAC object type 5/29 has extension sampling fields; reject them instead of guessing.
  if (
    bitOffset < (end - start) * 8 &&
    bytes.subarray(start + Math.floor(bitOffset / 8), end).some((value) => value !== 0)
  )
    unsupported('Extended AAC decoder configurations are not supported');
  return `mp4a.40.${objectType}`;
}

function parseEsds(
  context: ParseContext,
  box: Box,
  entryChannels: number,
  entryRate: number,
): string {
  const { version, flags, body } = fullBox(context, box, [0]);
  if (version !== 0 || flags !== 0) unsupported('MP4 esds header is invalid');
  const top = descriptorList(context.bytes, body, box.end);
  if (top.length !== 1 || top[0]!.tag !== 3) unsupported('MP4 ES descriptor is missing');
  const es = top[0]!;
  requireRange(context.bytes, es.start, 3, es.end);
  let cursor = es.start + 3;
  const esFlags = context.bytes[es.start + 2]!;
  if (esFlags & 0x80) cursor += 2;
  if (esFlags & 0x40) {
    requireRange(context.bytes, cursor, 1, es.end);
    const urlLength = context.bytes[cursor++]!;
    cursor += urlLength;
  }
  if (esFlags & 0x20) cursor += 2;
  if (cursor > es.end) unsupported('MP4 ES descriptor optional fields are truncated');
  const children = descriptorList(context.bytes, cursor, es.end);
  const decoder = children.filter((item) => item.tag === 4);
  if (decoder.length !== 1) unsupported('MP4 decoder configuration is missing or repeated');
  const config = decoder[0]!;
  requireRange(context.bytes, config.start, 13, config.end);
  const objectType = context.bytes[config.start]!;
  const streamType = context.bytes[config.start + 1]!;
  if (objectType !== 0x40 || ((streamType >> 2) & 0x3f) !== 5 || (streamType & 1) !== 1)
    unsupported('Only self-contained AAC audio sample entries are supported');
  const nested = descriptorList(context.bytes, config.start + 13, config.end);
  const specific = nested.filter((item) => item.tag === 5);
  if (specific.length !== 1) unsupported('AAC decoder-specific metadata is missing or repeated');
  return parseAacConfiguration(
    context.bytes,
    specific[0]!.start,
    specific[0]!.end,
    entryChannels,
    entryRate,
  );
}

function parseAudioDescription(context: ParseContext, entry: Box): string {
  const bytes = context.bytes;
  requireRange(bytes, entry.payloadStart, 28, entry.end);
  if (entry.type !== 'mp4a') unsupported('Only AAC audio sample entries are supported');
  if (u16(bytes, entry.payloadStart + 6, entry.end) !== 1)
    unsupported('MP4 audio sample entry uses an external data reference');
  const version = u16(bytes, entry.payloadStart + 8, entry.end);
  const channels = u16(bytes, entry.payloadStart + 16, entry.end);
  const sampleSize = u16(bytes, entry.payloadStart + 18, entry.end);
  const sampleRateFixed = u32(bytes, entry.payloadStart + 24, entry.end);
  const sampleRate = sampleRateFixed >>> 16;
  if (version !== 0 || !channels || !sampleSize || !sampleRate || (sampleRateFixed & 0xffff) !== 0)
    unsupported('MP4 AAC sample entry is invalid');
  const children = boxList(context, entry.payloadStart + 28, entry.end, 6);
  checkTypes(children, ['esds', 'btrt']);
  const esds = only(children, 'esds')!;
  for (const child of children) {
    if (child.type === 'btrt' && child.end - child.payloadStart !== 12)
      unsupported('MP4 bitrate metadata is malformed');
  }
  return parseEsds(context, esds, channels, sampleRate);
}

function parseSampleDescription(
  context: ParseContext,
  box: Box,
  handler: 'vide' | 'soun',
  width: number,
  height: number,
): string {
  const { version, flags, body } = fullBox(context, box, [0]);
  if (version !== 0 || flags !== 0) unsupported('MP4 stsd header is invalid');
  const entryCount = u32(context.bytes, body, box.end);
  if (entryCount !== 1) unsupported('Multiple MP4 sample descriptions are not supported');
  const entries = boxList(context, body + 4, box.end, 5);
  if (entries.length !== 1) unsupported('MP4 stsd sample entry count is inconsistent');
  return handler === 'vide'
    ? parseVideoDescription(context, entries[0]!, width, height)
    : parseAudioDescription(context, entries[0]!);
}

function parseTiming(context: ParseContext, box: Box): Array<{ count: number; delta: number }> {
  const { version, flags, body } = fullBox(context, box, [0]);
  if (version !== 0 || flags !== 0) unsupported('MP4 stts header is invalid');
  const count = u32(context.bytes, body, box.end);
  if (!count || count > MAX_TABLE_ENTRIES || box.end - (body + 4) !== count * 8)
    unsupported('MP4 stts entry count is invalid');
  const runs: Array<{ count: number; delta: number }> = [];
  for (let index = 0; index < count; index++) {
    const offset = body + 4 + index * 8;
    const samples = u32(context.bytes, offset, box.end);
    const delta = u32(context.bytes, offset + 4, box.end);
    if (!samples || !delta) unsupported('MP4 stts has an empty sample run');
    runs.push({ count: samples, delta });
  }
  return runs;
}

function parseComposition(
  context: ParseContext,
  box: Box,
): Array<{ count: number; offset: number }> {
  const { version, flags, body } = fullBox(context, box, [0, 1]);
  if (flags !== 0) unsupported('MP4 ctts flags are invalid');
  const count = u32(context.bytes, body, box.end);
  if (!count || count > MAX_TABLE_ENTRIES || box.end - (body + 4) !== count * 8)
    unsupported('MP4 ctts entry count is invalid');
  const runs: Array<{ count: number; offset: number }> = [];
  for (let index = 0; index < count; index++) {
    const offset = body + 4 + index * 8;
    const samples = u32(context.bytes, offset, box.end);
    const value = u32(context.bytes, offset + 4, box.end);
    const compositionOffset = version === 1 && value > 0x7fffffff ? value - 0x1_0000_0000 : value;
    if (!samples || compositionOffset < 0)
      unsupported('Negative or empty MP4 composition runs are not supported');
    runs.push({ count: samples, offset: compositionOffset });
  }
  return runs;
}

function parseSampleToChunk(context: ParseContext, box: Box): SampleTable['stsc'] {
  const { version, flags, body } = fullBox(context, box, [0]);
  if (version !== 0 || flags !== 0) unsupported('MP4 stsc header is invalid');
  const count = u32(context.bytes, body, box.end);
  if (!count || count > MAX_TABLE_ENTRIES || box.end - (body + 4) !== count * 12)
    unsupported('MP4 stsc entry count is invalid');
  const entries: SampleTable['stsc'] = [];
  let previous = 0;
  for (let index = 0; index < count; index++) {
    const offset = body + 4 + index * 12;
    const firstChunk = u32(context.bytes, offset, box.end);
    const samplesPerChunk = u32(context.bytes, offset + 4, box.end);
    const descriptionIndex = u32(context.bytes, offset + 8, box.end);
    if (firstChunk <= previous || !samplesPerChunk || descriptionIndex !== 1)
      unsupported('MP4 stsc mapping is invalid');
    entries.push({ firstChunk, samplesPerChunk, descriptionIndex });
    previous = firstChunk;
  }
  if (entries[0]!.firstChunk !== 1) unsupported('MP4 stsc must map the first chunk');
  return entries;
}

function parseSampleSizes(
  context: ParseContext,
  box: Box,
): {
  sampleCount: number;
  sizes: number[] | null;
  constantSize: number;
} {
  const { version, flags, body } = fullBox(context, box, [0]);
  if (version !== 0 || flags !== 0) unsupported('MP4 stsz header is invalid');
  const constantSize = u32(context.bytes, body, box.end);
  const sampleCount = u32(context.bytes, body + 4, box.end);
  if (!sampleCount || sampleCount > MAX_TABLE_ENTRIES) unsupported('MP4 sample count is invalid');
  if (constantSize) {
    if (box.end !== body + 8) unsupported('MP4 constant stsz contains unexpected entries');
    return { sampleCount, sizes: null, constantSize };
  }
  if (box.end - (body + 8) !== sampleCount * 4) unsupported('MP4 stsz entry count is invalid');
  const sizes: number[] = [];
  for (let index = 0; index < sampleCount; index++) {
    const size = u32(context.bytes, body + 8 + index * 4, box.end);
    if (!size) unsupported('MP4 sample size is zero');
    sizes.push(size);
  }
  return { sampleCount, sizes, constantSize: 0 };
}

function parseChunkOffsets(context: ParseContext, box: Box): number[] {
  const { version, flags, body } = fullBox(context, box, [0]);
  if (version !== 0 || flags !== 0) unsupported(`MP4 ${box.type} header is invalid`);
  const count = u32(context.bytes, body, box.end);
  const width = box.type === 'co64' ? 8 : 4;
  if (!count || count > MAX_TABLE_ENTRIES || box.end - (body + 4) !== count * width)
    unsupported('MP4 chunk offset table is invalid');
  const offsets: number[] = [];
  for (let index = 0; index < count; index++) {
    const offset = body + 4 + index * width;
    offsets.push(
      width === 8 ? u64(context.bytes, offset, box.end) : u32(context.bytes, offset, box.end),
    );
  }
  return offsets;
}

function parseSyncSamples(context: ParseContext, box: Box, sampleCount: number): number[] {
  const { version, flags, body } = fullBox(context, box, [0]);
  if (version !== 0 || flags !== 0) unsupported('MP4 stss header is invalid');
  const count = u32(context.bytes, body, box.end);
  if (count > sampleCount || box.end - (body + 4) !== count * 4)
    unsupported('MP4 stss entry count is invalid');
  const result: number[] = [];
  let previous = 0;
  for (let index = 0; index < count; index++) {
    const sample = u32(context.bytes, body + 4 + index * 4, box.end);
    if (sample <= previous || sample > sampleCount) unsupported('MP4 sync sample index is invalid');
    result.push(sample);
    previous = sample;
  }
  if (!count) unsupported('MP4 video track has no sync samples');
  return result;
}

function parseSampleTable(context: ParseContext, box: Box, handler: 'vide' | 'soun'): SampleTable {
  const children = boxList(context, box.payloadStart, box.end, 5);
  checkTypes(children, ['stsd', 'stts', 'ctts', 'stsc', 'stsz', 'stco', 'co64', 'stss', 'free']);
  only(children, 'stsd');
  const stts = only(children, 'stts')!;
  const stsc = only(children, 'stsc')!;
  const stsz = only(children, 'stsz')!;
  const stco = only(children, 'stco', false);
  const co64 = only(children, 'co64', false);
  if (!!stco === !!co64) unsupported('MP4 requires exactly one chunk offset table');
  const timing = parseTiming(context, stts);
  const compositionBox = only(children, 'ctts', false);
  const composition = compositionBox ? parseComposition(context, compositionBox) : null;
  const sizes = parseSampleSizes(context, stsz);
  const chunks = parseChunkOffsets(context, stco ?? co64!);
  const mapping = parseSampleToChunk(context, stsc);
  if (mapping[mapping.length - 1]!.firstChunk > chunks.length)
    unsupported('MP4 stsc references a nonexistent chunk');
  const syncBox = only(children, 'stss', false);
  const syncSamples = syncBox ? parseSyncSamples(context, syncBox, sizes.sampleCount) : null;
  if (composition && composition.reduce((sum, run) => sum + run.count, 0) !== sizes.sampleCount)
    unsupported('MP4 ctts sample count disagrees with stsz');
  if (timing.reduce((sum, run) => sum + run.count, 0) !== sizes.sampleCount)
    unsupported('MP4 stts sample count disagrees with stsz');
  if (handler === 'vide' && syncSamples === null)
    unsupported('MP4 video track must declare sync samples');
  return {
    sampleCount: sizes.sampleCount,
    sampleSizes: sizes.sizes,
    constantSampleSize: sizes.constantSize,
    chunks,
    stsc: mapping,
    timing,
    composition,
    syncSamples,
  };
}

function computeTiming(table: SampleTable): number {
  let sampleCount = 0;
  let decodeTime = 0n;
  for (const run of table.timing) {
    sampleCount += run.count;
    decodeTime += BigInt(run.count) * BigInt(run.delta);
  }
  if (sampleCount !== table.sampleCount || decodeTime > BigInt(Number.MAX_SAFE_INTEGER))
    unsupported('MP4 decode timeline is invalid');
  if (table.composition) {
    let timingIndex = 0;
    let compositionIndex = 0;
    let timingRemaining = table.timing[0]!.count;
    let compositionRemaining = table.composition[0]!.count;
    let decodeCursor = 0n;
    let maxEnd = 0n;
    let consumed = 0;
    while (consumed < table.sampleCount) {
      const count = Math.min(timingRemaining, compositionRemaining);
      const timing = table.timing[timingIndex]!;
      const composition = table.composition[compositionIndex]!;
      const start = decodeCursor + BigInt(composition.offset);
      const end =
        decodeCursor +
        BigInt(count - 1) * BigInt(timing.delta) +
        BigInt(composition.offset) +
        BigInt(timing.delta);
      if (start < 0n) unsupported('MP4 presentation timeline starts before zero');
      if (end > maxEnd) maxEnd = end;
      decodeCursor += BigInt(count) * BigInt(timing.delta);
      consumed += count;
      timingRemaining -= count;
      compositionRemaining -= count;
      if (!timingRemaining && consumed < table.sampleCount) {
        timingIndex++;
        timingRemaining = table.timing[timingIndex]!.count;
      }
      if (!compositionRemaining && consumed < table.sampleCount) {
        compositionIndex++;
        compositionRemaining = table.composition[compositionIndex]!.count;
      }
    }
    if (maxEnd > decodeTime) unsupported('MP4 presentation timeline exceeds media duration');
  }
  return Number(decodeTime);
}

function mapChunks(table: SampleTable, mdats: MediaRange[], fileLength: number): MediaRange[] {
  const ranges: MediaRange[] = [];
  let samplesUsed = 0;
  let mappingIndex = 0;
  for (let index = 0; index < table.chunks.length; index++) {
    const chunkNumber = index + 1;
    while (
      mappingIndex + 1 < table.stsc.length &&
      table.stsc[mappingIndex + 1]!.firstChunk <= chunkNumber
    )
      mappingIndex++;
    const entry = table.stsc[mappingIndex]!;
    const inChunk = entry.samplesPerChunk;
    if (inChunk > table.sampleCount - samplesUsed)
      unsupported('MP4 chunk table references too many samples');
    let chunkBytes = 0n;
    if (table.sampleSizes) {
      for (let sample = 0; sample < inChunk; sample++)
        chunkBytes += BigInt(table.sampleSizes[samplesUsed + sample]!);
    } else {
      chunkBytes = BigInt(table.constantSampleSize) * BigInt(inChunk);
    }
    const start = table.chunks[index]!;
    const endBig = BigInt(start) + chunkBytes;
    if (!chunkBytes || endBig > BigInt(fileLength) || endBig > BigInt(Number.MAX_SAFE_INTEGER))
      unsupported('MP4 chunk sample range exceeds the file');
    const end = Number(endBig);
    if (!mdats.some((mdat) => start >= mdat.start && end <= mdat.end))
      unsupported('MP4 chunk sample range is outside mdat payload');
    ranges.push({ start, end });
    samplesUsed += inChunk;
  }
  if (samplesUsed !== table.sampleCount) unsupported('MP4 chunk table does not cover every sample');
  return ranges;
}

function parseTrack(
  context: ParseContext,
  box: Box,
  movie: { timescale: number; duration: number },
  mdats: MediaRange[],
): TrackFacts {
  const children = boxList(context, box.payloadStart, box.end, 2);
  checkTypes(children, ['tkhd', 'mdia', 'free']);
  const tkhd = only(children, 'tkhd')!;
  const mdia = only(children, 'mdia')!;
  const trackHeader = parseTrackHeader(context, tkhd);
  const mediaChildren = boxList(context, mdia.payloadStart, mdia.end, 3);
  checkTypes(mediaChildren, ['mdhd', 'hdlr', 'minf', 'elng', 'free']);
  if (mediaChildren.some((child) => child.type === 'elng'))
    unsupported('Extended media language metadata is not supported');
  const mediaHeader = parseMediaHeader(context, only(mediaChildren, 'mdhd')!);
  const handler = parseHandler(context, only(mediaChildren, 'hdlr')!);
  const minf = only(mediaChildren, 'minf')!;
  const minfChildren = boxList(context, minf.payloadStart, minf.end, 4);
  checkTypes(minfChildren, ['vmhd', 'smhd', 'dinf', 'stbl', 'free']);
  const mediaHeaderBox = only(minfChildren, handler === 'vide' ? 'vmhd' : 'smhd')!;
  if (only(minfChildren, handler === 'vide' ? 'smhd' : 'vmhd', false))
    unsupported('MP4 media header does not match track type');
  const mediaFlags = fullBox(context, mediaHeaderBox, [0]);
  if (handler === 'vide') {
    if (mediaFlags.flags !== 1 || mediaHeaderBox.end - mediaFlags.body !== 8)
      unsupported('MP4 vmhd box is malformed');
  } else if (mediaFlags.flags !== 0 || mediaHeaderBox.end - mediaFlags.body !== 4) {
    unsupported('MP4 smhd box is malformed');
  }
  parseDataInformation(context, only(minfChildren, 'dinf')!);
  const stbl = only(minfChildren, 'stbl')!;
  const stblChildren = boxList(context, stbl.payloadStart, stbl.end, 5);
  const description = parseSampleDescription(
    context,
    only(stblChildren, 'stsd')!,
    handler,
    trackHeader.width,
    trackHeader.height,
  );
  const table = parseSampleTable(context, stbl, handler);
  const decodeDuration = computeTiming(table);
  if (decodeDuration !== mediaHeader.duration) unsupported('MP4 mdhd duration disagrees with stts');
  const movieDuration = Math.round(
    (mediaHeader.duration * movie.timescale) / mediaHeader.timescale,
  );
  if (
    Math.abs(movieDuration - trackHeader.duration) > 1 ||
    trackHeader.duration > movie.duration + 1
  )
    unsupported('MP4 tkhd duration disagrees with media timeline');
  const ranges = mapChunks(table, mdats, context.bytes.length);
  if (handler === 'vide') {
    if (
      !Number.isSafeInteger(trackHeader.width) ||
      !Number.isSafeInteger(trackHeader.height) ||
      trackHeader.width < 1 ||
      trackHeader.height < 1 ||
      trackHeader.width > 32768 ||
      trackHeader.height > 32768
    )
      unsupported('MP4 video dimensions are invalid');
    return {
      handler,
      trackId: trackHeader.trackId,
      duration: mediaHeader.duration,
      timescale: mediaHeader.timescale,
      width: trackHeader.width,
      height: trackHeader.height,
      codec: description,
      sampleCount: table.sampleCount,
      ranges,
    };
  }
  if (trackHeader.width !== 0 || trackHeader.height !== 0)
    unsupported('MP4 audio track unexpectedly declares video dimensions');
  return {
    handler,
    trackId: trackHeader.trackId,
    duration: mediaHeader.duration,
    timescale: mediaHeader.timescale,
    width: null,
    height: null,
    codec: description,
    sampleCount: table.sampleCount,
    ranges,
  };
}

/**
 * Validates bounded, non-fragmented ISO BMFF structure and sample ranges.
 * It reports container metadata only; it does not decode or inspect media samples.
 */
export function validateMp4(bytes: Buffer): Record<string, number | string | boolean | null> {
  if (!Buffer.isBuffer(bytes)) unsupported('MP4 validator requires a Buffer');
  if (bytes.length > MAX_BYTES) tooLarge();
  if (bytes.length < 32) unsupported('MP4 file is too short');
  try {
    const context: ParseContext = { bytes, boxCount: 0 };
    const top = boxList(context, 0, bytes.length);
    checkTypes(top, ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide']);
    const ftyp = only(top, 'ftyp')!;
    const moov = only(top, 'moov')!;
    if (top[0] !== ftyp) unsupported('MP4 ftyp must be the first top-level box');
    const majorBrand = parseFileType(context, ftyp);
    if (!['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V', 'M4A'].includes(majorBrand))
      unsupported('MP4 major brand is not supported');
    const mdats = top
      .filter((box) => box.type === 'mdat')
      .map((box) => ({ start: box.payloadStart, end: box.end }));
    const mdatBytes = mdats.reduce((sum, range) => sum + range.end - range.start, 0);
    if (!mdats.length || !mdatBytes) unsupported('MP4 requires nonempty mdat payload');
    const movieChildren = boxList(context, moov.payloadStart, moov.end, 1);
    checkTypes(movieChildren, ['mvhd', 'trak', 'udta', 'free', 'skip']);
    const movie = parseMovieHeader(context, only(movieChildren, 'mvhd')!);
    const trackBoxes = movieChildren.filter((box) => box.type === 'trak');
    if (!trackBoxes.length || trackBoxes.length > 16) unsupported('MP4 track count is invalid');
    const tracks = trackBoxes.map((box) => parseTrack(context, box, movie, mdats));
    if (new Set(tracks.map((track) => track.trackId)).size !== tracks.length)
      unsupported('MP4 track IDs are repeated');
    const videos = tracks.filter((track) => track.handler === 'vide');
    const audios = tracks.filter((track) => track.handler === 'soun');
    if (videos.length !== 1) unsupported('MP4 must contain exactly one supported video track');
    const ranges = tracks
      .flatMap((track) => track.ranges)
      .sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index++)
      if (ranges[index]!.start < ranges[index - 1]!.end)
        unsupported('MP4 track sample ranges overlap');
    const video = videos[0]!;
    const durationSeconds = video.duration / video.timescale;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
      unsupported('MP4 video duration is invalid');
    const metadata: Record<string, number | string | boolean | null> = {
      container: 'mp4',
      majorBrand,
      width: video.width,
      height: video.height,
      durationSeconds: Number(durationSeconds.toFixed(6)),
      videoCodec: video.codec,
      sampleCount: video.sampleCount,
      mdatBytes,
    };
    if (audios.length) {
      metadata.audioTrackCount = audios.length;
      metadata.audioCodec = [...new Set(audios.map((track) => track.codec))].join(',');
    }
    return metadata;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    unsupported('MP4 box or sample table is malformed');
  }
}
