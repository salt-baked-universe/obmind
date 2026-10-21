import { Plugin, WorkspaceLeaf } from "obsidian";
import { MindmapView, MINDMAP_VIEW_TYPE } from "./MindmapView";

export default class MindmapPlugin extends Plugin {
	async onload() {
		this.registerView(MINDMAP_VIEW_TYPE, (leaf: WorkspaceLeaf) => new MindmapView(leaf));

		this.addRibbonIcon("network", "Open mindmap of current note", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-outline-mindmap",
			name: "Open mindmap of current note",
			callback: () => {
				this.activateView();
			},
		});
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(MINDMAP_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({ type: MINDMAP_VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	onunload() {
		// 无需额外清理，Obsidian 会卸载视图
	}
}
