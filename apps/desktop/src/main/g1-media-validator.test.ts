import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { GenerationMediaReader } from './g1-media-validator.js';
import { validateGenerationMedia } from './g1-media-validator.js';

const READER_LIMIT = 64 * 1024;

class MemoryMediaReader implements GenerationMediaReader {
  readonly requests: Array<{ offset: number; length: number }> = [];
  readonly protectedRanges: Array<{ start: number; end: number }> = [];
  largestRequest = 0;
  protectedBytesRead = 0;

  constructor(
    readonly sizeBytes: number,
    private readonly prefix: Buffer,
    private readonly chunkSize = 13,
  ) {}

  async read(offset: number, length: number): Promise<Buffer> {
    if (length > READER_LIMIT) throw new Error('read exceeded 64 KiB');
    if (offset < 0 || length < 0 || offset + length > this.sizeBytes)
      throw new Error('read exceeded synthetic file bounds');
    this.requests.push({ offset, length });
    this.largestRequest = Math.max(this.largestRequest, length);
    for (const range of this.protectedRanges) {
      const overlap = Math.max(
        0,
        Math.min(offset + length, range.end) - Math.max(offset, range.start),
      );
      this.protectedBytesRead += overlap;
    }
    const result = Buffer.alloc(length);
    const copyEnd = Math.min(offset + length, this.prefix.length);
    if (copyEnd > offset) this.prefix.copy(result, 0, offset, copyEnd);
    return result;
  }

  async *chunks(offset = 0, length = this.sizeBytes - offset): AsyncIterable<Uint8Array> {
    if (offset < 0 || length < 0 || offset + length > this.sizeBytes)
      throw new Error('chunks exceeded synthetic file bounds');
    let cursor = offset;
    let remaining = length;
    while (remaining > 0) {
      const count = Math.min(this.chunkSize, remaining);
      yield await this.read(cursor, count);
      cursor += count;
      remaining -= count;
    }
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return chunk;
}

function makePng(filter = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.from([filter, 1, 2, 3, 4]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeWav(dataBytes = 4): Buffer {
  const riffSize = 36 + dataBytes;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(riffSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function makeJpeg(): Buffer {
  const sof = Buffer.from([8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  const sos = Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xc0, sof),
    jpegSegment(0xda, sos),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd9]),
  ]);
}

function makeMp3(frameCount = 2): Buffer {
  const frameBytes = 417;
  const result = Buffer.alloc(frameCount * frameBytes);
  for (let index = 0; index < frameCount; index++) {
    const offset = index * frameBytes;
    result.set([0xff, 0xfb, 0x90, 0x64], offset);
  }
  return result;
}

function makeWebp(extended = false, lossless = false, exifAfterImage = false): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const chunks: Buffer[] = [];
  if (extended) {
    const header = Buffer.alloc(10);
    if (exifAfterImage) header[0] = 0x08;
    header.writeUIntLE(0, 4, 3);
    header.writeUIntLE(0, 7, 3);
    chunks.push(chunk('VP8X', header));
  }
  if (lossless) {
    chunks.push(chunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])));
  } else {
    const frame = Buffer.alloc(11);
    frame[0] = 0x30; // keyframe, shown, one-byte first partition
    frame.set([0x9d, 0x01, 0x2a], 3);
    frame.writeUInt16LE(1, 6);
    frame.writeUInt16LE(1, 8);
    chunks.push(chunk('VP8 ', frame));
  }
  if (exifAfterImage) chunks.push(chunk('EXIF', Buffer.from([0])));
  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write('WEBP', 8, 'ascii');
  return Buffer.concat([riff, body]);
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function mp4Box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + header.length, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function fullBox(type: string, body: Buffer, flags = 0): Buffer {
  const header = Buffer.from([0, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]);
  return mp4Box(type, Buffer.concat([header, body]));
}

function identityMatrix(): Buffer {
  const matrix = Buffer.alloc(36);
  matrix.writeUInt32BE(0x00010000, 0);
  matrix.writeUInt32BE(0x00010000, 16);
  matrix.writeUInt32BE(0x40000000, 32);
  return matrix;
}

function makeMp4Fixture(
  options: {
    compositionOffsets?: number[];
    edit?: { mediaTime: number; segmentDuration: number };
  } = {},
): Buffer {
  const sample = Buffer.from([0, 0, 0, 2, 0x65, 0x88]);
  const sampleCount = options.compositionOffsets?.length ?? 1;
  const decodeDuration = sampleCount * 1000;
  const movieDuration = options.edit?.segmentDuration ?? decodeDuration;
  const ftyp = mp4Box('ftyp', Buffer.from('isom\0\0\0\0isomiso2avc1mp41', 'latin1'));

  const mvhdBody = Buffer.alloc(96);
  mvhdBody.writeUInt32BE(1000, 8);
  mvhdBody.writeUInt32BE(movieDuration, 12);
  mvhdBody.writeUInt32BE(0x00010000, 16);
  mvhdBody.writeUInt16BE(0x0100, 20);
  identityMatrix().copy(mvhdBody, 32);
  const mvhd = fullBox('mvhd', mvhdBody);

  const tkhdBody = Buffer.alloc(80);
  tkhdBody.writeUInt32BE(1, 8);
  tkhdBody.writeUInt32BE(movieDuration, 16);
  identityMatrix().copy(tkhdBody, 36);
  tkhdBody.writeUInt32BE(640 * 65536, 72);
  tkhdBody.writeUInt32BE(360 * 65536, 76);
  const tkhd = fullBox('tkhd', tkhdBody, 7);

  const mdhdBody = Buffer.alloc(20);
  mdhdBody.writeUInt32BE(1000, 8);
  mdhdBody.writeUInt32BE(decodeDuration, 12);
  mdhdBody.writeUInt16BE(0x55c4, 16);
  const mdhd = fullBox('mdhd', mdhdBody);
  const hdlr = fullBox(
    'hdlr',
    Buffer.concat([Buffer.alloc(4), Buffer.from('vide'), Buffer.alloc(12)]),
  );
  const vmhd = fullBox('vmhd', Buffer.alloc(8), 1);
  const url = fullBox('url ', Buffer.alloc(0), 1);
  const dref = fullBox('dref', Buffer.concat([u32(1), url]));
  const dinf = mp4Box('dinf', dref);
  const avcConfig = mp4Box(
    'avcC',
    Buffer.from([
      1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 2, 0x67, 0x64, 1, 0, 2, 0x68, 0xee, 0xfd, 0xf8, 0xf8, 0,
    ]),
  );
  const visualEntry = Buffer.alloc(78);
  visualEntry.writeUInt16BE(1, 6);
  visualEntry.writeUInt16BE(640, 24);
  visualEntry.writeUInt16BE(360, 26);
  const avc1 = mp4Box('avc1', Buffer.concat([visualEntry, avcConfig]));
  const stsd = fullBox('stsd', Buffer.concat([u32(1), avc1]));
  const stts = fullBox('stts', Buffer.concat([u32(1), u32(sampleCount), u32(1000)]));
  let ctts: Buffer | null = null;
  if (options.compositionOffsets) {
    const runs: Array<{ count: number; offset: number }> = [];
    for (const offset of options.compositionOffsets) {
      const previous = runs[runs.length - 1];
      if (previous?.offset === offset) previous.count++;
      else runs.push({ count: 1, offset });
    }
    ctts = fullBox(
      'ctts',
      Buffer.concat([
        u32(runs.length),
        ...runs.flatMap((run) => [u32(run.count), u32(run.offset)]),
      ]),
    );
  }
  const stsc = fullBox('stsc', Buffer.concat([u32(1), u32(1), u32(sampleCount), u32(1)]));
  const stsz = fullBox(
    'stsz',
    Buffer.concat([
      u32(0),
      u32(sampleCount),
      ...Array.from({ length: sampleCount }, () => u32(sample.length)),
    ]),
  );
  const stss = fullBox('stss', Buffer.concat([u32(1), u32(1)]));
  let edts: Buffer[] = [];
  if (options.edit) {
    const entry = Buffer.alloc(12);
    entry.writeUInt32BE(options.edit.segmentDuration, 0);
    entry.writeInt32BE(options.edit.mediaTime, 4);
    entry.writeInt16BE(1, 8);
    edts = [mp4Box('edts', fullBox('elst', Buffer.concat([u32(1), entry])))];
  }

  const createMovie = (sampleOffset: number) => {
    const stco = fullBox('stco', Buffer.concat([u32(1), u32(sampleOffset)]));
    const stbl = mp4Box(
      'stbl',
      Buffer.concat([stsd, stts, ...(ctts ? [ctts] : []), stsc, stsz, stco, stss]),
    );
    const minf = mp4Box('minf', Buffer.concat([vmhd, dinf, stbl]));
    const mdia = mp4Box('mdia', Buffer.concat([mdhd, hdlr, minf]));
    const trak = mp4Box('trak', Buffer.concat([tkhd, ...edts, mdia]));
    return mp4Box('moov', Buffer.concat([mvhd, trak]));
  };

  const firstMoov = createMovie(0);
  const payloadStart = ftyp.length + firstMoov.length + 8;
  const moov = createMovie(payloadStart);
  const samples = Buffer.concat(Array.from({ length: sampleCount }, () => sample));
  return Buffer.concat([ftyp, moov, mp4Box('mdat', samples)]);
}

function expectDomainCode(action: () => Promise<unknown>, expectedCode: string) {
  return expect(action()).rejects.toMatchObject({ code: expectedCode });
}

describe('G1 file-backed generation media validation', () => {
  it('validates PNG chunk checksums and filters while reading IDAT incrementally', async () => {
    const bytes = makePng();
    const reader = new MemoryMediaReader(bytes.length, bytes, 3);
    await expect(validateGenerationMedia('image/png', reader)).resolves.toEqual({
      container: 'png',
      width: 1,
      height: 1,
    });
    expect(reader.largestRequest).toBeLessThanOrEqual(READER_LIMIT);
    expect(reader.requests.some((request) => request.length === bytes.length)).toBe(false);

    const badCrc = Buffer.from(bytes);
    badCrc[badCrc.length - 5] = badCrc[badCrc.length - 5]! ^ 1;
    await expectDomainCode(
      () => validateGenerationMedia('image/png', new MemoryMediaReader(badCrc.length, badCrc)),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    await expectDomainCode(
      () =>
        validateGenerationMedia('image/png', new MemoryMediaReader(makePng(5).length, makePng(5))),
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('skips a large WAV data chunk and checks its bounded fmt metadata', async () => {
    const largeDataBytes = 32 * 1024 * 1024;
    const prefix = makeWav(largeDataBytes);
    const reader = new MemoryMediaReader(prefix.length + largeDataBytes, prefix);
    reader.protectedRanges.push({ start: 44, end: reader.sizeBytes });
    await expect(validateGenerationMedia('audio/wav', reader)).resolves.toEqual({
      container: 'wav',
      channels: 1,
      sampleRate: 8000,
      bitsPerSample: 16,
      durationSeconds: 2097.152,
    });
    expect(reader.protectedBytesRead).toBe(0);
    expect(reader.largestRequest).toBeLessThanOrEqual(READER_LIMIT);

    const inconsistent = makeWav(4);
    inconsistent.writeUInt32LE(1, 28);
    await expectDomainCode(
      () => validateGenerationMedia('audio/wav', new MemoryMediaReader(48, inconsistent)),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    const malformed = Buffer.from(makeWav());
    malformed.writeUInt32LE(0xfffffff0, 40);
    await expectDomainCode(
      () =>
        validateGenerationMedia('audio/wav', new MemoryMediaReader(malformed.length, malformed)),
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('checks JPEG markers and dimensions while streaming entropy data', async () => {
    const bytes = makeJpeg();
    const reader = new MemoryMediaReader(bytes.length, bytes, 2);
    reader.protectedRanges.push({ start: bytes.length - 6, end: bytes.length - 2 });
    await expect(validateGenerationMedia('image/jpeg', reader)).resolves.toEqual({
      container: 'jpeg',
      width: 1,
      height: 1,
    });
    expect(reader.protectedBytesRead).toBeGreaterThan(0);
    expect(reader.largestRequest).toBeLessThanOrEqual(READER_LIMIT);

    const truncated = bytes.subarray(0, bytes.length - 2);
    await expectDomainCode(
      () =>
        validateGenerationMedia('image/jpeg', new MemoryMediaReader(truncated.length, truncated)),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    const badDimensions = Buffer.from(bytes);
    badDimensions.writeUInt16BE(0, 7);
    await expectDomainCode(
      () =>
        validateGenerationMedia(
          'image/jpeg',
          new MemoryMediaReader(badDimensions.length, badDimensions),
        ),
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('validates bounded static lossy WebP chunks and rejects arbitrary RIFF data', async () => {
    for (const bytes of [
      makeWebp(),
      makeWebp(true),
      makeWebp(false, true),
      makeWebp(true, false, true),
    ]) {
      await expect(
        validateGenerationMedia('image/webp', new MemoryMediaReader(bytes.length, bytes)),
      ).resolves.toEqual({ container: 'webp', width: 1, height: 1 });
    }
    const arbitraryRiff = Buffer.from(makeWebp());
    arbitraryRiff.write('AVI ', 8, 'ascii');
    await expectDomainCode(
      () =>
        validateGenerationMedia(
          'image/webp',
          new MemoryMediaReader(arbitraryRiff.length, arbitraryRiff),
        ),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    const badChunkLength = Buffer.from(makeWebp());
    badChunkLength.writeUInt32LE(0xffffffff, 16);
    await expectDomainCode(
      () =>
        validateGenerationMedia(
          'image/webp',
          new MemoryMediaReader(badChunkLength.length, badChunkLength),
        ),
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('validates MP3 Layer III frame boundaries while seeking over frame payloads', async () => {
    const bytes = makeMp3(3);
    const reader = new MemoryMediaReader(bytes.length, bytes);
    reader.protectedRanges.push(
      { start: 4, end: 417 },
      { start: 421, end: 834 },
      { start: 838, end: 1251 },
    );
    await expect(validateGenerationMedia('audio/mpeg', reader)).resolves.toEqual({
      container: 'mp3',
      audioCodec: 'mp3',
      channels: 2,
      sampleRate: 44100,
      frameCount: 3,
      bitrateKbps: 128,
      durationSeconds: 0.078367,
    });
    expect(reader.protectedBytesRead).toBe(0);
    expect(reader.largestRequest).toBe(4);

    const truncated = bytes.subarray(0, bytes.length - 1);
    await expectDomainCode(
      () =>
        validateGenerationMedia('audio/mp3', new MemoryMediaReader(truncated.length, truncated)),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    const invalidHeader = Buffer.from(bytes);
    invalidHeader[2] = invalidHeader[2]! & 0x0f;
    await expectDomainCode(
      () =>
        validateGenerationMedia(
          'audio/mpeg',
          new MemoryMediaReader(invalidHeader.length, invalidHeader),
        ),
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('validates MP4 metadata while seeking over an mdat larger than 16 MiB', async () => {
    const fixture = makeMp4Fixture();
    const payloadStart = fixture.length - 6;
    const mdatHeaderStart = payloadStart - 8;
    const mdatPayloadBytes = 32 * 1024 * 1024;
    fixture.writeUInt32BE(mdatPayloadBytes + 8, mdatHeaderStart);
    const reader = new MemoryMediaReader(
      payloadStart + mdatPayloadBytes,
      fixture.subarray(0, payloadStart),
    );
    reader.protectedRanges.push({ start: payloadStart, end: reader.sizeBytes });

    await expect(validateGenerationMedia('video/mp4', reader)).resolves.toEqual({
      container: 'mp4',
      majorBrand: 'isom',
      width: 640,
      height: 360,
      durationSeconds: 1,
      videoCodec: 'avc1.64001f',
      sampleCount: 1,
      mdatBytes: mdatPayloadBytes,
    });
    expect(reader.sizeBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(reader.protectedBytesRead).toBe(0);
    expect(reader.largestRequest).toBeLessThanOrEqual(READER_LIMIT);
  });

  it('validates a B-frame edit against ctts presentation ranges without reading mdat samples', async () => {
    const fixture = makeMp4Fixture({
      compositionOffsets: [1000, 2000, 0],
      edit: { mediaTime: 1000, segmentDuration: 3000 },
    });
    const payloadStart = fixture.length - 3 * 6;
    const mdatHeaderStart = payloadStart - 8;
    const mdatPayloadBytes = 32 * 1024 * 1024;
    fixture.writeUInt32BE(mdatPayloadBytes + 8, mdatHeaderStart);
    const reader = new MemoryMediaReader(
      payloadStart + mdatPayloadBytes,
      fixture.subarray(0, payloadStart),
    );
    reader.protectedRanges.push({ start: payloadStart, end: reader.sizeBytes });

    await expect(validateGenerationMedia('video/mp4', reader)).resolves.toMatchObject({
      container: 'mp4',
      durationSeconds: 3,
      sampleCount: 3,
    });
    expect(reader.protectedBytesRead).toBe(0);
    expect(reader.largestRequest).toBeLessThanOrEqual(READER_LIMIT);
  });
});
