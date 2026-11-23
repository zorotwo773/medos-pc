"""Fail-closed network access policy for the MedOS backend."""
from __future__ import annotations

import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Mapping
import errno

from starlette.types import ASGIApp, Message, Receive, Scope, Send


SETTINGS_VERSION = 1
FORWARDED_CLIENT_HEADER = "x-medos-forwarded-client"
INTERNAL_TOKEN_HEADER = "x-medos-internal-token"
_STANDARD_FORWARDING_HEADERS = {b"forwarded", b"x-forwarded-for"}
_DENIED_BODY = b'{"detail":"network access denied"}'
_REPARSE_POINT_ATTRIBUTE = 0x400

_RFC1918_NETWORKS = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
)
_ULA_NETWORK = ipaddress.ip_network("fc00::/7")
_INSTALL_ROOT = Path(__file__).resolve().parents[2]
_WINDOWS_FULL_CONTROL = 0x001F01FF
NETWORK_POLICY_LOCK = threading.RLock()


@dataclass(frozen=True)
class NetworkSettings:
    allow_public: bool
    valid: bool
    needs_attention: bool
    source_missing: bool = False


@dataclass(frozen=True)
class EffectiveNetworkPolicy:
    status: str
    allow_public: bool
    valid: bool


class NetworkPolicyError(RuntimeError):
    """A platform policy operation failed safely."""


class NetworkPolicyCancelled(NetworkPolicyError):
    """The user cancelled platform authorization."""


class NetworkPolicyTimeout(NetworkPolicyError):
    """The platform helper exceeded its fixed timeout."""

    restoration_owned = True

    def __init__(self, message: str, *, outcome_unknown: bool = False) -> None:
        super().__init__(message)
        self.outcome_unknown = outcome_unknown


class NetworkPolicyApplyFailed(NetworkPolicyError):
    """The transactional platform helper failed after restoring its snapshot."""

    restoration_owned = True


class ApplicationNetworkPolicyApplier:
    """Effective app admission policy for platforms without firewall mutation."""

    uses_persisted_application_policy = True

    def __init__(
        self,
        settings_path: str | os.PathLike[str],
        *,
        settings_loader: Callable[[str | os.PathLike[str] | None], NetworkSettings] | None = None,
    ) -> None:
        self.settings_path = Path(settings_path)
        self.settings_loader = settings_loader or load_network_settings

    def apply(self, allow_public: bool) -> None:
        if type(allow_public) is not bool:
            raise TypeError("allow_public must be a boolean")

    def read_effective(self) -> EffectiveNetworkPolicy:
        settings = self.settings_loader(self.settings_path)
        return EffectiveNetworkPolicy(
            "public" if settings.allow_public else "private",
            settings.allow_public,
            settings.valid and not settings.needs_attention,
        )

    def rollback(self, allow_public: bool) -> None:
        if type(allow_public) is not bool:
            raise TypeError("allow_public must be a boolean")


class _SettingsReadRace(OSError):
    pass


def normalize_client_address(raw_value: object):
    """Return a canonical unscoped address, unmapping IPv4-mapped IPv6."""
    if not isinstance(raw_value, str) or not raw_value or raw_value != raw_value.strip():
        return None
    if "%" in raw_value or "," in raw_value or raw_value.startswith("["):
        return None
    if any(ord(character) < 33 or ord(character) == 127 for character in raw_value):
        return None
    try:
        address = ipaddress.ip_address(raw_value)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _is_valid_unicast(address: Any) -> bool:
    if not address or address.is_unspecified or address.is_multicast:
        return False
    return _is_private_network_address(address) or address.is_global


def _is_private_network_address(address: Any) -> bool:
    if address.is_loopback or address.is_link_local:
        return True
    if isinstance(address, ipaddress.IPv4Address):
        return any(address in network for network in _RFC1918_NETWORKS)
    return address in _ULA_NETWORK


def client_is_allowed(raw_value: object, *, allow_public: bool) -> bool:
    address = normalize_client_address(raw_value)
    if not _is_valid_unicast(address):
        return False
    return bool(allow_public) or _is_private_network_address(address)


def network_settings_path(
    *,
    environment: Mapping[str, str] | None = None,
    platform_name: str | None = None,
) -> Path:
    environment = os.environ if environment is None else environment
    configured = environment.get("MEDOS_NETWORK_ACCESS_SETTINGS", "").strip()
    if configured:
        return Path(configured)

    platform_name = sys.platform if platform_name is None else platform_name
    home = Path(environment.get("HOME") or Path.home())
    if platform_name == "win32":
        local_app_data = environment.get("LOCALAPPDATA", "").strip()
        base = Path(local_app_data) if local_app_data else home / "AppData" / "Local"
        return base / "MedOS" / "network-access.json"
    if platform_name == "darwin":
        return home / "Library" / "Application Support" / "MedOS" / "network-access.json"
    xdg_config = environment.get("XDG_CONFIG_HOME", "").strip()
    base = Path(xdg_config) if xdg_config else home / ".config"
    return base / "medos" / "network-access.json"


def _has_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _is_reparse_or_symlink(path: Path, file_stat: os.stat_result | None = None) -> bool:
    if path.is_symlink():
        return True
    file_stat = os.lstat(path) if file_stat is None else file_stat
    return bool(getattr(file_stat, "st_file_attributes", 0) & _REPARSE_POINT_ATTRIBUTE)


def _absolute_lexical(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def _reject_remote_or_device_path(path: Path) -> None:
    raw = os.fspath(path)
    normalized = raw.replace("/", "\\")
    if normalized.startswith("\\\\"):
        raise OSError("settings path must be a local filesystem path")


def _validate_existing_ancestors(parent: Path) -> None:
    parent = _absolute_lexical(parent)
    chain = [parent, *parent.parents]
    for current in reversed(chain):
        try:
            current_stat = os.lstat(current)
        except FileNotFoundError:
            continue
        if _is_reparse_or_symlink(current, current_stat):
            raise OSError("settings parent traverses a link or reparse point")
        if not stat.S_ISDIR(current_stat.st_mode):
            raise OSError("settings parent traverses a non-directory")


def _windows_handle_identity(handle: int) -> tuple[int, int]:
    import ctypes
    from ctypes import wintypes

    class ByHandleFileInformation(ctypes.Structure):
        _fields_ = (
            ("FileAttributes", wintypes.DWORD),
            ("CreationTime", wintypes.FILETIME),
            ("LastAccessTime", wintypes.FILETIME),
            ("LastWriteTime", wintypes.FILETIME),
            ("VolumeSerialNumber", wintypes.DWORD),
            ("FileSizeHigh", wintypes.DWORD),
            ("FileSizeLow", wintypes.DWORD),
            ("NumberOfLinks", wintypes.DWORD),
            ("FileIndexHigh", wintypes.DWORD),
            ("FileIndexLow", wintypes.DWORD),
        )

    information = ByHandleFileInformation()
    get_information = ctypes.WinDLL("kernel32", use_last_error=True).GetFileInformationByHandle
    get_information.argtypes = (wintypes.HANDLE, ctypes.POINTER(ByHandleFileInformation))
    get_information.restype = wintypes.BOOL
    if not get_information(handle, ctypes.byref(information)):
        raise ctypes.WinError(ctypes.get_last_error())
    file_index = (information.FileIndexHigh << 32) | information.FileIndexLow
    return information.VolumeSerialNumber, file_index


def _windows_final_path(handle: int) -> Path:
    import ctypes
    from ctypes import wintypes

    get_final_path = ctypes.WinDLL(
        "kernel32", use_last_error=True
    ).GetFinalPathNameByHandleW
    get_final_path.argtypes = (
        wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
    )
    get_final_path.restype = wintypes.DWORD
    buffer = ctypes.create_unicode_buffer(32768)
    length = get_final_path(handle, buffer, len(buffer), 0)
    if not length or length >= len(buffer):
        raise ctypes.WinError(ctypes.get_last_error())
    value = "".join(buffer[:length])
    if "\0" in value:
        raise OSError("Windows returned an invalid final path")
    if value.startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    elif value.startswith("\\\\?\\"):
        value = value[4:]
    return Path(value)


class _SafeParentHandle:
    def __init__(self, parent: Path, *, lock_mutation: bool = False) -> None:
        self.parent = _absolute_lexical(parent)
        self.lock_mutation = lock_mutation
        self.fd: int | None = None
        self.windows_handle: int | None = None
        self.windows_identity: tuple[int, int] | None = None

    def __enter__(self) -> "_SafeParentHandle":
        _validate_existing_ancestors(self.parent)
        if os.name != "nt":
            flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
            self.fd = os.open(self.parent, flags)
            try:
                opened = os.fstat(self.fd)
                lexical = os.lstat(self.parent)
                if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != (
                    lexical.st_dev,
                    lexical.st_ino,
                ):
                    raise OSError("settings parent changed while opening")
            except BaseException as error:
                try:
                    os.close(self.fd)
                except BaseException as close_error:
                    if hasattr(error, "add_note"):
                        error.add_note(f"also failed to close settings parent: {close_error}")
                finally:
                    self.fd = None
                raise
            return self

        import ctypes
        from ctypes import wintypes

        create_file = ctypes.WinDLL("kernel32", use_last_error=True).CreateFileW
        create_file.argtypes = (
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        )
        create_file.restype = wintypes.HANDLE
        handle = None
        for attempt in range(100):
            handle = create_file(
                str(self.parent),
                (0x00010000 if self.lock_mutation else 0) | 0x0080 | 0x0001,
                0x00000001 | 0x00000002 | (0 if self.lock_mutation else 0x00000004),
                None,
                3,  # OPEN_EXISTING
                0x02000000 | 0x00200000,  # BACKUP_SEMANTICS | OPEN_REPARSE_POINT
                None,
            )
            if handle != wintypes.HANDLE(-1).value:
                break
            error_code = ctypes.get_last_error()
            if not self.lock_mutation or error_code not in {5, 32} or attempt == 99:
                raise ctypes.WinError(error_code)
            time.sleep(0.002)
        assert handle is not None
        self.windows_handle = int(handle)
        try:
            self.windows_identity = _windows_handle_identity(self.windows_handle)
            self.assert_safe()
        except BaseException as error:
            try:
                self.__exit__(None, None, None)
            except BaseException as close_error:
                if hasattr(error, "add_note"):
                    error.add_note(f"also failed to close settings parent: {close_error}")
            raise
        return self

    def assert_safe(self) -> None:
        if os.name == "nt":
            current = os.lstat(self.parent)
            if _is_reparse_or_symlink(self.parent, current) or not stat.S_ISDIR(current.st_mode):
                raise OSError("settings parent changed during transaction")
            import ctypes
            from ctypes import wintypes

            create_file = ctypes.WinDLL("kernel32", use_last_error=True).CreateFileW
            create_file.argtypes = (
                wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
            )
            create_file.restype = wintypes.HANDLE
            comparison = create_file(
                str(self.parent), 0x0080,
                0x00000001 | 0x00000002 | 0x00000004,
                None, 3, 0x02000000 | 0x00200000, None,
            )
            if comparison == wintypes.HANDLE(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            primary_error: BaseException | None = None
            try:
                if _windows_handle_identity(int(comparison)) != self.windows_identity:
                    raise OSError("settings parent identity changed during transaction")
            except BaseException as error:
                primary_error = error
                raise
            finally:
                close_comparison = ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle
                close_comparison.argtypes = (wintypes.HANDLE,)
                close_comparison.restype = wintypes.BOOL
                if not close_comparison(comparison):
                    close_error = ctypes.WinError(ctypes.get_last_error())
                    if primary_error is not None and hasattr(primary_error, "add_note"):
                        primary_error.add_note(
                            f"also failed to close comparison handle: {close_error}"
                        )
                    elif primary_error is None:
                        raise close_error

    def canonical_path(self) -> Path:
        if os.name == "nt":
            if self.windows_handle is None:
                raise OSError("settings parent handle is closed")
            return _windows_final_path(self.windows_handle)
        if self.fd is None:
            raise OSError("settings parent handle is closed")
        for descriptor_root in ("/proc/self/fd", "/dev/fd"):
            try:
                target = os.readlink(f"{descriptor_root}/{self.fd}")
            except OSError:
                continue
            # Descriptor links on POSIX are absolute exactly when they begin at
            # the filesystem root.  Keep this check independent of the host's
            # ``os.path`` implementation so Windows can exercise the POSIX
            # boundary faithfully in the release test suite.
            if target.endswith(" (deleted)") or not target.startswith("/"):
                raise OSError("settings parent descriptor has no stable canonical path")
            return Path(target)
        raise OSError("settings parent descriptor cannot be canonicalized safely")

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self.windows_handle is not None:
            import ctypes
            from ctypes import wintypes

            close_handle = ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle
            close_handle.argtypes = (wintypes.HANDLE,)
            close_handle.restype = wintypes.BOOL
            handle = self.windows_handle
            self.windows_handle = None
            self.windows_identity = None
            if not close_handle(handle):
                raise ctypes.WinError(ctypes.get_last_error())


@lru_cache(maxsize=1)
def _windows_directory() -> Path:
    if os.name != "nt":
        return Path(os.environ.get("SystemRoot", r"C:\Windows"))
    import ctypes
    from ctypes import wintypes

    buffer = ctypes.create_unicode_buffer(32768)
    get_windows_directory = ctypes.WinDLL("kernel32", use_last_error=True).GetWindowsDirectoryW
    get_windows_directory.argtypes = (wintypes.LPWSTR, wintypes.UINT)
    get_windows_directory.restype = wintypes.UINT
    length = get_windows_directory(buffer, len(buffer))
    if not length or length >= len(buffer):
        raise ctypes.WinError(ctypes.get_last_error())
    result = Path(buffer.value)
    if not result.is_absolute() or not result.is_dir():
        raise OSError("canonical Windows directory is invalid")
    return result


@lru_cache(maxsize=1)
def _windows_local_application_data() -> Path:
    if os.name != "nt":
        raise OSError("trusted LocalAppData is available only on Windows")
    import ctypes
    from ctypes import wintypes

    buffer = ctypes.create_unicode_buffer(32768)
    get_folder_path = ctypes.WinDLL("shell32", use_last_error=True).SHGetFolderPathW
    get_folder_path.argtypes = (
        wintypes.HWND,
        ctypes.c_int,
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
    )
    get_folder_path.restype = ctypes.c_long
    # CSIDL_LOCAL_APPDATA is resolved by the shell rather than LOCALAPPDATA/TEMP/TMP.
    result = get_folder_path(None, 0x1C, None, 0, buffer)
    if result != 0 or not buffer.value:
        raise OSError("could not resolve trusted Windows LocalAppData")
    path = _absolute_lexical(Path(buffer.value))
    _reject_remote_or_device_path(path)
    _validate_existing_ancestors(path)
    path_stat = os.lstat(path)
    if _is_reparse_or_symlink(path, path_stat) or not stat.S_ISDIR(path_stat.st_mode):
        raise OSError("trusted Windows LocalAppData is unsafe")
    with _SafeParentHandle(path) as handle:
        canonical = handle.canonical_path()
    if os.path.normcase(os.path.abspath(os.fspath(canonical))) != os.path.normcase(
        os.path.abspath(os.fspath(path))
    ):
        raise OSError("trusted Windows LocalAppData changed during validation")
    return path


def _windows_operation_root() -> Path:
    root = _windows_local_application_data() / "MedOS" / "NetworkOperations"
    _ensure_safe_parent(root)
    _validate_existing_ancestors(root)
    with _SafeParentHandle(root) as handle:
        canonical = handle.canonical_path()
    if os.path.normcase(os.path.abspath(os.fspath(canonical))) != os.path.normcase(
        os.path.abspath(os.fspath(root))
    ):
        raise OSError("Windows operation root changed during validation")
    return root


def _windows_helper_temp_directory() -> Path:
    helper_temp = _windows_local_application_data() / "MedOS" / "Temp"
    _ensure_safe_parent(helper_temp)
    _validate_existing_ancestors(helper_temp)
    with _SafeParentHandle(helper_temp) as handle:
        canonical = handle.canonical_path()
    if os.path.normcase(os.path.abspath(os.fspath(canonical))) != os.path.normcase(
        os.path.abspath(os.fspath(helper_temp))
    ):
        raise OSError("Windows helper temp changed during validation")
    return helper_temp


def _validate_windows_operation_directory(path: Path) -> None:
    _reject_remote_or_device_path(path)
    candidate = _absolute_lexical(path)
    root = _windows_operation_root()
    if candidate.parent != root or not re.fullmatch(
        r"operation-[a-f0-9]{32}", candidate.name
    ):
        raise OSError("network operation directory is outside the trusted root")
    _validate_existing_ancestors(candidate)
    candidate_stat = os.lstat(candidate)
    if _is_reparse_or_symlink(candidate, candidate_stat) or not stat.S_ISDIR(
        candidate_stat.st_mode
    ):
        raise OSError("network operation directory is unsafe")
    with _SafeParentHandle(candidate) as handle:
        canonical = handle.canonical_path()
    if os.path.normcase(os.path.abspath(os.fspath(canonical))) != os.path.normcase(
        os.path.abspath(os.fspath(candidate))
    ):
        raise OSError("network operation directory changed during validation")


def _create_windows_operation_directory() -> Path:
    root = _windows_operation_root()
    for _attempt in range(100):
        candidate = root / f"operation-{secrets.token_hex(16)}"
        try:
            os.mkdir(candidate, 0o700)
        except FileExistsError:
            continue
        try:
            _validate_windows_operation_directory(candidate)
        except BaseException:
            shutil.rmtree(candidate, ignore_errors=True)
            raise
        return candidate
    raise OSError("could not allocate a unique network operation directory")


@lru_cache(maxsize=1)
def _current_windows_sid() -> str:
    windows_root = _windows_directory()
    whoami = windows_root / "System32" / "whoami.exe"
    completed = subprocess.run(
        [str(whoami), "/user", "/fo", "csv", "/nh"],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
    )
    if completed.returncode != 0:
        raise OSError("could not identify the current Windows user")
    try:
        import csv

        row = next(csv.reader([completed.stdout.strip()]))
        sid = row[1].strip()
    except (IndexError, StopIteration, csv.Error) as error:
        raise OSError("could not parse the current Windows user") from error
    if not sid.startswith("S-1-"):
        raise OSError("current Windows user SID is invalid")
    return sid


def _windows_acl_entries_from_handle(
    descriptor: int,
) -> tuple[str, list[tuple[str, int, int]], bool]:
    import ctypes
    import msvcrt
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = (wintypes.HLOCAL,)
    kernel.LocalFree.restype = wintypes.HLOCAL
    owner = ctypes.c_void_p()
    dacl = ctypes.c_void_p()
    security_descriptor = ctypes.c_void_p()
    get_security = advapi.GetSecurityInfo
    get_security.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
    )
    result = get_security(
        msvcrt.get_osfhandle(descriptor), 1, 0x00000001 | 0x00000004,
        ctypes.byref(owner), None, ctypes.byref(dacl), None,
        ctypes.byref(security_descriptor),
    )
    if result != 0:
        raise ctypes.WinError(result)

    convert_sid = advapi.ConvertSidToStringSidW
    convert_sid.argtypes = (ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR))
    convert_sid.restype = wintypes.BOOL

    def sid_text(pointer: int) -> str:
        value = wintypes.LPWSTR()
        if not convert_sid(pointer, ctypes.byref(value)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return value.value
        finally:
            kernel.LocalFree(value)

    class AclSizeInformation(ctypes.Structure):
        _fields_ = (
            ("AceCount", wintypes.DWORD),
            ("AclBytesInUse", wintypes.DWORD),
            ("AclBytesFree", wintypes.DWORD),
        )

    entries: list[tuple[str, int, int]] = []
    try:
        owner_text = sid_text(owner.value)
        control = wintypes.WORD()
        revision = wintypes.DWORD()
        get_control = advapi.GetSecurityDescriptorControl
        get_control.argtypes = (
            ctypes.c_void_p, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.DWORD),
        )
        get_control.restype = wintypes.BOOL
        if not get_control(
            security_descriptor, ctypes.byref(control), ctypes.byref(revision)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        dacl_protected = bool(control.value & 0x1000)
        if not dacl.value:
            return owner_text, entries, dacl_protected
        information = AclSizeInformation()
        advapi.GetAclInformation.argtypes = (
            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
        )
        advapi.GetAclInformation.restype = wintypes.BOOL
        advapi.GetAce.argtypes = (
            ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p),
        )
        advapi.GetAce.restype = wintypes.BOOL
        if not advapi.GetAclInformation(
            dacl, ctypes.byref(information), ctypes.sizeof(information), 2
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        for index in range(information.AceCount):
            ace = ctypes.c_void_p()
            if not advapi.GetAce(dacl, index, ctypes.byref(ace)):
                raise ctypes.WinError(ctypes.get_last_error())
            address = ace.value
            ace_type = ctypes.c_ubyte.from_address(address).value
            ace_flags = ctypes.c_ubyte.from_address(address + 1).value
            access_mask = ctypes.c_uint32.from_address(address + 4).value
            entries.append((sid_text(address + 8), ace_type, ace_flags | (access_mask << 8)))
        return owner_text, entries, dacl_protected
    finally:
        if security_descriptor.value:
            kernel.LocalFree(security_descriptor)


def _windows_acl_entries(path: Path) -> tuple[str, list[tuple[str, int, int]], bool]:
    descriptor = _open_windows_file_no_follow(path)
    try:
        return _windows_acl_entries_from_handle(descriptor)
    finally:
        os.close(descriptor)


def _verify_windows_file_security(path: Path) -> None:
    current_sid = _current_windows_sid()
    owner, packed_entries, dacl_protected = _windows_acl_entries(path)
    _validate_windows_acl(current_sid, owner, packed_entries, dacl_protected)


def _verify_windows_file_security_handle(descriptor: int) -> None:
    current_sid = _current_windows_sid()
    owner, packed_entries, dacl_protected = _windows_acl_entries_from_handle(descriptor)
    _validate_windows_acl(current_sid, owner, packed_entries, dacl_protected)


def _validate_windows_acl(
    current_sid: str,
    owner: str,
    packed_entries: list[tuple[str, int, int]],
    dacl_protected: bool,
) -> None:
    expected_sids = {current_sid, "S-1-5-18", "S-1-5-32-544"}
    if owner != current_sid or len(packed_entries) != 3 or not dacl_protected:
        raise OSError("settings file Windows security is not private")
    actual_sids: set[str] = set()
    for sid, ace_type, packed in packed_entries:
        ace_flags = packed & 0xFF
        access_mask = packed >> 8
        if ace_type != 0 or ace_flags != 0 or access_mask != _WINDOWS_FULL_CONTROL:
            raise OSError("settings file Windows security is not private")
        actual_sids.add(sid)
    if actual_sids != expected_sids:
        raise OSError("settings file Windows security is not private")


def _secure_windows_file(path: Path) -> None:
    current_sid = _current_windows_sid()
    windows_root = _windows_directory()
    icacls = windows_root / "System32" / "icacls.exe"
    completed = subprocess.run(
        [
            str(icacls), str(path), "/inheritance:r", "/grant:r",
            f"*{current_sid}:(F)", "*S-1-5-18:(F)", "*S-1-5-32-544:(F)", "/Q",
        ],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
    )
    if completed.returncode != 0:
        raise OSError("could not restrict settings file Windows security")
    _verify_windows_file_security(path)


def _create_windows_private_file(path: Path) -> int:
    """Create a new file whose exact protected DACL exists before its first byte."""
    import ctypes
    import msvcrt
    from ctypes import wintypes

    current_sid = _current_windows_sid()
    descriptor = ctypes.c_void_p()
    sddl = (
        f"O:{current_sid}D:P"
        f"(A;;FA;;;{current_sid})(A;;FA;;;SY)(A;;FA;;;BA)"
    )
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    convert = advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p,
    )
    convert.restype = wintypes.BOOL
    if not convert(sddl, 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())

    class SecurityAttributes(ctypes.Structure):
        _fields_ = (
            ("nLength", wintypes.DWORD),
            ("lpSecurityDescriptor", ctypes.c_void_p),
            ("bInheritHandle", wintypes.BOOL),
        )

    security = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
    create_file = kernel.CreateFileW
    create_file.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        ctypes.POINTER(SecurityAttributes), wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    )
    create_file.restype = wintypes.HANDLE
    try:
        handle = create_file(
            str(path), 0xC0010000, 0x00000001, ctypes.byref(security),
            1, 0x00000080 | 0x00200000, None,
        )
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.LocalFree(descriptor)
    try:
        return msvcrt.open_osfhandle(
            int(handle), os.O_RDWR | getattr(os, "O_BINARY", 0)
        )
    except BaseException:
        kernel.CloseHandle(handle)
        raise


def _open_windows_file_no_follow(path: Path, *, writable: bool = False) -> int:
    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel.CreateFileW
    create_file.argtypes = (
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    )
    create_file.restype = wintypes.HANDLE
    access = 0xC0000000 if writable else 0x80000000
    handle = create_file(
        str(path), access, 0x00000001 | 0x00000002 | 0x00000004,
        None, 3, 0x00200000, None
    )
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        attributes = _windows_handle_attributes(int(handle))
    except BaseException:
        kernel.CloseHandle(handle)
        raise
    if attributes & (_REPARSE_POINT_ATTRIBUTE | 0x10):
        kernel.CloseHandle(handle)
        raise OSError("settings path is a reparse point or directory")
    try:
        flags = (os.O_RDWR if writable else os.O_RDONLY) | getattr(os, "O_BINARY", 0)
        return msvcrt.open_osfhandle(int(handle), flags)
    except BaseException:
        kernel.CloseHandle(handle)
        raise


def _windows_handle_attributes(handle: int) -> int:
    import ctypes
    from ctypes import wintypes

    class ByHandleFileInformation(ctypes.Structure):
        _fields_ = (
            ("FileAttributes", wintypes.DWORD),
            ("CreationTime", wintypes.FILETIME),
            ("LastAccessTime", wintypes.FILETIME),
            ("LastWriteTime", wintypes.FILETIME),
            ("VolumeSerialNumber", wintypes.DWORD),
            ("FileSizeHigh", wintypes.DWORD),
            ("FileSizeLow", wintypes.DWORD),
            ("NumberOfLinks", wintypes.DWORD),
            ("FileIndexHigh", wintypes.DWORD),
            ("FileIndexLow", wintypes.DWORD),
        )

    information = ByHandleFileInformation()
    get_information = ctypes.WinDLL("kernel32", use_last_error=True).GetFileInformationByHandle
    get_information.argtypes = (wintypes.HANDLE, ctypes.POINTER(ByHandleFileInformation))
    get_information.restype = wintypes.BOOL
    if not get_information(handle, ctypes.byref(information)):
        raise ctypes.WinError(ctypes.get_last_error())
    return int(information.FileAttributes)


def _replace_windows_file_handle(descriptor: int, destination: Path) -> None:
    import ctypes
    import msvcrt
    from ctypes import wintypes

    destination_text = str(destination)

    class FileRenameInformation(ctypes.Structure):
        _fields_ = (
            ("Flags", wintypes.DWORD),
            ("RootDirectory", wintypes.HANDLE),
            ("FileNameLength", wintypes.DWORD),
            ("FileName", wintypes.WCHAR * (len(destination_text) + 1)),
        )

    information = FileRenameInformation()
    information.Flags = 0x00000001
    information.RootDirectory = None
    information.FileNameLength = len(destination_text.encode("utf-16-le"))
    information.FileName = destination_text
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    set_information = kernel.SetFileInformationByHandle
    set_information.argtypes = (
        wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
    )
    set_information.restype = wintypes.BOOL
    for attempt in range(100):
        if set_information(
            msvcrt.get_osfhandle(descriptor),
            22,
            ctypes.byref(information),
            FileRenameInformation.FileName.offset + information.FileNameLength,
        ):
            return
        error_code = ctypes.get_last_error()
        if error_code not in {5, 32} or attempt == 99:
            raise ctypes.WinError(error_code)
        time.sleep(0.002)


def _read_settings_bytes_once(path: Path) -> bytes:
    path = _absolute_lexical(path)
    _validate_existing_ancestors(path.parent)
    with _SafeParentHandle(path.parent) as parent_handle:
        _assert_canonical_settings_location(parent_handle, Path(path.name))
        if os.name != "nt":
            assert parent_handle.fd is not None
            before = os.stat(path.name, dir_fd=parent_handle.fd, follow_symlinks=False)
            flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path.name, flags, dir_fd=parent_handle.fd)
        else:
            before = os.lstat(path)
            descriptor = _open_windows_file_no_follow(path)
        if _is_reparse_or_symlink(path, before) or not stat.S_ISREG(before.st_mode):
            os.close(descriptor)
            raise OSError("settings path is not a safe regular file")
        if getattr(before, "st_nlink", 1) != 1:
            os.close(descriptor)
            raise OSError("settings path must have exactly one link")
        if os.name != "nt" and stat.S_IMODE(before.st_mode) != 0o600:
            os.close(descriptor)
            raise OSError("settings permissions are not private")
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode):
                raise OSError("settings descriptor is not a regular file")
            if getattr(opened, "st_nlink", 1) != 1:
                raise OSError("settings descriptor must have exactly one link")
            if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                raise _SettingsReadRace("settings file changed while opening")
            if os.name == "nt":
                _verify_windows_file_security_handle(descriptor)
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = os.read(descriptor, 4097 - total)
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > 4096:
                    raise OSError("settings file is too large")
            if os.name != "nt":
                after = os.stat(path.name, dir_fd=parent_handle.fd, follow_symlinks=False)
            else:
                parent_handle.assert_safe()
                after = os.lstat(path)
            if _is_reparse_or_symlink(path, after) or (opened.st_dev, opened.st_ino) != (
                after.st_dev,
                after.st_ino,
            ):
                raise _SettingsReadRace("settings file changed while reading")
            if getattr(after, "st_nlink", 1) != 1:
                raise OSError("settings path link count changed while reading")
        finally:
            os.close(descriptor)
    return b"".join(chunks)


def _read_settings_bytes(path: Path) -> bytes:
    for attempt in range(100):
        try:
            return _read_settings_bytes_once(path)
        except FileNotFoundError:
            if attempt >= 2:
                raise
            time.sleep(0.002)
        except (PermissionError, _SettingsReadRace):
            if attempt == 99:
                raise
            time.sleep(0.002)
    raise OSError("settings file remained unavailable")


def _assert_canonical_settings_location(
    parent_handle: _SafeParentHandle, relative_suffix: Path
) -> None:
    protected = _INSTALL_ROOT.resolve(strict=True)
    candidate = parent_handle.canonical_path() / relative_suffix
    candidate_key = os.path.normcase(os.path.abspath(os.fspath(candidate)))
    protected_key = os.path.normcase(os.path.abspath(os.fspath(protected)))
    try:
        common = os.path.commonpath((candidate_key, protected_key))
    except ValueError:
        return
    if common == protected_key:
        raise OSError("settings path must be outside the install tree")


def _assert_external_settings_location(path: Path) -> None:
    _reject_remote_or_device_path(path)
    lexical = _absolute_lexical(path)
    _validate_existing_ancestors(lexical.parent)
    try:
        final_stat = os.lstat(lexical)
    except FileNotFoundError:
        final_stat = None
    if final_stat is not None and _is_reparse_or_symlink(lexical, final_stat):
        raise OSError("settings path is a link or reparse point")
    existing_parent = lexical.parent
    missing_parts: list[str] = []
    while True:
        try:
            existing_stat = os.lstat(existing_parent)
        except FileNotFoundError:
            missing_parts.append(existing_parent.name)
            if existing_parent == existing_parent.parent:
                raise OSError("settings path has no existing local ancestor")
            existing_parent = existing_parent.parent
            continue
        if not stat.S_ISDIR(existing_stat.st_mode):
            raise OSError("settings parent traverses a non-directory")
        break
    suffix = Path(*reversed(missing_parts), lexical.name)
    with _SafeParentHandle(existing_parent) as parent_handle:
        _assert_canonical_settings_location(parent_handle, suffix)


def load_network_settings(path: str | os.PathLike[str] | None = None) -> NetworkSettings:
    settings_path = network_settings_path() if path is None else Path(path)
    try:
        _assert_external_settings_location(settings_path)
    except (OSError, TypeError, ValueError):
        return NetworkSettings(False, False, True)
    try:
        raw = _read_settings_bytes(settings_path)
    except FileNotFoundError:
        return NetworkSettings(False, True, False, source_missing=True)
    except OSError:
        return NetworkSettings(False, False, True)
    try:
        payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_has_duplicate_keys)
        if not isinstance(payload, dict) or set(payload) != {"version", "allow_public"}:
            raise ValueError("unexpected settings schema")
        if type(payload["version"]) is not int or payload["version"] != SETTINGS_VERSION:
            raise ValueError("unsupported settings version")
        if type(payload["allow_public"]) is not bool:
            raise ValueError("allow_public must be a boolean")
        return NetworkSettings(payload["allow_public"], True, False)
    except (UnicodeError, ValueError, TypeError, json.JSONDecodeError):
        return NetworkSettings(False, False, True)


def _default_write(file_object, payload: bytes) -> None:
    written = file_object.write(payload)
    if written != len(payload):
        raise OSError("short settings write")


def _ensure_safe_parent(parent: Path) -> None:
    parent = _absolute_lexical(parent)
    _validate_existing_ancestors(parent)
    current = Path(parent.anchor)
    for component in parent.parts[1:]:
        child = current / component
        try:
            child_stat = os.lstat(child)
        except FileNotFoundError:
            with _SafeParentHandle(current, lock_mutation=True) as current_handle:
                if os.name != "nt":
                    assert current_handle.fd is not None
                    os.mkdir(component, 0o700, dir_fd=current_handle.fd)
                else:
                    current_handle.assert_safe()
                    os.mkdir(child, 0o700)
        else:
            if _is_reparse_or_symlink(child, child_stat) or not stat.S_ISDIR(child_stat.st_mode):
                raise OSError("settings parent traverses a link, reparse point, or non-directory")
        current = child
    _validate_existing_ancestors(parent)
    if os.name != "nt":
        with _SafeParentHandle(parent, lock_mutation=True) as parent_handle:
            assert parent_handle.fd is not None
            os.fchmod(parent_handle.fd, 0o700)


def _fsync_parent(parent: Path, *, descriptor: int | None = None) -> None:
    if descriptor is None and not hasattr(os, "O_DIRECTORY"):
        return
    try:
        opened_here = descriptor is None
        if descriptor is None:
            descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            if opened_here:
                os.close(descriptor)
    except OSError as error:
        unsupported = {errno.EINVAL}
        for name in ("ENOTSUP", "EOPNOTSUPP"):
            value = getattr(errno, name, None)
            if value is not None:
                unsupported.add(value)
        if error.errno not in unsupported:
            raise


def _restore_prior_settings(
    settings_path: Path,
    prior_payload: bytes | None,
    parent_handle: _SafeParentHandle,
) -> None:
    if os.name != "nt":
        assert parent_handle.fd is not None
        if prior_payload is None:
            try:
                os.unlink(settings_path.name, dir_fd=parent_handle.fd)
            except FileNotFoundError:
                pass
            return
        restore_name = f".{settings_path.name}.{secrets.token_hex(16)}.restore"
        descriptor = -1
        try:
            descriptor = os.open(
                restore_name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o600,
                dir_fd=parent_handle.fd,
            )
            offset = 0
            while offset < len(prior_payload):
                written = os.write(descriptor, prior_payload[offset:])
                if written <= 0:
                    raise OSError("short settings restoration write")
                offset += written
            os.fsync(descriptor)
            os.fchmod(descriptor, 0o600)
            os.close(descriptor)
            descriptor = -1
            os.replace(
                restore_name,
                settings_path.name,
                src_dir_fd=parent_handle.fd,
                dst_dir_fd=parent_handle.fd,
            )
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                os.unlink(restore_name, dir_fd=parent_handle.fd)
            except FileNotFoundError:
                pass
        return

    parent_handle.assert_safe()
    if prior_payload is None:
        settings_path.unlink(missing_ok=True)
        return
    restore_path = settings_path.parent / f".{settings_path.name}.{secrets.token_hex(16)}.restore"
    descriptor = -1
    try:
        descriptor = _create_windows_private_file(restore_path)
        with os.fdopen(descriptor, "wb", closefd=False) as restore_file:
            written = restore_file.write(prior_payload)
            if written != len(prior_payload):
                raise OSError("short settings restoration write")
            restore_file.flush()
            os.fsync(descriptor)
        _verify_windows_file_security_handle(descriptor)
        os.lseek(descriptor, 0, os.SEEK_SET)
        if os.read(descriptor, len(prior_payload) + 1) != prior_payload:
            raise OSError("settings restoration content changed before publication")
        _replace_windows_file_handle(descriptor, settings_path)
        os.close(descriptor)
        descriptor = -1
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        restore_path.unlink(missing_ok=True)


def _read_prior_payload_locked(
    settings_path: Path,
    parent_handle: _SafeParentHandle,
) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    if os.name != "nt":
        assert parent_handle.fd is not None
        before = os.stat(settings_path.name, dir_fd=parent_handle.fd, follow_symlinks=False)
        descriptor = os.open(settings_path.name, flags, dir_fd=parent_handle.fd)
    else:
        parent_handle.assert_safe()
        before = os.lstat(settings_path)
        descriptor = _open_windows_file_no_follow(settings_path)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (
            opened.st_dev,
            opened.st_ino,
        ):
            raise _SettingsReadRace("settings file changed while capturing prior bytes")
        if os.name == "nt":
            _verify_windows_file_security_handle(descriptor)
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(descriptor, 4097 - total)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > 4096:
                raise OSError("settings file is too large")
        if os.name == "nt":
            after = os.lstat(settings_path)
            if _is_reparse_or_symlink(settings_path, after) or (
                opened.st_dev, opened.st_ino
            ) != (after.st_dev, after.st_ino):
                raise _SettingsReadRace("settings file changed while capturing prior bytes")
    finally:
        os.close(descriptor)
    return b"".join(chunks)


def atomic_write_network_settings(
    path: str | os.PathLike[str],
    allow_public: bool,
    *,
    write_fn: Callable[[Any, bytes], None] = _default_write,
    fsync_fn: Callable[[int], None] = os.fsync,
    replace_fn: Callable[[str | os.PathLike[str], str | os.PathLike[str]], None] = os.replace,
) -> None:
    if type(allow_public) is not bool:
        raise TypeError("allow_public must be a boolean")
    settings_path = _absolute_lexical(Path(path))
    _assert_external_settings_location(settings_path)
    _ensure_safe_parent(settings_path.parent)
    payload = (
        b'{"version":1,"allow_public":true}\n'
        if allow_public
        else b'{"version":1,"allow_public":false}\n'
    )
    with _SafeParentHandle(settings_path.parent, lock_mutation=True) as parent_handle:
        _assert_canonical_settings_location(parent_handle, Path(settings_path.name))
        prior_payload: bytes | None = None
        try:
            existing = os.lstat(settings_path)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if _is_reparse_or_symlink(settings_path, existing) or not stat.S_ISREG(existing.st_mode):
                raise OSError("refusing to replace unsafe settings path")
            if os.name != "nt" and stat.S_IMODE(existing.st_mode) != 0o600:
                raise OSError("refusing to replace settings with unsafe permissions")
            prior_payload = _read_prior_payload_locked(settings_path, parent_handle)

        temporary_name = f".{settings_path.name}.{secrets.token_hex(16)}.tmp"
        temporary_path = settings_path.parent / temporary_name
        flags = (
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        descriptor = -1
        published = False
        try:
            if os.name != "nt":
                assert parent_handle.fd is not None
                descriptor = os.open(temporary_name, flags, 0o600, dir_fd=parent_handle.fd)
            else:
                parent_handle.assert_safe()
                descriptor = _create_windows_private_file(temporary_path)
            if os.name != "nt":
                os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb", closefd=False) as file_object:
                write_fn(file_object, payload)
                file_object.flush()
                fsync_fn(descriptor)
            if os.name == "nt":
                parent_handle.assert_safe()
                _verify_windows_file_security_handle(descriptor)
                os.lseek(descriptor, 0, os.SEEK_SET)
                verified_payload = os.read(descriptor, len(payload) + 1)
                if verified_payload != payload:
                    raise OSError("settings temporary content changed before publication")
            if os.name != "nt":
                os.close(descriptor)
                descriptor = -1
            _assert_canonical_settings_location(
                parent_handle, Path(settings_path.name)
            )
            if replace_fn is os.replace and os.name != "nt":
                assert parent_handle.fd is not None
                os.replace(
                    temporary_name,
                    settings_path.name,
                    src_dir_fd=parent_handle.fd,
                    dst_dir_fd=parent_handle.fd,
                )
                published = True
            elif replace_fn is os.replace:
                parent_handle.assert_safe()
                _replace_windows_file_handle(descriptor, settings_path)
                published = True
                parent_handle.assert_safe()
                _verify_windows_file_security_handle(descriptor)
                published_stat = os.lstat(settings_path)
                if _is_reparse_or_symlink(settings_path, published_stat):
                    raise OSError("published settings identity changed")
                import msvcrt

                published_handle = msvcrt.get_osfhandle(descriptor)
                if _windows_handle_attributes(published_handle) & (
                    _REPARSE_POINT_ATTRIBUTE | 0x10
                ):
                    raise OSError("published settings identity changed")
                published_path = _windows_final_path(published_handle)
                if os.path.normcase(os.path.abspath(os.fspath(published_path))) != os.path.normcase(
                    os.path.abspath(os.fspath(settings_path))
                ):
                    raise OSError(
                        f"published settings identity changed: {published_path} != {settings_path}"
                    )
            else:
                if os.name == "nt":
                    os.close(descriptor)
                    descriptor = -1
                for attempt in range(100):
                    try:
                        parent_handle.assert_safe()
                        replace_fn(temporary_path, settings_path)
                        break
                    except PermissionError:
                        if replace_fn is not os.replace or attempt == 99:
                            raise
                        time.sleep(0.002)
                published = True
            _assert_canonical_settings_location(
                parent_handle, Path(settings_path.name)
            )
            if os.name == "nt":
                parent_handle.assert_safe()
                if descriptor >= 0:
                    _verify_windows_file_security_handle(descriptor)
                else:
                    _verify_windows_file_security(settings_path)
            _fsync_parent(
                settings_path.parent,
                descriptor=parent_handle.fd if os.name != "nt" else None,
            )
            if os.name == "nt" and descriptor >= 0:
                closing_descriptor = descriptor
                descriptor = -1
                os.close(closing_descriptor)
        except Exception as error:
            if published:
                if descriptor >= 0:
                    closing_descriptor = descriptor
                    descriptor = -1
                    try:
                        os.close(closing_descriptor)
                    except Exception as close_error:
                        if hasattr(error, "add_note"):
                            error.add_note(
                                f"published settings handle also failed to close: {close_error}"
                            )
                try:
                    _restore_prior_settings(settings_path, prior_payload, parent_handle)
                    _fsync_parent(
                        settings_path.parent,
                        descriptor=parent_handle.fd if os.name != "nt" else None,
                    )
                except Exception as restore_error:
                    if hasattr(error, "add_note"):
                        error.add_note(f"settings restoration also failed: {restore_error}")
            raise
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            if os.name != "nt" and parent_handle.fd is not None:
                try:
                    os.unlink(temporary_name, dir_fd=parent_handle.fd)
                except FileNotFoundError:
                    pass
            else:
                temporary_path.unlink(missing_ok=True)


class WindowsNetworkPolicyApplier:
    """Apply the fixed Windows firewall helper without a command shell."""

    def __init__(
        self,
        *,
        helper_path: str | os.PathLike[str] | None = None,
        runner: Callable[..., Any] = subprocess.run,
        powershell_executable: str | None = None,
        timeout_seconds: int = 45,
        terminal_wait_seconds: float = 10.0,
        platform_name: str | None = None,
    ) -> None:
        self.helper_path = (
            Path(__file__).resolve().parents[1] / "Set-MedOSNetworkAccess.ps1"
            if helper_path is None
            else Path(helper_path)
        )
        self.runner = runner
        self.timeout_seconds = timeout_seconds
        self.terminal_wait_seconds = terminal_wait_seconds
        self._retained_operation_directories: list[Path] = []
        self.platform_name = sys.platform if platform_name is None else platform_name
        self.powershell_executable = (
            _canonical_powershell_executable(powershell_executable)
            if self.platform_name == "win32"
            else (powershell_executable or "powershell.exe")
        )

    @property
    def retained_operation_directories(self) -> tuple[Path, ...]:
        return tuple(self._retained_operation_directories)

    def _write_operation_marker(
        self, operation_directory: Path, name: str, payload: str
    ) -> None:
        marker = operation_directory / name
        descriptor = -1
        try:
            descriptor = os.open(
                marker,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o600,
            )
            encoded = payload.encode("ascii")
            if os.write(descriptor, encoded) != len(encoded):
                raise OSError("short network operation marker write")
            os.fsync(descriptor)
        finally:
            if descriptor >= 0:
                os.close(descriptor)

    def _read_operation_marker(
        self, operation_directory: Path, name: str
    ) -> str | None:
        marker = operation_directory / name
        try:
            marker_stat = os.lstat(marker)
        except FileNotFoundError:
            return None
        if _is_reparse_or_symlink(marker, marker_stat) or not stat.S_ISREG(marker_stat.st_mode):
            raise OSError("network operation marker is unsafe")
        descriptor = (
            _open_windows_file_no_follow(marker)
            if os.name == "nt"
            else os.open(marker, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        )
        try:
            opened = os.fstat(descriptor)
            if (marker_stat.st_dev, marker_stat.st_ino) != (opened.st_dev, opened.st_ino):
                raise OSError("network operation marker changed while opening")
            payload = os.read(descriptor, 257)
            if len(payload) > 256:
                raise OSError("network operation marker is oversized")
            return payload.decode("ascii").strip()
        except UnicodeError as error:
            raise OSError("network operation marker is invalid") from error
        finally:
            os.close(descriptor)

    def _retain_operation_directory(self, operation_directory: Path) -> None:
        if operation_directory not in self._retained_operation_directories:
            self._retained_operation_directories.append(operation_directory)

    def _signal_cancellation(
        self, operation_directory: Path, operation_token: str
    ) -> None:
        try:
            self._write_operation_marker(
                operation_directory, "cancel", operation_token + "\n"
            )
        except FileExistsError:
            if self._read_operation_marker(operation_directory, "cancel") != operation_token:
                raise OSError("network operation cancel marker is unauthenticated")

    def _run_cooperatively(
        self,
        arguments: list[str],
        kwargs: dict[str, Any],
        operation_directory: Path,
        operation_token: str,
        allow_public: bool,
    ) -> Any:
        popen_kwargs = {
            key: value
            for key, value in kwargs.items()
            if key not in {"capture_output", "timeout", "check"}
        }
        _validate_windows_operation_directory(operation_directory)
        process = subprocess.Popen(
            arguments,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **popen_kwargs,
        )
        try:
            stdout, stderr = process.communicate(timeout=self.timeout_seconds)
        except subprocess.TimeoutExpired as error:
            try:
                self._signal_cancellation(operation_directory, operation_token)
            except OSError as marker_error:
                self._retain_operation_directory(operation_directory)
                raise NetworkPolicyTimeout(
                    "network policy helper cancellation state is unknown",
                    outcome_unknown=True,
                ) from marker_error
            try:
                stdout, stderr = process.communicate(timeout=self.terminal_wait_seconds)
            except subprocess.TimeoutExpired as terminal_error:
                self._retain_operation_directory(operation_directory)
                raise NetworkPolicyTimeout(
                    "network policy helper timed out without a terminal process exit",
                    outcome_unknown=True,
                ) from terminal_error
            completed = subprocess.CompletedProcess(
                arguments, process.returncode, stdout, stderr
            )
            if completed.returncode == 10:
                raise NetworkPolicyTimeout(
                    "network policy helper timed out and restored its snapshot",
                    outcome_unknown=False,
                ) from error
            if completed.returncode == 11:
                self._retain_operation_directory(operation_directory)
                raise NetworkPolicyTimeout(
                    "network policy helper timed out with an unknown outcome",
                    outcome_unknown=True,
                )
            return completed
        return subprocess.CompletedProcess(arguments, process.returncode, stdout, stderr)

    def _run(self, allow_public: bool | None) -> EffectiveNetworkPolicy:
        if self.platform_name != "win32":
            raise NetworkPolicyError("network access changes are unsupported on this platform")
        arguments = [
            self.powershell_executable,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(self.helper_path),
        ]
        if allow_public is None:
            arguments.append("-ReadEffective")
        else:
            arguments.extend(["-Mode", "public" if allow_public else "private"])
        operation_directory: Path | None = None
        try:
            operation_directory = _create_windows_operation_directory()
            _validate_windows_operation_directory(operation_directory)
            helper_temp = _windows_helper_temp_directory()
        except OSError as error:
            if operation_directory is not None:
                shutil.rmtree(operation_directory, ignore_errors=True)
            raise NetworkPolicyError(
                "trusted network operation state is unavailable"
            ) from error
        operation_token = secrets.token_hex(32)
        helper_environment = {
            key: value
            for key, value in os.environ.items()
            if not key.upper().startswith("MEDOS_NETWORK_")
            and key.upper() not in {"TEMP", "TMP", "TMPDIR"}
        }
        helper_environment.update(
            {
                "SystemRoot": str(_windows_directory()),
                "WINDIR": str(_windows_directory()),
                "MEDOS_NETWORK_OPERATION_DIRECTORY": str(operation_directory),
                "MEDOS_NETWORK_OPERATION_TOKEN": operation_token,
                "TEMP": str(helper_temp),
                "TMP": str(helper_temp),
                "TMPDIR": str(helper_temp),
            }
        )
        kwargs: dict[str, Any] = {
            "capture_output": True,
            "text": True,
            "timeout": self.timeout_seconds,
            "check": False,
            "shell": False,
            "env": helper_environment,
        }
        if self.platform_name == "win32":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            if hasattr(subprocess, "STARTUPINFO"):
                startup_info = subprocess.STARTUPINFO()
                startup_info.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
                startup_info.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
                kwargs["startupinfo"] = startup_info
        try:
            if self.runner is subprocess.run:
                completed = self._run_cooperatively(
                    arguments,
                    kwargs,
                    operation_directory,
                    operation_token,
                    bool(allow_public),
                )
            else:
                _validate_windows_operation_directory(operation_directory)
                completed = self.runner(arguments, **kwargs)
        except NetworkPolicyTimeout as error:
            if error.outcome_unknown:
                self._retain_operation_directory(operation_directory)
            else:
                shutil.rmtree(operation_directory, ignore_errors=True)
            raise
        except subprocess.TimeoutExpired as error:
            try:
                self._signal_cancellation(operation_directory, operation_token)
            except OSError:
                self._retain_operation_directory(operation_directory)
                raise NetworkPolicyTimeout(
                    "network policy helper cancellation state is unknown",
                    outcome_unknown=True,
                ) from error
            time.sleep(self.terminal_wait_seconds)
            self._retain_operation_directory(operation_directory)
            raise NetworkPolicyTimeout(
                "network policy helper timed out", outcome_unknown=True
            ) from error
        except OSError as error:
            shutil.rmtree(operation_directory, ignore_errors=True)
            raise NetworkPolicyError("network policy helper could not start") from error
        if allow_public is not None and completed.returncode not in (0, 10, 1223):
            try:
                self._signal_cancellation(operation_directory, operation_token)
            except OSError:
                pass
            self._retain_operation_directory(operation_directory)
            raise NetworkPolicyTimeout(
                "network policy helper reported an unknown outcome",
                outcome_unknown=True,
            )
        shutil.rmtree(operation_directory, ignore_errors=True)
        if completed.returncode == 10:
            raise NetworkPolicyApplyFailed("network policy helper failed and restored")
        if completed.returncode != 0:
            if completed.returncode == 1223:
                raise NetworkPolicyCancelled("network policy authorization was cancelled")
            raise NetworkPolicyError("network policy helper failed")
        return _parse_helper_output(completed.stdout)

    def apply(self, allow_public: bool) -> None:
        effective = self._run(allow_public)
        if not effective.valid or effective.allow_public != allow_public:
            raise NetworkPolicyError("network policy helper did not apply the requested state")

    def read_effective(self) -> EffectiveNetworkPolicy:
        return self._run(None)

    def rollback(self, allow_public: bool) -> None:
        effective = self._run(allow_public)
        if not effective.valid or effective.allow_public != allow_public:
            raise NetworkPolicyError("network policy helper did not restore the prior state")


def _canonical_powershell_executable(configured: str | None = None) -> str:
    windows_root = _windows_directory()
    candidates = (
        windows_root / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe",
        windows_root / "Sysnative" / "WindowsPowerShell" / "v1.0" / "powershell.exe",
    )
    selected = Path(configured) if configured is not None else next(
        (candidate for candidate in candidates if candidate.is_file()), candidates[0]
    )
    if not selected.is_absolute():
        raise ValueError("PowerShell executable must be a canonical absolute path")
    allowed = {os.path.normcase(os.path.abspath(str(candidate))) for candidate in candidates}
    normalized = os.path.normcase(os.path.abspath(str(selected)))
    if normalized not in allowed:
        raise ValueError("PowerShell executable is outside the protected Windows directory")
    if configured is None and not selected.is_file():
        raise ValueError("canonical Windows PowerShell executable is missing")
    return str(selected)


def _parse_helper_output(stdout: str) -> EffectiveNetworkPolicy:
    lines = [line for line in stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise NetworkPolicyError("network policy helper returned corrupt output")
    try:
        payload = json.loads(lines[0], object_pairs_hook=_has_duplicate_keys)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise NetworkPolicyError("network policy helper returned corrupt output") from error
    if not isinstance(payload, dict) or set(payload) != {"version", "status", "allow_public"}:
        raise NetworkPolicyError("network policy helper returned an unexpected schema")
    if type(payload["version"]) is not int or payload["version"] != SETTINGS_VERSION:
        raise NetworkPolicyError("network policy helper returned an unsupported version")
    status_value = payload["status"]
    if type(status_value) is not str or status_value not in {
        "private", "public", "mixed", "invalid"
    }:
        raise NetworkPolicyError("network policy helper returned an invalid status")
    if type(payload["allow_public"]) is not bool:
        raise NetworkPolicyError("network policy helper returned a non-boolean state")
    expected_allow_public = status_value == "public"
    if payload["allow_public"] is not expected_allow_public:
        raise NetworkPolicyError("network policy helper returned an inconsistent state")
    return EffectiveNetworkPolicy(
        status=status_value,
        allow_public=expected_allow_public,
        valid=status_value in {"private", "public"},
    )


class NetworkAccessMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        settings_path: str | os.PathLike[str] | None = None,
        internal_forward_token: str | None = None,
    ) -> None:
        self.app = app
        self.settings_path = Path(settings_path) if settings_path is not None else None
        self.internal_forward_token = internal_forward_token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        client = scope.get("client")
        actual = normalize_client_address(client[0] if client else None)
        headers = scope.get("headers", [])
        forwarded_values = [
            value for name, value in headers if name.lower() == FORWARDED_CLIENT_HEADER.encode("ascii")
        ]
        token_values = [
            value for name, value in headers if name.lower() == INTERNAL_TOKEN_HEADER.encode("ascii")
        ]
        standard_forwarding_present = any(
            name.lower() in _STANDARD_FORWARDING_HEADERS for name, _value in headers
        )
        fixed_present = bool(forwarded_values or token_values)
        trusted = False
        effective = actual

        if fixed_present:
            expected_token = (
                self.internal_forward_token
                if self.internal_forward_token is not None
                else os.getenv("MEDOS_INTERNAL_FORWARD_TOKEN", "")
            )
            try:
                forwarded_text = forwarded_values[0].decode("ascii")
                token_text = token_values[0].decode("ascii")
            except (IndexError, UnicodeDecodeError):
                await self._deny(scope, send)
                return
            if (
                len(forwarded_values) != 1
                or len(token_values) != 1
                or not actual
                or not actual.is_loopback
                or not expected_token
                or not hmac.compare_digest(token_text, expected_token)
            ):
                await self._deny(scope, send)
                return
            effective = normalize_client_address(forwarded_text)
            if effective is None:
                await self._deny(scope, send)
                return
            trusted = True

        settings_path = self.settings_path or network_settings_path()
        settings = load_network_settings(settings_path)
        if not _is_valid_unicast(effective) or not client_is_allowed(
            str(effective), allow_public=settings.allow_public
        ):
            await self._deny(scope, send)
            return

        state = scope.setdefault("state", {})
        state["network_actual_client"] = actual
        state["network_effective_client"] = effective
        state["network_forward_trusted"] = trusted
        state["network_forwarding_header_present"] = fixed_present or standard_forwarding_present
        state["network_can_change"] = bool(
            actual
            and actual.is_loopback
            and (
                (not fixed_present and not standard_forwarding_present)
                or (trusted and effective.is_loopback)
            )
        )
        await self.app(scope, receive, send)

    async def _deny(self, scope: Scope, send: Send) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        headers = [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(_DENIED_BODY)).encode("ascii")),
        ]
        await send({"type": "http.response.start", "status": 403, "headers": headers})
        await send({"type": "http.response.body", "body": _DENIED_BODY})
