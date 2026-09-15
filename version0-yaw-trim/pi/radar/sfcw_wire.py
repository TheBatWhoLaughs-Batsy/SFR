"""Compact binary encoding of an sfcw_result, for clients that ask for it.

Every sweep used to go to every client as JSON carrying two copies of the same
measurement: the raw calibrated sweep (h_cal_real / h_cal_imag, what everything
downstream actually uses) and the Pi's own range profile (distances /
magnitudes, a Hanning IFFT at 4x zero-pad that the groundstation recomputes
anyway). At 51 steps the profile is over half of a 2.8 KB message.

A client opts in with {"cmd": "sfcw_binary", "enabled": true} (sdr_server.py).
It then gets each sfcw_result as ONE binary WebSocket frame. Every other client
-- the Python tools (benchmark_sweep, capture_bgmodel, span_confirm,
test_dsp_path) and any groundstation build that predates this -- keeps getting
exactly the JSON it always did.

Frame layout, little-endian:

    offset 0   4 bytes   magic b'SFR1'
    offset 4   uint32    H = length of the JSON header in bytes
    offset 8   H bytes   UTF-8 JSON: every field of the JSON sfcw_result EXCEPT
                         distances, magnitudes, h_cal_real and h_cal_imag, in
                         the same order, plus "n" = number of steps
    zero padding to the next multiple of 8 (so a Float64Array can view it)
    2*n float64          h_cal real parts, then imaginary parts, at FULL precision

Full-precision float64, not the 8-decimal values the JSON carries, and not
float32. The JSON profile is computed by sfcw_engine._process_h_cal from the
unrounded h_cal; rebuilding it from the 8-decimal values gets the last 0.01 dB
wrong on ~1% of bins of a quiet sweep (measured: 2064 of 214,740 values, and
numpy disagrees with itself by exactly that much). So the frame carries the
unrounded sweep, and the decoder:
  - rounds h_cal to 8 decimals exactly as np.round does, so every consumer and
    every export sees the same numbers the JSON message had;
  - rebuilds distances / magnitudes from the unrounded values, lazily, only for
    a sweep something actually reads them from.
See groundstation/frontend/src/lib/sfcwWire.js.
"""

import json
import struct

import numpy as np

MAGIC = b'SFR1'
_ARRAYS = ('h_cal_real', 'h_cal_imag')
_PROFILE = ('distances', 'magnitudes')


def encode_sfcw_binary(result_msg, h_cal=None):
    """Encode one sfcw_result dict (as sdr_server builds it for JSON).

    h_cal is the engine's unrounded complex sweep (_process_h_cal's 'h_cal_full').
    Without it the 8-decimal lists from result_msg are packed instead: h_cal still
    decodes to the same values, but the rebuilt profile can then differ from the
    Pi's by 0.01 dB in a few bins.

    Returns bytes, or None when the message has no usable h_cal (the caller
    then sends that client JSON instead, so nothing is lost).
    """
    re = result_msg.get('h_cal_real')
    im = result_msg.get('h_cal_imag')
    if re is None or im is None or len(re) == 0 or len(re) != len(im):
        return None
    if h_cal is not None and len(h_cal) == len(re):
        h = np.asarray(h_cal, dtype=np.complex128)
        re, im = h.real, h.imag
    header = {k: v for k, v in result_msg.items() if k not in _ARRAYS + _PROFILE}
    header['n'] = len(re)
    hb = json.dumps(header, separators=(',', ':')).encode('utf-8')
    pad = (-(8 + len(hb))) % 8
    body = np.concatenate((np.asarray(re, dtype='<f8'),
                           np.asarray(im, dtype='<f8'))).tobytes()
    return b''.join((MAGIC, struct.pack('<I', len(hb)), hb, b'\0' * pad, body))
