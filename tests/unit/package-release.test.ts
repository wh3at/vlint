import { describe, expect, test } from "bun:test";
import {
  releaseNames,
  renderDebianControl,
  renderInstaller,
} from "../../scripts/package-release";

describe("release packaging", () => {
  test("uses version-bound asset names", () => {
    expect(releaseNames("0.1.0")).toEqual({
      tag: "v0.1.0",
      archive: "vlint-v0.1.0-linux-x64.tar.gz",
      deb: "vlint_0.1.0_amd64.deb",
      installer: "install-v0.1.0.sh",
    });
  });

  test("declares the Ubuntu browser runtime libraries as deb dependencies", () => {
    const control = renderDebianControl("0.1.0");
    expect(control).toContain("Package: vlint\n");
    expect(control).toContain("Version: 0.1.0\n");
    expect(control).toContain("Architecture: amd64\n");
    expect(control).toContain("Depends: ca-certificates, fonts-liberation, libasound2t64");
    expect(control).toContain("libxrandr2\n");
  });

  test("renders a tag-fixed, user-local, checksum-verifying installer", () => {
    const script = renderInstaller("0.1.0", "wh3at/vlint");
    expect(script).toContain('TAG="v0.1.0"');
    expect(script).toContain('REPOSITORY="wh3at/vlint"');
    expect(script).toContain('INSTALL_DIR=${VLINT_INSTALL_DIR:-"$HOME/.local/bin"}');
    expect(script).toContain('*) INSTALL_DIR="$(pwd)/$INSTALL_DIR" ;;');
    expect(script).toContain("sha256sum -c ARCHIVE.SHA256");
    expect(script).toContain('[ "$VERSION_ID" != "24.04" ]');
    expect(script).not.toContain("sudo");
    expect(script).not.toContain("releases/latest");
  });
});
