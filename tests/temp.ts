import { afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const directories: string[] = [];

export const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "tool-templates-"));
  directories.push(directory);
  return directory;
};

export const writeTemp = async (
  directory: string,
  relative: string,
  content: string,
): Promise<string> => {
  const file = join(directory, relative);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return file;
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
