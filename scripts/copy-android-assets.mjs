import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "dist");
const destination = resolve(root, "android", "app", "src", "main", "assets", "www");

await mkdir(resolve(root, "android", "app", "src", "main", "assets"), { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
console.log(`Offline app assets copied to ${destination}`);
