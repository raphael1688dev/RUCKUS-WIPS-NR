#!/bin/bash
set -e

echo "=== 1. Bundling and Injecting JS into Flow ==="
node build.js

echo ""
echo "=== 2. Checking Python files ==="
python3 -m py_compile probe.py probe_unblock.py
echo "✔ Python files OK."

echo ""
echo "=== 3. Checking Flow JSON files ==="
for f in flows/*.json; do
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f"
done
echo "✔ JSON files OK."

echo ""
echo "=== 4. Checking JS inside Node-RED flows syntax ==="
python3 - <<'PY'
import json, subprocess, sys, tempfile, pathlib
ok = True
for flow in pathlib.Path("flows").glob("*.json"):
    nodes = json.load(open(flow))
    for n in nodes:
        if n.get("type") != "function":
            continue
        for key in ("func", "initialize", "finalize"):
            src = n.get(key) or ""
            if not src.strip():
                continue
            wrapped = f"(async function(){{\n{src}\n}})();"
            with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as t:
                t.write(wrapped); path = t.name
            r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"Error in file={flow}, function-node {key} in {n.get('name', n['id'])}:\n{r.stderr.strip()}")
                ok = False
            else:
                print(f"Syntax OK for file={flow}, function-node {key} in {n.get('name', n['id'])}")
sys.exit(0 if ok else 1)
PY
echo "✔ JS syntax check done."

echo ""
echo "=== 5. Running Automated Unit Test Suite ==="
node --test tests/driver.test.mjs
echo "✔ Automated Unit Test Suite OK."
