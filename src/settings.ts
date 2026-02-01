import { App, PluginSettingTab, Setting } from "obsidian";
import type ClaudeTerminalPlugin from "./main";

export class ClaudeTerminalSettingTab extends PluginSettingTab {
	plugin: ClaudeTerminalPlugin;

	constructor(app: App, plugin: ClaudeTerminalPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Claude flags")
			.setDesc("Extra flags passed to claude CLI (e.g. --model opus --allowedTools)")
			.addText((text) =>
				text
					.setPlaceholder("--model opus")
					.setValue(this.plugin.settings.claudeFlags)
					.onChange(async (value) => {
						this.plugin.settings.claudeFlags = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Shell path")
			.setDesc("Override shell (leave blank for auto-detect: zsh on macOS, bash on Linux)")
			.addText((text) =>
				text
					.setPlaceholder("/bin/zsh")
					.setValue(this.plugin.settings.shellPath)
					.onChange(async (value) => {
						this.plugin.settings.shellPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Terminal font size in pixels")
			.addSlider((slider) =>
				slider
					.setLimits(10, 24, 1)
					.setValue(this.plugin.settings.fontSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.fontSize = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-launch Claude")
			.setDesc("Automatically run the claude CLI when the terminal opens")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoLaunch)
					.onChange(async (value) => {
						this.plugin.settings.autoLaunch = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Theme" });
		containerEl.createEl("p", {
			text: "Leave blank to auto-detect from Obsidian theme.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Background color")
			.addText((text) =>
				text
					.setPlaceholder("#1e1e2e")
					.setValue(this.plugin.settings.theme.background)
					.onChange(async (value) => {
						this.plugin.settings.theme.background = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Foreground color")
			.addText((text) =>
				text
					.setPlaceholder("#cdd6f4")
					.setValue(this.plugin.settings.theme.foreground)
					.onChange(async (value) => {
						this.plugin.settings.theme.foreground = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Cursor color")
			.addText((text) =>
				text
					.setPlaceholder("#f5e0dc")
					.setValue(this.plugin.settings.theme.cursor)
					.onChange(async (value) => {
						this.plugin.settings.theme.cursor = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
