"""Groundstation web application. Serves the Vite-built frontend.

For development: run `python run.py` from groundstation/ to start this
Flask API (port 5000) and the Vite dev server (port 5173) together.
For production: run `npm run build` in frontend/, then `python app.py`.
"""

from flask import Flask, send_from_directory, request, jsonify
import os
import json

DIST_DIR = os.path.join(os.path.dirname(__file__), 'frontend', 'dist')
MODELS_DIR = os.path.join(os.path.dirname(__file__), 'models')

os.makedirs(MODELS_DIR, exist_ok=True)

app = Flask(__name__, static_folder=DIST_DIR)


@app.route('/')
def index():
    return send_from_directory(DIST_DIR, 'index.html')


@app.route('/api/models', methods=['GET'])
def list_models():
    models = []
    for fname in os.listdir(MODELS_DIR):
        if fname.endswith('.json'):
            fpath = os.path.join(MODELS_DIR, fname)
            try:
                with open(fpath, 'r') as f:
                    data = json.load(f)
                models.append({
                    'filename': fname,
                    'name': data.get('name', fname.replace('.json', '')),
                    'created': data.get('created'),
                    'numSamples': data.get('numSamples'),
                    # interp models carry held-out suppression; the legacy MLP
                    # models only have a training loss, which is not comparable
                    'type': data.get('type', 'mlp'),
                    'suppressionDb': (data.get('quality') or {}).get('meanSuppDb'),
                    'finalLoss': data.get('finalLoss'),
                })
            except (json.JSONDecodeError, IOError):
                pass
    return jsonify(models)


@app.route('/api/models', methods=['POST'])
def save_model():
    data = request.get_json()
    if not data or 'name' not in data:
        return jsonify({'error': 'name is required'}), 400
    name = data['name'].strip()
    if not name:
        return jsonify({'error': 'name cannot be empty'}), 400
    safe_name = ''.join(c for c in name if c.isalnum() or c in '-_ ').strip()
    fname = f"{safe_name}.json"
    fpath = os.path.join(MODELS_DIR, fname)
    with open(fpath, 'w') as f:
        json.dump(data, f)
    return jsonify({'filename': fname, 'success': True})


@app.route('/api/models/<filename>', methods=['GET'])
def get_model(filename):
    if not filename.endswith('.json'):
        filename += '.json'
    fpath = os.path.join(MODELS_DIR, filename)
    if not os.path.isfile(fpath):
        return jsonify({'error': 'not found'}), 404
    return send_from_directory(MODELS_DIR, filename)


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory(DIST_DIR, path)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
