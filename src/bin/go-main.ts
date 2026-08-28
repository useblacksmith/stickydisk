import { runMount } from "../mount";

runMount({
  goCaching: true,
  defaultKey: `${process.env.GITHUB_REPOSITORY}-go-cache-${process.env.RUNNER_OS}`,
});
