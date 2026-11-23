import struct
import sys
import tempfile
import traceback
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import apply_update as au

exe = Path(r"D:\MedOS-installer-dist\MedOS-Updater.exe")
with exe.open("rb") as stream:
    stream.seek(-60, 2)
    footer = stream.read(60)
magic, offset, length, checksum, schema = struct.unpack("<8sqq32sI", footer)
work = Path(tempfile.mkdtemp(prefix="medos-debug-kit-"))
zip_path = work / "kit.zip"
with exe.open("rb") as source, zip_path.open("wb") as out:
    source.seek(offset)
    remaining = length
    while remaining > 0:
        chunk = source.read(min(1024 * 1024, remaining))
        out.write(chunk)
        remaining -= len(chunk)
with zipfile.ZipFile(zip_path) as archive:
    archive.extractall(work / "kit")
kit = work / "kit"
print("kit:", kit)
print("has update.json:", (kit / "update.json").is_file())
original_contained = au.contained


def traced_contained(base, relative):
    try:
        return original_contained(base, relative)
    except Exception:
        print("CONTAINED FAILED base=", base, " relative=", relative)
        raise


au.contained = traced_contained
try:
    au.apply_update(Path(r"C:\MedOS"), kit, check_ports=False, verify_only=True)
    print("VERIFY OK")
except Exception:
    traceback.print_exc()
