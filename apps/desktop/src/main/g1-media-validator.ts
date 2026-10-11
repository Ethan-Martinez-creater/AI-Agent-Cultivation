import { GENERATION_MEDIA_POLICY } from '@cultivation/application/g1-media-policy';
import { DomainError } from '@cultivation/shared';
import { createInflate } from 'node:zlib';
import { validateMp4Parts } from './g1-mp4-validator.js';
import type { Mp4MediaRange } from './g1-mp4-validator.js';

const MAX_READER_REQUEST_BYTES = GENERATION_MEDIA_POLICY.ioChunkBytes;
const MAX_SOURCE_CHUNK_BYTES = GENERATION_MEDIA_POLICY.maxSourceChunkBytes;
const MAX_MOOV_BYTES = GENERATION_MEDIA_POLICY.maxMetadataBytes;
const MAX_PNG_DECODED_BYTES = GENERATION_MEDIA_POLICY.maxDecodedImageBytes;
const MAX_CONTAINER_RECORDS = GENERATION_MEDIA_POLICY.maxContainerRecords;
const MAX_MP3_TAG_BYTES = GENERATION_MEDIA_POLICY.maxMetadataBytes;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

/**
 * Bounded, seekable media input. `read` is capped at 64 KiB and yielded chunks at
 * the shared 1 MiB source-chunk limit. `chunks` must yield exactly the requested
 * range when a length is supplied.
 */
export interface GenerationMediaReader {
  sizeBytes: number;
  read(offset: number, length: number): Promise<Buffer>;
  chunks(offset?: number, length?: number): AsyncIterable<Uint8Array>;
}

type Metadata = Record<string, number | string | boolean | null>;
type MimeFamily = 'png' | 'jpeg' | 'webp' | 'wav' | 'mp3' | 'mp4';

function unsupported(message: string): never {
  throw new DomainError('UNSUPPORTED_MEDIA_TYPE', message);
}

function inputTooLarge(message: string): never {
  throw new DomainError('INPUT_TOO_LARGE', message);
}

function mediaSize(reader: GenerationMediaReader): number {
  if (
    !reader ||
    !Number.isSafeInteger(reader.sizeBytes) ||
    reader.sizeBytes < 0 ||
    typeof reader.read !== 'function' ||
    typeof reader.chunks !== 'function'
  )
    unsupported('Media reader metadata is invalid');
  return reader.sizeBytes;
}

function assertRange(total: number, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > total ||
    length > total - offset
  )
    unsupported('Media container range exceeds the file');
}

async function readRange(
  reader: GenerationMediaReader,
  offset: number,
  length: number,
): Promise<Buffer> {
  assertRange(reader.sizeBytes, offset, length);
  if (length > MAX_READER_REQUEST_BYTES)
    throw new Error('Internal media validator attempted an oversized read');
  const bytes = await reader.read(offset, length);
  if (!Buffer.isBuffer(bytes) || bytes.length !== length)
    unsupported('Media reader returned a truncated range');
  return bytes;
}

async function* rangeChunks(
  reader: GenerationMediaReader,
  offset: number,
  length: number,
): AsyncGenerator<Buffer> {
  assertRange(reader.sizeBytes, offset, length);
  let received = 0;
  for await (const value of reader.chunks(offset, length)) {
    if (!(value instanceof Uint8Array) || value.byteLength === 0)
      unsupported('Media reader returned an invalid chunk');
    if (value.byteLength > MAX_SOURCE_CHUNK_BYTES)
      unsupported('Media reader returned a chunk above the source-chunk limit');
    if (value.byteLength > length - received)
      unsupported('Media reader returned more bytes than requested');
    received += value.byteLength;
    yield Buffer.from(value);
  }
  if (received !== length) unsupported('Media reader returned a truncated range');
}

async function collectRange(
  reader: GenerationMediaReader,
  offset: number,
  length: number,
): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for await (const piece of rangeChunks(reader, offset, length)) pieces.push(piece);
  return Buffer.concat(pieces, length);
}

function crcUpdate(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
}

function waitForDrain(stream: ReturnType<typeof createInflate>): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onError);
      stream.off('close', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('PNG inflater closed before draining'));
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

class PngInflater {
  private readonly stream = createInflate({ chunkSize: MAX_READER_REQUEST_BYTES });
  private readonly output: Promise<void>;
  private outputError: unknown;
  private outputBytes = 0;

  constructor(
    private readonly expectedBytes: number,
    private readonly rowBytes: number,
  ) {
    this.output = this.consume().catch((error: unknown) => {
      this.outputError = error;
      if (!this.stream.destroyed) this.stream.destroy();
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.outputError) this.throwOutputError();
    try {
      if (!this.stream.write(bytes)) await waitForDrain(this.stream);
    } catch {
      this.throwOutputError();
      unsupported('PNG compressed pixel data is invalid');
    }
    if (this.outputError) this.throwOutputError();
  }

  async finish(): Promise<void> {
    if (this.outputError) this.throwOutputError();
    this.stream.end();
    await this.output;
    if (this.outputError) this.throwOutputError();
    if (this.outputBytes !== this.expectedBytes) unsupported('PNG pixel data length is invalid');
  }

  destroy(): void {
    if (!this.stream.destroyed) this.stream.destroy();
  }

  private async consume(): Promise<void> {
    for await (const value of this.stream) {
      const bytes = value as Buffer;
      if (bytes.length > this.expectedBytes - this.outputBytes)
        unsupported('PNG decoded pixel data exceeds its declared dimensions');
      for (let index = 0; index < bytes.length; index++) {
        if ((this.outputBytes + index) % this.rowBytes === 0 && bytes[index]! > 4)
          unsupported('PNG row filter is invalid');
      }
      this.outputBytes += bytes.length;
    }
  }

  private throwOutputError(): never {
    if (this.outputError instanceof DomainError) throw this.outputError;
    unsupported('PNG compressed pixel data is invalid');
  }
}

async function validatePng(reader: GenerationMediaReader): Promise<Metadata> {
  const size = reader.sizeBytes;
  if (size < PNG_SIGNATURE.length) unsupported('PNG file header is invalid');
  const signature = await readRange(reader, 0, PNG_SIGNATURE.length);
  if (!signature.equals(PNG_SIGNATURE)) unsupported('PNG file header is invalid');

  let cursor = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let channels = 0;
  let expectedDecodedBytes = 0;
  let recordCount = 0;
  let sawHeader = false;
  let sawData = false;
  let dataClosed = false;
  let sawEnd = false;
  let inflater: PngInflater | null = null;

  try {
    while (cursor < size) {
      recordCount++;
      if (recordCount > MAX_CONTAINER_RECORDS) unsupported('PNG contains too many chunks');
      if (size - cursor < 12) unsupported('PNG chunk is truncated');
      const header = await readRange(reader, cursor, 8);
      const length = header.readUInt32BE(0);
      const typeBytes = header.subarray(4, 8);
      const type = typeBytes.toString('ascii');
      if (!/^[A-Za-z]{4}$/u.test(type)) unsupported('PNG chunk type is invalid');
      const dataStart = cursor + 8;
      const dataEnd = dataStart + length;
      const chunkEnd = dataEnd + 4;
      assertRange(size, dataStart, length + 4);

      let crc = crcUpdate(0xffffffff, typeBytes);
      if (!sawHeader) {
        if (cursor !== PNG_SIGNATURE.length || type !== 'IHDR' || length !== 13)
          unsupported('PNG IHDR is invalid');
        const ihdr = await readRange(reader, dataStart, 13);
        crc = crcUpdate(crc, ihdr);
        width = ihdr.readUInt32BE(0);
        height = ihdr.readUInt32BE(4);
        const bitDepth = ihdr[8]!;
        const colorType = ihdr[9]!;
        channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType] ?? 0;
        if (
          !width ||
          !height ||
          width > 32768 ||
          height > 32768 ||
          width * height > 268_435_456 ||
          bitDepth !== 8 ||
          !channels ||
          ihdr[10] !== 0 ||
          ihdr[11] !== 0 ||
          ihdr[12] !== 0
        )
          unsupported('PNG pixel format or dimensions are unsupported');
        const rowBytes = width * channels + 1;
        expectedDecodedBytes = height * rowBytes;
        if (expectedDecodedBytes > MAX_PNG_DECODED_BYTES)
          inputTooLarge('PNG decoded pixels exceed the validation limit');
        sawHeader = true;
      } else if (type === 'IHDR') {
        unsupported('PNG contains a repeated IHDR');
      }

      if (type === 'IDAT') {
        if (dataClosed) unsupported('PNG IDAT chunks are not contiguous');
        sawData = true;
        inflater ??= new PngInflater(expectedDecodedBytes, width * channels + 1);
        for await (const piece of rangeChunks(reader, dataStart, length)) {
          crc = crcUpdate(crc, piece);
          await inflater.write(piece);
        }
      } else {
        if (sawData) dataClosed = true;
        if (type === 'IHDR') {
          // IHDR was read above, so its bytes are already included in the checksum.
        } else {
          for await (const piece of rangeChunks(reader, dataStart, length))
            crc = crcUpdate(crc, piece);
        }
      }

      const expectedCrc = (await readRange(reader, dataEnd, 4)).readUInt32BE(0);
      if ((crc ^ 0xffffffff) >>> 0 !== expectedCrc) unsupported('PNG chunk checksum is invalid');
      cursor = chunkEnd;
      if (type === 'IEND') {
        if (length !== 0 || cursor !== size) unsupported('PNG IEND is invalid');
        sawEnd = true;
        break;
      }
    }

    if (!sawHeader || !sawData || !sawEnd || !inflater) unsupported('PNG structure is incomplete');
    await inflater.finish();
    return { container: 'png', width, height };
  } catch (error) {
    inflater?.destroy();
    throw error;
  }
}

async function validateWav(reader: GenerationMediaReader): Promise<Metadata> {
  const size = reader.sizeBytes;
  if (size < 12) unsupported('WAV file header is invalid');
  const riff = await readRange(reader, 0, 12);
  if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE')
    unsupported('WAV file header is invalid');
  const riffEnd = riff.readUInt32LE(4) + 8;
  if (riffEnd > size || riffEnd < 12) unsupported('WAV length is invalid');

  let cursor = 12;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  let blockAlign = 0;
  let sawFormat = false;
  let sawData = false;
  let recordCount = 0;
  while (cursor < riffEnd) {
    recordCount++;
    if (recordCount > MAX_CONTAINER_RECORDS) unsupported('WAV contains too many chunks');
    if (riffEnd - cursor < 8) unsupported('WAV chunk header is truncated');
    const header = await readRange(reader, cursor, 8);
    const name = header.toString('ascii', 0, 4);
    const chunkSize = header.readUInt32LE(4);
    const dataStart = cursor + 8;
    if (chunkSize > riffEnd - dataStart) unsupported('WAV chunk length is invalid');
    const paddedSize = chunkSize + (chunkSize & 1);
    if (paddedSize > riffEnd - dataStart) unsupported('WAV chunk padding is truncated');

    if (name === 'fmt ') {
      if (sawFormat || chunkSize < 16) unsupported('WAV fmt chunk is invalid');
      sawFormat = true;
      const fmt = await readRange(reader, dataStart, 16);
      const audioFormat = fmt.readUInt16LE(0);
      channels = fmt.readUInt16LE(2);
      sampleRate = fmt.readUInt32LE(4);
      byteRate = fmt.readUInt32LE(8);
      blockAlign = fmt.readUInt16LE(12);
      bitsPerSample = fmt.readUInt16LE(14);
      if (
        ![1, 3].includes(audioFormat) ||
        !channels ||
        !sampleRate ||
        !byteRate ||
        !blockAlign ||
        !bitsPerSample
      )
        unsupported('WAV audio format is invalid');
      if (
        ![8, 16, 24, 32].includes(bitsPerSample) ||
        (audioFormat === 3 && bitsPerSample !== 32) ||
        blockAlign !== (channels * bitsPerSample) / 8 ||
        byteRate !== sampleRate * blockAlign
      )
        unsupported('WAV audio metadata is inconsistent');
    } else if (name === 'data') {
      if (sawData) unsupported('WAV repeated data chunks are unsupported');
      sawData = true;
      dataBytes = chunkSize;
    }
    cursor = dataStart + paddedSize;
  }

  if (
    !channels ||
    !sampleRate ||
    !byteRate ||
    !bitsPerSample ||
    !dataBytes ||
    dataBytes % blockAlign !== 0 ||
    riffEnd !== size
  )
    unsupported('WAV trusted audio metadata is missing');
  return {
    container: 'wav',
    channels,
    sampleRate,
    bitsPerSample,
    durationSeconds: Number((dataBytes / byteRate).toFixed(6)),
  };
}

type JpegMarker = { marker: number; nextOffset: number };

async function readJpegMarker(reader: GenerationMediaReader, offset: number): Promise<JpegMarker> {
  if (offset >= reader.sizeBytes) unsupported('JPEG marker is missing');
  const bytes = await readRange(reader, offset, Math.min(64, reader.sizeBytes - offset));
  if (bytes[0] !== 0xff) unsupported('JPEG marker prefix is invalid');
  let index = 1;
  while (index < bytes.length && bytes[index] === 0xff) index++;
  if (index >= bytes.length) {
    // Marker fill bytes can span a reader boundary; continue with bounded requests.
    let cursor = offset + index;
    while (cursor < reader.sizeBytes) {
      const fill = await readRange(reader, cursor, Math.min(64, reader.sizeBytes - cursor));
      let next = 0;
      while (next < fill.length && fill[next] === 0xff) next++;
      if (next < fill.length) return { marker: fill[next]!, nextOffset: cursor + next + 1 };
      cursor += fill.length;
    }
    unsupported('JPEG marker is truncated');
  }
  return { marker: bytes[index]!, nextOffset: offset + index + 1 };
}

async function nextJpegEntropyMarker(
  reader: GenerationMediaReader,
  offset: number,
): Promise<JpegMarker> {
  let cursor = offset;
  let sawPrefix = false;
  for await (const chunk of rangeChunks(reader, offset, reader.sizeBytes - offset)) {
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index]!;
      if (!sawPrefix) {
        if (byte === 0xff) sawPrefix = true;
        continue;
      }
      if (byte === 0xff) continue;
      sawPrefix = false;
      if (byte === 0x00 || (byte >= 0xd0 && byte <= 0xd7)) continue;
      return { marker: byte, nextOffset: cursor + index + 1 };
    }
    cursor += chunk.length;
  }
  unsupported('JPEG entropy-coded data has no terminating marker');
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

async function validateJpeg(reader: GenerationMediaReader): Promise<Metadata> {
  const size = reader.sizeBytes;
  if (size < 4) unsupported('JPEG file is too short');
  if (!(await readRange(reader, 0, 2)).equals(Buffer.from([0xff, 0xd8])))
    unsupported('JPEG start marker is invalid');
  let cursor = 2;
  let markerCount = 0;
  let width = 0;
  let height = 0;
  let components = 0;
  const frameComponentIds = new Set<number>();
  let progressive = false;
  let sawFrame = false;
  let sawScan = false;
  let entropyMarker: number | null = null;
  let ended = false;

  while (cursor < size || entropyMarker !== null) {
    markerCount++;
    if (markerCount > MAX_CONTAINER_RECORDS) unsupported('JPEG contains too many markers');
    let marker: number;
    if (entropyMarker !== null) {
      marker = entropyMarker;
      entropyMarker = null;
    } else {
      const parsed = await readJpegMarker(reader, cursor);
      marker = parsed.marker;
      cursor = parsed.nextOffset;
    }
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || cursor !== size)
        unsupported('JPEG end marker or image structure is invalid');
      ended = true;
      break;
    }
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01)
      unsupported('JPEG standalone marker is misplaced');
    if (isJpegStartOfFrame(marker) && marker !== 0xc0 && marker !== 0xc2)
      unsupported('JPEG frame coding mode is unsupported');

    const lengthBytes = await readRange(reader, cursor, 2);
    const segmentLength = lengthBytes.readUInt16BE(0);
    if (segmentLength < 2) unsupported('JPEG segment length is invalid');
    const payloadOffset = cursor + 2;
    const payloadLength = segmentLength - 2;
    assertRange(size, payloadOffset, payloadLength);
    const segmentEnd = payloadOffset + payloadLength;

    if (marker === 0xc0 || marker === 0xc2) {
      if (sawFrame || payloadLength < 6) unsupported('JPEG frame header is invalid');
      const header = await readRange(reader, payloadOffset, payloadLength);
      const precision = header[0]!;
      height = header.readUInt16BE(1);
      width = header.readUInt16BE(3);
      components = header[5]!;
      if (
        precision !== 8 ||
        !width ||
        !height ||
        width > 32768 ||
        height > 32768 ||
        width * height > 268_435_456 ||
        ![1, 3].includes(components) ||
        payloadLength !== 6 + components * 3
      )
        unsupported('JPEG dimensions or frame components are unsupported');
      for (let index = 0; index < components; index++) {
        const at = 6 + index * 3;
        const identifier = header[at]!;
        const sampling = header[at + 1]!;
        if (
          frameComponentIds.has(identifier) ||
          sampling >> 4 < 1 ||
          sampling >> 4 > 4 ||
          (sampling & 0x0f) < 1 ||
          (sampling & 0x0f) > 4 ||
          header[at + 2]! > 3
        )
          unsupported('JPEG frame component metadata is invalid');
        frameComponentIds.add(identifier);
      }
      sawFrame = true;
      progressive = marker === 0xc2;
    } else if (marker === 0xda) {
      if (!sawFrame || payloadLength < 4) unsupported('JPEG scan header is invalid');
      const header = await readRange(reader, payloadOffset, payloadLength);
      const scanComponents = header[0]!;
      if (
        !scanComponents ||
        scanComponents > components ||
        payloadLength !== 4 + scanComponents * 2
      )
        unsupported('JPEG scan component count is invalid');
      const identifiers = new Set<number>();
      for (let index = 0; index < scanComponents; index++) {
        const at = 1 + index * 2;
        const identifier = header[at]!;
        const tables = header[at + 1]!;
        if (
          identifiers.has(identifier) ||
          !frameComponentIds.has(identifier) ||
          tables >> 4 > 3 ||
          (tables & 0x0f) > 3
        )
          unsupported('JPEG scan component metadata is invalid');
        identifiers.add(identifier);
      }
      const spectralStart = header[payloadLength - 3]!;
      const spectralEnd = header[payloadLength - 2]!;
      const approximation = header[payloadLength - 1]!;
      if (
        spectralStart > spectralEnd ||
        spectralEnd > 63 ||
        approximation >> 4 > 13 ||
        (approximation & 0x0f) > 13 ||
        (!progressive && (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0))
      )
        unsupported('JPEG scan spectral selection is invalid');
      sawScan = true;
      cursor = segmentEnd;
      const next = await nextJpegEntropyMarker(reader, cursor);
      cursor = next.nextOffset;
      entropyMarker = next.marker;
      continue;
    } else if (marker === 0xdd && payloadLength !== 2) {
      unsupported('JPEG restart interval is malformed');
    }

    cursor = segmentEnd;
  }

  if (!ended) unsupported('JPEG image is incomplete');
  return { container: 'jpeg', width, height };
}

async function validateWebp(reader: GenerationMediaReader): Promise<Metadata> {
  const size = reader.sizeBytes;
  if (size < 20) unsupported('WebP file is too short');
  const riff = await readRange(reader, 0, 12);
  if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WEBP')
    unsupported('WebP RIFF header is invalid');
  const riffEnd = riff.readUInt32LE(4) + 8;
  if (riffEnd !== size) unsupported('WebP RIFF length disagrees with the file');

  let cursor = 12;
  let chunkCount = 0;
  let sawExtended = false;
  let extendedFlags = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let imageWidth = 0;
  let imageHeight = 0;
  let sawLossy = false;
  let sawLossless = false;
  let sawAlphaChunk = false;
  let sawIcc = false;
  let sawExif = false;
  let sawXmp = false;
  let losslessHasAlpha = false;

  while (cursor < riffEnd) {
    chunkCount++;
    if (chunkCount > MAX_CONTAINER_RECORDS) unsupported('WebP contains too many chunks');
    if (riffEnd - cursor < 8) unsupported('WebP chunk header is truncated');
    const chunkHeader = await readRange(reader, cursor, 8);
    const type = chunkHeader.toString('ascii', 0, 4);
    const chunkBytes = chunkHeader.readUInt32LE(4);
    const dataStart = cursor + 8;
    const paddedBytes = chunkBytes + (chunkBytes & 1);
    if (!chunkBytes || paddedBytes > riffEnd - dataStart)
      unsupported('WebP chunk length exceeds the RIFF boundary');
    const chunkEnd = dataStart + paddedBytes;
    if (paddedBytes !== chunkBytes && (await readRange(reader, dataStart + chunkBytes, 1))[0] !== 0)
      unsupported('WebP chunk padding is invalid');

    if (type === 'VP8X') {
      if (sawExtended || chunkCount !== 1 || chunkBytes !== 10)
        unsupported('WebP extended header is misplaced or malformed');
      const header = await readRange(reader, dataStart, 10);
      extendedFlags = header[0]!;
      if (
        (extendedFlags & 0xc1) !== 0 ||
        header[1] !== 0 ||
        header[2] !== 0 ||
        header[3] !== 0 ||
        (extendedFlags & 0x02) !== 0
      )
        unsupported('Animated or malformed extended WebP is unsupported');
      canvasWidth = 1 + header.readUIntLE(4, 3);
      canvasHeight = 1 + header.readUIntLE(7, 3);
      sawExtended = true;
    } else if (type === 'VP8 ') {
      if (sawLossy || sawLossless || chunkBytes < 10)
        unsupported('WebP contains a repeated or truncated image bitstream');
      const header = await readRange(reader, dataStart, 10);
      const frameTag = header.readUIntLE(0, 3);
      const frameVersion = (frameTag >>> 1) & 7;
      const firstPartitionBytes = frameTag >>> 5;
      if (
        (frameTag & 1) !== 0 ||
        frameVersion > 3 ||
        (frameTag & 0x10) === 0 ||
        !firstPartitionBytes ||
        firstPartitionBytes > chunkBytes - 10 ||
        header[3] !== 0x9d ||
        header[4] !== 0x01 ||
        header[5] !== 0x2a
      )
        unsupported('WebP lossy frame header is invalid');
      const widthField = header.readUInt16LE(6);
      const heightField = header.readUInt16LE(8);
      if ((widthField & 0xc000) !== 0 || (heightField & 0xc000) !== 0)
        unsupported('WebP lossy scaling is unsupported');
      imageWidth = widthField & 0x3fff;
      imageHeight = heightField & 0x3fff;
      sawLossy = true;
    } else if (type === 'VP8L') {
      if (sawLossy || sawLossless || chunkBytes < 5)
        unsupported('WebP contains a repeated or truncated lossless bitstream');
      const header = await readRange(reader, dataStart, 5);
      if (header[0] !== 0x2f) unsupported('WebP lossless signature is invalid');
      const dimensions = header.readUInt32LE(1);
      if (dimensions >>> 29 !== 0) unsupported('WebP lossless version is unsupported');
      imageWidth = (dimensions & 0x3fff) + 1;
      imageHeight = ((dimensions >>> 14) & 0x3fff) + 1;
      losslessHasAlpha = ((dimensions >>> 28) & 1) !== 0;
      sawLossless = true;
    } else if (type === 'ALPH') {
      if (!sawExtended || sawAlphaChunk || sawLossy || sawLossless || chunkBytes < 1)
        unsupported('WebP alpha chunk is misplaced or malformed');
      const alphaHeader = await readRange(reader, dataStart, 1);
      if ((alphaHeader[0]! & 0xc0) !== 0) unsupported('WebP alpha reserved bits are invalid');
      sawAlphaChunk = true;
    } else if (type === 'ICCP' || type === 'EXIF' || type === 'XMP ') {
      if (!sawExtended) unsupported('WebP metadata requires an extended header');
      if (
        (type === 'ICCP' && (sawIcc || sawLossy || sawLossless)) ||
        (type === 'EXIF' && sawExif) ||
        (type === 'XMP ' && sawXmp)
      )
        unsupported('WebP metadata chunk is repeated or misplaced');
      if (type === 'ICCP') sawIcc = true;
      else if (type === 'EXIF') sawExif = true;
      else sawXmp = true;
    } else {
      unsupported(`WebP ${type} chunk is unsupported`);
    }
    cursor = chunkEnd;
  }

  const alphaPresent = sawAlphaChunk || losslessHasAlpha;
  if (
    cursor !== riffEnd ||
    (!sawLossy && !sawLossless) ||
    !imageWidth ||
    !imageHeight ||
    imageWidth > 32768 ||
    imageHeight > 32768 ||
    imageWidth * imageHeight > 268_435_456 ||
    (sawExtended &&
      (canvasWidth !== imageWidth ||
        canvasHeight !== imageHeight ||
        Boolean(extendedFlags & 0x20) !== sawIcc ||
        Boolean(extendedFlags & 0x08) !== sawExif ||
        Boolean(extendedFlags & 0x04) !== sawXmp ||
        Boolean(extendedFlags & 0x10) !== alphaPresent)) ||
    (!sawExtended && sawAlphaChunk) ||
    (sawAlphaChunk && !sawLossy)
  )
    unsupported('WebP image dimensions or chunk structure is invalid');
  return { container: 'webp', width: imageWidth, height: imageHeight };
}

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function parseMp3FrameHeader(header: number): {
  version: number;
  sampleRate: number;
  channels: number;
  samplesPerFrame: number;
  frameBytes: number;
  bitrateKbps: number;
} {
  const version = (header >>> 19) & 3;
  const layer = (header >>> 17) & 3;
  const bitrateIndex = (header >>> 12) & 15;
  const sampleRateIndex = (header >>> 10) & 3;
  const padding = (header >>> 9) & 1;
  const emphasis = header & 3;
  if (
    header >>> 21 !== 0x7ff ||
    version === 1 ||
    layer !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3 ||
    emphasis === 2
  )
    unsupported('MP3 frame header is unsupported');
  const baseRate = [44100, 48000, 32000][sampleRateIndex]!;
  const sampleRate = version === 3 ? baseRate : version === 2 ? baseRate / 2 : baseRate / 4;
  const bitrateKbps = (version === 3 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)[
    bitrateIndex
  ]!;
  const samplesPerFrame = version === 3 ? 1152 : 576;
  const frameBytes =
    Math.floor(((version === 3 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding;
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 24)
    unsupported('MP3 frame length is invalid');
  return {
    version,
    sampleRate,
    channels: ((header >>> 6) & 3) === 3 ? 1 : 2,
    samplesPerFrame,
    frameBytes,
    bitrateKbps,
  };
}

async function validateMp3(reader: GenerationMediaReader): Promise<Metadata> {
  const size = reader.sizeBytes;
  let cursor = 0;
  if (size >= 10 && (await readRange(reader, 0, 3)).toString('ascii') === 'ID3') {
    const id3 = await readRange(reader, 0, 10);
    const major = id3[3]!;
    const flags = id3[5]!;
    if (
      ![2, 3, 4].includes(major) ||
      id3[4] === 0xff ||
      (id3[6]! | id3[7]! | id3[8]! | id3[9]!) & 0x80 ||
      (major === 2
        ? (flags & ~0xc0) !== 0
        : major === 3
          ? (flags & ~0xe0) !== 0
          : (flags & ~0xf0) !== 0)
    )
      unsupported('MP3 ID3 header is malformed');
    const tagBytes = (id3[6]! << 21) | (id3[7]! << 14) | (id3[8]! << 7) | id3[9]!;
    if (tagBytes > MAX_MP3_TAG_BYTES)
      inputTooLarge('MP3 ID3 metadata exceeds its validation limit');
    const footerBytes = major === 4 && (flags & 0x10) !== 0 ? 10 : 0;
    cursor = 10 + tagBytes + footerBytes;
    assertRange(size, 0, cursor);
  }

  let frames = 0;
  let sampleRate = 0;
  let channels = 0;
  let samplesPerFrame = 0;
  let version = -1;
  let bitrateTotal = 0;
  while (cursor < size) {
    if (size - cursor === 128 && (await readRange(reader, cursor, 3)).toString('ascii') === 'TAG') {
      cursor = size;
      break;
    }
    if (size - cursor < 4) unsupported('MP3 audio frame is truncated');
    const frameHeader = await readRange(reader, cursor, 4);
    const parsed = parseMp3FrameHeader(frameHeader.readUInt32BE(0));
    if (
      (version !== -1 && version !== parsed.version) ||
      (sampleRate !== 0 && sampleRate !== parsed.sampleRate) ||
      (channels !== 0 && channels !== parsed.channels)
    )
      unsupported('MP3 frame stream changes MPEG version, sample rate, or channel count');
    version = parsed.version;
    sampleRate = parsed.sampleRate;
    channels = parsed.channels;
    samplesPerFrame = parsed.samplesPerFrame;
    assertRange(size, cursor, parsed.frameBytes);
    cursor += parsed.frameBytes;
    frames++;
    if (frames > MAX_CONTAINER_RECORDS) unsupported('MP3 contains too many frames');
    bitrateTotal += parsed.bitrateKbps;
  }
  if (!frames || cursor !== size) unsupported('MP3 frame stream is empty or incomplete');
  const durationSeconds = (frames * samplesPerFrame) / sampleRate;
  return {
    container: 'mp3',
    audioCodec: 'mp3',
    channels,
    sampleRate,
    frameCount: frames,
    bitrateKbps: Number((bitrateTotal / frames).toFixed(3)),
    durationSeconds: Number(durationSeconds.toFixed(6)),
  };
}

async function validateMp4(reader: GenerationMediaReader): Promise<Metadata> {
  const fileLength = reader.sizeBytes;
  if (fileLength < 32) unsupported('MP4 file is too short');
  let cursor = 0;
  let topLevelCount = 0;
  let ftyp: Buffer | null = null;
  let moov: Buffer | null = null;
  const mdats: Mp4MediaRange[] = [];

  while (cursor < fileLength) {
    if (fileLength - cursor < 8) unsupported('MP4 top-level box header is truncated');
    const shortHeader = await readRange(reader, cursor, 8);
    const shortSize = shortHeader.readUInt32BE(0);
    const type = shortHeader.toString('latin1', 4, 8);
    if (!/^[\x20-\x7e]{4}$/u.test(type)) unsupported('MP4 box type is invalid');
    if (type === 'uuid') unsupported('MP4 uuid boxes are unsupported');
    if (!['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(type))
      unsupported(`MP4 ${type} box is unsupported`);

    let headerSize = 8;
    let boxSize: number;
    if (shortSize === 1) {
      if (fileLength - cursor < 16) unsupported('MP4 extended box header is truncated');
      const longHeader = await readRange(reader, cursor + 8, 8);
      const longSize = longHeader.readBigUInt64BE(0);
      if (longSize > BigInt(Number.MAX_SAFE_INTEGER))
        unsupported('MP4 box length exceeds the safe range');
      boxSize = Number(longSize);
      headerSize = 16;
    } else if (shortSize === 0) {
      unsupported('MP4 boxes with an implicit end are unsupported');
    } else {
      boxSize = shortSize;
    }
    if (boxSize < headerSize || boxSize > fileLength - cursor)
      unsupported('MP4 box exceeds the file boundary');
    topLevelCount++;
    if (topLevelCount > MAX_CONTAINER_RECORDS) unsupported('MP4 contains too many top-level boxes');

    const end = cursor + boxSize;
    if (type === 'ftyp') {
      if (ftyp || cursor !== 0) unsupported('MP4 ftyp must be the first top-level box');
      if (boxSize > MAX_READER_REQUEST_BYTES)
        inputTooLarge('MP4 ftyp metadata exceeds its validation limit');
      ftyp = await collectRange(reader, cursor, boxSize);
    } else if (type === 'moov') {
      if (moov) unsupported('MP4 contains a repeated moov box');
      if (boxSize > MAX_MOOV_BYTES)
        inputTooLarge('MP4 movie metadata exceeds the 8 MiB validation limit');
      moov = await collectRange(reader, cursor, boxSize);
    } else if (type === 'mdat') {
      const payloadStart = cursor + headerSize;
      if (payloadStart < end) mdats.push({ start: payloadStart, end });
    }
    cursor = end;
  }

  if (!ftyp || !moov) unsupported('MP4 ftyp or moov box is missing');
  return validateMp4Parts(ftyp, moov, mdats, fileLength);
}

function familyForMime(mime: string): MimeFamily {
  switch (mime.trim().toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpeg';
    case 'image/webp':
      return 'webp';
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
      return 'wav';
    case 'video/mp4':
      return 'mp4';
    case 'audio/mpeg':
    case 'audio/mp3':
    case 'audio/x-mp3':
      return 'mp3';
    default:
      unsupported('Generated output MIME type is unsupported');
  }
}

/** Validate container metadata without buffering the complete generated media file. */
export async function validateGenerationMedia(
  mime: string,
  reader: GenerationMediaReader,
): Promise<Metadata> {
  mediaSize(reader);
  switch (familyForMime(mime)) {
    case 'png':
      return validatePng(reader);
    case 'jpeg':
      return validateJpeg(reader);
    case 'webp':
      return validateWebp(reader);
    case 'wav':
      return validateWav(reader);
    case 'mp3':
      return validateMp3(reader);
    case 'mp4':
      return validateMp4(reader);
  }
}
