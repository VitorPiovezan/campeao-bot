FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-venv build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir faster-whisper yt-dlp
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV HF_HOME=/data/hf
VOLUME /data
CMD ["bash", "start.sh"]
