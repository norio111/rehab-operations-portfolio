import postcssConfig from "./postcss.config.js";

function githubPagesBase() {
  if (!process.env.GITHUB_ACTIONS) return "/";

  const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1];
  if (!repositoryName || repositoryName.endsWith(".github.io")) return "/";
  return `/${repositoryName}/`;
}

export default {
  base: githubPagesBase(),
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  css: {
    postcss: postcssConfig,
  },
};
