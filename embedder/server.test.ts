import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { modelName, parseDtype, readPicture, unitLength } from './clip.ts';
import { createEmbedderServer, type ImageModel, UnreadableImageError } from './server.ts';

/** Reads the picture for real, then makes a vector of its average colour. */
const fakeModel: ImageModel = {
  name: 'fake-clip',
  dim: 3,
  async embed(bytes) {
    const image = await readPicture(bytes);
    const sums = [0, 0, 0];
    image.data.forEach((value, i) => (sums[i % 3]! += value));
    return unitLength(sums);
  },
};

let base: string;
let server: ReturnType<typeof createEmbedderServer>;
before(async () => {
  server = createEmbedderServer(fakeModel, { key: 'k3y', maxBytes: 64 * 1024, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const auth = { Authorization: 'Bearer k3y' };
const picture = (background: string, channels: 3 | 4 = 3, width = 40, height = 30) =>
  sharp({ create: { width, height, channels, background } }).png().toBuffer();

test('tells which model it runs', async () => {
  const res = await fetch(base, { headers: auth });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { model: 'fake-clip', dim: 3 });
});

test('embeds a picture sent as the body', async () => {
  const res = await fetch(`${base}/embed`, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/png' }, body: await picture('#ff0000') });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { model: string; dim: number; embedding: number[] };
  assert.equal(body.model, 'fake-clip');
  assert.equal(body.dim, 3);
  assert.deepEqual(
    body.embedding.map((v) => Math.round(v * 1000) / 1000),
    [1, 0, 0],
  );
});

test('needs the key', async () => {
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(base, { headers: { Authorization: 'Bearer nope' } })).status, 401);
});

test('answers 400 for what is not a picture, 413 for too much, 404 and 405 for the rest', async () => {
  const junk = await fetch(`${base}/embed`, { method: 'POST', headers: auth, body: 'hello' });
  assert.equal(junk.status, 400);
  assert.match(((await junk.json()) as { error: string }).error, /not a picture/);
  assert.equal((await fetch(`${base}/embed`, { method: 'POST', headers: auth })).status, 400);
  assert.equal((await fetch(`${base}/embed`, { method: 'POST', headers: auth, body: new Uint8Array(65 * 1024) })).status, 413);
  assert.equal((await fetch(`${base}/embed`, { headers: auth })).status, 405);
  assert.equal((await fetch(`${base}/nope`, { headers: auth })).status, 404);
});

test('embeds one picture at a time, and carries on after a failure', async () => {
  let running = 0;
  let most = 0;
  const slow: ImageModel = {
    name: 'slow',
    dim: 1,
    async embed(bytes) {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      if (bytes[0] === 0) throw new UnreadableImageError('not a picture');
      return [1];
    },
  };
  const local = createEmbedderServer(slow);
  await new Promise<void>((resolve) => local.listen(0, resolve));
  const url = `http://localhost:${(local.address() as AddressInfo).port}/embed`;
  const statuses = await Promise.all(
    [0, 1, 1, 0, 1].map((first) => fetch(url, { method: 'POST', body: new Uint8Array([first, 2]) }).then((r) => r.status)),
  );
  await new Promise<void>((resolve) => local.close(() => resolve()));

  assert.deepEqual(statuses, [400, 200, 200, 400, 200]);
  assert.equal(most, 1);
});

test('reads pictures upright, as RGB, with transparency on white, and shrinks large ones', async () => {
  const cutOut = await readPicture(await picture('rgba(0, 0, 0, 0)', 4));
  assert.equal(cutOut.channels, 3);
  assert.deepEqual([...cutOut.data.subarray(0, 3)], [255, 255, 255]);

  const grey = await readPicture(
    new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
        .toColourspace('b-w')
        .png()
        .toBuffer(),
    ),
  );
  assert.equal(grey.channels, 3);

  const large = await readPicture(await picture('#00ff00', 3, 2000, 1000));
  assert.deepEqual([large.width, large.height], [896, 448]);

  // stored landscape, shown portrait (EXIF orientation 6: turned 90°)
  const turned = await readPicture(
    await sharp({ create: { width: 60, height: 20, channels: 3, background: '#000' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer(),
  );
  assert.deepEqual([turned.width, turned.height], [20, 60]);

  await assert.rejects(readPicture(new TextEncoder().encode('<svg')), UnreadableImageError);
});

test('names the model with its weight format, so a switch re-embeds the catalog', () => {
  assert.equal(parseDtype(undefined), 'q8');
  assert.equal(parseDtype('fp32'), 'fp32');
  assert.throws(() => parseDtype('q2'), /DTYPE must be one of/);
  assert.equal(modelName('Xenova/clip-vit-base-patch32', 'q8'), 'Xenova/clip-vit-base-patch32@q8');
  assert.equal(modelName('Xenova/clip-vit-base-patch32', 'fp32'), 'Xenova/clip-vit-base-patch32');
});
