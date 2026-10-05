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
type MimeFamily = 'png' | 'wav' | 'mp4';

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
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
      return 'wav';
    case 'video/mp4':
      return 'mp4';
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
    case 'wav':
      return validateWav(reader);
    case 'mp4':
      return validateMp4(reader);
  }
}
