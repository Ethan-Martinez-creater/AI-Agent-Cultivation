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

function versionedFullBox(type: string, version: number, body: Buffer, flags = 0): Buffer {
  const header = Buffer.from([version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]);
  return box(type, Buffer.concat([header, body]));
}

function descriptor(tag: number, payload: Buffer): Buffer {
  if (payload.length >= 128) throw new Error('Fixture descriptor payload must fit one length byte');
  return Buffer.concat([Buffer.from([tag, payload.length]), payload]);
}

function identityMatrix(): Buffer {
  const matrix = Buffer.alloc(36);
  matrix.writeUInt32BE(0x00010000, 0);
  matrix.writeUInt32BE(0x00010000, 16);
  matrix.writeUInt32BE(0x40000000, 32);
  return matrix;
}

function makeFixture(
  options: {
    sample?: Buffer;
    emptyMdat?: boolean;
    editList?: {
      mediaTime?: number;
      rate?: number;
      segmentDuration?: number;
      emptyDuration?: number | null;
    };
    includeAacEditList?: boolean;
    aacSyncExtension?: boolean;
    aacRollGroup?: boolean;
    videoCompositionOffsets?: number[];
    avcExtension?: Buffer | null;
  } = {},
): Buffer {
  const sample = options.sample ?? Buffer.from([0, 0, 0, 2, 0x65, 0x88]);
  const sampleCount = options.videoCompositionOffsets?.length ?? 1;
  const decodeDuration = sampleCount * 1000;
  const mediaEditDuration = options.editList?.segmentDuration ?? 900;
  const emptyEditDuration = options.editList
    ? options.editList.emptyDuration === undefined
      ? 100
      : options.editList.emptyDuration
    : null;
  const trackDuration = options.editList
    ? mediaEditDuration + (emptyEditDuration ?? 0)
    : decodeDuration;
  const movieDuration = trackDuration;
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomiso2avc1mp41', 'latin1'));

  const mvhdBody = Buffer.alloc(96);
  mvhdBody.writeUInt32BE(1000, 8);
  mvhdBody.writeUInt32BE(movieDuration, 12);
  mvhdBody.writeUInt32BE(0x00010000, 16);
  mvhdBody.writeUInt16BE(0x0100, 20);
  identityMatrix().copy(mvhdBody, 32);
  const mvhd = fullBox('mvhd', mvhdBody);

  const tkhdBody = Buffer.alloc(80);
  tkhdBody.writeUInt32BE(1, 8);
  tkhdBody.writeUInt32BE(trackDuration, 16);
  identityMatrix().copy(tkhdBody, 36);
  tkhdBody.writeUInt32BE(640 * 65536, 72);
  tkhdBody.writeUInt32BE(360 * 65536, 76);
  const tkhd = fullBox('tkhd', tkhdBody, 7);
  let edts: Buffer | null = null;
  if (options.editList) {
    const entries: Buffer[] = [];
    if (emptyEditDuration !== null) {
      const empty = Buffer.alloc(12);
      empty.writeUInt32BE(emptyEditDuration, 0);
      empty.writeInt32BE(-1, 4);
      empty.writeInt16BE(1, 8);
      entries.push(empty);
    }
    const media = Buffer.alloc(12);
    media.writeUInt32BE(mediaEditDuration, 0);
    media.writeInt32BE(options.editList.mediaTime ?? 100, 4);
    media.writeInt16BE(options.editList.rate ?? 1, 8);
    entries.push(media);
    const elst = fullBox('elst', Buffer.concat([u32(entries.length), ...entries]));
    edts = box('edts', elst);
  }

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
  const dinf = box('dinf', dref);

  const avcExtension =
    options.avcExtension === undefined ? Buffer.from([0xfd, 0xf8, 0xf8, 0]) : options.avcExtension;
  const avcConfig = box(
    'avcC',
    Buffer.concat([
      Buffer.from([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 2, 0x67, 0x64, 1, 0, 2, 0x68, 0xee]),
      ...(avcExtension ? [avcExtension] : []),
    ]),
  );
  const visualEntry = Buffer.alloc(78);
  visualEntry.writeUInt16BE(1, 6);
  visualEntry.writeUInt16BE(640, 24);
  visualEntry.writeUInt16BE(360, 26);
  const avc1 = box('avc1', Buffer.concat([visualEntry, avcConfig]));
  const stsd = fullBox('stsd', Buffer.concat([u32(1), avc1]));
  const stts = fullBox('stts', Buffer.concat([u32(1), u32(sampleCount), u32(1000)]));
  const compositionOffsets = options.videoCompositionOffsets;
  let ctts: Buffer | null = null;
  if (compositionOffsets) {
    const runs: Array<{ count: number; offset: number }> = [];
    for (const offset of compositionOffsets) {
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

  const createAacTrack = (sampleOffset: number) => {
    const audioTkhdBody = Buffer.alloc(80);
    audioTkhdBody.writeUInt32BE(2, 8);
    const audioRate = options.aacSyncExtension ? 44100 : 48000;
    const audioChannels = 2;
    const audioEditDuration = options.aacSyncExtension ? 23 : 20;
    audioTkhdBody.writeUInt32BE(audioEditDuration, 16);
    identityMatrix().copy(audioTkhdBody, 36);
    const audioTkhd = fullBox('tkhd', audioTkhdBody, 7);
    const edit = Buffer.alloc(12);
    edit.writeUInt32BE(audioEditDuration, 0);
    edit.writeInt32BE(1024, 4);
    edit.writeInt16BE(1, 8);
    const audioEdts = box('edts', fullBox('elst', Buffer.concat([u32(1), edit])));

    const audioMdhdBody = Buffer.alloc(20);
    audioMdhdBody.writeUInt32BE(audioRate, 8);
    audioMdhdBody.writeUInt32BE(2048, 12);
    audioMdhdBody.writeUInt16BE(0x55c4, 16);
    const audioMdhd = fullBox('mdhd', audioMdhdBody);
    const audioHdlr = fullBox(
      'hdlr',
      Buffer.concat([Buffer.alloc(4), Buffer.from('soun'), Buffer.alloc(12)]),
    );
    const smhd = fullBox('smhd', Buffer.alloc(4));
    const decoderSpecific = descriptor(
      5,
      Buffer.from(options.aacSyncExtension ? [0x12, 0x10, 0x56, 0xe5, 0x00] : [0x11, 0x90]),
    );
    const decoderConfig = descriptor(
      4,
      Buffer.concat([Buffer.from([0x40, 0x15]), Buffer.alloc(11), decoderSpecific]),
    );
    const esDescriptor = descriptor(
      3,
      Buffer.concat([Buffer.alloc(2), Buffer.from([0]), decoderConfig]),
    );
    const esds = fullBox('esds', esDescriptor);
    const audioEntry = Buffer.alloc(28);
    audioEntry.writeUInt16BE(1, 6);
    audioEntry.writeUInt16BE(audioChannels, 16);
    audioEntry.writeUInt16BE(16, 18);
    audioEntry.writeUInt32BE(audioRate * 65536, 24);
    const mp4a = box('mp4a', Buffer.concat([audioEntry, esds]));
    const audioStsd = fullBox('stsd', Buffer.concat([u32(1), mp4a]));
    const audioStts = fullBox('stts', Buffer.concat([u32(1), u32(2), u32(1024)]));
    const audioStsc = fullBox('stsc', Buffer.concat([u32(1), u32(1), u32(2), u32(1)]));
    const audioStsz = fullBox('stsz', Buffer.concat([u32(0), u32(2), u32(1), u32(1)]));
    const audioStco = fullBox('stco', Buffer.concat([u32(1), u32(sampleOffset)]));
    const rollGroups = options.aacRollGroup
      ? [
          versionedFullBox(
            'sgpd',
            1,
            Buffer.concat([
              Buffer.from('roll', 'ascii'),
              u32(2),
              u32(1),
              Buffer.from([0xff, 0xff]),
            ]),
          ),
          fullBox('sbgp', Buffer.concat([Buffer.from('roll', 'ascii'), u32(1), u32(2), u32(1)])),
        ]
      : [];
    const audioStbl = box(
      'stbl',
      Buffer.concat([audioStsd, audioStts, audioStsc, audioStsz, audioStco, ...rollGroups]),
    );
    const audioUrl = fullBox('url ', Buffer.alloc(0), 1);
    const audioDref = fullBox('dref', Buffer.concat([u32(1), audioUrl]));
    const audioDinf = box('dinf', audioDref);
    const audioMinf = box('minf', Buffer.concat([smhd, audioDinf, audioStbl]));
    const audioMdia = box('mdia', Buffer.concat([audioMdhd, audioHdlr, audioMinf]));
    return box('trak', Buffer.concat([audioTkhd, audioEdts, audioMdia]));
  };

  const createMovie = (sampleOffset: number, audioSampleOffset: number) => {
    const stco = fullBox('stco', Buffer.concat([u32(1), u32(sampleOffset)]));
    const stbl = box(
      'stbl',
      Buffer.concat([stsd, stts, ...(ctts ? [ctts] : []), stsc, stsz, stco, stss]),
    );
    const minf = box('minf', Buffer.concat([vmhd, dinf, stbl]));
    const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
    const trak = box('trak', Buffer.concat([tkhd, ...(edts ? [edts] : []), mdia]));
    return box(
      'moov',
      Buffer.concat([
        mvhd,
        trak,
        ...(options.includeAacEditList ? [createAacTrack(audioSampleOffset)] : []),
      ]),
    );
  };

  const firstMoov = createMovie(0, 0);
  const mdatHeaderSize = 8;
  const sampleOffset = ftyp.length + firstMoov.length + mdatHeaderSize;
  const videoSamples = Buffer.concat(Array.from({ length: sampleCount }, () => sample));
  const audioSampleOffset = sampleOffset + videoSamples.length;
  const moov = createMovie(sampleOffset, audioSampleOffset);
  const audioSamples = options.includeAacEditList ? Buffer.from([0x01, 0x02]) : Buffer.alloc(0);
  const mdatPayload = options.emptyMdat
    ? Buffer.alloc(0)
    : Buffer.concat([videoSamples, audioSamples]);
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

  it('accepts bounded 4:2:0 8-bit AVC high-profile configuration fields', () => {
    expect(validateMp4(makeFixture())).toMatchObject({
      videoCodec: 'avc1.64001f',
      width: 640,
      height: 360,
    });
    expect(
      validateMp4(makeFixture({ avcExtension: Buffer.from([0xfd, 0xf8, 0xf8, 1, 0, 1, 0x0d]) })),
    ).toMatchObject({ videoCodec: 'avc1.64001f' });
  });

  it('rejects malformed or unsupported AVC high-profile extension fields', () => {
    for (const extension of [
      Buffer.from([0x3d, 0xf8, 0xf8, 0]), // reserved chroma bits
      Buffer.from([0xfe, 0xf8, 0xf8, 0]), // unsupported 4:2:2 chroma
      Buffer.from([0xfd, 0xf9, 0xf8, 0]), // unsupported 10-bit luma
      Buffer.from([0xfd, 0xf8, 0xf8, 1]), // missing SPS-extension length/data
      Buffer.from([0xfd, 0xf8, 0xf8, 1, 0, 1, 0x67]), // wrong SPS-extension NAL type
      Buffer.from([0xfd, 0xf8, 0xf8, 1, 0, 1, 0x8d]), // forbidden NAL header bit
      Buffer.from([0xfd, 0xf8, 0xf8, 0, 0]), // trailing unknown extension data
    ])
      expectDomainCode(
        () => validateMp4(makeFixture({ avcExtension: extension })),
        'UNSUPPORTED_MEDIA_TYPE',
      );

    expectDomainCode(
      () => validateMp4(makeFixture({ avcExtension: null })),
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('accepts a bounded standard empty edit followed by an in-range AVC media edit', () => {
    expect(validateMp4(makeFixture({ editList: {} }))).toMatchObject({
      container: 'mp4',
      durationSeconds: 1,
      videoCodec: 'avc1.64001f',
    });
  });

  it('accepts a bounded AAC priming edit alongside AVC video', () => {
    expect(validateMp4(makeFixture({ includeAacEditList: true }))).toMatchObject({
      container: 'mp4',
      audioTrackCount: 1,
      audioCodec: 'mp4a.40.2',
    });
  });

  it('accepts AAC-LC with the explicit absent-SBR sync extension and bounded roll metadata', () => {
    expect(
      validateMp4(
        makeFixture({
          includeAacEditList: true,
          aacSyncExtension: true,
          aacRollGroup: true,
        }),
      ),
    ).toMatchObject({
      audioTrackCount: 1,
      audioCodec: 'mp4a.40.2',
    });
  });

  it('accepts an edit that exactly covers reordered composition-time samples', () => {
    expect(
      validateMp4(
        makeFixture({
          videoCompositionOffsets: [1000, 2000, 0],
          editList: { mediaTime: 1000, segmentDuration: 3000, emptyDuration: null },
        }),
      ),
    ).toMatchObject({ durationSeconds: 3, sampleCount: 3 });
  });

  it('rejects composition timelines with a gap and edit ends beyond the final presentation sample', () => {
    expectDomainCode(
      () =>
        validateMp4(
          makeFixture({
            videoCompositionOffsets: [1000, 3000, 0],
            editList: { mediaTime: 1000, segmentDuration: 3000, emptyDuration: null },
          }),
        ),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expectDomainCode(
      () =>
        validateMp4(
          makeFixture({
            videoCompositionOffsets: [1000, 2000, 0],
            editList: { mediaTime: 1000, segmentDuration: 3001, emptyDuration: null },
          }),
        ),
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('rejects ctts runs whose sample total differs from the sample table', () => {
    const mismatched = Buffer.from(
      makeFixture({
        videoCompositionOffsets: [1000, 2000, 0],
        editList: { mediaTime: 1000, segmentDuration: 3000, emptyDuration: null },
      }),
    );
    const cttsType = mismatched.indexOf(Buffer.from('ctts'));
    expect(cttsType).toBeGreaterThan(0);
    mismatched.writeUInt32BE(2, cttsType + 12);
    expectDomainCode(() => validateMp4(mismatched), 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects unsupported AAC extension payloads and malformed roll-group bounds', () => {
    const sbrPresent = makeFixture({
      includeAacEditList: true,
      aacSyncExtension: true,
      aacRollGroup: true,
    });
    const badSbrFlag = Buffer.from(sbrPresent);
    const dsi = badSbrFlag.indexOf(Buffer.from([0x12, 0x10, 0x56, 0xe5, 0x00]));
    expect(dsi).toBeGreaterThan(0);
    badSbrFlag[dsi + 3] = 0xe5;
    badSbrFlag[dsi + 4] = 0x80;
    expectDomainCode(() => validateMp4(badSbrFlag), 'UNSUPPORTED_MEDIA_TYPE');

    const unknownSyncExtension = Buffer.from(sbrPresent);
    const syncDsi = unknownSyncExtension.indexOf(Buffer.from([0x12, 0x10, 0x56, 0xe5, 0x00]));
    expect(syncDsi).toBeGreaterThan(0);
    unknownSyncExtension[syncDsi + 2] = 0x54;
    expectDomainCode(() => validateMp4(unknownSyncExtension), 'UNSUPPORTED_MEDIA_TYPE');

    const badRollIndex = Buffer.from(sbrPresent);
    const sbgp = badRollIndex.indexOf(Buffer.from('sbgp'));
    expect(sbgp).toBeGreaterThan(0);
    badRollIndex.writeUInt32BE(2, sbgp + 20);
    expectDomainCode(() => validateMp4(badRollIndex), 'UNSUPPORTED_MEDIA_TYPE');

    const incompleteRollCoverage = Buffer.from(sbrPresent);
    const coverageSbgp = incompleteRollCoverage.indexOf(Buffer.from('sbgp'));
    expect(coverageSbgp).toBeGreaterThan(0);
    incompleteRollCoverage.writeUInt32BE(1, coverageSbgp + 16);
    expectDomainCode(() => validateMp4(incompleteRollCoverage), 'UNSUPPORTED_MEDIA_TYPE');

    const zeroRollDistance = Buffer.from(sbrPresent);
    const sgpd = zeroRollDistance.indexOf(Buffer.from('sgpd'));
    expect(sgpd).toBeGreaterThan(0);
    zeroRollDistance.writeInt16BE(0, sgpd + 20);
    expectDomainCode(() => validateMp4(zeroRollDistance), 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects edit lists with out-of-range media time or non-unit rate', () => {
    expectDomainCode(
      () => validateMp4(makeFixture({ editList: { mediaTime: 102 } })),
      'UNSUPPORTED_MEDIA_TYPE',
    );
    expectDomainCode(
      () => validateMp4(makeFixture({ editList: { rate: 2 } })),
      'UNSUPPORTED_MEDIA_TYPE',
    );
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
});
