import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderInstaller } from "../../scripts/package-release";

const enabled = process.env.VLINT_INSTALLER_CONTAINER_ACCEPTANCE === "1";

(enabled ? test : test.skip)("real installer prepares, repeats, updates and preserves installed executable on failed or interrupted candidates", async () => {
  const name = `vlint-59-${process.pid}-${Date.now()}`;
  const stage = resolve(`dist/${name}`);
  let completed = false;
  let sequence = 0;
  async function command(args: string[], expected = 0) {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    await writeFile(`${stage}/command-${sequence++}.log`, `${args.join(" ")}\nexit=${code}\n${stdout}\n${stderr}`);
    if (code !== expected) throw new Error(`${args.join(" ")}: expected ${expected}, got ${code}\n${stdout}\n${stderr}`);
    return stdout;
  }
  const docker = (...args: string[]) => command(["docker", ...args]);
  const shell = (script: string) => docker("exec", name, "timeout", "-k", "5", "600", "sh", "-ec", script);
  try {
    await mkdir(stage, { recursive: true });
    for (const version of ["0.10.0", "0.10.1"]) {
      await writeFile(`${stage}/install-${version}.sh`, renderInstaller(version, "wh3at/vlint"));
      await command(["tar", "-czf", `${stage}/vlint-v${version}-linux-x64.tar.gz`, "-C", "dist", "vlint-linux-x64", "--transform=s/vlint-linux-x64/vlint/"]);
    }
    await docker("run", "--name", name, "-d", "-e", "DEBUG=pw:browser", "-e", "PLAYWRIGHT_SKIP_BROWSER_GC=1", "-e", "PLAYWRIGHT_BROWSERS_PATH=/tmp/browsers-59", "-e", "VLINT_INSTALL_DIR=/tmp/bin", "-v", `${stage}:/assets:ro`, "ubuntu:24.04", "sleep", "infinity");
    await shell("apt-get update >/tmp/bootstrap.log 2>&1 && apt-get install -y ca-certificates curl >>/tmp/bootstrap.log 2>&1; mkdir -p /transport /release; cp /assets/*.tar.gz /release/; cd /release; sha256sum *.tar.gz >SHA256SUMS");
    await shell(`cat > /transport/curl <<'EOF'
#!/bin/sh
if [ -f /tmp/fetch-fail ]; then exit 22; fi
if [ -f /tmp/fetch-wait ]; then sleep 60; fi
for arg do
  case "$arg" in https://*) asset="\${arg##*/}" ;; esac
done
while [ "$1" != -o ]; do shift; done
cp "/release/$asset" "$2"
EOF
chmod +x /transport/curl`);
    const install = (version: string) => shell(`PATH=/transport:$PATH sh /assets/install-${version}.sh`);
    await shell("touch /tmp/fetch-fail; if PATH=/transport:$PATH sh /assets/install-0.10.0.sh >/tmp/first-failure 2>&1; then exit 1; fi; test ! -e /tmp/bin/vlint; rm /tmp/fetch-fail");
    const first = await install("0.10.0");
    expect(first).toContain("chromium, firefox, webkit ready");
    expect(first).toContain("vlint init --help");
    expect(first).not.toContain("config created");
    expect(await install("0.10.0")).toContain("installed");
    await shell("cp /tmp/bin/vlint /tmp/previous; touch /tmp/browsers-59/old-assets-59");
    await shell("touch /tmp/fetch-fail; if PATH=/transport:$PATH sh /assets/install-0.10.1.sh >/tmp/fetch-failure 2>&1; then exit 1; fi; cmp /tmp/previous /tmp/bin/vlint; grep 'not updated' /tmp/fetch-failure; rm /tmp/fetch-fail");
    await shell("find /tmp/browsers-59/firefox-* -type f -name firefox -exec chmod a-x {} +; if PATH=/transport:$PATH sh /assets/install-0.10.1.sh >/tmp/launch-failure 2>&1; then exit 1; fi; cmp /tmp/previous /tmp/bin/vlint; grep 'not updated' /tmp/launch-failure; test -f /tmp/browsers-59/old-assets-59; find /tmp/browsers-59/firefox-* -type f -name firefox -exec chmod a+x {} +");
    await shell("touch /tmp/fetch-wait; if timeout -s TERM 2 env PATH=/transport:$PATH sh /assets/install-0.10.1.sh >/tmp/interrupt 2>&1; then exit 1; fi; cmp /tmp/previous /tmp/bin/vlint; grep 'not updated' /tmp/interrupt; rm /tmp/fetch-wait; test -z \"$(find /tmp/bin -name '.vlint.*')\"");
    await shell("printf '\\nold-marker-59\\n' >>/tmp/bin/vlint");
    expect(await install("0.10.1")).toContain("v0.10.1 installed");
    await shell("! grep -a -q old-marker-59 /tmp/bin/vlint; test -f /tmp/browsers-59/old-assets-59; /tmp/bin/vlint browser install --force >/tmp/repair");
    await docker("network", "disconnect", "bridge", name);
    const ready = JSON.parse(await shell("/tmp/bin/vlint browser status --format json"));
    expect(ready.ready).toBe(true);
    expect(ready.engines.map((engine: { engine: string }) => engine.engine)).toEqual(["chromium", "firefox", "webkit"]);
    for (const engine of ready.engines) {
      expect(engine.launch).toBe("passed");
      expect(engine.emptyPage).toBe("passed");
      expect(engine.close).toBe("passed");
    }
    console.log(JSON.stringify({ container: name, first, ready }));
    completed = true;
  } finally {
    if (completed) {
      await docker("rm", "-f", name);
    } else {
      console.error(`Preserved diagnostic container ${name} and logs ${stage}`);
    }
  }
}, 1_800_000);
