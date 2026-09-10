import { once } from "node:events";

const projectRoot = process.env.REHAB_VITE_PROJECT_ROOT;
const configFile = process.env.REHAB_VITE_CONFIG_FILE;

if (!projectRoot || !configFile) {
  throw new Error("Vite起動用のプロジェクトパスが設定されていません");
}

// Load Vite while module resolution still uses the ASCII junction. Changing the
// working directory afterwards makes Vite and esbuild calculate identical paths.
const { build, createServer, preview } = await import("vite");
process.chdir(projectRoot);

const [command = "dev"] = process.argv.slice(2);
const config = {
  root: projectRoot,
  configFile,
  configLoader: "native",
};

async function waitForShutdown(server) {
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  await server.close();
}

if (command === "build") {
  await build(config);
} else if (command === "preview") {
  const server = await preview(config);
  server.printUrls();
  await waitForShutdown(server);
} else {
  const server = await createServer(config);
  await server.listen();
  server.printUrls();
  await waitForShutdown(server);
}
