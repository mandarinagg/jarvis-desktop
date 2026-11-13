import pytest

from jarvis_voice.diagnostics import text_metrics as tm


def test_normalize_drops_spanish_punctuation_and_case():
    assert tm.normalize("¿Qué tengo HOY?  ¡Dale!") == "qué tengo hoy dale"


def test_strip_accents_keeps_enie():
    assert tm.normalize("Mañana, acción", keep_accents=False) == "mañana accion"


def test_wer_identical_is_zero():
    assert tm.wer("Abrí el proyecto.", "abrí el proyecto") == 0.0


def test_wer_counts_substitution_insertion_deletion():
    assert tm.wer("a b c d", "a x c") == pytest.approx(2 / 4)  # 1 sub + 1 del
    assert tm.wer("a b", "a b c") == pytest.approx(1 / 2)  # 1 ins


def test_accent_only_errors_disappear_when_ignoring_accents():
    ref, hyp = "decime qué tareas", "decime que tareas"
    assert tm.wer(ref, hyp) == pytest.approx(1 / 3)
    assert tm.wer(ref, hyp, keep_accents=False) == 0.0


def test_cer():
    assert tm.cer("Jarvis", "Yarvis") == pytest.approx(1 / 6)


def test_corpus_wer_weights_by_reference_length():
    pairs = [("a b c d", "a b c d"), ("e f", "x f")]
    assert tm.corpus_wer(pairs) == pytest.approx(1 / 6)


def test_empty_reference():
    assert tm.wer("", "") == 0.0
    assert tm.wer("", "algo") == 1.0
