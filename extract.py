import json
flow = json.load(open("flows/ruckus_wips.json"))
with open("extracted_logic.js", "w") as f:
    for n in flow:
        if n.get("type") == "function":
            name = n.get("name", n.get("id"))
            f.write(f"=== Function Node: {name} ===\n")
            f.write("--- initialize ---\n")
            f.write(n.get("initialize", "") + "\n")
            f.write("--- func ---\n")
            f.write(n.get("func", "") + "\n")
            f.write("--- finalize ---\n")
            f.write(n.get("finalize", "") + "\n\n")
