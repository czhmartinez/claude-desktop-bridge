import { rm } from "node:fs/promises";

await Promise.all(process.argv.slice(2).map((path) => rm(path, { recursive: true, force: true })));
