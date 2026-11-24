"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { appBuilderPath } = require("app-builder-bin");

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
