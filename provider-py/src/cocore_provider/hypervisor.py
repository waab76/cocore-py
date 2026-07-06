"""Best-effort hypervisor-presence detection for the optional
`hypervisor_present` field on `attestation_response` (see
`provider/src/hypervisor.rs` for the Rust CPUID-leaf-1/ECX-bit-31
equivalent). Python has no portable CPUID intrinsic, so each platform
reports an already-decoded signal instead of re-deriving the same bit:

- Linux: the kernel already exposes the CPUID hypervisor bit as a
  `hypervisor` token in /proc/cpuinfo's `flags` line.
- macOS: `sysctl kern.hv_vmm_present` is Apple's own guest-VM indicator
  (works on Apple Silicon too, unlike a raw CPUID call which Apple
  Silicon doesn't support at all).
- Windows: no direct CPUID leaf access without a C extension. Falls
  back to a BIOS/SMBIOS vendor-string heuristic (the registry's
  SystemManufacturer/SystemProductName/BIOSVendor), which catches
  every mainstream hypervisor even though it isn't the CPUID bit
  itself.
- Anything else, or any probe failure: `None`, matching Rust's
  "couldn't make a confident statement" case -- the field is optional
  and simply omitted from the signed payload and the wire frame.
"""

from __future__ import annotations

import platform
import re
import subprocess
from pathlib import Path
from typing import Any

_VM_VENDOR_MARKERS = (
    "vmware",
    "virtualbox",
    "innotek",  # VirtualBox's SMBIOS vendor string
    "qemu",
    "kvm",
    "xen",
    "microsoft corporation",  # Hyper-V / Azure guests
    "amazon ec2",
    "google compute engine",
    "bochs",
    "parallels",
)

_SYSCTL_TIMEOUT_SECS = 2.0


def detect() -> bool | None:
    system = platform.system()
    if system == "Linux":
        return _detect_linux()
    if system == "Darwin":
        return _detect_macos()
    if system == "Windows":
        return _detect_windows()
    return None


def parse_linux_cpuinfo_flags(cpuinfo_text: str) -> bool | None:
    match = re.search(r"^flags\s*:\s*(.*)$", cpuinfo_text, re.MULTILINE)
    if not match:
        return None
    return "hypervisor" in match.group(1).split()


def _detect_linux() -> bool | None:
    try:
        text = Path("/proc/cpuinfo").read_text()
    except OSError:
        return None
    return parse_linux_cpuinfo_flags(text)


def parse_macos_sysctl_value(value: str) -> bool | None:
    trimmed = value.strip()
    if trimmed == "1":
        return True
    if trimmed == "0":
        return False
    return None


def _detect_macos() -> bool | None:
    try:
        out = subprocess.run(
            ["/usr/sbin/sysctl", "-n", "kern.hv_vmm_present"],
            capture_output=True,
            text=True,
            timeout=_SYSCTL_TIMEOUT_SECS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return parse_macos_sysctl_value(out.stdout)


def vendor_strings_indicate_vm(values: list[str]) -> bool:
    haystack = " ".join(values).lower()
    return any(marker in haystack for marker in _VM_VENDOR_MARKERS)


def _detect_windows() -> bool | None:
    try:
        import winreg
    except ImportError:
        return None
    # `winreg` is a Windows-only stdlib module; typeshed's stub only defines
    # these names for a Windows target, so mypy (run on macOS/Linux CI) sees
    # this module as attribute-less. `Any` sidesteps that without weakening
    # any check that actually runs on this platform.
    reg: Any = winreg
    try:
        key = reg.OpenKey(reg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\BIOS")
    except OSError:
        return None
    try:
        values: list[str] = []
        for name in ("SystemManufacturer", "SystemProductName", "BIOSVendor"):
            try:
                values.append(str(reg.QueryValueEx(key, name)[0]))
            except OSError:
                continue
    finally:
        reg.CloseKey(key)
    if not values:
        return None
    return vendor_strings_indicate_vm(values)
