import { ItemView, WorkspaceLeaf } from "obsidian";
import { Terminal, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { VIEW_TYPE_TERMINAL } from "./constants";
import { PtyManager } from "./pty-manager";
import type ClaudeTerminalPlugin from "./main";

export class TerminalView extends ItemView {
	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private ptyManager: PtyManager | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private terminalContainer: HTMLElement | null = null;
	private plugin: ClaudeTerminalPlugin;
	/** Disposable for the terminal.onData listener (keyboard → PTY) */
	private inputDisposable: IDisposable | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ClaudeTerminalPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return "Obsidian Shell";
	}

	getIcon(): string {
		return "terminal";
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("claude-terminal-container");

		this.terminalContainer = container.createDiv({ cls: "claude-terminal-xterm" });

		this.initTerminal();
	}

	private initTerminal() {
		if (!this.terminalContainer) return;

		// Clean up any previous terminal (e.g. if onOpen is called twice)
		this.disposeTerminal();

		const settings = this.plugin.settings;

		// Read Obsidian's active theme colors via CSS variables so the
		// terminal matches whatever theme the user has installed.
		const cs = getComputedStyle(document.body);
		const cv = (v: string) => cs.getPropertyValue(v).trim();

		const bg = settings.theme.background || cv("--background-primary") || "#1e1e2e";
		const fg = settings.theme.foreground || cv("--text-normal") || "#cdd6f4";
		const cursor = settings.theme.cursor || cv("--text-accent") || "#f5e0dc";

		const theme = {
			background: bg,
			foreground: fg,
			cursor: cursor,
			selectionBackground: cv("--text-selection") || "#45475a",
			black: cv("--color-base-00") || "#000000",
			red: cv("--color-red") || "#f38ba8",
			green: cv("--color-green") || "#a6e3a1",
			yellow: cv("--color-yellow") || "#f9e2af",
			blue: cv("--color-blue") || "#89b4fa",
			magenta: cv("--color-purple") || "#f5c2e7",
			cyan: cv("--color-cyan") || "#94e2d5",
			white: cv("--color-base-70") || "#bac2de",
			brightBlack: cv("--color-base-30") || "#585b70",
			brightRed: cv("--color-red") || "#f38ba8",
			brightGreen: cv("--color-green") || "#a6e3a1",
			brightYellow: cv("--color-yellow") || "#f9e2af",
			brightBlue: cv("--color-blue") || "#89b4fa",
			brightMagenta: cv("--color-purple") || "#f5c2e7",
			brightCyan: cv("--color-cyan") || "#94e2d5",
			brightWhite: cv("--color-base-100") || "#ffffff",
		};

		this.terminal = new Terminal({
			fontSize: settings.fontSize,
			fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
			theme,
			cursorBlink: true,
			cursorStyle: "block",
			allowProposedApi: true,
			macOptionIsMeta: true,
		});

		this.fitAddon = new FitAddon();
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(new Unicode11Addon());
		this.terminal.unicode.activeVersion = "11";
		this.terminal.loadAddon(new WebLinksAddon());

		this.terminal.open(this.terminalContainer);

		// Wait for the container to have real dimensions, then fit and spawn.
		const waitForLayout = () => {
			const rect = this.terminalContainer?.getBoundingClientRect();
			if (rect && rect.width > 0 && rect.height > 0) {
				this.fitAddon?.fit();
				this.spawnPty();
				this.startResizeObserver();
			} else {
				requestAnimationFrame(waitForLayout);
			}
		};
		requestAnimationFrame(waitForLayout);
	}

	private startResizeObserver() {
		if (!this.terminalContainer || !this.terminal) return;

		let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
		this.resizeObserver = new ResizeObserver(() => {
			if (resizeTimeout) clearTimeout(resizeTimeout);
			resizeTimeout = setTimeout(() => this.fitAddon?.fit(), 50);
		});
		this.resizeObserver.observe(this.terminalContainer);

		this.terminal.onResize(({ cols, rows }) => {
			this.ptyManager?.resize(cols, rows);
		});
	}

	private spawnPty() {
		if (!this.terminal) return;

		// Clean up previous PTY and input listener to prevent double keystrokes
		this.ptyManager?.kill();
		this.inputDisposable?.dispose();
		this.inputDisposable = null;

		const vaultPath = (this.app.vault.adapter as any).basePath as string;
		const settings = this.plugin.settings;

		this.ptyManager = new PtyManager();

		let command: string | undefined;
		if (settings.autoLaunch) {
			const flags = settings.claudeFlags ? ` ${settings.claudeFlags}` : "";
			command = `claude${flags}`;
		}

		try {
			this.ptyManager.spawn({
				shellPath: settings.shellPath || undefined,
				cwd: vaultPath,
				cols: this.terminal.cols,
				rows: this.terminal.rows,
				pluginDir: this.plugin.pluginDir,
				command,
			});
		} catch (err) {
			this.terminal.writeln(`\r\n\x1b[31mFailed to spawn terminal: ${err}\x1b[0m`);
			this.terminal.writeln("\x1b[33mMake sure node-pty is properly built for Obsidian's Electron.\x1b[0m");
			return;
		}

		// Wire PTY output → terminal display
		this.ptyManager.onData((data) => {
			this.terminal?.write(data);
		});

		// Wire terminal input → PTY (single listener, tracked for disposal)
		this.inputDisposable = this.terminal.onData((data) => {
			this.ptyManager?.write(data);
		});
	}

	private disposeTerminal() {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.inputDisposable?.dispose();
		this.inputDisposable = null;
		this.ptyManager?.kill();
		this.ptyManager = null;
		this.terminal?.dispose();
		this.terminal = null;
		this.fitAddon = null;
	}

	async onClose() {
		this.disposeTerminal();
		this.terminalContainer = null;
	}

	restart() {
		if (!this.terminal) return;
		this.terminal.clear();
		this.terminal.reset();
		this.spawnPty();
	}

	sendToTerminal(command: string) {
		this.ptyManager?.sendCommand(command);
	}
}
