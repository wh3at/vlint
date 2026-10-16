import { expect, test } from "bun:test";
import { releaseNames } from "../../scripts/package-release";

test("release exposes only archive and common installer assets", () => {
  expect(releaseNames("0.1.0")).toEqual({
    tag: "v0.1.0",
    archive: "vlint-v0.1.0-linux-x64.tar.gz",
    installer: "install-v0.1.0.sh",
  });
});
