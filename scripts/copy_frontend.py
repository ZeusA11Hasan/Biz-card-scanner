from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
source = root / "FrontendBucket"
target = root / "public"

if not source.exists():
    raise SystemExit(f"Missing frontend directory: {source}")

target.mkdir(parents=True, exist_ok=True)
shutil.copytree(source, target, dirs_exist_ok=True)
print(f"Copied {source} -> {target}")
