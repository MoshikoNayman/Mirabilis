"""
Mirabilis AI — Local image generation service
Uses Stable Diffusion via HuggingFace diffusers with Apple MPS (Metal) on M-series chips.
Falls back to CPU if MPS is unavailable.

Usage: python server.py
Environment:
  IMAGE_MODEL   HuggingFace model ID (default: runwayml/stable-diffusion-v1-5)
  IMAGE_SERVICE_PORT  Port to listen on (default: 7860)
"""

from flask import Flask, request, jsonify
import torch
from diffusers import StableDiffusionPipeline
from io import BytesIO
import base64
import logging
import os

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)s  %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('mirabilis-image')

app = Flask(__name__)

MODEL_ID = os.environ.get('IMAGE_MODEL', 'runwayml/stable-diffusion-v1-5')


def load_pipeline():
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
    log.info('Loading model — first run will download ~4 GB, subsequent starts are fast.')

    pipeline = StableDiffusionPipeline.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        safety_checker=None,
        requires_safety_checker=False,
    )
    pipeline = pipeline.to(device)
    pipeline.enable_attention_slicing()  # reduces peak memory usage

    log.info('Model loaded. Image service ready.')
    return pipeline, device


pipe, DEVICE = load_pipeline()


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'device': DEVICE, 'model': MODEL_ID})


@app.route('/generate', methods=['POST'])
def generate():
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

    generator = torch.Generator(device=DEVICE)
    if seed_param is not None:
        generator.manual_seed(int(seed_param))
    seed_used = generator.initial_seed()

    log.info(f'Generating [{width}x{height}, steps={steps}, seed={seed_used}]: {prompt[:80]}')

    try:
        with torch.no_grad():
            result = pipe(
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
    # threaded=False — SD pipeline is not thread-safe; queue requests
    app.run(host='127.0.0.1', port=port, debug=False, threaded=False)
