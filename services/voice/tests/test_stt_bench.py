from pathlib import Path

import numpy as np
import pytest

from jarvis_voice.diagnostics import stt_bench as sb

WHISPER_STDOUT = """
[00:00:00.000 --> 00:00:03.100]   Jarvis, abrí el proyecto
[00:00:03.100 --> 00:00:05.260]   de la tienda.
"""
WHISPER_STDERR = """
whisper_print_timings:     load time =   672.09 ms
whisper_print_timings:   encode time =   137.57 ms /     1 runs (   137.57 ms per run)
whisper_print_timings:    total time =   928.07 ms
"""


def test_parse_whisper_output_joins_segments_and_reads_timings():
    text, load, total = sb.parse_output("whisper-cli.exe", WHISPER_STDOUT, WHISPER_STDERR)
    assert text == "Jarvis, abrí el proyecto de la tienda."
    assert (load, total) == (672.09, 928.07)


def test_parse_parakeet_output():
    err = "parakeet_print_timings:     load time =   723.13 ms\nparakeet_print_timings:    total time =   946.69 ms\n"
    text, load, total = sb.parse_output("parakeet-cli.exe", "Hola Jarvis.\n", err)
    assert text == "Hola Jarvis."
    assert (load, total) == (723.13, 946.69)


def test_parse_failure_has_no_total():
    assert sb.parse_output("whisper-cli.exe", "", "error: failed to open model")[2] is None


@pytest.mark.parametrize(("dur", "expected"), [(1.0, 512), (6.1, 512), (12.0, 700), (40.0, 1500)])
def test_audio_ctx_for(dur, expected):
    assert sb.audio_ctx_for(dur) == expected


def test_build_command_variants():
    wav = Path("x.wav")
    gpu = sb.build_command(sb.ENGINES["whisper-turbo-gpu"], wav, 12.0, 6)
    assert "-ac" in gpu and gpu[gpu.index("-ac") + 1] == "700" and "-ng" not in gpu
    assert gpu[gpu.index("-bs") + 1] == "1"
    beam = sb.build_command(sb.ENGINES["whisper-turbo-gpu-beam5"], wav, 6.1, 6)
    assert beam[beam.index("-bs") + 1] == "5" and "-ac" in beam
    full = sb.build_command(sb.ENGINES["whisper-turbo-gpu-fullctx"], wav, 6.1, 6)
    assert "-ac" not in full
    cpu = sb.build_command(sb.ENGINES["whisper-turbo-cpu"], wav, 6.1, 6)
    assert "-ng" in cpu
    pk = sb.build_command(sb.ENGINES["parakeet-v3-gpu"], wav, 6.1, 6)
    assert "-l" not in pk and pk[0].endswith("parakeet-cli.exe")


def test_percentile():
    assert sb.percentile([1, 2, 3, 4], 50) == 2.5
    assert sb.percentile([10], 95) == 10


def test_phrases_file_has_20_phrases():
    phrases = sb.load_phrases(sb.phrases_file())
    assert len(phrases) == 20
    assert all(not p.startswith("#") for p in phrases)


def test_wav_roundtrip(tmp_path):
    path = tmp_path / "a.wav"
    sb.write_wav(path, np.zeros((16000, 1), dtype="float32"))
    assert sb.wav_duration(path) == pytest.approx(1.0)


def test_extract_flat_ignores_directories_and_traversal(tmp_path):
    import zipfile

    z = tmp_path / "a.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.writestr("Release/whisper-cli.exe", b"exe")
        f.writestr("../../evil.dll", b"x")
        f.writestr("other/ggml-vulkan.dll", b"vk")
    out = tmp_path / "out"
    out.mkdir()
    sb.extract_flat(z, out, only={"ggml-vulkan.dll"})
    assert sorted(p.name for p in out.iterdir()) == ["ggml-vulkan.dll"]
    assert not (tmp_path / "evil.dll").exists()


def test_markdown_table_sorts_by_wer():
    a = sb.EngineResult("a", files=2, wer=0.2, latency_p50_ms=100)
    b = sb.EngineResult("b", files=2, wer=0.05, latency_p50_ms=300)
    table = sb.markdown_table([a, b])
    assert table.index("| b |") < table.index("| a |")


def test_vocab_engine_passes_prompt_and_full_context():
    cmd = sb.build_command(sb.ENGINES["whisper-turbo-gpu-fullctx-vocab"], Path("x.wav"), 5.0, 6)
    assert cmd[cmd.index("--prompt") + 1] == sb.VOCAB_PROMPT
    assert "-ac" not in cmd
