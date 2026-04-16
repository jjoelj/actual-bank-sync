// host/src/install.js
// Registers the native messaging host manifest with the OS/browser.
// Run via: node src/install.js
// Or automatically via postinstall: npm install

import { execSync } from "child_process";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_SCRIPT = resolve(__dirname, "index.js");
const HOST_NAME = "com.github.jjoelj.actualbanksync";

const configPath = resolve(__dirname, "../config.json");
let EXTENSION_ID;
try {
  ({ extensionId: EXTENSION_ID } = JSON.parse(readFileSync(configPath, "utf8")));
} catch {
  console.error("Error: config.json not found. Copy config.example.json to config.json and fill in your extension ID.");
  process.exit(1);
}

if (!EXTENSION_ID || EXTENSION_ID === "YOUR_EXTENSION_ID_HERE") {
  console.error("Error: open packages/host/config.json and set your extension ID first.");
  console.error("Find it at chrome://extensions after loading the extension unpacked.");
  process.exit(1);
}

const manifest = {
  name: HOST_NAME,
  description: "Actual Bank Sync native messaging host",
  path: process.execPath, // node binary
  type: "stdio",
  allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  // We pass the script path as an argument to node
};

// We need to wrap the call in a small launcher script so Chrome can invoke it
// as a single executable. Write a launcher next to this file.
const launcherPath = resolve(__dirname, "launcher.js");
writeFileSync(
    launcherPath,
    `#!/usr/bin/env node\nimport(${JSON.stringify(new URL("file:///" + HOST_SCRIPT.replace(/\\/g, "/")).href)}).catch(console.error);\n`
);

manifest.path = process.execPath;
// Chrome will call: node launcher.js
// We need the manifest path to point at the launcher wrapped in a shell script on Windows,
// or directly on Mac/Linux.

const platform = process.platform;

if (platform === "win32") {
  installWindows();
} else if (platform === "darwin") {
  installMac();
} else {
  installLinux();
}

function writeManifestFile(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });

  // On Windows Chrome expects path to an .exe or bat; wrap in a .bat
  if (platform === "win32") {
    const batPath = filePath.replace(/\.json$/, "-launcher.bat");
    const bat = `@echo off\n"${process.execPath}" "${launcherPath}" %*\n`;
    writeFileSync(batPath, bat);
    manifest.path = batPath;
  } else {
    // Write a shell wrapper
    const shPath = resolve(__dirname, "launcher.sh");
    writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${launcherPath}" "$@"\n`);
    execSync(`chmod +x "${shPath}"`);
    manifest.path = shPath;
  }
  writeFileSync(filePath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest written to: ${filePath}`);
}

function installWindows() {
  const manifestPath = resolve(
      process.env.APPDATA,
      "Microsoft/Edge/NativeMessagingHosts",
      `${HOST_NAME}.json`
  );
  writeManifestFile(manifestPath);

  for (const regKey of [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  ]) {
    try {
      execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`);
      console.log(`Registry key set: ${regKey}`);
    } catch (err) {
      console.error(`Failed to write registry key ${regKey}:`, err.message);
    }
  }
}

function installMac() {
  const browserPaths = {
    Chrome: resolve(process.env.HOME, "Library/Application Support/Google/Chrome/NativeMessagingHosts", `${HOST_NAME}.json`),
    Edge:   resolve(process.env.HOME, "Library/Application Support/Microsoft Edge/NativeMessagingHosts", `${HOST_NAME}.json`),
  };

  let first = true;
  for (const [, manifestPath] of Object.entries(browserPaths)) {
    if (first) {
      writeManifestFile(manifestPath);
      first = false;
    } else {
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`Manifest written to: ${manifestPath}`);
    }
  }
  console.log("Mac install complete.");
}

function installLinux() {
  const browserPaths = {
    Chrome: resolve(process.env.HOME, ".config/google-chrome/NativeMessagingHosts", `${HOST_NAME}.json`),
    Edge:   resolve(process.env.HOME, ".config/microsoft-edge/NativeMessagingHosts", `${HOST_NAME}.json`),
  };

  let first = true;
  for (const [, manifestPath] of Object.entries(browserPaths)) {
    if (first) {
      writeManifestFile(manifestPath);
      first = false;
    } else {
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`Manifest written to: ${manifestPath}`);
    }
  }
  console.log("Linux install complete.");
}

console.log(`\nDone! Native messaging host "${HOST_NAME}" registered.`);
