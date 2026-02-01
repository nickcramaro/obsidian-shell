import { Plugin, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_TERMINAL, DEFAULT_SETTINGS, ClaudeTerminalSettings } from "./constants";
import { TerminalView } from "./terminal-view";
import { ClaudeTerminalSettingTab } from "./settings";

export default class ClaudeTerminalPlugin extends Plugin {
	settings: ClaudeTerminalSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_TERMINAL, (leaf) => new TerminalView(leaf, this));

		this.addCommand({
			id: "open-terminal",
			name: "Open Claude Code terminal",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "add-current-note",
			name: "Add current note to Claude context",
			callback: () => this.addCurrentNote(),
		});

		this.addCommand({
			id: "restart-session",
			name: "Restart Claude Code session",
			callback: () => this.restartSession(),
		});

		this.addRibbonIcon("terminal", "Claude Code", () => this.activateView());

		this.addSettingTab(new ClaudeTerminalSettingTab(this.app, this));
	}

	async onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	getTerminalView(): TerminalView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
		if (leaves.length > 0) {
			return leaves[0].view as TerminalView;
		}
		return null;
	}

	addCurrentNote() {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;

		const view = this.getTerminalView();
		if (!view) {
			this.activateView().then(() => {
				// Wait a beat for the terminal to initialize
				setTimeout(() => {
					const v = this.getTerminalView();
					v?.sendToTerminal(`/add ${file.path}`);
				}, 1000);
			});
			return;
		}

		view.sendToTerminal(`/add ${file.path}`);
	}

	restartSession() {
		const view = this.getTerminalView();
		if (view) {
			view.restart();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
