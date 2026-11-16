# Ball embedder

Turns ball pictures into vectors for the Ball API's image search (`POST /api/balls/image-search`). It runs CLIP's image encoder ([`Xenova/clip-vit-base-patch32`](https://huggingface.co/Xenova/clip-vit-base-patch32), ONNX, CPU) through transformers.js. Like the ball tracker it runs in Docker on a VPS rather than on Vercel: the model needs about 600 MB of memory and a warm process.

## API

|               |                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /`       | `{ "model": "Xenova/clip-vit-base-patch32", "dim": 512 }`                                                             |
| `POST /embed` | Body: the picture's bytes (JPEG, PNG, WebP, …). Answer: `{ "model", "dim", "embedding": [512 numbers, unit length] }` |

`401` without the key, `400` when the body isn't a picture, `413` over 8 MB. Pictures are read upright (EXIF), transparency goes on white like the catalog's cut-outs, and one picture is embedded at a time.

## Run

```bash
docker build -t lightningbowl-ball-embedder .
docker run -d --restart unless-stopped -p 8080:8080 -e API_KEY=$(openssl rand -hex 32) lightningbowl-ball-embedder
```

The build downloads the model into the image (about 350 MB), so the container starts without reaching Hugging Face. Put it behind HTTPS (e.g. the same reverse proxy as the ball tracker), then set `EMBEDDER_URL` and `EMBEDDER_KEY` (= `API_KEY`) on the Ball API in Vercel, and run `npm run embed-images` in the API once to embed the catalog.

| Variable    |                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_KEY`   | Required as `Authorization: Bearer <key>` when set.                                                                                                                                                            |
| `PORT`      | Default `8080`.                                                                                                                                                                                                |
| `MODEL`     | A CLIP checkpoint in ONNX form (build argument and variable), default `Xenova/clip-vit-base-patch32`; `Xenova/clip-vit-base-patch16` is slower and finer. A new model makes the API embed every picture again. |
| `MODEL_DIR` | Where models are kept, default `./models`.                                                                                                                                                                     |

Locally (Node 22.18+, which runs the TypeScript directly): `ONNXRUNTIME_NODE_INSTALL=skip npm install`, `npm start`, `npm test` (the HTTP side and picture reading, with a stand-in model), `npm run typecheck`.
