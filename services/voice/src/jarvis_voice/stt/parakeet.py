"""Parakeet TDT 0.6B v3 in-process over parakeet.dll (ADR-010, ADR-014).

The CLI reloads the model and re-initialises Vulkan on every call (~4.7 s); loading it once
here leaves ~100 ms per utterance on the RX 6600 XT.

ctypes notes (Windows x64 ABI, see ADR-014):
- `parakeet_context_params` is 8 bytes {bool use_gpu; bool flash_attn; int gpu_device}, so it is
  passed by value in a register and must be declared as a Structure.
- `parakeet_full_params` is large: by-value arguments that big are passed as a pointer to a
  copy, so the pointer from `parakeet_full_default_params_by_ref` is passed as-is and its layout
  never needs to be mirrored here.
- ggml backends (Vulkan, CPU) must be loaded explicitly before creating the context.
"""

from __future__ import annotations

import ctypes
import os
import threading
import time
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16_000
GREEDY = 0


class SttError(RuntimeError):
    pass


class _ContextParams(ctypes.Structure):
    _fields_ = [("use_gpu", ctypes.c_bool), ("flash_attn", ctypes.c_bool), ("gpu_device", ctypes.c_int)]


def _bind(lib: ctypes.CDLL) -> None:
    vp, cp, ci = ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int
    sigs = {
        "parakeet_context_default_params": ([], _ContextParams),
        "parakeet_init_from_file_with_params": ([cp, _ContextParams], vp),
        "parakeet_full_default_params_by_ref": ([ci], vp),
        "parakeet_free_params": ([vp], None),
        "parakeet_full": ([vp, vp, ctypes.POINTER(ctypes.c_float), ci], ci),
        "parakeet_full_n_segments": ([vp], ci),
        "parakeet_full_get_segment_text": ([vp, ci], cp),
        "parakeet_free": ([vp], None),
    }
    for name, (args, res) in sigs.items():
        fn = getattr(lib, name)
        fn.argtypes, fn.restype = args, res


class ParakeetEngine:
    """Thread-safe: transcriptions are serialised (one GPU context)."""

    def __init__(self, bin_dir: Path, model: Path, use_gpu: bool = True) -> None:
        if not (bin_dir / "parakeet.dll").exists() or not model.exists():
            raise FileNotFoundError(f"parakeet.dll or model missing ({bin_dir}, {model}); run jarvis-stt-bench setup")
        self._dll_dir = os.add_dll_directory(str(bin_dir))
        ggml = ctypes.CDLL(str(bin_dir / "ggml.dll"))
        ggml.ggml_backend_load_all_from_path.argtypes = [ctypes.c_char_p]
        ggml.ggml_backend_load_all_from_path(str(bin_dir).encode())
        self._lib = lib = ctypes.CDLL(str(bin_dir / "parakeet.dll"))
        _bind(lib)
        params = lib.parakeet_context_default_params()
        params.use_gpu = use_gpu
        t0 = time.monotonic()
        self._ctx = lib.parakeet_init_from_file_with_params(str(model).encode(), params)
        if not self._ctx:
            raise SttError("parakeet_init_from_file_with_params failed")
        self.load_ms = (time.monotonic() - t0) * 1000
        self._params = lib.parakeet_full_default_params_by_ref(GREEDY)
        self._lock = threading.Lock()

    def transcribe(self, samples: np.ndarray) -> str:
        """samples: float32 mono at 16 kHz."""
        pcm = np.ascontiguousarray(samples, dtype=np.float32)
        if len(pcm) == 0:
            return ""
        ptr = pcm.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
        with self._lock:
            if self._ctx is None:
                raise SttError("engine closed")
            rc = self._lib.parakeet_full(self._ctx, self._params, ptr, len(pcm))
            if rc != 0:
                raise SttError(f"parakeet_full returned {rc}")
            n = self._lib.parakeet_full_n_segments(self._ctx)
            parts = [self._lib.parakeet_full_get_segment_text(self._ctx, i) or b"" for i in range(n)]
        return " ".join(p.decode("utf-8", "replace").strip() for p in parts).strip()

    def close(self) -> None:
        with self._lock:
            if self._ctx is not None:
                self._lib.parakeet_free(self._ctx)
                self._lib.parakeet_free_params(self._params)
                self._ctx = None
