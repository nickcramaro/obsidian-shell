import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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

	constructor(leaf: WorkspaceLeaf, plugin: ClaudeTerminalPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return "Claude Code";
	}

	getIcon(): string {
		return "terminal";
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("claude-terminal-container");

		// Toolbar
		const toolbar = container.createDiv({ cls: "claude-terminal-toolbar" });

		const restartBtn = toolbar.createEl("button", {
			cls: "claude-terminal-toolbar-btn",
			attr: { "aria-label": "Restart Claude" },
		});
		setIcon(restartBtn, "rotate-ccw");
		restartBtn.addEventListener("click", () => this.restart());

		const addNoteBtn = toolbar.createEl("button", {
			cls: "claude-terminal-toolbar-btn",
			attr: { "aria-label": "Add current note" },
		});
		setIcon(addNoteBtn, "file-plus");
		addNoteBtn.addEventListener("click", () => this.plugin.addCurrentNote());

		// Terminal container
		this.terminalContainer = container.createDiv({ cls: "claude-terminal-xterm" });

		this.initTerminal();
	}

	private initTerminal() {
		if (!this.terminalContainer) return;

		const settings = this.plugin.settings;
		const obsidianDark = document.body.classList.contains("theme-dark");

		const theme = {
			background: settings.theme.background || (obsidianDark ? "#1e1e2e" : "#ffffff"),
			foreground: settings.theme.foreground || (obsidianDark ? "#cdd6f4" : "#1e1e2e"),
			cursor: settings.theme.cursor || (obsidianDark ? "#f5e0dc" : "#1e1e2e"),
			selectionBackground: obsidianDark ? "#45475a" : "#d0d0d0",
			black: obsidianDark ? "#45475a" : "#000000",
			red: obsidianDark ? "#f38ba8" : "#cc0000",
			green: obsidianDark ? "#a6e3a1" : "#00cc00",
			yellow: obsidianDark ? "#f9e2af" : "#cccc00",
			blue: obsidianDark ? "#89b4fa" : "#0000cc",
			magenta: obsidianDark ? "#f5c2e7" : "#cc00cc",
			cyan: obsidianDark ? "#94e2d5" : "#00cccc",
			white: obsidianDark ? "#bac2de" : "#cccccc",
			brightBlack: obsidianDark ? "#585b70" : "#666666",
			brightRed: obsidianDark ? "#f38ba8" : "#ff0000",
			brightGreen: obsidianDark ? "#a6e3a1" : "#00ff00",
			brightYellow: obsidianDark ? "#f9e2af" : "#ffff00",
			brightBlue: obsidianDark ? "#89b4fa" : "#0000ff",
			brightMagenta: obsidianDark ? "#f5c2e7" : "#ff00ff",
			brightCyan: obsidianDark ? "#94e2d5" : "#00ffff",
			brightWhite: obsidianDark ? "#a6adc8" : "#ffffff",
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
		this.terminal.loadAddon(new WebLinksAddon());

		this.terminal.open(this.terminalContainer);

		// Fit after a frame so the container has dimensions
		requestAnimationFrame(() => {
			this.fitAddon?.fit();
			this.spawnPty();
		});

		// Responsive resize
		this.resizeObserver = new ResizeObserver(() => {
			requestAnimationFrame(() => this.fitAddon?.fit());
		});
		this.resizeObserver.observe(this.terminalContainer);

		// Forward resize to PTY
		this.terminal.onResize(({ cols, rows }) => {
			this.ptyManager?.resize(cols, rows);
		});
	}

	private spawnPty() {
		if (!this.terminal) return;

		const vaultPath = (this.app.vault.adapter as any).basePath as string;
		const settings = this.plugin.settings;

		this.ptyManager = new PtyManager();

		try {
			this.ptyManager.spawn({
				shellPath: settings.shellPath || undefined,
				cwd: vaultPath,
				cols: this.terminal.cols,
				rows: this.terminal.rows,
			});
		} catch (err) {
			this.terminal.writeln(`\r\n\x1b[31mFailed to spawn terminal: ${err}\x1b[0m`);
			this.terminal.writeln("\x1b[33mMake sure node-pty is properly built for Obsidian's Electron.\x1b[0m");
			return;
		}

		// Wire I/O
		this.ptyManager.onData((data) => {
			this.terminal?.write(data);
		});

		this.terminal.onData((data) => {
			this.ptyManager?.write(data);
		});

		// Auto-launch claude
		if (settings.autoLaunch) {
			const flags = settings.claudeFlags ? ` ${settings.claudeFlags}` : "";
			// Small delay to let shell initialize
			setTimeout(() => {
				this.ptyManager?.sendCommand(`claude${flags}`);
			}, 500);
		}
	}

	async onClose() {
		this.resizeObserver?.disconnect();
		this.ptyManager?.kill();
		this.terminal?.dispose();
		this.terminal = null;
		this.fitAddon = null;
		this.ptyManager = null;
		this.terminalContainer = null;
	}

	restart() {
		this.ptyManager?.kill();
		this.terminal?.clear();
		this.terminal?.reset();
		this.spawnPty();
	}

	sendToTerminal(command: string) {
		this.ptyManager?.sendCommand(command);
	}
}
