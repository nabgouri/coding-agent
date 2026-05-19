import Anthropic from "@anthropic-ai/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { confirm } from "./io.js";

const execP = promisify(exec);

// A Tool bundles everything Claude needs (name, description, schema) with
// everything WE need (a handler that actually runs the tool locally).
export interface Tool {
  definition: Anthropic.Tool;
  handler: (input: any) => Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// read_file
// ─────────────────────────────────────────────────────────────────────────────
export const readFile: Tool = {
  definition: {
    name: "read_file",
    description:
      "Read the contents of a file at a given relative path. " +
      "Use this when you need to inspect a file the user is asking about. " +
      "Returns the raw file contents as a string.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file, e.g. 'src/agent.ts'.",
        },
      },
      required: ["path"],
    },
  },
  handler: async ({ path: p }: { path: string }) => {
    return await fs.readFile(p, "utf8");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// list_files
// Walks a directory recursively. Directories are returned with a trailing '/'
// so Claude can distinguish them at a glance. Skips node_modules and .git
// because they're noise and would blow the token budget.
// ─────────────────────────────────────────────────────────────────────────────
const IGNORE = new Set(["node_modules", ".git", ".next", "dist", "build"]);

async function walk(dir: string, base: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      out.push(rel + "/");
      await walk(full, base, out);
    } else {
      out.push(rel);
    }
  }
}

export const listFiles: Tool = {
  definition: {
    name: "list_files",
    description:
      "Recursively list files and directories under a path. " +
      "Directories are suffixed with '/'. Skips node_modules and .git. " +
      "If no path is provided, lists the current working directory. " +
      "Use this to explore a codebase before reading specific files.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to list. Defaults to '.' (current directory).",
        },
      },
    },
  },
  handler: async ({ path: p = "." }: { path?: string }) => {
    const out: string[] = [];
    await walk(p, p, out);
    return JSON.stringify(out, null, 2);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// edit_file
// String-replacement editor. Two modes:
//   1. Edit existing file: replace exactly one occurrence of old_str with new_str.
//   2. Create new file: if the file doesn't exist AND old_str is empty,
//      create it with new_str as its contents.
// ─────────────────────────────────────────────────────────────────────────────
export const editFile: Tool = {
  definition: {
    name: "edit_file",
    description:
      "Edit a text file by replacing 'old_str' with 'new_str'. " +
      "'old_str' must match EXACTLY one occurrence in the file (whitespace included). " +
      "If 'old_str' is the empty string and the file does not exist, the file is " +
      "created with 'new_str' as its contents. " +
      "Returns 'OK' on success, or an error message describing why the edit failed.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to edit or create.",
        },
        old_str: {
          type: "string",
          description:
            "Exact text to replace. Empty string means 'create a new file'.",
        },
        new_str: {
          type: "string",
          description: "Replacement text (or initial contents for new files).",
        },
      },
      required: ["path", "old_str", "new_str"],
    },
  },
  handler: async ({
    path: p,
    old_str,
    new_str,
  }: {
    path: string;
    old_str: string;
    new_str: string;
  }) => {
    let content: string | null = null;
    try {
      content = await fs.readFile(p, "utf8");
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }

    if (content === null) {
      if (old_str !== "") {
        return `Error: file ${p} does not exist. To create it, pass old_str="".`;
      }
      await fs.writeFile(p, new_str);
      return "OK (created)";
    }

    if (old_str === "") {
      return `Error: file ${p} already exists; refusing to overwrite with empty old_str.`;
    }

    const occurrences = content.split(old_str).length - 1;
    if (occurrences === 0) {
      return `Error: old_str not found in ${p}. Re-read the file and try again.`;
    }
    if (occurrences > 1) {
      return `Error: old_str matches ${occurrences} places in ${p}. Add more surrounding context so it's unique.`;
    }

    await fs.writeFile(p, content.replace(old_str, new_str));
    return "OK";
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// bash
// Run a shell command, but ONLY after the human user types 'y'. This is the
// safety boundary — the model proposes, the human disposes.
// ─────────────────────────────────────────────────────────────────────────────
export const bash: Tool = {
  definition: {
    name: "bash",
    description:
      "Execute a shell command on the user's machine. The user must approve " +
      "the command before it runs; you may be denied. Use this for running " +
      "tests, git operations, package managers, grep/ripgrep, or any other " +
      "command-line tool. Returns combined stdout/stderr, or a denial message " +
      "if the user rejected the command.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The shell command to run, e.g. 'pnpm test' or 'git status'.",
        },
      },
      required: ["command"],
    },
  },
  handler: async ({ command }: { command: string }) => {
    // Always ask first. Even if the user has approved 100 commands in a row,
    // we still ask — that's the safety invariant.
    console.log(`\n  Proposed command: ${command}`);
    const ok = await confirm("  Run it?");
    if (!ok) {
      return "User denied execution of this command. Ask the user what they want to do instead.";
    }

    try {
      const { stdout, stderr } = await execP(command, {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      return [stdout, stderr].filter(Boolean).join("").trimEnd() || "(no output)";
    } catch (err: any) {
      const parts = [
        err.stdout ?? "",
        err.stderr ?? "",
        err.killed ? "[killed after timeout]" : `[exit code: ${err.code ?? "?"}]`,
      ];
      return parts.filter(Boolean).join("").trimEnd();
    }
  },
};

export const allTools: Tool[] = [readFile, listFiles, editFile, bash];

export const toolsByName: Record<string, Tool> = Object.fromEntries(
  allTools.map((t) => [t.definition.name, t]),
);
