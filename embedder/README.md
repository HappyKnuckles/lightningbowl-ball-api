# Ball embedder

Turns ball pictures into vectors for the Ball API's image search (`POST /api/balls/image-search`). It runs an image model through transformers.js (ONNX, CPU): CLIP's image encoder ([`Xenova/clip-vit-base-patch32`](https://huggingface.co/Xenova/clip-vit-base-patch32)) by default, or DINOv2 ([`onnx-community/dinov2-small`](https://huggingface.co/onnx-community/dinov2-small)), which tells individual objects apart better and leans less on printed text. Like the ball tracker it runs in Docker on a VPS rather than on Vercel: the model needs a few hundred MB of memory and a warm process.

## API

|               |                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /`       | `{ "model": "Xenova/clip-vit-base-patch32", "dim": 512 }`                                                             |
| `POST /embed` | Body: the picture's bytes (JPEG, PNG, WebP, …). Answer: `{ "model", "dim", "embedding": [512 numbers, unit length] }` |

`401` without the key, `400` when the body isn't a picture, `413` over 8 MB. Pictures are read upright (EXIF), transparency goes on white like the catalog's cut-outs, and one picture is embedded at a time.

## Run

On the VPS (HappyKnuckles/vps runs it as the `embedder` service behind Caddy at `embed.lightningbowl.de`), the **Embedder** workflow of this repo deploys it: on every push to `main` that touches `embedder/` it runs the tests, builds the image for amd64 and arm64, checks that it really embeds a picture, pushes it to `ghcr.io/happyknuckles/lightningbowl-ball-embedder` and restarts the service. Secrets: `VPS_HOST`, `VPS_SSH_KEY` (as in the other repos) and `EMBEDDER_API_KEY` (e.g. `openssl rand -hex 32`; the same value goes into `EMBEDDER_KEY` of the Ball API on Vercel, Production and Preview).

Then set `EMBEDDER_URL=https://embed.lightningbowl.de` on Vercel and run `npm run embed-images` in the API once to embed the catalog (on one core roughly 30–60 minutes; the nightly sync only adds new balls).

By hand:

```bash
docker build -t lightningbowl-ball-embedder .
docker run -d --restart unless-stopped -p 8080:8080 -e API_KEY=$(openssl rand -hex 32) lightningbowl-ball-embedder
```

The build downloads the model into the image, so the container starts without reaching Hugging Face.

| Variable    |                                                                                                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_KEY`   | Required as `Authorization: Bearer <key>` when set.                                                                                                                                                                                                                           |
| `PORT`      | Default `8080`.                                                                                                                                                                                                                                                               |
| `DTYPE`     | Weights: `q8` (default, about 90 MB and roughly twice as fast on a CPU), `fp16` or `fp32` (about 350 MB). A switch makes the API embed every picture again.                                                                                                                   |
| `MODEL`     | A CLIP or DINOv2 checkpoint in ONNX form (build argument and variable), default `Xenova/clip-vit-base-patch32`; `Xenova/clip-vit-base-patch16` is slower and finer; `onnx-community/dinov2-small` or `-base` for DINOv2. A new model makes the API embed every picture again. |
| `MODEL_DIR` | Where models are kept, default `./models`.                                                                                                                                                                                                                                    |

Locally (Node 22.18+, which runs the TypeScript directly): `ONNXRUNTIME_NODE_INSTALL=skip npm install`, `npm start`, `npm test` (the HTTP side and picture reading, with a stand-in model), `npm run typecheck`.
