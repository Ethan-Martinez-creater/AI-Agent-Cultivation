// Read-only publication checks. This does not launch the app, call a provider,
// mutate evidence, or authorize another crash/recovery experiment.
import assert from 'node:assert/strict';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const root = 'docs/evidence/v1-engineering-validation';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const manifest = json(`${root}/publication/publication-manifest.json`);
const byOriginal = new Map(manifest.entries.map((entry) => [entry.path, entry]));
let localOriginalsVerified = 0;
for (const entry of manifest.entries) {
  const bytes = readFileSync(entry.publicPath);
  assert.equal(hash(bytes), entry.publicSha256, entry.publicPath);
  assert.equal(bytes.length, entry.publicBytes, entry.publicPath);
  if (existsSync(entry.path)) {
    assert.equal(hash(readFileSync(entry.path)), entry.sha256, entry.path);
    localOriginalsVerified += 1;
  }
}
const historical = [
  `${root}/preflight/evidence-manifest.json`,
  `${root}/e3/evidence-manifest.json`,
  `${root}/e3/cr-a-corrective/evidence-manifest.json`,
].map((path) => {
  const originalManifest = json(path);
  for (const entry of originalManifest.entries) {
    const publicEntry = byOriginal.get(entry.path);
    assert(publicEntry, `Missing publication mapping: ${entry.path}`);
    assert.equal(publicEntry.sha256, entry.sha256, entry.path);
  }
  return { path, sha256: hash(readFileSync(path)), entries: originalManifest.entries.length };
});
const frozen = {
  'docs/AI_Agent_Cultivation_V1_E0_Evaluation_Design_v0.2.md':
    '2667e1ac9281084b492b8bb81fbb3514f5d242bf0d919945c04dae615582160c',
  [`${root}/publication/e0/canonical-dataset.json`]:
    'ecf073ad4ed30be2c8d4adfc6b9285eb91fa4f6459d88395ea9d9c3c3f48e602',
  [`${root}/publication/e0/tool-fixture-mapping.tsv`]:
    '04ac50f6f151131b6af6010fef9c6606a6d228230c4f04e567d05caa9ae99a62',
};
for (const [path, expected] of Object.entries(frozen)) {
  assert.equal(hash(readFileSync(path)), expected, path);
}
console.log(
  JSON.stringify(
    {
      status: 'PASS',
      publicFilesVerified: manifest.entries.length,
      localOriginalsVerified,
      historical,
      frozen,
      limitation:
        'Public derivations verify publication hashes; original-byte claims require the retained local originals. This is not a rerun or a secrecy proof.',
    },
    null,
    2,
  ),
);
