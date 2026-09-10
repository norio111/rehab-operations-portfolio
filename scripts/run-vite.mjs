import { createHash } from "node:crypto";
import { lstatSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function samePath(left, right) {
  const normalize = (value) => realpathSync(value).toLowerCase();
  return normalize(left) === normalize(right);
}

function createAsciiProjectLink() {
  const id = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  const linkPath = join(tmpdir(), `rehab-vite-${id}`);

  try {
    const existing = lstatSync(linkPath);
    if (!existing.isSymbolicLink() || !samePath(linkPath, projectRoot)) {
      throw new Error(`一時パスが別のファイルに使われています: ${linkPath}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    symlinkSync(projectRoot, linkPath, "junction");
  }

  return linkPath;
}

const needsAsciiLink = process.platform === "win32" && /[^\x00-\x7F]/.test(projectRoot);
const executionRoot = needsAsciiLink ? createAsciiProjectLink() : projectRoot;
const viteCli = join(executionRoot, "node_modules", "vite", "bin", "vite.js");
const viteArgs = process.argv.slice(2);

if (!needsAsciiLink) {
  if (["build", "preview"].includes(viteArgs[0])) {
    viteArgs.splice(1, 0, executionRoot);
  } else {
    viteArgs.unshift(executionRoot);
  }
  viteArgs.push(
    "--config",
    join(executionRoot, "vite.config.js"),
    "--configLoader",
    "native"
  );
}

const preserveLinkOptions = "--preserve-symlinks --preserve-symlinks-main";
const nodeOptions = needsAsciiLink
  ? `${process.env.NODE_OPTIONS ?? ""} ${preserveLinkOptions}`.trim()
  : process.env.NODE_OPTIONS;
const childEnvironment = { ...process.env };
if (nodeOptions) childEnvironment.NODE_OPTIONS = nodeOptions;
if (needsAsciiLink) {
  childEnvironment.REHAB_VITE_PROJECT_ROOT = projectRoot;
  childEnvironment.REHAB_VITE_CONFIG_FILE = join(executionRoot, "vite.config.js");
}

const childEntry = needsAsciiLink
  ? join(executionRoot, "scripts", "vite-child.mjs")
  : viteCli;

const child = spawn(process.execPath, [childEntry, ...viteArgs], {
  cwd: executionRoot,
  env: childEnvironment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

try {
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  if (needsAsciiLink) {
    try {
      if (lstatSync(executionRoot).isSymbolicLink() && samePath(executionRoot, projectRoot)) {
        unlinkSync(executionRoot);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`一時パスを削除できませんでした: ${executionRoot}`);
      }
    }
  }
}
