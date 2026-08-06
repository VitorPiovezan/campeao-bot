import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
from faster_whisper import WhisperModel

model = WhisperModel(
    os.environ.get("WHISPER_MODEL", "base"),
    device="cpu",
    compute_type="int8",
    cpu_threads=int(os.environ.get("WHISPER_THREADS", "4")),
)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        pcm = self.rfile.read(length)
        audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
        segments, _ = model.transcribe(
            audio,
            language="pt",
            beam_size=1,
            vad_filter=True,
            initial_prompt="Campeão, toca Wonderwall do Oasis aí.",
        )
        text = " ".join(s.text for s in segments).strip()
        body = json.dumps({"text": text}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


print("STT pronto na porta 5005", flush=True)
HTTPServer(("127.0.0.1", 5005), Handler).serve_forever()
