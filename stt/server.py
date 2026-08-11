import json
import os
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from faster_whisper import WhisperModel

FULL_MODEL = os.environ.get("WHISPER_MODEL", "base")
GATE_MODEL = os.environ.get("GATE_WHISPER_MODEL", "tiny")
FULL_THREADS = int(os.environ.get("WHISPER_THREADS", "2"))
GATE_THREADS = int(os.environ.get("GATE_WHISPER_THREADS", "1"))
GATE_POOL_SIZE = int(os.environ.get("GATE_POOL", "3"))


def load(name: str, threads: int) -> WhisperModel:
    return WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads)


full_model = load(FULL_MODEL, FULL_THREADS)
full_lock = threading.Lock()

gate_pool: queue.Queue[WhisperModel] = queue.Queue()
for _ in range(GATE_POOL_SIZE):
    gate_pool.put(load(GATE_MODEL, GATE_THREADS))


def run(model: WhisperModel, audio: np.ndarray) -> str:
    segments, _ = model.transcribe(
        audio,
        language="pt",
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    return " ".join(s.text for s in segments).strip()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        pcm = self.rfile.read(length)
        audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0

        if self.path.startswith("/gate"):
            model = gate_pool.get()
            try:
                text = run(model, audio)
            finally:
                gate_pool.put(model)
        else:
            with full_lock:
                text = run(full_model, audio)

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


ThreadingHTTPServer.request_queue_size = 128
ThreadingHTTPServer.daemon_threads = True
print(
    f"STT pronto na porta 5005 (completo={FULL_MODEL}, porteiro={GATE_MODEL} x{GATE_POOL_SIZE})",
    flush=True,
)
ThreadingHTTPServer(("127.0.0.1", 5005), Handler).serve_forever()
