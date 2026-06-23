import subprocess, json

with open("/root/honcho/.env") as f:
    content = f.read()

for line in content.splitlines():
    if "LLM_OPENAI_API_KEY" in line and "sk-" in line:
        key = line.split("LLM_OPENAI_API_KEY=")[-1]...')
        print(f"Key found: {key[:12]}...{key[-4:]}")
        
        for model in ["deepseek-chat", "deepseek-v4-flash"]:
            payload = json.dumps({
                "model": model,
                "messages": [{"role": "user", "content": "Say exactly: modelcheck-ok"}],
                "max_tokens": 20
            })
            r = subprocess.run(
                ["curl", "-s", "-H", f"Authorization: Bearer *** "-H", "Content-Type: application/json", "-d", payload, "https://api.deepseek.com/v1/chat/completions"],
                capture_output=True, text=True, timeout=15
            )
            resp = r.stdout.strip()
            print(f"\n=== {model} ===")
            print(resp[:400])
            if r.stderr:
                print(f"stderr: {r.stderr[:200]}")
        break
