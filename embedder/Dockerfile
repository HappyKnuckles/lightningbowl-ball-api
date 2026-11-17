FROM node:24-slim

# onnxruntime-node ships its CPU build in the npm package; skip fetching the CUDA extras
ENV NODE_ENV=production \
    ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /srv

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY model.ts main.ts server.ts ./

# The model goes into the image, so the container starts without reaching Hugging Face.
# A different MODEL (a CLIP or DINOv2 checkpoint in ONNX form, e.g. onnx-community/dinov2-small) or DTYPE
# makes the Ball API embed every picture again.
ARG MODEL=Xenova/clip-vit-base-patch32
# q8: a quarter of the memory of fp32 and about twice as fast, which matters on a one-core server
ARG DTYPE=q8
ENV MODEL=$MODEL \
    DTYPE=$DTYPE \
    MODEL_DIR=/srv/models
RUN mkdir -p /srv/models && chown node:node /srv/models
USER node
RUN node main.ts --download

EXPOSE 8080
CMD ["node", "main.ts"]
