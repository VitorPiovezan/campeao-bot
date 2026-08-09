FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-venv build-essential ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir faster-whisper yt-dlp bgutil-ytdlp-pot-provider
RUN git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider /opt/bgutil \
    && cd /opt/bgutil/server && npm install && npx tsc
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV HF_HOME=/data/hf
ENV XDG_CACHE_HOME=/data/cache
RUN mkdir -p /data/hf /data/cache
CMD ["bash", "start.sh"]
