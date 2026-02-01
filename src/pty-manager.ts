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

		// Build PATH that includes common locations for CLI tools.
		// Obsidian's process.env.PATH often misses paths added in .zshrc/.bashrc.
		const extraPaths = [
			path.join(process.env.HOME || "", ".local", "bin"),
			"/usr/local/bin",
			"/opt/homebrew/bin",
			"/opt/homebrew/sbin",
			path.join(process.env.HOME || "", ".nvm", "versions", "node"),
			path.join(process.env.HOME || "", ".npm-global", "bin"),
			path.join(process.env.HOME || "", "bin"),
		];
		const currentPath = process.env.PATH || "/usr/bin:/bin";
		const fullPath = [...extraPaths, ...currentPath.split(":")].filter(Boolean);
		// Deduplicate while preserving order
		const uniquePath = [...new Set(fullPath)].join(":");

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
			// Strip Kitty keyboard protocol sequences that xterm.js doesn't support.
			// Claude Code sends these at startup; xterm.js misparses them, corrupting
			// the display. See https://github.com/xtermjs/xterm.js/issues/4198
			const cleaned = stripKittySequences(data);
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
 * Strip Kitty keyboard protocol escape sequences.
 * These are CSI sequences ending in 'u' with specific intermediate bytes:
 *   CSI > Ps u    (push mode)
 *   CSI < u       (pop mode)
 *   CSI ? u       (query mode)
 *   CSI > Ps;Ps u (push with flags)
 * Also strip the synchronized output sequences (CSI ? 2026 h/l)
 * which Claude Code uses but older xterm.js may not fully support.
 */
function stripKittySequences(data: string): string {
	// Match ESC[ followed by optional >/</? then digits/semicolons then u
	// Also match CSI ? 2026 h and CSI ? 2026 l (synchronized output)
	// Also match OSC 9;4;0; ST (ConEmu progress)
	return data.replace(
		/\x1b\[[<>?][0-9;]*u|\x1b\[\?2026[hl]|\x1b\]9;4;0;\x07?/g,
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
