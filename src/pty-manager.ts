import { Platform } from "obsidian";
import * as path from "path";

interface SpawnOptions {
	shellPath?: string;
	cwd: string;
	cols: number;
	rows: number;
	pluginDir: string;
	/** If set, launch this command directly via shell -c (skipping rc files) */
	command?: string;
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

		const shell = options.shellPath || this.detectShell();

		// Obsidian's process.env.PATH is minimal (no .zshrc/.bashrc additions).
		// Resolve the user's full PATH by asking their login shell.
		const uniquePath = this.resolveUserPath();

		const env = Object.assign({}, process.env, {
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			PATH: uniquePath,
			// Tell Claude Code we're xterm-based so it doesn't enable the
			// Kitty keyboard protocol (which xterm.js doesn't support).
			// Without this, Claude Code sends CSI > 1 u sequences that
			// corrupt xterm.js's escape parser and garble box-drawing chars.
			TERM_PROGRAM: "xterm",
		});

		if (options.command) {
			// Spawn the command directly — no shell, no prompt, no rc files.
			// Parse command into binary + args.
			const parts = options.command.split(/\s+/);
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
			// Interactive shell mode (no auto-launch)
			this.pty = nodePty.spawn(shell, [], {
				name: "xterm-256color",
				cols: options.cols,
				rows: options.rows,
				cwd: options.cwd,
				env,
			});
		}

		this.pty.onData((data: string) => {
			// Strip escape sequences that xterm.js doesn't support.
			// See https://github.com/xtermjs/xterm.js/issues/4198
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

	/**
	 * Get the user's full PATH by asking their login shell.
	 * Falls back to a hardcoded list if the shell query fails.
	 */
	private resolveUserPath(): string {
		const shell = this.detectShell();
		try {
			const { execSync } = require("child_process");
			const result = execSync(`${shell} -l -i -c 'echo $PATH'`, {
				timeout: 3000,
				encoding: "utf-8",
				env: { HOME: process.env.HOME, USER: process.env.USER },
			}).trim();
			if (result) return result;
		} catch {
			// Fall through to hardcoded paths
		}

		const home = process.env.HOME || "";
		const extras = [
			path.join(home, ".local", "bin"),
			path.join(home, ".bun", "bin"),
			"/usr/local/bin",
			"/opt/homebrew/bin",
			"/opt/homebrew/sbin",
			path.join(home, ".nvm", "versions", "node"),
			path.join(home, ".npm-global", "bin"),
			path.join(home, "bin"),
		];
		const current = process.env.PATH || "/usr/bin:/bin";
		return [...new Set([...extras, ...current.split(":")])].filter(Boolean).join(":");
	}

	private detectShell(): string {
		if (Platform.isMacOS) {
			return process.env.SHELL || "/bin/zsh";
		}
		if (Platform.isLinux) {
			return process.env.SHELL || "/bin/bash";
		}
		// Windows
		return process.env.COMSPEC || "cmd.exe";
	}
}

/**
 * Strip escape sequences that xterm.js doesn't handle well.
 *
 * - Kitty keyboard protocol (CSI > Ps u, CSI < u, CSI ? u)
 * - Synchronized output (CSI ? 2026 h/l)
 * - Focus event reporting (CSI ? 1004 h/l) — prevents feedback loop where
 *   xterm.js sends focus events back to the PTY during Obsidian layout,
 *   causing garbled output
 * - Bracketed paste mode (CSI ? 2004 h/l) — not needed in embedded terminal
 * - ConEmu progress (OSC 9;4;0; ST)
 */
function stripUnsupportedSequences(data: string): string {
	return data.replace(
		/\x1b\[[<>?][0-9;]*u|\x1b\[\?(?:2026|1004|2004)[hl]|\x1b\]9;4;0;\x07?/g,
		""
	);
}

function requireNodePty(pluginDir: string) {
	// Obsidian's require() doesn't search plugin node_modules,
	// so we must use an absolute path to the native module.
	const modulePath = path.join(pluginDir, "node_modules", "node-pty");
	try {
		return require(modulePath);
	} catch (err) {
		throw new Error(
			`Failed to load node-pty from ${modulePath}. ` +
			`It must be compiled for Obsidian's Electron version. ` +
			`Run 'npm run postinstall' in the plugin directory. Original error: ${err}`
		);
	}
}
