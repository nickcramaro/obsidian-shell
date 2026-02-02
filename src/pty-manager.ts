import { Platform } from "obsidian";
import * as path from "path";
import { parseCommand } from "./parse-command";

export interface SpawnOptions {
	shellPath?: string;
	cwd: string;
	cols: number;
	rows: number;
	pluginDir: string;
	/** If set, launch this command directly (skipping rc files) */
	command?: string;
	/** Pre-resolved user PATH. If omitted, uses process.env.PATH fallback. */
	resolvedPath?: string;
}

type DataCallback = (data: string) => void;
type ExitCallback = (exitCode: number, signal?: number) => void;

export class PtyManager {
	private pty: any = null;
	private dataCallbacks: DataCallback[] = [];
	private exitCallbacks: ExitCallback[] = [];

	spawn(options: SpawnOptions) {
		// node-pty must be required at runtime (native module, not bundled)
		const nodePty = requireNodePty(options.pluginDir);

		const shell = options.shellPath || detectShell();

		const env = Object.assign({}, process.env, {
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			PATH: options.resolvedPath || buildFallbackPath(),
			// Tell Claude Code we're xterm-based so it doesn't enable the
			// Kitty keyboard protocol (which xterm.js doesn't support).
			TERM_PROGRAM: "xterm",
		});

		if (options.command) {
			const parts = parseCommand(options.command);
			const bin = parts[0];
			const args = parts.slice(1);

			this.pty = nodePty.spawn(bin, args, {
				name: "xterm-256color",
				cols: options.cols,
				rows: options.rows,
				cwd: options.cwd,
				env,
			});
		} else {
			this.pty = nodePty.spawn(shell, [], {
				name: "xterm-256color",
				cols: options.cols,
				rows: options.rows,
				cwd: options.cwd,
				env,
			});
		}

		this.pty.onData((data: string) => {
			const cleaned = stripUnsupportedSequences(data);
			if (cleaned.length === 0) return;
			for (const cb of this.dataCallbacks) {
				cb(cleaned);
			}
		});

		this.pty.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
			for (const cb of this.exitCallbacks) {
				cb(exitCode, signal);
			}
		});
	}

	write(data: string) {
		this.pty?.write(data);
	}

	onData(callback: DataCallback) {
		this.dataCallbacks.push(callback);
	}

	onExit(callback: ExitCallback) {
		this.exitCallbacks.push(callback);
	}

	resize(cols: number, rows: number) {
		try {
			this.pty?.resize(cols, rows);
		} catch {
			// Resize can fail if process already exited
		}
	}

	kill() {
		try {
			this.pty?.kill();
		} catch {
			// Already dead
		}
		this.pty = null;
		this.dataCallbacks = [];
		this.exitCallbacks = [];
	}

	sendCommand(cmd: string) {
		this.write(cmd + "\r");
	}

	sendText(text: string) {
		this.write(text);
	}
}

// --- PATH resolution ---

let cachedUserPath: string | null = null;

/**
 * Resolve the user's full PATH by querying their login shell.
 * Uses execFileSync with a short timeout — no -i flag to avoid hangs.
 * Result is cached — subsequent calls return immediately.
 */
export function resolveUserPath(shellOverride?: string): string {
	if (cachedUserPath) return cachedUserPath;

	const shell = shellOverride || detectShell();
	try {
		const { execFileSync } = require("child_process");
		const env = { HOME: process.env.HOME, USER: process.env.USER };
		// Prefer interactive login to capture PATH from ~/.zshrc or similar.
		// If it hangs or fails, fall back to non-interactive login.
		const interactive = (execFileSync(shell, ["-l", "-i", "-c", "echo $PATH"], {
			timeout: 2000,
			encoding: "utf8",
			env,
		}) as string).trim();
		if (interactive) {
			cachedUserPath = interactive;
			return interactive;
		}
	} catch {
		// Fall through to non-interactive login
	}

	try {
		const { execFileSync } = require("child_process");
		const result = (execFileSync(shell, ["-l", "-c", "echo $PATH"], {
			timeout: 2000,
			encoding: "utf8",
			env: { HOME: process.env.HOME, USER: process.env.USER },
		}) as string).trim();
		if (result) {
			cachedUserPath = result;
			return result;
		}
	} catch {
		// Fall through to hardcoded paths
	}

	cachedUserPath = buildFallbackPath();
	return cachedUserPath;
}

/** Clear the cached PATH (for testing) */
export function clearPathCache() {
	cachedUserPath = null;
}

export function buildFallbackPath(): string {
	const home = process.env.HOME || "";
	const extras = [
		path.join(home, ".local", "bin"),
		path.join(home, ".bun", "bin"),
		"/usr/local/bin",
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		path.join(home, ".npm-global", "bin"),
		path.join(home, "bin"),
	];
	const current = process.env.PATH || "/usr/bin:/bin";
	return [...new Set([...extras, ...current.split(":")])].filter(Boolean).join(":");
}

export function detectShell(): string {
	if (Platform.isMacOS) {
		return process.env.SHELL || "/bin/zsh";
	}
	if (Platform.isLinux) {
		return process.env.SHELL || "/bin/bash";
	}
	// Windows
	return process.env.COMSPEC || "cmd.exe";
}

// --- Escape sequence handling ---

/**
 * Strip escape sequences that xterm.js doesn't handle well.
 */
export function stripUnsupportedSequences(data: string): string {
	return data.replace(
		/\x1b\[[<>?][0-9;]*u|\x1b\[\?(?:2026|1004|2004)[hl]|\x1b\]9;4;0;\x07?/g,
		""
	);
}

function requireNodePty(pluginDir: string) {
	const modulePath = path.join(pluginDir, "node_modules", "node-pty");
	try {
		return require(modulePath);
	} catch (err) {
		throw new Error(
			`Failed to load node-pty from ${modulePath}. ` +
			`The native binary must be present and compiled for Obsidian's Electron version. ` +
			`Install from the GitHub release zip which includes prebuilt binaries: ` +
			`https://github.com/nickcramaro/claude-shell/releases — Original error: ${err}`
		);
	}
}
