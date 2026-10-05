import { describe, expect, it } from 'vitest';
import { DomainError } from '@cultivation/shared';
import { validateMp4 } from './g1-mp4-validator.js';

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + header.length, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function fullBox(type: string, body: Buffer, flags = 0): Buffer {
  const header = Buffer.from([0, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]);
  return box(type, Buffer.concat([header, body]));
}

function identityMatrix(): Buffer {
  const matrix = Buffer.alloc(36);
  matrix.writeUInt32BE(0x00010000, 0);
  matrix.writeUInt32BE(0x00010000, 16);
  matrix.writeUInt32BE(0x40000000, 32);
  return matrix;
}

function makeFixture(options: { sample?: Buffer; emptyMdat?: boolean } = {}): Buffer {
  const sample = options.sample ?? Buffer.from([0, 0, 0, 2, 0x65, 0x88]);
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomiso2avc1mp41', 'latin1'));

  const mvhdBody = Buffer.alloc(96);
  mvhdBody.writeUInt32BE(1000, 8);
  mvhdBody.writeUInt32BE(1000, 12);
  mvhdBody.writeUInt32BE(0x00010000, 16);
  mvhdBody.writeUInt16BE(0x0100, 20);
  identityMatrix().copy(mvhdBody, 32);
  const mvhd = fullBox('mvhd', mvhdBody);

  const tkhdBody = Buffer.alloc(80);
  tkhdBody.writeUInt32BE(1, 8);
  tkhdBody.writeUInt32BE(1000, 16);
  identityMatrix().copy(tkhdBody, 36);
  tkhdBody.writeUInt32BE(640 * 65536, 72);
  tkhdBody.writeUInt32BE(360 * 65536, 76);
  const tkhd = fullBox('tkhd', tkhdBody, 7);

  const mdhdBody = Buffer.alloc(20);
  mdhdBody.writeUInt32BE(1000, 8);
  mdhdBody.writeUInt32BE(1000, 12);
  mdhdBody.writeUInt16BE(0x55c4, 16);
  const mdhd = fullBox('mdhd', mdhdBody);
  const hdlr = fullBox(
    'hdlr',
    Buffer.concat([Buffer.alloc(4), Buffer.from('vide'), Buffer.alloc(12)]),
  );
  const vmhd = fullBox('vmhd', Buffer.alloc(8), 1);
  const url = fullBox('url ', Buffer.alloc(0), 1);
  const dref = fullBox('dref', Buffer.concat([u32(1), url]));
  const dinf = box('dinf', dref);

  const avcConfig = box(
    'avcC',
    Buffer.from([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 2, 0x67, 0x64, 1, 0, 2, 0x68, 0xee]),
  );
  const visualEntry = Buffer.alloc(78);
  visualEntry.writeUInt16BE(1, 6);
  visualEntry.writeUInt16BE(640, 24);
  visualEntry.writeUInt16BE(360, 26);
  const avc1 = box('avc1', Buffer.concat([visualEntry, avcConfig]));
  const stsd = fullBox('stsd', Buffer.concat([u32(1), avc1]));
  const stts = fullBox('stts', Buffer.concat([u32(1), u32(1), u32(1000)]));
  const stsc = fullBox('stsc', Buffer.concat([u32(1), u32(1), u32(1), u32(1)]));
  const stsz = fullBox('stsz', Buffer.concat([u32(0), u32(1), u32(sample.length)]));
  const stss = fullBox('stss', Buffer.concat([u32(1), u32(1)]));

  const createMovie = (sampleOffset: number) => {
    const stco = fullBox('stco', Buffer.concat([u32(1), u32(sampleOffset)]));
    const stbl = box('stbl', Buffer.concat([stsd, stts, stsc, stsz, stco, stss]));
    const minf = box('minf', Buffer.concat([vmhd, dinf, stbl]));
    const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
    const trak = box('trak', Buffer.concat([tkhd, mdia]));
    return box('moov', Buffer.concat([mvhd, trak]));
  };

  const firstMoov = createMovie(0);
  const mdatHeaderSize = 8;
  const sampleOffset = ftyp.length + firstMoov.length + mdatHeaderSize;
  const moov = createMovie(sampleOffset);
  const mdatPayload = options.emptyMdat ? Buffer.alloc(0) : sample;
  return Buffer.concat([ftyp, moov, box('mdat', mdatPayload)]);
}

function expectDomainCode(action: () => unknown, expectedCode: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(expectedCode);
}

describe('G1 MP4 container metadata validator', () => {
  it('accepts a deterministic AVC fixture and reports bounded container metadata', () => {
    const metadata = validateMp4(makeFixture());
    expect(metadata).toEqual({
      container: 'mp4',
      majorBrand: 'isom',
      width: 640,
      height: 360,
      durationSeconds: 1,
      videoCodec: 'avc1.64001f',
      sampleCount: 1,
      mdatBytes: 6,
    });
  });

  it('rejects a file type header without movie tracks or media samples', () => {
    const headerOnly = box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1'));
    expectDomainCode(() => validateMp4(headerOnly), 'UNSUPPORTED_MEDIA_TYPE');
    expectDomainCode(() => validateMp4(makeFixture({ emptyMdat: true })), 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects truncated and out-of-parent boxes', () => {
    const valid = makeFixture();
    expectDomainCode(
      () => validateMp4(valid.subarray(0, valid.length - 1)),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    const badSize = Buffer.from(valid);
    badSize.writeUInt32BE(0xffffffff, 0);
    expectDomainCode(() => validateMp4(badSize), 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects sample tables whose media ranges exceed mdat or disagree internally', () => {
    const outOfRange = Buffer.from(makeFixture());
    const stcoType = outOfRange.indexOf(Buffer.from('stco'));
    expect(stcoType).toBeGreaterThan(0);
    outOfRange.writeUInt32BE(outOfRange.length + 20, stcoType + 12);
    expectDomainCode(() => validateMp4(outOfRange), 'UNSUPPORTED_MEDIA_TYPE');

    const badCount = Buffer.from(makeFixture());
    const stszType = badCount.indexOf(Buffer.from('stsz'));
    expect(stszType).toBeGreaterThan(0);
    badCount.writeUInt32BE(2, stszType + 12);
    expectDomainCode(() => validateMp4(badCount), 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects fragmented and unsupported sample-entry metadata', () => {
    const fragmented = Buffer.concat([makeFixture(), box('moof', Buffer.alloc(0))]);
    expectDomainCode(() => validateMp4(fragmented), 'UNSUPPORTED_MEDIA_TYPE');

    const unsupportedCodec = Buffer.from(makeFixture());
    const avcCType = unsupportedCodec.indexOf(Buffer.from('avcC'));
    expect(avcCType).toBeGreaterThan(0);
    unsupportedCodec.write('hvcC', avcCType, 'ascii');
    expectDomainCode(() => validateMp4(unsupportedCodec), 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('uses the dedicated size error before parsing oversized data', () => {
    expectDomainCode(() => validateMp4(Buffer.alloc(16 * 1024 * 1024 + 1)), 'INPUT_TOO_LARGE');
  });
});
