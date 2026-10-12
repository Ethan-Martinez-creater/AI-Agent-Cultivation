import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

// Capture the actual packaged BrowserWindow compositor. Video surfaces can
// stall Playwright's animation stabilization even after playback is paused.
export async function capturePackagedWindow(app, page, path) {
  const window = await app.browserWindow(page);
  const png = await window.evaluate(async (value) =>
    (await value.capturePage()).toPNG().toString('base64'),
  );
  await writeFile(path, Buffer.from(png, 'base64'));
}
