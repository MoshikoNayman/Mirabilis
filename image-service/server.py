"""
Mirabilis AI — Local image generation service
Uses Stable Diffusion via HuggingFace diffusers with Apple MPS (Metal) on M-series chips.
Falls back to CPU if MPS is unavailable.

Usage: python server.py
Environment:
  IMAGE_MODEL   HuggingFace model ID (default: runwayml/stable-diffusion-v1-5)
  IMAGE_SERVICE_PORT  Port to listen on (default: 7860)
"""

import os
from io import BytesIO
from pathlib import Path
from threading import Lock, Thread
import base64
import logging

# Use a local writable cache by default so first-run model downloads do not fail
# on Windows profiles with restricted access to %USERPROFILE%\.cache.
APP_DIR = Path(__file__).resolve().parent
HF_CACHE_DIR = APP_DIR / '.cache' / 'huggingface'
os.environ.setdefault('HF_HOME', str(HF_CACHE_DIR))
os.environ.setdefault('HUGGINGFACE_HUB_CACHE', str(HF_CACHE_DIR / 'hub'))
os.environ.setdefault('TRANSFORMERS_CACHE', str(HF_CACHE_DIR / 'transformers'))

from flask import Flask, request, jsonify
import torch
from diffusers import StableDiffusionPipeline

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)s  %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('mirabilis-image')

app = Flask(__name__)

MODEL_ID = os.environ.get('IMAGE_MODEL', 'runwayml/stable-diffusion-v1-5')
pipe = None
DEVICE = 'uninitialized'
LOAD_ERROR = None
PIPELINE_LOCK = Lock()


def load_pipeline():
    global pipe, DEVICE, LOAD_ERROR
    if pipe is not None:
        return pipe, DEVICE

    with PIPELINE_LOCK:
        if pipe is not None:
            return pipe, DEVICE

        LOAD_ERROR = None

        if torch.backends.mps.is_available():
            device = 'mps'
            dtype = torch.float32  # float32 is more stable across MPS driver versions
        elif torch.cuda.is_available():
            device = 'cuda'
            dtype = torch.float16
        else:
            device = 'cpu'
            dtype = torch.float32

        log.info(f'Device: {device}  Dtype: {dtype}  Model: {MODEL_ID}')
        log.info('Loading model - first run will download ~4 GB, subsequent starts are fast.')

        try:
            pipeline = StableDiffusionPipeline.from_pretrained(
                MODEL_ID,
                torch_dtype=dtype,
                safety_checker=None,
                requires_safety_checker=False,
            )
            pipeline = pipeline.to(device)
            pipeline.enable_attention_slicing()  # reduces peak memory usage
        except Exception as exc:
            LOAD_ERROR = exc
            log.error(f'Model load failed: {exc}', exc_info=True)
            raise

        pipe = pipeline
        DEVICE = device
        log.info('Model loaded. Image service ready.')
        return pipe, DEVICE


def warm_pipeline():
    try:
        load_pipeline()
    except Exception:
        # Error is captured in LOAD_ERROR and exposed via /health and /generate.
        pass


@app.route('/health', methods=['GET'])
def health():
    if pipe is not None:
        status = 'ok'
    elif LOAD_ERROR is not None:
        status = 'error'
    else:
        status = 'initializing'
    return jsonify({
        'status': status,
        'device': DEVICE,
        'model': MODEL_ID,
        'error': str(LOAD_ERROR) if LOAD_ERROR is not None else None,
    })


@app.route('/generate', methods=['POST'])
def generate():
    global LOAD_ERROR
    data = request.get_json(force=True) or {}
    prompt = (data.get('prompt') or '').strip()

    if not prompt:
        return jsonify({'error': 'prompt is required'}), 400

    negative_prompt = data.get(
        'negative_prompt',
        'blurry, low quality, distorted, deformed, ugly, watermark, text, signature',
    )
    steps = max(1, min(int(data.get('steps', 25)), 100))
    width = max(128, min(int(data.get('width', 512)), 1024))
    height = max(128, min(int(data.get('height', 512)), 1024))
    guidance_scale = float(data.get('guidance_scale', 7.5))
    seed_param = data.get('seed', None)

    try:
        pipeline, device = load_pipeline()
    except Exception as exc:
        LOAD_ERROR = exc
        return jsonify({'error': f'image model failed to load: {exc}'}), 500

    generator = torch.Generator(device=device)
    if seed_param is not None:
        generator.manual_seed(int(seed_param))
    seed_used = generator.initial_seed()

    log.info(f'Generating [{width}x{height}, steps={steps}, seed={seed_used}]: {prompt[:80]}')

    try:
        with torch.no_grad():
            result = pipeline(
                prompt,
                negative_prompt=negative_prompt,
                num_inference_steps=steps,
                width=width,
                height=height,
                guidance_scale=guidance_scale,
                generator=generator,
            )

        image = result.images[0]
        buf = BytesIO()
        image.save(buf, format='PNG')
        img_b64 = base64.b64encode(buf.getvalue()).decode()

        log.info(f'Done — {len(img_b64) // 1024} kB base64 PNG')
        return jsonify({'image': img_b64, 'format': 'png', 'prompt': prompt, 'seed': seed_used})

    except Exception as exc:
        log.error(f'Generation failed: {exc}', exc_info=True)
        return jsonify({'error': str(exc)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('IMAGE_SERVICE_PORT', 7860))
    log.info(f'Listening on http://127.0.0.1:{port}')
    Thread(target=warm_pipeline, daemon=True).start()
    # threaded=False — SD pipeline is not thread-safe; queue requests
    app.run(host='127.0.0.1', port=port, debug=False, threaded=False)
