"""Single entry point for groundstation development.

Launches the Flask API (app.py, port 5000) and the Vite dev server
(frontend/, port 5173) together. Ctrl+C stops both.

Usage: python run.py
"""

import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(ROOT, 'frontend')
IS_WINDOWS = os.name == 'nt'


def _kill(proc):
    if proc.poll() is not None:
        return
    if IS_WINDOWS:
        # taskkill /T kills the whole process tree (npm.cmd -> node, or the
        # Flask reloader's child process), which proc.terminate() would miss.
        subprocess.run(
            ['taskkill', '/PID', str(proc.pid), '/T', '/F'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    else:
        proc.terminate()


def main():
    npm_cmd = 'npm.cmd' if IS_WINDOWS else 'npm'

    print('[run] starting Flask backend on http://localhost:5000')
    backend = subprocess.Popen([sys.executable, 'app.py'], cwd=ROOT)

    print('[run] starting Vite dev server on http://localhost:5173')
    frontend = subprocess.Popen([npm_cmd, 'run', 'dev'], cwd=FRONTEND_DIR)

    procs = [backend, frontend]
    try:
        while all(p.poll() is None for p in procs):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        print('\n[run] shutting down...')
        for p in procs:
            _kill(p)
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass


if __name__ == '__main__':
    main()
