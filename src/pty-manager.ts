import { Platform } from "obsidian";

interface SpawnOptions {
	shellPath?: string;
	cwd: string;
	cols: number;
	rows: number;
}

type DataCallback = (data: string) => void;
type ExitCallback = (exitCode: number, signal?: number) => void;

export class PtyManager {
	private pty: any = null;
	private dataCallbacks: DataCallback[] = [];
	private exitCallbacks: ExitCallback[] = [];

	spawn(options: SpawnOptions) {
		// node-pty must be required at runtime (native module, not bundled)
		const nodePty = requireNodePty();

		const shell = options.shellPath || this.detectShell();
		const env = Object.assign({}, process.env, {
			// Ensure proper terminal
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
		});

		this.pty = nodePty.spawn(shell, [], {
			name: "xterm-256color",
			cols: options.cols,
			rows: options.rows,
			cwd: options.cwd,
			env,
		});

		this.pty.onData((data: string) => {
			for (const cb of this.dataCallbacks) {
				cb(data);
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

function requireNodePty() {
	try {
		// Use dynamic require to load native module at runtime
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require("node-pty");
	} catch (err) {
		throw new Error(
			`Failed to load node-pty. It must be compiled for Obsidian's Electron version. ` +
			`Run 'npm run postinstall' in the plugin directory. Original error: ${err}`
		);
	}
}
