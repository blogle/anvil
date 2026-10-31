import { runGitCredentialHelper } from "./git-credentials";

if (import.meta.main) {
  try {
    process.stdout.write(
      await runGitCredentialHelper(
        process.argv[2],
        await Bun.stdin.text(),
        process.env,
      ),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Anvil Git helper failed"}\n`,
    );
    process.exitCode = 1;
  }
}
