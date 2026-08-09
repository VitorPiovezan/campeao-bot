import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from faster_whisper import WhisperModel

model = WhisperModel(
    os.environ.get("WHISPER_MODEL", "base"),
    device="cpu",
    compute_type="int8",
    cpu_threads=int(os.environ.get("WHISPER_THREADS", "4")),
)
lock = threading.Lock()
INITIAL_PROMPT = os.environ.get(
    "WHISPER_PROMPT",
    "Campeão, toca, pula, pausa, continua, para, sai, fila, rádio, letra, música.",
)
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE", "1"))
STT_PORT = int(os.environ.get("STT_PORT", "5005"))


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        pcm = self.rfile.read(length)
        audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
        with lock:
            segments, _ = model.transcribe(
                audio,
                language="pt",
                beam_size=BEAM_SIZE,
                vad_filter=True,
                initial_prompt=INITIAL_PROMPT,
            )
            text = " ".join(s.text for s in segments).strip()
        body = json.dumps({"text": text}).encode()
        try:
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


ThreadingHTTPServer.request_queue_size = 64
print(f"STT pronto na porta {STT_PORT}", flush=True)
ThreadingHTTPServer(("127.0.0.1", STT_PORT), Handler).serve_forever()
