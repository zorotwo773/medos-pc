"""
UpToDate bundle decryption (reverse-engineered from iMedicalDoctor APK v5.5 /
build 190, class `net.imedicaldoctor.imd.Data.CompressHelper`).

Three independent layers — all AES-128-CBC / PKCS7 / PBKDF2-HMAC-SHA1, 19 iters,
128-bit derived key.  Only the salt, IV, and password source differ.

  Layer 1 — activation payload  (VBHelper.x)
    password : device key (derived from DS + android_id — see derive_device_key)
    salt     : b"z\\x0c\\x0bx 4...\\x17" (19 bytes, hardcoded)
    iv       : b"usofghoohzxwo[nm"      (16 bytes, hardcoded)
    data     : hex(prefs.ActivationCode)

  Layer 2 — device key unwrap  (VBHelper.k / .m)
    password : android_id + "30"    (string)
    salt     : same 19 bytes as layer 1 (one byte differs in .m's salt table
               but unwrap always uses the 12-variant seen in k/x)
    iv       : b"\\x1f !\"#$%&'\\x1e\\x1f !\"#$" (16 bytes, hardcoded)
    data     : hex(prefs.DS)
    → yields the device key string (v1_8 in the Java source)

  Layer 3 — bundle content  (CompressHelper.v / .w / .x  +  h1 gunzip)
    password : activation_string.replace("||","::").split("::")[1]
    salt     : (row_id_as_str + "        ")[:len(row_id_as_str) if >=8 else 8],
               encoded UTF-8 (pad trailing spaces until len ≥ 8)
    iv       : b"\\x11sifghokl zxwvbnm" (16 bytes, hardcoded)
    data     : base64(row.payload)
    → AES decrypt → GZIP decompress → plaintext HTML / JSON / JPEG base64

Everything derived from actual Dalvik bytecode + DAD-decompiled Java. No guessing.
"""
from __future__ import annotations

import base64
import gzip
import io
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.hashes import SHA1
from cryptography.hazmat.backends import default_backend


# ─── Fixed byte tables from decompiled CompressHelper / VBHelper ────────────

# CompressHelper.{v,w,x} IV — used for every topic_asset / graphic_asset /
# other_asset blob.  Spells "\x11sifghokl zxwvbnm" — a diagonal run across a
# QWERTY keyboard.  This is THE payload IV.
IV_PAYLOAD = bytes([17, 115, 105, 102, 103, 104, 111, 107,
                    108, 122, 120, 119, 118, 98, 110, 109])

# VBHelper.x / b / p / q IV (used for the ActivationCode decrypt and for
# license-stub obfuscation).
IV_ACTIVATION = bytes([117, 115, 111, 102, 103, 104, 111, 111,
                       108, 122, 120, 119, 111, 91, 110, 109])

# VBHelper.k / n / o / p / q IV (used when unwrapping the DS blob with
# android_id as part of the password).
IV_DEVICE = bytes([31, 32, 33, 34, 35, 36, 37, 38,
                   39, 30, 31, 32, 33, 34, 35, 36])

# The canonical 19-byte salt used in all three layers (VBHelper.k/n/o/p/q and
# .x, and CompressHelper.J0/N0 whenever the caller doesn't override it).
SALT_19 = bytes([122, 12, 11, 120, 32, 34, 56, 78, 21,
                 24, 76, 21, 65, 32, 76, 31, 24, 64, 23])

# Low-level PBKDF2 parameters — identical everywhere in the app.
PBKDF2_ITERATIONS = 19
PBKDF2_KEY_LEN    = 16       # 128-bit AES key


# ─── Primitives ─────────────────────────────────────────────────────────────

def _derive_key(password: str | bytes, salt: bytes) -> bytes:
    """PBKDF2-HMAC-SHA1, 19 iters, 128-bit key.

    Java's PBEKeySpec treats the `char[]` password as UTF-16-free raw chars
    (each char → one byte of the password buffer when the char is ASCII); for
    BMP-only ASCII strings this matches UTF-8 byte-for-byte, which is what the
    app always feeds it.
    """
    if isinstance(password, str):
        pw_bytes = password.encode("utf-8")
    else:
        pw_bytes = password
    kdf = PBKDF2HMAC(
        algorithm=SHA1(),
        length=PBKDF2_KEY_LEN,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
        backend=default_backend(),
    )
    return kdf.derive(pw_bytes)


def _aes_cbc_decrypt(key: bytes, iv: bytes, ciphertext: bytes) -> bytes:
    """AES-CBC decrypt and strip PKCS7 padding."""
    dec = Cipher(algorithms.AES(key), modes.CBC(iv),
                 backend=default_backend()).decryptor()
    plain = dec.update(ciphertext) + dec.finalize()
    pad = plain[-1]
    if pad < 1 or pad > 16:
        raise ValueError(f"bad PKCS7 pad byte: {pad}")
    if plain[-pad:] != bytes([pad]) * pad:
        raise ValueError("bad PKCS7 padding")
    return plain[:-pad]


def _pad_salt_min8(raw_salt: str) -> bytes:
    """App pads salt string with trailing spaces until len ≥ 8 (then UTF-8)."""
    s = raw_salt
    while len(s) < 8:
        s += " "
    return s.encode("utf-8")


def _hex_to_bytes(s: str) -> bytes:
    return bytes.fromhex(s.strip())


# ─── Public API ─────────────────────────────────────────────────────────────

@dataclass
class UTDKey:
    """Resolved bundle key.  Construct via derive() or from_activation_string()."""
    password: str    # element[1] of the activation string — the master data PW

    def decrypt_payload(self, row_id: str | int, payload_b64: str,
                         decompress: bool = True) -> bytes:
        """Decrypt one `*_asset.payload` TEXT value to its raw bytes.

        `row_id` must match the `id` column of the same row exactly — the app
        uses it as the PBKDF2 salt, padded with trailing spaces to ≥ 8 chars.
        """
        salt = _pad_salt_min8(str(row_id))
        key  = _derive_key(self.password, salt)
        ct   = base64.b64decode(payload_b64, validate=False)
        pt   = _aes_cbc_decrypt(key, IV_PAYLOAD, ct)
        if decompress:
            pt = gzip.decompress(pt)
        return pt


def from_activation_string(activation: str) -> UTDKey:
    """Build a UTDKey from the ALREADY-decrypted activation string.

    This is what you get after running `derive_device_key()` and
    `decrypt_activation_code()` on the prefs, OR what a Frida hook of
    `VBHelper.x(String)` returns directly.
    """
    parts = activation.replace("||", "::").split("::")
    if len(parts) < 2 or not parts[1]:
        raise ValueError(
            f"activation string has no element[1]; got {len(parts)} parts")
    return UTDKey(password=parts[1])


def derive_device_key(ds_hex: str, android_id: str) -> str:
    """Step 1 / 3 — unwrap the DS blob to recover the per-device string key.

    Mirrors `VBHelper.k("127", android_id + "30")` which is what `.m()` calls
    when "DS" already exists in SharedPreferences.
    """
    password = f"{android_id}30"
    key  = _derive_key(password, SALT_19)
    data = _hex_to_bytes(ds_hex)
    out  = _aes_cbc_decrypt(key, IV_DEVICE, data)
    return out.decode("utf-8")


def decrypt_activation_code(activation_hex: str, device_key: str) -> str:
    """Step 2 / 3 — decrypt the prefs' ActivationCode using the device key.

    Mirrors `VBHelper.x(String p6)` with p6 = m()'s return value.
    """
    key  = _derive_key(device_key, SALT_19)
    data = _hex_to_bytes(activation_hex)
    out  = _aes_cbc_decrypt(key, IV_ACTIVATION, data)
    return out.decode("utf-8")


def derive_bundle_key(prefs_ds_hex: str, prefs_activation_hex: str,
                       android_id: str) -> UTDKey:
    """One-shot: turn the three prefs values into a ready-to-use UTDKey."""
    device_key = derive_device_key(prefs_ds_hex, android_id)
    activation = decrypt_activation_code(prefs_activation_hex, device_key)
    return from_activation_string(activation)


# ─── CLI smoke-test ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse, sqlite3, sys, pathlib

    ap = argparse.ArgumentParser(
        description="Decrypt a single UTD asset row end-to-end.")
    ap.add_argument("--db", required=True,
                    help="Path to utdasset.sqlite")
    ap.add_argument("--table", default="topic_asset",
                    choices=["topic_asset", "graphic_asset", "other_asset"])
    ap.add_argument("--id", required=True, help="Row id to decrypt")
    ap.add_argument("--password",
                    help="Direct activation[1] string (skip prefs derivation)")
    ap.add_argument("--ds", help="Hex DS value from default_preferences.xml")
    ap.add_argument("--activation",
                    help="Hex ActivationCode from default_preferences.xml")
    ap.add_argument("--android-id",
                    help="Device android_id (Settings.Secure.ANDROID_ID)")
    ap.add_argument("--out", help="Write plaintext to this file "
                                   "(otherwise prints first 2 KB).")
    ap.add_argument("--no-decompress", action="store_true",
                    help="Skip GZIP step (only useful for debugging).")
    args = ap.parse_args()

    if args.password:
        ukey = UTDKey(password=args.password)
    elif args.ds and args.activation and args.android_id:
        ukey = derive_bundle_key(args.ds, args.activation, args.android_id)
        print(f"[+] derived password = {ukey.password}")
    else:
        sys.exit("ERR: supply either --password OR all of "
                 "--ds --activation --android-id")

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    row = conn.execute(
        f"SELECT payload FROM {args.table} WHERE id=?", (args.id,),
    ).fetchone()
    conn.close()
    if not row:
        sys.exit(f"ERR: {args.table} id={args.id} not found")
    payload_b64 = row[0]

    plaintext = ukey.decrypt_payload(
        args.id, payload_b64, decompress=not args.no_decompress)
    print(f"[+] decrypted {len(plaintext)} bytes")
    if args.out:
        pathlib.Path(args.out).write_bytes(plaintext)
        print(f"[+] wrote {args.out}")
    else:
        head = plaintext[:2048]
        try:
            sys.stdout.write(head.decode("utf-8"))
        except UnicodeDecodeError:
            sys.stdout.buffer.write(head)
