"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { appBuilderPath } = require("app-builder-bin");

// win.signAndEditExecutable is false (avoids the winCodeSign download/symlink issue and we do not sign),
// so electron-builder skips rcedit; stamp the icon and version info on the app exe here instead.
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const appInfo = context.packager.appInfo;
  const executablePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, "build", "icon.ico");
  const resourceArgs = [
    executablePath,
    "--set-version-string",
    "FileDescription",
    appInfo.productName,
    "--set-version-string",
    "ProductName",
    appInfo.productName,
    "--set-version-string",
    "InternalName",
    appInfo.productFilename,
    "--set-version-string",
    "CompanyName",
    appInfo.companyName || "Visubly",
    "--set-version-string",
    "LegalCopyright",
    appInfo.copyright,
    "--set-file-version",
    appInfo.getVersionInWeirdWindowsForm(),
    "--set-product-version",
    appInfo.getVersionInWeirdWindowsForm(),
    "--set-icon",
    iconPath
  ];

  execFileSync(appBuilderPath, ["rcedit", "--args", JSON.stringify(resourceArgs)], {
    stdio: "inherit"
  });
};
