# Download & install argos-translate models with visible progress + retries.
#
# Usage (from repo root, with the venv python):
#   .venv\Scripts\python.exe scripts\install-lang.py en ru
# installs every model between the given language codes (both directions).
import sys
import time

import argostranslate.package as pkg
import argostranslate.translate as tr

codes = set(sys.argv[1:] or ["en", "ru"])
print("Updating package index...", flush=True)
pkg.update_package_index()

todo = [q for q in pkg.get_available_packages()
        if q.from_code in codes and q.to_code in codes and q.from_code != q.to_code]
print("To install:", [f"{q.from_code}->{q.to_code}" for q in todo], flush=True)

for q in todo:
    for attempt in range(1, 7):
        try:
            print(f"Downloading {q.from_code}->{q.to_code} (~200MB)...", flush=True)
            path = q.download()
            pkg.install_from_path(path)
            print(f"  OK installed {q.from_code}->{q.to_code}", flush=True)
            break
        except Exception as e:
            print(f"  attempt {attempt} failed: {str(e)[:90]}; retrying...", flush=True)
            time.sleep(3)
    else:
        print(f"  GAVE UP on {q.from_code}->{q.to_code} (network)", flush=True)

print("Installed languages now:", [l.code for l in tr.get_installed_languages()], flush=True)
print("DONE", flush=True)
