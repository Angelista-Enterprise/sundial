"""Plan 15 step 3: Gnomon's voice, Kokoro on this Mac. Sundial.app starts this once and keeps it.

stdin, one JSON line per sentence: {"id": "...", "text": "...", "voice": "af_heart"}
stdout, one JSON line per sentence when its audio is written: {"id": "...", "path": "...", "ms": 312}
The app plays the file, so a stop is the app's and takes no round trip. Nothing leaves the machine.
argv[1]: the folder for the audio files.
"""
import json
import os
import sys
import time

os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")

import espeakng_loader
import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model
from phonemizer.backend.espeak.wrapper import EspeakWrapper

EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())

out_dir = sys.argv[1]
os.makedirs(out_dir, mode=0o700, exist_ok=True)
model = load_model("mlx-community/Kokoro-82M-bf16")
# The first sentence builds the pipeline (about 3 s): do that before the owner waits on it.
for _ in model.generate(text="Ready.", voice="af_heart", speed=1.0, lang_code="a"):
    pass
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    try:
        req = json.loads(line)
        started = time.time()
        voice = req.get("voice") or "af_heart"
        parts = [np.array(r.audio, dtype=np.float32).reshape(-1) for r in model.generate(text=req["text"], voice=voice, speed=1.0, lang_code=voice[0])]
        path = os.path.join(out_dir, f"{req['id']}.wav")
        sf.write(path, np.concatenate(parts) if parts else np.zeros(1, dtype=np.float32), model.sample_rate)
        print(json.dumps({"id": req["id"], "path": path, "ms": round((time.time() - started) * 1000)}), flush=True)
    except Exception as error:  # one bad sentence must not end the voice
        print(json.dumps({"id": req.get("id") if isinstance(req, dict) else None, "error": str(error)[:200]}), flush=True)
