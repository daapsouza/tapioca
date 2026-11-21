import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const android = resolve(root, "android");
const vite = resolve(root, "node_modules", "vite", "bin", "vite.js");
const modes = ["guest", "attendant"];

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? "unknown"}.`);
  }
}

for (const mode of modes) {
  console.log(`Building ${mode} app assets...`);
  run(process.execPath, [vite, "build"], {
    cwd: root,
    env: { ...process.env, VITE_APP_MODE: mode },
  });

  const destination = resolve(android, "app", "src", mode, "assets", "www");
  await rm(destination, { recursive: true, force: true });
  await mkdir(resolve(android, "app", "src", mode, "assets"), { recursive: true });
  await cp(resolve(root, "dist"), destination, { recursive: true });
}

if (process.platform === "win32") {
  run(process.env.ComSpec || "cmd.exe", [
    "/d",
    "/s",
    "/c",
    "gradlew.bat assembleGuestDebug assembleAttendantDebug",
  ], { cwd: android });
} else {
  run("./gradlew", ["assembleGuestDebug", "assembleAttendantDebug"], { cwd: android });
}

console.log("Guest APK: android/app/build/outputs/apk/guest/debug/app-guest-debug.apk");
console.log("Attendant APK: android/app/build/outputs/apk/attendant/debug/app-attendant-debug.apk");
