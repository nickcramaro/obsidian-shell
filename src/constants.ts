export const VIEW_TYPE_TERMINAL = "obsidian-shell-view";

export const DEFAULT_SETTINGS: ClaudeTerminalSettings = {
	claudeFlags: "",
	shellPath: "",
	fontSize: 14,
	autoLaunch: true,
	theme: {
		background: "",
		foreground: "",
		cursor: "",
	},
};

export interface ClaudeTerminalSettings {
	claudeFlags: string;
	shellPath: string;
	fontSize: number;
	autoLaunch: boolean;
	theme: {
		background: string;
		foreground: string;
		cursor: string;
	};
}
