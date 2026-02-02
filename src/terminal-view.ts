import { ItemView, WorkspaceLeaf } from "obsidian";
import { Terminal, IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { VIEW_TYPE_TERMINAL } from "./constants";
import { PtyManager } from "./pty-manager";
import type ClaudeTerminalPlugin from "./main";

const MAX_LAYOUT_RETRIES = 200; // ~3.3s at 60fps

export class TerminalView extends ItemView {
	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private ptyManager: PtyManager | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeDisposable: IDisposable | null = null;
	private terminalContainer: HTMLElement | null = null;
	private plugin: ClaudeTerminalPlugin;
	private inputDisposable: IDisposable | null = null;
	private focusDisposable: IDisposable | null = null;
	private abortController: AbortController | null = null;
	private waitForLayoutId: number | null = null;

	private _readyResolve: (() => void) | null = null;
	readonly ready: Promise<void>;

	constructor(leaf: WorkspaceLeaf, plugin: ClaudeTerminalPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.ready = new Promise<void>((resolve) => {
			this._readyResolve = resolve;
		});
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return "Claude Shell";
	}

	getIcon(): string {
		return "sparkles";
	}

	async onOpen() {
		const container = this.contentEl;
		container.empty();
		container.addClass("claude-terminal-container");

		this.terminalContainer = container.createDiv({ cls: "claude-terminal-xterm" });

		this.initTerminal();
	}

	private initTerminal() {
		if (!this.terminalContainer) return;

		// Clean up any previous terminal (e.g. if onOpen is called twice)
		this.disposeTerminal();

		this.abortController = new AbortController();
		const { signal } = this.abortController;

		const settings = this.plugin.settings;

		// Read Obsidian's active theme colors via CSS variables
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

		// Resolve Obsidian's monospace font by probing a temporary element
		// that uses the same CSS variable chain Obsidian applies to code blocks.
		const probe = document.body.createEl("span", {
			attr: { style: "font-family: var(--font-monospace, var(--font-monospace-default)); position: absolute; visibility: hidden;" },
		});
		const obsidianFont =
			getComputedStyle(probe).fontFamily || "monospace";
		probe.remove();

		const terminalFont = obsidianFont;

		// Set the container background to match the terminal so padding areas
		// don't show the default leaf background colour.
		this.terminalContainer.style.backgroundColor = bg;

		this.terminal = new Terminal({
			fontSize: settings.fontSize,
			fontFamily: terminalFont,
			fontWeight: "300",
			fontWeightBold: "normal",
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

		// Use GPU-accelerated WebGL renderer, fall back to canvas on failure
		try {
			const webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => webglAddon.dispose());
			this.terminal.loadAddon(webglAddon);
		} catch {
			// Canvas renderer remains active as fallback
		}

		// Track focus so the plugin knows which terminal was last active
		this.focusDisposable = this.terminal.onData(() => {
			this.plugin.setLastFocusedTerminal(this);
		});
		this.terminalContainer.addEventListener("focus", () => {
			this.plugin.setLastFocusedTerminal(this);
		}, { capture: true, signal });

		// Drag-and-drop: accept files dragged from file explorer
		this.terminalContainer.addEventListener("dragover", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.terminalContainer?.addClass("claude-terminal-drop-active");
		}, { signal });

		this.terminalContainer.addEventListener("dragleave", () => {
			this.terminalContainer?.removeClass("claude-terminal-drop-active");
		}, { signal });

		this.terminalContainer.addEventListener("drop", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.terminalContainer?.removeClass("claude-terminal-drop-active");

			const files = (this.app as any).dragManager?.draggable?.files as string[] | undefined;
			const dragData = e.dataTransfer?.getData("text/plain");

			if (files && files.length > 0) {
				this.plugin.addFiles(files);
			} else if (dragData) {
				this.plugin.addFiles([dragData]);
			}
		}, { signal });

		// Wait for the container to have real dimensions, then fit and spawn.
		let retries = 0;
		const waitForLayout = () => {
			if (!this.terminalContainer || !this.terminal) return; // closed during wait
			const rect = this.terminalContainer.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				this.waitForLayoutId = null;
				this.fitAddon?.fit();
				this.spawnPty();
				this.startResizeObserver();
			} else if (retries++ < MAX_LAYOUT_RETRIES) {
				this.waitForLayoutId = requestAnimationFrame(waitForLayout);
			} else {
				this.waitForLayoutId = null;
				console.warn("obsidian-shell: terminal container never acquired dimensions");
				this._readyResolve?.();
			}
		};
		this.waitForLayoutId = requestAnimationFrame(waitForLayout);
	}

	private startResizeObserver() {
		if (!this.terminalContainer || !this.terminal) return;

		let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
		this.resizeObserver = new ResizeObserver(() => {
			if (resizeTimeout) clearTimeout(resizeTimeout);
			resizeTimeout = setTimeout(() => this.fitAddon?.fit(), 50);
		});
		this.resizeObserver.observe(this.terminalContainer);

		this.resizeDisposable = this.terminal.onResize(({ cols, rows }) => {
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
				resolvedPath: this.plugin.resolvedPath || undefined,
			});
		} catch (err) {
			this.terminal.writeln(`\r\n\x1b[31mFailed to spawn terminal: ${err}\x1b[0m`);
			this.terminal.writeln("\x1b[33mMake sure node-pty is properly built for Obsidian's Electron.\x1b[0m");
			this._readyResolve?.();
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

		this._readyResolve?.();
	}

	private disposeTerminal() {
		if (this.waitForLayoutId !== null) {
			cancelAnimationFrame(this.waitForLayoutId);
			this.waitForLayoutId = null;
		}
		this.abortController?.abort();
		this.abortController = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.resizeDisposable?.dispose();
		this.resizeDisposable = null;
		this.focusDisposable?.dispose();
		this.focusDisposable = null;
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

	focusTerminal() {
		this.terminal?.focus();
	}
}
