from __future__ import annotations

import subprocess

import pytest

from cocore_provider import hypervisor


def test_parse_linux_cpuinfo_flags_present() -> None:
    text = "processor\t: 0\nflags\t\t: fpu vme de pse hypervisor tsc\n"
    assert hypervisor.parse_linux_cpuinfo_flags(text) is True


def test_parse_linux_cpuinfo_flags_absent() -> None:
    text = "processor\t: 0\nflags\t\t: fpu vme de pse tsc\n"
    assert hypervisor.parse_linux_cpuinfo_flags(text) is False


def test_parse_linux_cpuinfo_flags_no_flags_line() -> None:
    assert hypervisor.parse_linux_cpuinfo_flags("processor\t: 0\n") is None


def test_parse_macos_sysctl_value() -> None:
    assert hypervisor.parse_macos_sysctl_value("1\n") is True
    assert hypervisor.parse_macos_sysctl_value("0\n") is False
    assert hypervisor.parse_macos_sysctl_value("garbage") is None


def test_vendor_strings_indicate_vm() -> None:
    assert hypervisor.vendor_strings_indicate_vm(["Microsoft Corporation", "Virtual Machine"])
    assert hypervisor.vendor_strings_indicate_vm(["VMware, Inc.", "VMware Virtual Platform"])
    assert not hypervisor.vendor_strings_indicate_vm(["Dell Inc.", "OptiPlex 7090"])
    assert not hypervisor.vendor_strings_indicate_vm([])


def test_detect_dispatches_to_linux(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hypervisor.platform, "system", lambda: "Linux")
    monkeypatch.setattr(hypervisor, "_detect_linux", lambda: True)
    assert hypervisor.detect() is True


def test_detect_dispatches_to_macos(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hypervisor.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(hypervisor, "_detect_macos", lambda: False)
    assert hypervisor.detect() is False


def test_detect_dispatches_to_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hypervisor.platform, "system", lambda: "Windows")
    monkeypatch.setattr(hypervisor, "_detect_windows", lambda: True)
    assert hypervisor.detect() is True


def test_detect_returns_none_on_unknown_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hypervisor.platform, "system", lambda: "SunOS")
    assert hypervisor.detect() is None


def test_detect_linux_returns_none_when_proc_cpuinfo_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _raise_read_text(self: object) -> str:
        raise OSError("no such file")

    monkeypatch.setattr(hypervisor.Path, "read_text", _raise_read_text)
    assert hypervisor._detect_linux() is None


def test_detect_macos_returns_none_on_missing_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(*args: object, **kwargs: object) -> None:
        raise FileNotFoundError("no sysctl")

    monkeypatch.setattr(hypervisor.subprocess, "run", _raise)
    assert hypervisor._detect_macos() is None


def test_detect_macos_returns_none_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(*args: object, **kwargs: object) -> None:
        raise subprocess.TimeoutExpired(cmd="sysctl", timeout=2)

    monkeypatch.setattr(hypervisor.subprocess, "run", _raise)
    assert hypervisor._detect_macos() is None


def test_detect_macos_returns_none_on_nonzero_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Result:
        returncode = 1
        stdout = ""

    monkeypatch.setattr(hypervisor.subprocess, "run", lambda *a, **k: _Result())
    assert hypervisor._detect_macos() is None


def test_detect_windows_returns_none_without_winreg() -> None:
    # On this (non-Windows) test host `winreg` genuinely doesn't exist, so
    # `_detect_windows` must hit its ImportError path and return None -- this
    # exercises the real code path rather than a mock.
    assert hypervisor._detect_windows() is None
