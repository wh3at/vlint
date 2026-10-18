import { expect, test } from "bun:test";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { packageRelease, renderInstaller } from "../../scripts/package-release";
import packageJson from "../../package.json";

const enabled = process.env.VLINT_INSTALLER_CONTAINER_ACCEPTANCE === "1";

(enabled ? test : test.skip)("real installer prepares, repeats, updates and preserves installed executable on failed or interrupted candidates", async () => {
  const name = `vlint-59-${process.pid}-${Date.now()}`;
  const stage = resolve(`dist/${name}`);
  const version = packageJson.version;
  const candidateVersion = `${version.split(".").slice(0, 2).join(".")}.${Number(version.split(".")[2]) + 1}`;
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
    await packageRelease({ root: resolve("."), outputDirectory: stage, version, repository: "wh3at/vlint", binaryPath: resolve("dist/vlint-linux-x64") });
    if (process.env.VLINT_RELEASE_ARCHIVE !== undefined) {
      await copyFile(process.env.VLINT_RELEASE_ARCHIVE, `${stage}/vlint-v${version}-linux-x64.tar.gz`);
      await copyFile(process.env.VLINT_RELEASE_INSTALLER!, `${stage}/install-v${version}.sh`);
    }
    await copyFile(`${stage}/vlint-v${version}-linux-x64.tar.gz`, `${stage}/vlint-v${candidateVersion}-linux-x64.tar.gz`);
    await writeFile(`${stage}/install-v${candidateVersion}.sh`, renderInstaller(candidateVersion, "wh3at/vlint"));
    await docker("run", "--name", name, "-d", "-e", "DEBUG=pw:browser", "-e", "PLAYWRIGHT_SKIP_BROWSER_GC=1", "-e", "PLAYWRIGHT_BROWSERS_PATH=/tmp/browsers-59", "-e", "VLINT_INSTALL_DIR=/tmp/bin", "-v", `${stage}:/assets:ro`, "ubuntu@sha256:52df9b1ee71626e0088f7d400d5c6b5f7bb916f8f0c82b474289a4ece6cf3faf", "sleep", "infinity");
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
    const install = (tag: string) => shell(`PATH=/transport:$PATH sh /assets/install-v${tag}.sh`);
    await shell(`touch /tmp/fetch-fail; if PATH=/transport:$PATH sh /assets/install-v${version}.sh >/tmp/first-failure 2>&1; then exit 1; fi; test ! -e /tmp/bin/vlint; rm /tmp/fetch-fail`);
    const first = await install(version);
    expect(first).toContain("chromium, firefox, webkit ready");
    expect(first).toContain("vlint init --help");
    expect(first).not.toContain("config created");
    expect(await install(version)).toContain("installed");
    await shell("cp /tmp/bin/vlint /tmp/previous; touch /tmp/browsers-59/old-assets-59");
    await shell(`touch /tmp/fetch-fail; if PATH=/transport:$PATH sh /assets/install-v${candidateVersion}.sh >/tmp/fetch-failure 2>&1; then exit 1; fi; cmp /tmp/previous /tmp/bin/vlint; grep 'not updated' /tmp/fetch-failure; rm /tmp/fetch-fail`);
    await shell(`find /tmp/browsers-59/firefox-* -type f -name firefox -exec chmod a-x {} +; if PATH=/transport:$PATH sh /assets/install-v${candidateVersion}.sh >/tmp/launch-failure 2>&1; then exit 1; fi; cmp /tmp/previous /tmp/bin/vlint; grep 'not updated' /tmp/launch-failure; test -f /tmp/browsers-59/old-assets-59; find /tmp/browsers-59/firefox-* -type f -name firefox -exec chmod a+x {} +`);
    await shell(`touch /tmp/fetch-wait; if timeout -s TERM 2 env PATH=/transport:$PATH sh /assets/install-v${candidateVersion}.sh >/tmp/interrupt 2>&1; then exit 1; fi; cmp /tmp/previous /tmp/bin/vlint; grep 'not updated' /tmp/interrupt; rm /tmp/fetch-wait; test -z "$(find /tmp/bin -name '.vlint.*')"`);
    await shell("printf '\\nold-marker-59\\n' >>/tmp/bin/vlint");
    expect(await install(candidateVersion)).toContain(`v${candidateVersion} installed`);
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
